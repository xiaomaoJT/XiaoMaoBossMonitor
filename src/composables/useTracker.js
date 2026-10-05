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
      faceAt: 0
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
 * 把检测框分配给人脸识别结果：为每张脸找「脚点在脸框内 / 与脸框重叠最大」的人形轨迹。
 * 用于把「这张脸是谁」写到对应的轨迹上。
 */
export function attachFacesToTracks(tracks, faces, iouThreshold = 0.1) {
  const result = []
  if (!tracks || !faces || !faces.length) return result
  for (const face of faces) {
    let best = null
    for (const tr of tracks) {
      const ov = iou(tr.box, face)
      if (ov < iouThreshold) continue
      const areaRatio = (face.w * face.h) / Math.max(EPS, tr.box.w * tr.box.h)
      // 人脸占人形框的比例也要合理（太小说明不是这个人的脸）
      if (areaRatio < 0.01) continue
      const score = ov + Math.min(0.4, areaRatio)
      if (!best || score > best.score) best = { score, track: tr, ov }
    }
    if (best) result.push({ face, track: best.track })
  }
  return result
}
