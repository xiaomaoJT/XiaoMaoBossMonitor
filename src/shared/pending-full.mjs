/**
 * 待录入人脸库「预警 / 满库提醒」状态机（单来源、可测）
 * ----------------------------------------------------------------------------
 * 用户需求：待录入（未建档）人脸队列**快满了就提醒一次**（默认到容量的 80%），
 * **满了再提醒一次**，免得等到彻底满、新面孔开始被滚动挤掉才发现。
 *
 * 提醒策略（**两级、每级每个填满周期各一次**）：
 *   - 数量 ≥ 预警线（`warnAt`，默认 = 容量 × 0.8）→ 发「快满了」预警；
 *   - 数量 ≥ 容量（`fullAt`）               → 发「已满」提醒；
 *   - 掉回预警线**以下**才算「处理过了」→ 重新武装，下次再涨上去才会重新提醒。
 *
 * 为什么单独成一个模块：
 *   - 判定逻辑（现在处在哪一级、要不要提醒、要不要重新武装）必须只有一份，
 *     否则 analyzer 的两条收集路径、/api/pending-face 删除路径各写一遍迟早漂移；
 *   - 纯函数 + 注入 kv / 推送，探针能不启动整个服务就把它验证透。
 *
 * 状态存在 store 的 kv（key: pendingFull），**跨重启保留**——
 * 否则服务一重启就把「这个周期已经提醒过」忘掉，变成反复刷屏。
 *
 * ⚠️ 触发点：队列数量**发生变化**时调用 refresh(count)。由三处驱动：
 *   1. analyzer 新插入一条待录入（store.addPendingFace 返回 inserted=true）；
 *   2. /api/pending-face 删掉一条（录入 / 忽略）；
 *   3. （如有）清空整条队列。
 *   refresh 内部对「数量没变」会直接短路，不会每帧写 kv。
 *
 * ⚠️ 容量 / 预警线**每次调用都可现算**：调用方把 `pendingFullConf(face, 缺省)` 的结果
 *    当第二个参数传进来，于是设置页改了阈值**不用重启**也能立刻生效；不传则回落到
 *    创建时的 `fullAt` / `warnRatio`（保持与旧调用点、旧探针兼容）。
 *
 * @param {object}   deps
 * @param {Function} deps.kvGet    (key) => string|null
 * @param {Function} deps.kvSet    (key, value) => void
 * @param {Function} deps.pushDirectToUsers  (kind, payload) => Promise<{ok,sent}>
 * @param {number}   [deps.fullAt] 满库阈值兜底，默认 100（与 store 收集上限 PENDING_KEEP 对齐）
 * @param {number}   [deps.warnRatio] 预警比例兜底，默认 0.8
 */
const KEY = 'pendingFull'

/** 状态级别：0 未提醒 / 1 已发预警 / 2 已发满库。取最高级，同周期内单调不回退。 */
const LEVEL_NONE = 0
const LEVEL_WARN = 1
const LEVEL_FULL = 2

