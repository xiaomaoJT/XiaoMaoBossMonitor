/**
 * 轻量多目标跟踪器（零模型，纯几何）
 * ----------------------------------------------------------------------------
 * 为什么需要它：人形检测每一帧都是「一堆互不相干的框」，没有身份。
 * 而下面这些事情全部依赖同一个人的**跨帧连续性**：
 *
 *   - 走入区域 / 走出区域   → 要知道「这一帧的框」和「上一帧的框」是同一个人
 *   - 徘徊检测             → 要知道这个人在这儿待了多久、动没动地方
 *   - 人员计数             → 要知道是不是同一个人的第 N 帧（否则一帧算一个人）
 *   - 人脸去重             → 同一个人不需要每隔 5 秒重复提人脸特征
 *
 * 所以它是这四项功能的公共底座，本身不花任何算力（不跑模型）。
 *
 * 算法：IoU + 质心距离的贪心匹配（比匈牙利算法简单，实际效果足够），
 * 匹配不上的轨迹进入「丢失容忍」状态而不是立刻删除——人被遮挡一两帧很常见，
 * 直接删掉会导致同一个人被当成两个人反复计数。
 */

const EPS = 1e-6

function iou(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const w = x2 - x1
  const h = y2 - y1
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** 归一化矩形是否包含点 */
export function rectHas(rect, x, y) {
  if (!rect) return true
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h
}

/** 检测框的「脚点」：区域判定用它比用中心点更符合直觉（人站在区域内） */
export function footOf(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h }
}

