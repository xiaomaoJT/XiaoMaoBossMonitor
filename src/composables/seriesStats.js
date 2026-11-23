/**
 * 时序指标（§5.195）的纯函数收口：区内峰值分钟线 / 停留分位 / 通道在线 SLA。
 * ----------------------------------------------------------------------------
 * 这里只做有界数据与归一化，不碰 localStorage、不 import 统计模块：
 *   · 前端日存档、后端 /api/stats、托盘主进程都按同一套分桶与合并口径；
 *   · 浏览器和 Node ESM 都能直接 import（文件带 .js 扩展名）。
 *
 * 体积上界：每区域每天最多 360 个分钟峰值 + 9 个停留分桶；每通道状态翻转
 * 每天最多 200 条。全是整数/稀疏映射，几百个区域也不会把存档撑大。
 */

/** 停留分桶上界（毫秒）：第 8 桶是「>=30 分钟」，统一按 60 分钟取上界做插值 */
export const DWELL_EDGES_MS = [1000, 3000, 10000, 30000, 60000, 180000, 600000, 1800000]
export const DWELL_BUCKET_COUNT = DWELL_EDGES_MS.length + 1
export const ZONE_MINUTES_MAX = 360
export const SLA_EVENTS_MAX = 200
export const SLA_EXTEND_MAX_MS = 86400000

/** 落入哪个停留分桶（0..8） */
export function dwellBucketIndex(ms) {
  const v = Number(ms)
  if (!Number.isFinite(v) || v <= 0) return 0
  for (let i = 0; i < DWELL_EDGES_MS.length; i += 1) {
    if (v < DWELL_EDGES_MS[i]) return i
  }
  return DWELL_BUCKET_COUNT - 1
}

/** 停留直方图 → 分位数（0~1）。桶内按上/下界线性插值，空表返回 0 */
export function dwellPercentile(buckets, p) {
  const src = Array.isArray(buckets) ? buckets : []
  let total = 0
  for (let i = 0; i < DWELL_BUCKET_COUNT; i += 1) total += Math.max(0, Math.floor(Number(src[i]) || 0))
  if (!total) return 0
  const ratio = Math.max(0, Math.min(1, Number(p) || 0))
  const target = Math.max(1, Math.ceil(total * ratio))
  let seen = 0
  for (let i = 0; i < DWELL_BUCKET_COUNT; i += 1) {
    const n = Math.max(0, Math.floor(Number(src[i]) || 0))
    if (!n) continue
    if (seen + n >= target) {
      const low = i === 0 ? 0 : DWELL_EDGES_MS[i - 1]
      const high = i === DWELL_BUCKET_COUNT - 1 ? 3600000 : DWELL_EDGES_MS[i]
      const frac = n > 1 ? (target - seen - 1) / (n - 1 || 1) : 0
      return Math.round(low + (high - low) * frac)
    }
    seen += n
  }
  return 0
}

/** 归一化区域分钟线：cam / zoneId 白名单限长，分钟键 0~1439，峰值非负整数 */
export function normZoneTimeline(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const [camRaw, table] of Object.entries(src)) {
    const cam = String(camRaw || '').trim().slice(0, 24)
    if (!cam || !table || typeof table !== 'object') continue
    const cOut = {}
    for (const [zoneRaw, z] of Object.entries(table)) {
      const zone = String(zoneRaw || '').trim().slice(0, 64)
      if (!zone || !z || typeof z !== 'object') continue
      const minutes = {}
      const rawMinutes = z.minutes && typeof z.minutes === 'object' ? z.minutes : {}
      const entries = Object.entries(rawMinutes)
        .map(([m, raw]) => {
          const min = Math.floor(Number(m))
          const v = Math.max(0, Math.floor(Number(raw) || 0))
          return min >= 0 && min < 1440 && v > 0 ? [min, v] : null
        })
        .filter(Boolean)
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .slice(0, ZONE_MINUTES_MAX)
      // 排序后保持按分钟升序存，读时间线时不用每次重排
      entries.sort((a, b) => a[0] - b[0])
      for (const [m, v] of entries) minutes[String(m)] = v
      const hist = Array.isArray(z.dwellBuckets) ? z.dwellBuckets : []
      const dwellBuckets = Array.from({ length: DWELL_BUCKET_COUNT }, (_, i) =>
        Math.max(0, Math.floor(Number(hist[i]) || 0)))
      if (!Object.keys(minutes).length && !dwellBuckets.some(Boolean)) continue
      cOut[zone] = { name: String(z.name || '区域').trim().slice(0, 24), minutes, dwellBuckets }
    }
    if (Object.keys(cOut).length) out[cam] = cOut
  }
  return out
}