export function createPendingFullWatcher({
  kvGet,
  kvSet,
  pushDirectToUsers,
  fullAt = 100,
  warnRatio = 0.8
}) {
  function read() {
    try {
      const raw = kvGet(KEY)
      if (raw) {
        const o = JSON.parse(raw)
        if (o && typeof o === 'object') {
          // 兼容旧存档（只有 { full:boolean, lastCount }）：映射成 level
          const level = Number.isFinite(Number(o.level))
            ? Number(o.level) || 0
            : (o.full ? LEVEL_FULL : LEVEL_NONE)
          return {
            level: Math.max(0, Math.min(LEVEL_FULL, level)),
            lastCount: Number.isFinite(Number(o.lastCount)) ? Number(o.lastCount) : -1
          }
        }
      }
    } catch (e) {
      /* 损坏当成「还没提醒过」，最坏是多提醒一次，比静默吞掉好 */
    }
    return { level: LEVEL_NONE, lastCount: -1 }
  }

  function write(st) {
    try {
      // full 字段保留：老版本 / 前端 localStorage 存档都认它
      kvSet(KEY, JSON.stringify({ level: st.level, lastCount: st.lastCount, full: st.level >= LEVEL_FULL }))
    } catch (e) {
      /* 落不进去只是下次可能多提醒一次，不影响本次判定 */
    }
  }

  /**
   * 通知当前待录入数量，驱动状态机。
   * @param {number} count 当前待录入数量
   * @param {{fullAt?:number, warnAt?:number}} [limit] 现算的容量/预警线（不传用创建时的兜底）
   * @returns {Promise<{fired:boolean, level:number, full:boolean, rearmed:boolean, fullAt:number, warnAt:number}>}
   */
  async function refresh(count, limit) {
    const n = Math.max(0, Number(count) || 0)
    const cap = Math.max(1, Math.round(Number(limit && limit.fullAt) || Number(fullAt) || 100))
    const warnRaw = Number(limit && limit.warnAt)
    const warnAt = Math.max(
      1,
      Math.min(cap, Math.round(Number.isFinite(warnRaw) && warnRaw > 0 ? warnRaw : Math.floor(cap * warnRatio)))
    )

    const st = read()
    // 数量没变 → 不做任何事（避免每帧写 kv / 重复判定）
    if (st.lastCount === n) {
      return { fired: false, level: st.level, full: st.level >= LEVEL_FULL, rearmed: false, fullAt: cap, warnAt }
    }
    st.lastCount = n

    const target = n >= cap ? LEVEL_FULL : n >= warnAt ? LEVEL_WARN : LEVEL_NONE
    let fired = false
    let rearmed = false
    if (target === LEVEL_NONE) {
      // 掉回预警线以下：算「处理过了」，重新武装
      if (st.level !== LEVEL_NONE) {
        st.level = LEVEL_NONE
        rearmed = true
      }
    } else if (target > st.level) {
      // 只发「更高一级」的那条；直接从 none 跳到 full 时**只发满库**（预警已被包住）
      st.level = target
      fired = true
    }
    write(st)

    if (fired) {
      try {
        await pushDirectToUsers('pending', {
          title: st.level >= LEVEL_FULL ? '待录入人脸库已满' : '待录入人脸库快满了',
          html: st.level >= LEVEL_FULL ? buildPendingFullHtml(n, cap) : buildPendingWarnHtml(n, cap, warnAt)
        })
      } catch (e) {
        /* 推送失败不该让判定逻辑崩 */
      }
    }
    return { fired, level: st.level, full: st.level >= LEVEL_FULL, rearmed, fullAt: cap, warnAt }
  }

  return { refresh }
}

/**
 * 提醒正文（预警级）。故意不塞图片：这条是「去处理」的催促，不是某一张人脸的特写。
 */
function buildPendingWarnHtml(n, fullAt, warnAt) {
  return (
    `<b>⚠️ 待录入人脸库快满了（${n}/${fullAt}）</b>\n\n` +
    `已到预警线 ${warnAt} 张。请到「设置 → 人脸库 → 待录入」挑需要的录入，` +
    `不需要的「忽略」掉，免得攒满后**最旧的面孔被自动挤掉**。\n` +
    `<i>本预警每个填满周期只发一次；处理下去再涨上来会再提醒。</i>`
  )
}

/**
 * 提醒正文（满库级）。
 *
 * ⚠️ 以前这里写「满了之后新面孔进不来」——**与代码实际行为相反**：队列满了以后并不是停收，
 *    而是**滚动保留最新的 N 张、把最旧的删掉**（见 store.prunePendingFaces）。文案改成如实描述，
 *    否则用户会以为"停收了、慢慢处理就行"，实际却在不知不觉丢最旧的未录入人脸。
 */
function buildPendingFullHtml(n, fullAt) {
  return (
    `<b>🚨 待录入人脸库已满（${n}/${fullAt}）</b>\n\n` +
    `已达收集上限 ${fullAt} 张。新出现的人脸仍会继续收，但**最旧的会被自动挤掉**——` +
    `请尽快到「设置 → 人脸库 → 待录入」逐张录入或忽略。\n` +
    `<i>本提醒每个填满周期只发一次；处理下去再填满后会再提醒。</i>`
  )
}
