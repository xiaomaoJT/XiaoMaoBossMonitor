/**
 * 推送统计
 * ----------------------------------------------------------------------------
 * 「关于系统」页要展示累计推送次数 —— 而且用户明确要求**三端分开 + 累计**，
 * 因为同时开着钉钉、企业微信、Telegram 三个渠道时，
 * 只看一个总数根本不知道是哪条链路在掉链子。
 *
 * 两个设计决定：
 *   1. 存独立的 localStorage key，**不放进 options**。
 *      用户点「恢复初始化」清的是配置，不该顺手把历史战绩一起抹掉。
 *   2. 只记「已经真的发出去了」的结果（成功 / 失败），
 *      因为各种原因没发的（静默时段、未勾选、限流）压根走不到这里，也不算数。
 */
import { reactive } from 'vue'
// ⚠️ 相对 import 必须带 .js 扩展名：后端用 Node ESM 直接加载这个文件，
// Node 不会像 Vite 那样帮你补扩展名，写成 './useDailyStats' 会直接
// ERR_MODULE_NOT_FOUND 起不来（前端 vite build 却是通过的，很容易漏）。
import { statPush, resetDailyStats } from './useDailyStats.js'

const KEY = 'monitor-wall-push-stats-v1'

/** 渠道 id → 展示名，与 useAlertPush 的 CHANNEL_DEFS 保持一致 */
export const PUSH_CHANNELS = [
  { id: 'ding', label: '钉钉' },
  { id: 'wecom', label: '企业微信' },
  { id: 'tg', label: 'Telegram' }
]

function emptyState() {
  const channels = {}
  PUSH_CHANNELS.forEach((c) => {
    channels[c.id] = { ok: 0, fail: 0, lastAt: 0, lastError: '' }
  })
  return {
    /** 累计尝试次数（成功 + 失败） */
    total: 0,
    ok: 0,
    fail: 0,
    /** 首次 / 最近一次推送时间戳 */
    firstAt: 0,
    lastAt: 0,
    channels
  }
}

function load() {
  const st = emptyState()
  try {
    if (typeof localStorage === 'undefined') return st
    const raw = localStorage.getItem(KEY)
    if (!raw) return st
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object') return st

    st.total = Number(saved.total) || 0
    st.ok = Number(saved.ok) || 0
    st.fail = Number(saved.fail) || 0
    st.firstAt = Number(saved.firstAt) || 0
    st.lastAt = Number(saved.lastAt) || 0

    PUSH_CHANNELS.forEach(({ id }) => {
      const s = saved.channels && saved.channels[id]
      if (!s) return
      st.channels[id] = {
        ok: Number(s.ok) || 0,
        fail: Number(s.fail) || 0,
        lastAt: Number(s.lastAt) || 0,
        lastError: typeof s.lastError === 'string' ? s.lastError : ''
      }
    })
  } catch (e) {
    /* 存储损坏就从头开始，不影响推送本身 */
  }
  return st
}

/** 响应式统计状态，页面直接读 */
export const pushStats = reactive(load())

let saveTimer = null

/** 节流落盘：推送高峰时可能连发好几条，没必要每条都同步写 */
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(KEY, JSON.stringify(pushStats))
    } catch (e) {
      /* 写不进去就算了，统计不该影响推送 */
    }
  }, 500)
}

/**
 * 记一次推送结果。
 * @param {string} channelId 渠道 id：ding / wecom / tg
 * @param {boolean} ok 是否送达
 * @param {string} [error] 失败原因（成功时忽略）
 */
export function recordPush(channelId, ok, error = '') {
  try {
    const now = Date.now()
    const ch = pushStats.channels[channelId]
    if (!ch) return

    pushStats.total += 1
    pushStats.lastAt = now
    if (!pushStats.firstAt) pushStats.firstAt = now

    /*
     * 每日统计（item 111）：复用这个唯一的推送结果入口，
     * 这样「关于系统」的累计数和「统计」页的按天数天然一致，
     * 不需要在两个地方各记一遍、也不会漏。
     */
    statPush(channelId, ok, now)

    if (ok) {
      pushStats.ok += 1
      ch.ok += 1
      ch.lastError = ''
    } else {
      pushStats.fail += 1
      ch.fail += 1
      ch.lastError = String(error || '').slice(0, 120)
    }
    ch.lastAt = now

    save()
  } catch (e) {
    /* 统计失败绝不影响正常推送 */
  }
}

/** 清零（关于页的重置按钮） */
export function resetPushStats() {
  const fresh = emptyState()
  Object.assign(pushStats, fresh)
  pushStats.channels = fresh.channels
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  } catch (e) {
    /* 忽略 */
  }
  // 累计清零了，按天统计也一起清（否则两边对不上，"统计"页还会留着旧数）
  resetDailyStats()
}