export class Tracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.iouThreshold=0.2] 匹配所需的最小 IoU
   * @param {number} [opts.maxDistance=0.22] 匹配允许的最大质心距离（归一化）
   * @param {number} [opts.maxMisses=12] 连续多少帧没匹配上才删除轨迹
   * @param {number} [opts.minHits=2] 连续命中多少帧才算「确认目标」
   * @param {number} [opts.historyMs=60000] 轨迹位置历史保留时长
   */
  constructor(opts = {}) {
    this.iouThreshold = opts.iouThreshold ?? 0.2
    this.maxDistance = opts.maxDistance ?? 0.22
    this.maxMisses = opts.maxMisses ?? 12
    this.minHits = opts.minHits ?? 2
    this.historyMs = opts.historyMs ?? 60000
    this.historyMax = opts.historyMax ?? 180

    /** @type {Array} 活动轨迹 */
    this.tracks = []
    this.nextId = 1
    /** @type {Array} 检测区域（由外部按通道配置注入） */
    this.zones = []
    /** 累计统计：人次 */
    this.stats = { current: 0, totalIn: 0, totalOut: 0 }
  }

  /** 更新区域配置（设置里改了区域后调用） */
  setZones(zones) {
    this.zones = Array.isArray(zones) ? zones : []
    // 区域被删掉时，轨迹里对应的状态也清掉，避免残留
    const ids = new Set(this.zones.map((z) => z.id))
    for (const tr of this.tracks) {
      Object.keys(tr.zones).forEach((k) => {
        if (!ids.has(k)) delete tr.zones[k]
      })
    }
  }

  reset() {
    this.tracks = []
    this.nextId = 1
    this.stats = { current: 0, totalIn: 0, totalOut: 0 }
  }

  /** 已确认（连续命中达标）的轨迹 */
  get confirmed() {
    return this.tracks.filter((t) => t.hits >= this.minHits && t.misses === 0)
  }

  /**
   * 喂一帧检测结果。
   * @param {Array<{x:number,y:number,w:number,h:number,score:number}>} detections 归一化框
   * @param {number} [now] 时间戳（毫秒），默认取当前时间
   * @returns {{tracks:Array, events:Array}} events 里是 enter / exit / loiter 边沿事件
   */
  update(detections, now) {
    const t = now || Date.now()
    const list = Array.isArray(detections) ? detections : []
    const events = []

    /* ---------- 1. 贪心匹配 ---------- */
    const pairs = []
    for (const tr of this.tracks) {
      for (let i = 0; i < list.length; i++) {
        const d = list[i]
        const ov = iou(tr.box, d)
        const dcx = d.x + d.w / 2
        const dcy = d.y + d.h / 2
        const dist = Math.hypot(dcx - tr.cx, dcy - tr.cy)
        // IoU 和质心距离满足其一就允许配对：IoU 管慢速，距离管快速移动
        if (ov < this.iouThreshold && dist > this.maxDistance) continue
        const cost = 1 - ov + (dist / Math.max(EPS, this.maxDistance)) * 0.45
        pairs.push({ tr, i, cost })
      }
    }
    pairs.sort((a, b) => a.cost - b.cost)

    const usedTrack = new Set()
    const usedDet = new Set()
    for (const p of pairs) {
      if (usedTrack.has(p.tr.id) || usedDet.has(p.i)) continue
      usedTrack.add(p.tr.id)
      usedDet.add(p.i)
      this._bind(p.tr, list[p.i], t)
    }

    /* ---------- 2. 未匹配的轨迹：丢失计数 ---------- */
    for (const tr of this.tracks) {
      if (!usedTrack.has(tr.id)) tr.misses += 1
    }

    /* ---------- 3. 未匹配的检测：新建轨迹 ---------- */
    for (let i = 0; i < list.length; i++) {
      if (!usedDet.has(i)) this.tracks.push(this._born(list[i], t))
    }

    /* ---------- 4. 清掉长时间没出现的轨迹 ---------- */
    if (this.tracks.some((tr) => tr.misses > this.maxMisses)) {
      const gone = this.tracks.filter((tr) => tr.misses > this.maxMisses)
      // 轨迹消失也算「离开」：否则人走出画面后，区域里的计数会一直挂着他
      for (const tr of gone) this._zoneLeaveAll(tr, t, events)
      this.tracks = this.tracks.filter((tr) => tr.misses <= this.maxMisses)
    }

    /* ---------- 5. 区域规则（进出 / 徘徊） ---------- */
    for (const tr of this.tracks) {
      if (tr.misses === 0 && tr.hits >= this.minHits) this._zoneCheck(tr, t, events)
    }

    /* ---------- 6. 统计 ---------- */
    this.stats.current = this.confirmed.length

    return { tracks: this.tracks, events }
  }

  /* ==================== 内部 ==================== */
  _born(box, t) {
    const foot = footOf(box)
    return {
      id: this.nextId++,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      score: box.score || 0,
      cx: box.x + box.w / 2,
      cy: box.y + box.h / 2,
      foot,
      /** 速度（归一化单位 / 秒），做指数平滑 */
      vx: 0,
      vy: 0,
      hits: 1,
      misses: 0,
      firstSeen: t,
      lastSeen: t,
      /** 每个区域的进出 / 徘徊状态 */
      zones: {},
      history: [{ t, x: foot.x, y: foot.y }],
      /** 人脸识别结果（由外部回填，用于去重） */
      face: null,
      /** 上一次「尝试」提特征的时刻（成功或失败都记）—— 失败重试的节流闸门 */
      faceAt: 0,
      /** 上一次「成功」提特征的时刻——复用闸门只看这个，避免一次失败就把人锁死一个去重窗 */
      faceOkAt: 0,
      /**
       * 上一次发起「头区补检」的时刻（无论检出与否都记）。
       * tracksDueForFace 的窗口节流**只看它** —— 不能复用 faceAt：
       * faceAt 只在「检出脸并去提特征」时才写，漏检的人头会永远没被记过 → 每帧都重检。
       */
      faceSearchAt: 0
    }
  }

  _bind(tr, box, t) {
    const ncx = box.x + box.w / 2
    const ncy = box.y + box.h / 2
    const dt = Math.max(1, t - tr.lastSeen) / 1000
    const vx = (ncx - tr.cx) / dt
    const vy = (ncy - tr.cy) / dt
    // 指数平滑，避免单帧抖动把速度打飞
    tr.vx = tr.vx * 0.6 + vx * 0.4
    tr.vy = tr.vy * 0.6 + vy * 0.4

    tr.box = { x: box.x, y: box.y, w: box.w, h: box.h }
    tr.score = box.score || tr.score
    tr.cx = ncx
    tr.cy = ncy
    tr.foot = footOf(box)
    tr.hits += 1
    tr.misses = 0
    tr.lastSeen = t

    tr.history.push({ t, x: tr.foot.x, y: tr.foot.y })
    this._trimHistory(tr, t)
  }

  _trimHistory(tr, t) {
    const minT = t - this.historyMs
    let cut = 0
    while (cut < tr.history.length - 2 && tr.history[cut].t < minT) cut += 1
    if (cut > 0) tr.history.splice(0, cut)
    if (tr.history.length > this.historyMax) {
      tr.history.splice(0, tr.history.length - this.historyMax)
    }
  }

  /** 轨迹在最近窗口内的活动范围（外接矩形对角线长度，归一化） */
  _span(tr, t, windowMs) {
    const from = t - windowMs
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let n = 0
    for (let i = tr.history.length - 1; i >= 0; i--) {
      const h = tr.history[i]
      if (h.t < from) break
      if (h.x < minX) minX = h.x
      if (h.y < minY) minY = h.y
      if (h.x > maxX) maxX = h.x
      if (h.y > maxY) maxY = h.y
      n += 1
    }
    if (n < 2) return 0
    return Math.hypot(maxX - minX, maxY - minY)
  }

  /** 离开全部区域（轨迹消失时用） */
  _zoneLeaveAll(tr, t, events) {
    for (const key of Object.keys(tr.zones)) {
      const st = tr.zones[key]
      if (!st.inside) continue
      st.inside = false
      const zone = this.zones.find((z) => z.id === key)
      if (zone && zone.enterExit !== false) {
        events.push({
          kind: 'exit',
          zoneId: key,
          zoneName: zone.name || '区域',
          trackId: tr.id,
          at: t,
          box: { ...tr.box },
          dwellMs: st.since ? t - st.since : 0,
          gone: true
        })
        this.stats.totalOut += 1
      }
    }
  }

  _zoneCheck(tr, t, events) {
    if (!this.zones.length) return
    for (const zone of this.zones) {
      const rect = zone.rect
      const inNow = rectHas(rect, tr.foot.x, tr.foot.y)
      let st = tr.zones[zone.id]
      if (!st) {
        st = { inside: false, since: 0, loitered: false, lastSeen: 0 }
        tr.zones[zone.id] = st
      }
      if (inNow) st.lastSeen = t

      /* ---- 进入 ---- */
      if (inNow && !st.inside) {
        st.inside = true
        st.since = t
        st.loitered = false
        if (zone.enterExit !== false) {
          events.push({
            kind: 'enter',
            zoneId: zone.id,
            zoneName: zone.name || '区域',
            trackId: tr.id,
            at: t,
            box: { ...tr.box },
            score: tr.score
          })
          this.stats.totalIn += 1
        }
      } else if (!inNow && st.inside) {
        /* ---- 离开 ---- */
        st.inside = false
        const dwellMs = st.since ? t - st.since : 0
        // 只是贴着边界抖动了一下（停留很短）就不算一次离开
        const minMs = Math.max(0, Number(zone.minDwellMs) || 600)
        if (zone.enterExit !== false && dwellMs >= minMs) {
          events.push({
            kind: 'exit',
            zoneId: zone.id,
            zoneName: zone.name || '区域',
            trackId: tr.id,
            at: t,
            box: { ...tr.box },
            dwellMs
          })
          this.stats.totalOut += 1
        }
      }

      /* ---- 徘徊 ---- */
      if (inNow && zone.loiter && !st.loitered) {
        const needMs = Math.max(5000, (Number(zone.loiterSec) || 20) * 1000)
        if (t - st.since >= needMs) {
          const radius = Number(zone.loiterRadius) > 0 ? Number(zone.loiterRadius) : 0.08
          // 窗口内没怎么挪地方 → 判定为徘徊
          if (this._span(tr, t, needMs) <= radius) {
            st.loitered = true
            events.push({
              kind: 'loiter',
              zoneId: zone.id,
              zoneName: zone.name || '区域',
              trackId: tr.id,
              at: t,
              box: { ...tr.box },
              dwellMs: t - st.since,
              radius
            })
          }
        }
      }
    }
  }
}

