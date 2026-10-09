/**
 * 系统运行时长（含中断统计 + 持久化）
 * ----------------------------------------------------------------------------
 * 「关于系统」页要显示"这套监控已经连续跑了多久"。难点有三个：
 *
 *   1. 前端页面时长 ≠ 系统时长。
 *      打开「后端检测服务」后，真正在值守的是后端进程；前端页面随时会被刷新、
 *      换设备、甚至根本没打开。所以**后端模式必须以后端为准**，前端只负责展示
 *      （后端把结果随 /api/status 吐出来，见 server/headless-monitor.mjs）。
 *
 *   2. 进程 / 页面会重启，不能一重启就归零。
 *      后端有自愈重启、前端会刷新页面，这些短暂的停机不该把"运行时长"清掉，
 *      否则永远只能看到几分钟。起点必须**落盘**，下次起来接着算。
 *
 *   3. 停机要能被看见，而且不能无限容忍。
 *      累计的中断时长单独展示；单次中断一旦超过 GAP_RESET_MS（4 小时），
 *      说明这不是"抖了一下"而是真停了，就把运行时长归零、当成新的一次运行。
 *
 * 口径（用户确认）：**运行时长含中断** —— 从持久化起点一直算到现在（挂钟），
 * 中断时长作为其中一个"有多少时间其实没在跑"的量单独展示。
 *
 * 存储：前端落浏览器 localStorage；后端跑 headless 时同一段代码经 compat.mjs
 * 落到 server/data/localstorage.json（跨进程重启保留）。两边各自隔离、互不干扰。
 */
import { reactive } from 'vue'

/** localStorage 键名（前端浏览器 / 后端 data 目录各存一份） */
export const UPTIME_KEY = 'monitor-wall-uptime-v1'

/**
 * 单次中断超过这个时长，就认为进入"新的一次运行"，运行时长归零重算。
 * 取 4 小时：夜里断个电、重启个系统再回来，通常也就这个量级以内；
 * 真停了大半天（>4h）再开，继续累加没有意义。
 */
export const GAP_RESET_MS = 4 * 60 * 60 * 1000

/** 心跳间隔：定期把 lastSeenAt 落盘，崩溃后据此估算中断起点 */
const HEARTBEAT_MS = 60 * 1000

/** 运行时长状态（响应式，页面直接读） */
export const systemUptime = reactive({
  /** 本次运行的起点（持久化） */
  startedAt: 0,
  /** 最近一次心跳时刻（用来算下次启动时的中断长度） */
  lastSeenAt: 0,
  /** 本次运行内累计的中断时长 */
  interruptMs: 0,
  /** 最近一次因「中断超过 GAP_RESET_MS」而重置起点的时刻（0 = 从未） */
  resetAt: 0,
  /** 最近一次启动时观测到的中断长度（诊断用） */
  lastGapMs: 0,
  /** 本进程 / 页面启动时刻（仅展示，不持久化） */
  processStartedAt: 0
})

function getStore() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch (e) {
    return null
  }
}

function loadPersisted() {
  const ls = getStore()
  if (!ls) return null
  try {
    const raw = ls.getItem(UPTIME_KEY)
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return null
    return {
      startedAt: Number(o.startedAt) || 0,
      lastSeenAt: Number(o.lastSeenAt) || 0,
      interruptMs: Number(o.interruptMs) || 0,
      resetAt: Number(o.resetAt) || 0
    }
  } catch (e) {
    return null
  }
}

let saveTimer = null
/** 节流落盘：心跳和高频调用没必要每次都同步写 */
function persist() {
  const ls = getStore()
  if (!ls) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      ls.setItem(
        UPTIME_KEY,
        JSON.stringify({
          startedAt: systemUptime.startedAt,
          lastSeenAt: systemUptime.lastSeenAt,
          interruptMs: systemUptime.interruptMs,
          resetAt: systemUptime.resetAt
        })
      )
    } catch (e) {
      /* 落盘失败不影响运行 */
    }
  }, 300)
  if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref()
}