/** 把一份快照并入目标（分钟峰值同名取 max，直方图按位求和） */
export function mergeZoneTimeline(dst, src) {
  const clean = normZoneTimeline(src)
  for (const [cam, table] of Object.entries(clean)) {
    const dstCam = dst[cam] || (dst[cam] = {})
    for (const [zone, z] of Object.entries(table)) {
      const cur = dstCam[zone] || { name: z.name, minutes: {}, dwellBuckets: Array(DWELL_BUCKET_COUNT).fill(0) }
      cur.name = z.name || cur.name
      for (const [m, v] of Object.entries(z.minutes)) {
        if (v > (cur.minutes[m] || 0)) cur.minutes[m] = v
      }
      for (let i = 0; i < DWELL_BUCKET_COUNT; i += 1) cur.dwellBuckets[i] = (cur.dwellBuckets[i] || 0) + z.dwellBuckets[i]
      // 合并后仍守上界：丢掉峰值最小的分钟键
      const keys = Object.keys(cur.minutes)
      if (keys.length > ZONE_MINUTES_MAX) {
        const keep = keys.sort((a, b) => cur.minutes[b] - cur.minutes[a] || Number(a) - Number(b)).slice(0, ZONE_MINUTES_MAX)
        const trimmed = {}
        keep.sort((a, b) => Number(a) - Number(b)).forEach((k) => { trimmed[k] = cur.minutes[k] })
        cur.minutes = trimmed
      }
      dstCam[zone] = cur
    }
  }
  return dst
}

/**
 * 同一次采样的当日累计快照并入：分钟峰值与直方图都取 max（不能相加，
 * 否则每 60 秒一次采样会把同一批停留重复计数）。跨天聚合才用 sum 版。
 */
export function mergeZoneTimelineSnapshot(dst, src) {
  const clean = normZoneTimeline(src)
  for (const [cam, table] of Object.entries(clean)) {
    const dstCam = dst[cam] || (dst[cam] = {})
    for (const [zone, z] of Object.entries(table)) {
      const cur = dstCam[zone] || { name: z.name, minutes: {}, dwellBuckets: Array(DWELL_BUCKET_COUNT).fill(0) }
      cur.name = z.name || cur.name
      for (const [m, v] of Object.entries(z.minutes)) {
        if (v > (cur.minutes[m] || 0)) cur.minutes[m] = v
      }
      for (let i = 0; i < DWELL_BUCKET_COUNT; i += 1) {
        cur.dwellBuckets[i] = Math.max(cur.dwellBuckets[i] || 0, z.dwellBuckets[i])
      }
      const keys = Object.keys(cur.minutes)
      if (keys.length > ZONE_MINUTES_MAX) {
        const trimmed = {}
        keys.sort((a, b) => cur.minutes[b] - cur.minutes[a] || Number(a) - Number(b))
          .slice(0, ZONE_MINUTES_MAX)
          .sort((a, b) => Number(a) - Number(b))
          .forEach((k) => { trimmed[k] = cur.minutes[k] })
        cur.minutes = trimmed
      }
      dstCam[zone] = cur
    }
  }
  return dst
}

/** 通道状态翻转事件归一化：{ cam, state, at }，有界、只认 offline/online */
export function normStateEvents(src) {
  if (!Array.isArray(src)) return []
  return src
    .map((raw) => {
      const ev = raw && typeof raw === 'object' ? raw : {}
      const state = ev.state === 'offline' || ev.state === 'online' ? ev.state : (ev.s === 'offline' || ev.s === 'online' ? ev.s : '')
      const at = Math.max(0, Math.floor(Number(ev.at !== undefined ? ev.at : ev.t) || 0))
      const cam = String(ev.cam || ev.camId || ev.camName || '').trim().slice(0, 24)
      return state && at && cam ? { cam, state, at } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at || a.cam.localeCompare(b.cam))
    .slice(-SLA_EVENTS_MAX)
}

/** 按通道把状态翻转串成区间，算已观测时长的在线占比（-1 = 还没观测到完整区间） */
export function channelSlaOf(src, now = Date.now()) {
  const events = normStateEvents(src)
  if (!events.length) return { upMs: 0, downMs: 0, rate: -1, transitions: 0 }
  const last = {}
  let upMs = 0
  let downMs = 0
  for (const ev of events) {
    const prev = last[ev.cam]
    if (prev) {
      const span = Math.max(0, Math.min(SLA_EXTEND_MAX_MS, ev.at - prev.at))
      if (prev.state === 'offline') downMs += span
      else upMs += span
    }
    last[ev.cam] = ev
  }
  // 仍在线的通道不额外补时间（观测窗口未知）；只剩「尚未恢复」的离线段延续到现在
  const end = Math.max(0, Math.floor(Number(now) || 0))
  for (const ev of Object.values(last)) {
    if (ev.state !== 'offline' || !end) continue
    downMs += Math.max(0, Math.min(SLA_EXTEND_MAX_MS, end - ev.at))
  }
  const total = upMs + downMs
  return { upMs, downMs, rate: total ? upMs / total : -1, transitions: events.length }
}