/**
 * 「这张脸属于这个人形框吗」——**唯一的几何判定**，前端 / 后端共用。
 * 规则与 attachFacesToTracks 相同（包含 + 头区 + 面积下限），详见其注释。
 * @returns {number} 0 = 不属于；>0 = 属于，数值为归属强度（人脸占框面积，封顶 1）
 */
export function faceBoxAffinity(face, box, opts = {}) {
  if (!face || !box || !box.w || !box.h) return 0
  const tolerance = Number.isFinite(opts.tolerance) ? opts.tolerance : 0.01
  const headZone = Number.isFinite(opts.headZone) ? opts.headZone : 0.6
  const minAreaRatio = Number.isFinite(opts.minAreaRatio) ? opts.minAreaRatio : 0.01
  const fx = face.x + face.w / 2
  const fy = face.y + face.h / 2
  // 1. 中心点在人形框内（含容差）
  if (fx < box.x - tolerance || fx > box.x + box.w + tolerance) return 0
  if (fy < box.y - tolerance || fy > box.y + box.h + tolerance) return 0
  // 2. 中心点在上部（头区）
  if (fy > box.y + box.h * headZone + tolerance) return 0
  // 3. 面积下限
  const areaRatio = (face.w * face.h) / Math.max(EPS, box.w * box.h)
  if (areaRatio < minAreaRatio) return 0
  return Math.min(1, areaRatio)
}