let begun = false

/**
 * 开始 / 续接一次运行会话（页面加载时、后端进程启动时各调一次）。
 * 幂等：同一进程内重复调用不会重复累计中断。
 *
 * 规则：
 *   - 没有历史记录        → 新建，起点 = now。
 *   - 距上次心跳的中断 > 4h → 视为新的一次运行，起点 = now、中断归零。
 *   - 否则（短中断）      → 继承原起点，把这段停机累加进 interruptMs。
 *
 * @param {number} [now]
 */
export function beginRunSession(now = Date.now()) {
  if (begun) return systemUptime
  begun = true

  const prev = loadPersisted()
  if (!prev || !prev.startedAt) {
    // 头一次：直接起算
    systemUptime.startedAt = now
    systemUptime.interruptMs = 0
    systemUptime.resetAt = 0
    systemUptime.lastGapMs = 0
  } else {
    const gap = prev.lastSeenAt ? Math.max(0, now - prev.lastSeenAt) : 0
    if (gap > GAP_RESET_MS) {
      // 中断太久：当成新的一次运行，归零重算
      systemUptime.startedAt = now
      systemUptime.interruptMs = 0
      systemUptime.resetAt = now
      systemUptime.lastGapMs = gap
    } else {
      // 短中断：继承原起点，把这段停机累加进中断时长
      systemUptime.startedAt = prev.startedAt
      systemUptime.interruptMs = (prev.interruptMs || 0) + gap
      systemUptime.resetAt = prev.resetAt || 0
      systemUptime.lastGapMs = gap
    }
  }
  systemUptime.lastSeenAt = now
  systemUptime.processStartedAt = now
  persist()
  return systemUptime
}

/** 心跳：刷新 lastSeenAt（会话未初始化时顺带兜底初始化）。页面关闭前也调一次。 */
export function touchRunSession(now = Date.now()) {
  if (!systemUptime.startedAt) systemUptime.startedAt = now
  systemUptime.lastSeenAt = now
  persist()
}

let hbTimer = null

/** 启动心跳；返回停止函数（幂等，重复调用只启一个） */
export function startUptimeHeartbeat() {
  if (hbTimer) return stopUptimeHeartbeat
  touchRunSession()
  hbTimer = setInterval(() => touchRunSession(), HEARTBEAT_MS)
  if (hbTimer && typeof hbTimer.unref === 'function') hbTimer.unref()
  return stopUptimeHeartbeat
}

export function stopUptimeHeartbeat() {
  if (hbTimer) {
    clearInterval(hbTimer)
    hbTimer = null
  }
}

/**
 * 当前快照。uptimeMs **含中断**（从起点算到现在的挂钟），中断时长单独给出。
 * @param {number} [now]
 */
export function uptimeSnapshot(now = Date.now()) {
  const startedAt = systemUptime.startedAt || now
  return {
    startedAt,
    uptimeMs: Math.max(0, now - startedAt),
    interruptMs: Math.max(0, systemUptime.interruptMs || 0),
    lastSeenAt: systemUptime.lastSeenAt || 0,
    resetAt: systemUptime.resetAt || 0,
    lastGapMs: Math.max(0, systemUptime.lastGapMs || 0),
    processStartedAt: systemUptime.processStartedAt || 0
  }
}

const pad2 = (n) => String(n).padStart(2, '0')

/** 「运行时长」格式：`3 天 04:05:06` / `04:05:06` */
export function formatUptime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const clock = `${pad2(h)}:${pad2(m)}:${pad2(s)}`
  return d > 0 ? `${d} 天 ${clock}` : clock
}

/** 「中断时长」格式：取最多两个单位，例 `2 小时 13 分` / `45 秒` / `3 天 5 小时` */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (total < 60) return `${total} 秒`
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (d > 0) return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
  return `${m} 分`
}
