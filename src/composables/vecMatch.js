/**
 * 人脸向量的「是不是同一个人」判定（前后端共用单一来源）。
 * ----------------------------------------------------------------------------
 * ⚠️ 为什么单独成文件、零依赖：前端 useFaceLib 和后端 store.mjs 都要用同一套口径，
 * 放这儿两边都 import，避免「前端认为同一个人、后端又插一条」的漂移。
 *
 * 向量是 MobileFaceNet 的 512 维、**已 L2 归一化**的单位向量
 * （见 server/detector.mjs 的 faceEmbedding / normalizeVector），
 * 所以「点积」等价于「余弦相似度」。looksSame 用 >0.5 当作同一人，
 * 和 face-lib 的 matchThreshold（默认 0.38，比对已录入人脸）是两套不同用途的阈值：
 *   - matchThreshold：和「已录入人脸」比，要严格才认得；
 *   - looksSame：和「待录入队列里已有的」比，松一点，只为别把同一个人堆成 N 张。
 */

/** 原始点积（向量已归一化时即余弦相似度） */
export function cosineOrRaw(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 粗略判断是不是同一张脸（避免同一个人每隔几秒就塞一张进去） */
export function looksSame(a, b) {
  if (!a || !b) return false
  if (!a.thumb || !b.thumb) return false
  if (!a.vector || !b.vector) return false
  return cosineOrRaw(a.vector, b.vector) > 0.5
}

/* ----------------------------------------------------------------------------
 * 待录入队列的「重复捕获合并间隔」（前后端共用单一来源）
 *
 * 场景：同一个人在门口来回走动，每隔几秒就采到一张；队列里很快堆满同一个人的
 * N 张脸，把真正想录入的新面孔挤出去。looksSame 只回答"像不像"，不回答
 * "是不是刚采过"—— 时间窗让采集有"防抖"：窗内再遇到同一个人只刷新已有那条
 * （时间/ hit 数 / 更清晰的原图），窗外再来才新增一条（用最新鲜的样本）。
 *
 * 配置：options.face.pendingDedupeSec（秒）。
 *   - 没配 → 用默认值（升级前后行为兼容：多数人几分钟内被重复采到都能合并）；
 *   - 配 0  → 关闭去重，每张都单独保留（想要"多角度样本库"的人自己关）；
 *   - 上限 86400（一天）——再大没有意义，队列本身按容量滚动删最旧。
 */
export const PENDING_DEDUPE = {
  sec: { def: 300, max: 86400 }
}
/**
 * 解析合并间隔（秒）。「没配」与「配 0」严格分开（与 clampDigestMinutes 同一约定）：
 * 没配回落默认值，显式 0 就是 0（关闭）。
 */
export function pendingDedupeSec(c) {
  const raw = c && c.pendingDedupeSec
  if (raw === undefined || raw === null || raw === '') return PENDING_DEDUPE.sec.def
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return PENDING_DEDUPE.sec.def
  return Math.max(0, Math.min(PENDING_DEDUPE.sec.max, n))
}

/**
 * 在待录入队列里找「应该被合并掉」的那一条，没有则返回 null。
 *
 * @param {Array} list      队列（前端 pendingFaces / 后端 listPendingFaces 的形状都行）
 * @param {{vector:ArrayLike, thumb:string}} incoming 新采到的脸
 * @param {number} windowSec 合并间隔（秒）；<=0 表示关闭去重（直接返回 null）
 * @param {number} [now]     当前 ms 时间戳（可注入，便于测试）
 * @returns {object|null} 命中的队列项（调用方刷新它的 at / hits / full）
 */
export function pendingDedupeTarget(list, incoming, windowSec, now = Date.now()) {
  // 走同一个解析器：没传 → 默认 300；显式 0 → 关闭；越界钳住
  const win = pendingDedupeSec({ pendingDedupeSec: windowSec })
  if (win <= 0 || !Array.isArray(list) || !list.length) return null
  // ⚠️ 不能写 Number(now) || Date.now()：0 是合法时间戳（测试注入），会被 || 当成缺失
  const n0 = Number(now)
  const t = Number.isFinite(n0) ? n0 : Date.now()
  for (const it of list) {
    if (!looksSame(it, incoming)) continue
    // 窗外（间隔以前采到的）不合并：那人可能是"又来了"，该给一条新鲜样本
    if (!(Number(it.at) >= t - win * 1000)) continue
    return it
  }
  return null
}

/* ----------------------------------------------------------------------------
 * 陌生人反例（「认错」标记）的「同一个人合并」阈值（前后端共用单一来源）
 *
 * 场景：酒店这类高流动场景里，同一个路人甲被误认成库里某人 5 次，
 * 老逻辑就是 5 条独立反例 —— 反例库按「点击次数」而不是「不同陌生人」增长，
 * 很快把 200 条容量占满，还把每次配置同步的载荷撑大。
 * 有了合并阈值：再来一张和某条反例足够像的脸，只给那条 count+1、刷新 at/thumb，
 * 不再新增记录 —— 库的大小回归到「撞过脸的陌生人有多少个」这个真实量级。
 *
 * ⚠️ 与 looksSame(0.5) / matchThreshold(0.38) 的取舍差异：
 *   · looksSame 只用于待录入队列"别把同一个人堆成 N 张"，0.5 就够松；
 *   · 反例合并 0.6 更严一点 —— 合并错了会把两个不同陌生人的脸揉成一条，
 *     之后两人互相"洗白"，代价比多存一条记录大得多；
 *   · matchThreshold 0.38 是「认不认成库内某人」，与合并是两件事，别混。
 *
 * 配置：options.face.blockMergeThreshold。
 *   - 没配 → 用默认值 0.6；
 *   - 配 0  → 关闭合并，每点一次「认错」都单独存一条（想要完整流水的人自己关）；
 *   - 上下限 [0.05, 0.95]：0.05 以下等于"见谁都合并"，0.95 以上等于没合并。
 */
export const BLOCK_MERGE = {
  th: { def: 0.6, min: 0.05, max: 0.95 }
}

/**
 * 解析反例合并阈值。与 pendingDedupeSec 同一约定：「没配」回落默认值，
 * 显式 0 就是 0（关闭合并），越界钳住。
 */
export function blockMergeThreshold(c) {
  const raw = c && c.blockMergeThreshold
  if (raw === undefined || raw === null || raw === '') return BLOCK_MERGE.th.def
  const n = Number(raw)
  if (!Number.isFinite(n)) return BLOCK_MERGE.th.def
  if (n <= 0) return 0
  return Math.max(BLOCK_MERGE.th.min, Math.min(BLOCK_MERGE.th.max, n))
}

/**
 * 在反例库里找「应该被合并掉」的那一条，没有则返回 null。
 *
 * @param {Array<{vector:ArrayLike}>} list 反例库（前端 blockCache / 后端 blocksList 的形状都行）
 * @param {{vector:ArrayLike}} incoming 新标记的这张脸
 * @param {number} threshold 合并阈值；<=0 表示关闭合并（直接返回 null）
 * @returns {object|null} 最像的那条反例（调用方给它 count+1、刷新 at/thumb）
 */
export function blockMergeTarget(list, incoming, threshold) {
  const th = blockMergeThreshold({ blockMergeThreshold: threshold })
  if (th <= 0) return null
  const vec = incoming && incoming.vector
  if (!vec || !vec.length) return null
  if (!Array.isArray(list) || !list.length) return null
  let best = null
  let bestScore = -1
  for (const b of list) {
    if (!b || !b.vector) continue
    const s = cosineOrRaw(b.vector, vec)
    if (s >= th && s > bestScore) {
      best = b
      bestScore = s
    }
  }
  return best
}

/* ----------------------------------------------------------------------------
 * 命中「分差」门槛（前后端共用单一来源）
 *
 * 场景：酒店这类高流动、人员长相相似度高的场景里，一张脸可能"差点"像库里两个人
 * （top1=0.45 像 A，top2=0.43 像 B）。这种"差一点"的命中极容易认错人（把 B 认成 A）。
 * 分差门槛要求"最像的人"必须明显比"第二像的人"高出 margin，才敢确认命中 ——
 * 差得不够远就当没认出（落入未录入/陌生人流程），从根上砍掉"长得像就乱认"的误命中。
 *
 * 配置：options.face.hitMargin（余弦差，[0, 0.5]）。
 *   - 没配 → 默认值 0.08（轻微要求区分度，酒店默认开）；
 *   - 配 0  → 关闭分差门槛，回到"只看 top1 ≥ 阈值"的历史行为；
 *   - 越界钳住。
 * 与 blockMergeThreshold 同一约定：「没配」回落默认，显式 0 就是关。
 */
export const HIT_MARGIN = {
  th: { def: 0.08, min: 0.0, max: 0.5 }
}

/**
 * 解析命中分差门槛。与 blockMergeThreshold 同一约定：「没配」回落默认值，
 * 显式 0 就是 0（关闭分差门槛），越界钳住。
 */
export function hitMarginThreshold(c) {
  const raw = c && c.hitMargin
  if (raw === undefined || raw === null || raw === '') return HIT_MARGIN.th.def
  const n = Number(raw)
  if (!Number.isFinite(n)) return HIT_MARGIN.th.def
  if (n <= 0) return 0
  return Math.max(HIT_MARGIN.th.min, Math.min(HIT_MARGIN.th.max, n))
}

/**
 * 分差门槛是否放行（纯函数，前后端共用）。
 * ----------------------------------------------------------------------------
 * @param {number} top1 库内最像分（余弦）
 * @param {number} top2 库内第二像分（余弦）；库里不足 2 人或 top2 无效时传 <0
 * @param {number} margin 门槛（hitMarginThreshold 的解析值）；<=0 表示关闭
 * @returns {boolean} true = 分差够大，敢确认命中
 *
 * 约定：margin<=0 关闭（回到只看 top1 的历史行为）；top2 无效（凑不出"第二像"，
 * 比如库里只有 1 个人）视为没有歧义对象，直接放行。
 */
export function hitMarginPassed(top1, top2, margin) {
  const m = Number(margin)
  // 关闭态（<=0 或未传/非法）直接放行，回到只看 top1 的历史行为
  if (!Number.isFinite(m) || m <= 0) return true
  // 库里凑不出"第二像"（不足两人 / top2 无效）→ 没有歧义对象，直接放行
  if (!(Number(top2) > 0)) return true
  return (Number(top1) - Number(top2)) >= m
}