/**
 * 把检测框分配给人脸识别结果：为每张脸找「它属于哪个人」。
 *
 * 为什么不用 IoU：人脸长在人形框**内部**，两者 IoU ≈ 人脸面积 / 人形框面积。
 * 旧版门槛 IoU ≥ 0.1 等于要求「脸占到人形框的 10%」——只有贴脸近拍
 * （人形框被裁到胸以上）才过得了；门口 1.2m 的全身框只剩 6.7%，
 * 大厅 4m / 走廊 6m 只有 3.6%，这就是人脸采集率只有约 1/10 的直接原因。
 * 实测（/tmp/face-probe/gates.mjs）：近距胸以上 32.0% / 门口半身 11.1%
 * 通过，门口全身 6.7% / 大厅 3.7% / 走廊 3.6% 被丢。
 *
 * 新规则（纯几何，与人形框绝对大小无关，远近一视同仁）：
 *   1. 人脸中心点落在人形框内（容差 tolerance 容忍边缘抖动）
 *   2. 人脸中心位于人形框**上部**（headZone）——头长在身体上方，
 *      顺带挡掉衣服图案 / 身上反光造成的假脸
 *   3. 人脸面积 ≥ 人形框面积的 minAreaRatio——挡掉隔壁人的脸
 *   4. 多个候选都合法时取人形框**最小**的那个：框最紧 = 最可能是本人；
 *      两人被检测成一体的合并框必然更大，天然排后
 *
 * @param {Array} tracks 人形轨迹（带 box）
 * @param {Array} faces 人脸检测框
 * @param {object} [opts] 见 faceBoxAffinity
 * @returns {Array<{face:object, track:object}>}
 */
export function attachFacesToTracks(tracks, faces, opts = {}) {
  const result = []
  if (!tracks || !tracks.length || !faces || !faces.length) return result
  for (const face of faces) {
    let best = null
    for (const tr of tracks) {
      const aff = faceBoxAffinity(face, tr.box, opts)
      if (aff <= 0) continue
      const area = tr.box.w * tr.box.h
      // 归属强度相同（都封顶 1）时，框最紧的赢
      if (!best || area < best.area) best = { track: tr, area, affinity: aff }
    }
    if (best) result.push({ face, track: best.track })
  }
  return result
}

/**
 * 哪些轨迹值得做一次「新鲜」的人脸检测（去重窗口已到期、整帧检测又没覆盖到）。
 *
 * 这是头部裁剪补检的性能闸门，两端共用同一份——写两边必然漂移：
 *   - 窗口没到期的轨迹本来就要复用旧结果，检出来了也用不上，白跑一次推理；
 *   - 2fps × 10s 去重窗下，每轨迹最多 0.1 次/秒，相对整帧检测（2 次/秒）可忽略。
 *
 * ⚠️ 闸门只看 `faceSearchAt`（「发起补检」的时刻，检出与否都记），**不能看 `faceAt`**：
 *    faceAt 只在「检出脸、去提特征」时才写。漏检的人头（太远 / 背对 / 被 affinity 拒）
 *    永远进不了这一步 → 永远没被记过 → **每一帧都被判为到期**，640 全推理每帧一发，
 *    几个通道几个人头就把单线程服务的 HTTP / 静态资源全按住（表现为页面转圈、
 *    「后端事件轮询超时」）。补检那一步必须自己记时刻。
 *
 * @param {Array} live 本帧活动轨迹
 * @param {Set<string|number>} covered 整帧检测已经覆盖到的 trackId
 * @param {number} now 时间戳（毫秒）
 * @param {number} dedupeMs 去重窗口（毫秒）
 * @returns {Array} 需要补检的轨迹（保持原顺序）
 */
export function tracksDueForFace(live, covered, now, dedupeMs) {
  if (!live || !live.length) return []
  return live.filter(
    (tr) => !covered.has(tr.id) && (!tr.faceSearchAt || now - tr.faceSearchAt >= dedupeMs)
  )
}

/**
 * 提特征「失败后的短重试」节流窗口（毫秒）。
 *
 * ⚠️ 这是采集率第二暗坑的修正：以前 `faceAt` 在「尝试提特征之前」就记了，
 * 一旦对齐/提特征失败（翻正失败、模型瞬间没就绪、WASM 抖动），
 * 这条轨迹就被去重窗（默认 10s）关在外面——人明明站着，10 秒内再也不会被提特征，
 * 采集率直接掉一截。
 * 改成「成功才记 long 窗口、失败只记一个短窗口」：失败的人 0.7s 后就能再试，
 * 成功的人仍享 10s 复用。0.7s 在 2fps 下≈每帧都试一遍，代价只是几次
 * 对齐 + 一次 112×112 推理（几十 ms），远小于「漏掉一张脸」的代价。
 */
export const FACE_RETRY_MS = 700

/**
 * 复用闸门：上一次提特征成功且在去重窗内，就直接继承既有结果，别重提。
 * 只看 `faceOkAt`（成功的时刻），所以一次失败不会把人锁死一个去重窗。
 */
export function faceReuseFresh(tr, now, dedupeMs) {
  return !!(tr && tr.faceOkAt && now - tr.faceOkAt < dedupeMs)
}

/**
 * 重试闸门：上一次「尝试」还在节流窗内（不论成败），就先歇一会儿，别每帧都撞。
 * 配合 FACE_RETRY_MS 用——连续失败时才节流，模型就绪/翻正成功后立刻能提。
 */
export function faceRetryDue(tr, now, retryMs = FACE_RETRY_MS) {
  return !!(tr && tr.faceAt && now - tr.faceAt < retryMs)
}

/**
 * 采集调优旋钮的缺省值与上下限 —— **唯一判定**，前端 `useAiExtras` 与
 * 后端 `analyzer` 都走 `faceTuning()`，显示层与执行层不会各算一遍。
 *
 * 这三个旋钮以前是散落的代码常量（`FACE_RETRY_MS` / 硬编码 0.45 / `SLOT_SIZE.face = 640`），
 * 调一次得改代码重构建。现在收口在这里，设置页「采集调优」直接改。
 * 缺省值 = 原来的常量值，所以**不配置时行为与历史完全一致**。
 */
export const FACE_TUNING = {
  /** 提特征失败后的短重试节流窗（毫秒），见 FACE_RETRY_MS */
  retryMs: { def: FACE_RETRY_MS, min: 100, max: 5000 },
  /**
   * 同一个人的脸多少秒内不重复提特征（省算力）。
   * ⚠️ 这个键早就在配置里（默认 10），但两端 `faceConf` 各写了一个 `|| 6` 的兜底，
   *    与配置默认值并不一致 —— 收口到这里，杜绝「设置页显示 10、执行层实际按 6 算」。
   */
  dedupeSec: { def: 10, min: 2, max: 60 },
  /**
   * 头部补检的裁剪高度占人形框的比例。
   * 0.45 是三种构图的兼容上界：全身 12~18% / 半身 25~30% / 胸以上 45~55%。
   */
  headRatio: { def: 0.45, min: 0.2, max: 0.9 },
  /**
   * SCRFD 检测输入边长。**必须是 32 的倍数**（解码按 stride 8/16/32 铺 anchor）。
   * 640 是原值；调大能救更远的半张脸，代价是推理更慢。
   */
  detSize: { def: 640, min: 320, max: 1280 }
}

const tuningNum = (v, def) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : def
}
const tuningClamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

/**
 * 把 `options.face` 解析成一组可直接用的数字。
 * 缺字段 / 脏值 / 越界都兜得住 —— 老存档里没有这些键时自动回到缺省，绝不产出 NaN。
 * @param {object} face `options.face`
 * @returns {{retryMs:number, headRatio:number, detSize:number}}
 */
export function faceTuning(face) {
  const c = face || {}
  // 输入边长吸附到 32 的倍数：配置写 700 也会落到 704，不会把 anchor 网格铺错
  const raw = tuningNum(c.detSize, FACE_TUNING.detSize.def)
  const snapped = Math.round(raw / 32) * 32
  return {
    retryMs: Math.round(tuningClamp(tuningNum(c.retryMs, FACE_TUNING.retryMs.def), FACE_TUNING.retryMs.min, FACE_TUNING.retryMs.max)),
    dedupeSec: tuningClamp(tuningNum(c.dedupeSec, FACE_TUNING.dedupeSec.def), FACE_TUNING.dedupeSec.min, FACE_TUNING.dedupeSec.max),
    headRatio: tuningClamp(tuningNum(c.headRatio, FACE_TUNING.headRatio.def), FACE_TUNING.headRatio.min, FACE_TUNING.headRatio.max),
    detSize: tuningClamp(snapped, FACE_TUNING.detSize.min, FACE_TUNING.detSize.max)
  }
}

/**
 * 待录入队列「容量 / 满库阈值 / 预警线」的缺省值与上下限 —— **唯一判定**。
 *
 * 以前这两个数写死在两处：后端 `analyzer.PENDING_KEEP = 100`、前端 `useFaceLib.PENDING_MAX = 24`，
 * 想改只能改代码重构建。现在收口成 `options.face` 下的两个旋钮（设置页「采集调优」里可调）：
 *   - `pendingFullAt`  队列容量**同时**就是满库阈值（「满了」= 到了上限，文案才不自相矛盾）。
 *                      缺省 0 = **自动**：后端跟 `PENDING_KEEP`、前端跟 `PENDING_MAX`，
 *                      于是「不配置时行为与升级前逐字节一致」。
 *   - `pendingWarnRatio` 到容量的这个比例先预警一次。
 *
 * ⚠️ 「满」和「预警」是两级、各提醒一次：先到预警线（默认 80%）催一次，再到上限提醒一次；
 *    掉回预警线以下才算「处理过了」，下次再涨上来才会重新提醒（见 server/pending-full.mjs）。
 */
export const PENDING_FULL = {
  /** 队列容量 = 满库阈值；0 = 自动（跟随后端 PENDING_KEEP / 前端 PENDING_MAX） */
  fullAt: { def: 0, min: 0, max: 500 },
  /** 预警线 = 容量 × 该比例（0.5~0.99） */
  warnRatio: { def: 0.8, min: 0.5, max: 0.99 }
}

/**
 * 解析 `options.face` 里的待录入容量/预警旋钮。
 * @param {object} face `options.face`
 * @param {number} fallback 自动模式下的容量（后端传 PENDING_KEEP、前端传 PENDING_MAX）
 * @returns {{fullAt:number, warnAt:number, warnRatio:number, auto:boolean}}
 */
export function pendingFullConf(face, fallback) {
  const c = face || {}
  const fb = Math.max(1, Math.round(Number(fallback) || 100))
  const raw = Number(c.pendingFullAt)
  const auto = !Number.isFinite(raw) || raw <= 0
  const fullAt = auto
    ? fb
    : tuningClamp(Math.round(raw), PENDING_FULL.fullAt.min || 1, PENDING_FULL.fullAt.max)
  const rr = Number(c.pendingWarnRatio)
  const warnRatio = Number.isFinite(rr) && rr > 0
    ? tuningClamp(rr, PENDING_FULL.warnRatio.min, PENDING_FULL.warnRatio.max)
    : PENDING_FULL.warnRatio.def
  // 预警线至少 1；且严格小于容量（否则预警和满库同点，两级就退化成一级）
  const warnAt = Math.max(1, Math.min(fullAt - 1, Math.floor(fullAt * warnRatio)))
  return { fullAt, warnAt: warnAt < 1 ? 1 : warnAt, warnRatio, auto }
}

/**
 * 在若干张人脸里，挑出最可能属于这个人形框的那一张（补拍窗口用）。
 * 与 attachFacesToTracks 共用 faceBoxAffinity——「哪张脸属于哪个人」
 * 只允许有一个答案，不许两端各演算一遍。
 * 排序：归属强度 → 脸更大（像素更多，特征更稳）→ 检测置信度更高。
 * @returns {object|null} 人脸框，或 null（这个框里没有脸）
 */
export function pickFaceFor(faces, box, opts = {}) {
  if (!faces || !faces.length || !box) return null
  let best = null
  let bestAff = 0
  let bestArea = -1
  let bestScore = -1
  for (const f of faces) {
    const aff = faceBoxAffinity(f, box, opts)
    if (aff <= 0) continue
    const area = f.w * f.h
    const sc = Number(f.score) || 0
    if (
      !best ||
      aff > bestAff ||
      (aff === bestAff && (area > bestArea || (area === bestArea && sc > bestScore)))
    ) {
      best = f
      bestAff = aff
      bestArea = area
      bestScore = sc
    }
  }
  return best
}
