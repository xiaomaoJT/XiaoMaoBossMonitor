import { reactive } from 'vue'
import { alarmBrief } from './useAlarmText.js'

/**
 * Apple Watch 桥接（手机端）
 * ============================================================================
 * 手表端跑不了 WKWebView，所以那边是原生 SwiftUI；这一层负责**把事件喂过去**，
 * 以及接住手表发回来的指令（标记已读 / 主动要一次同步）。
 *
 * 三件必须做对的事：
 *  1. **节流**：一轮报警可能连着来好几条，每条都推一次会让 WC 队列拥塞，
 *     手表那边还会闪。这里合并成「最多每 1.2 秒推一次，推永远推最新快照」。
 *  2. **只推该推的**：原图（shot，几百 KB 的 dataURL）、流地址、ROI、检测区域
 *     全都留在手机上 —— 手表要的是"谁、什么时候、发生了什么"。
 *  3. **降级要无声**：没有手表、用户没配对、插件不存在、调用报错……
 *     任何一步都不能影响主流程。手表是锦上添花，不是必需件。
 */

/** 手表连接状态（设置页展示用） */
export const watchState = reactive({
  /** 运行在原生壳里且插件存在 */
  supported: false,
  /** WCSession 已激活 */
  activated: false,
  /** 用户配对了 Apple Watch */
  paired: false,
  /** 手表上装了本 App */
  installed: false,
  /** 手机 App 正在前台且手表可达（实时推送可用） */
  reachable: false,
  /** 原生侧存有快照（手表随时能取到） */
  hasCache: false,
  /** 最近一次成功下发的时间戳 */
  lastSyncAt: 0,
  /** 最近一次下发时的事件条数 */
  lastCount: 0,
  /** 正在下发 */
  syncing: false,
  /** 最近一次失败原因（空表示没出过错） */
  error: ''
})

/** 取原生插件；不在原生壳里 / 没装插件时返回 null */
export function watchPlugin() {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null
  const p = cap.Plugins && cap.Plugins.WatchBridge
  return p && typeof p.syncEvents === 'function' ? p : null
}

/**
 * 一条记录 → 手表要的轻量版。
 * 字段名与 iOS 侧 WatchBridgePlugin / 手表端 WatchEvent 一一对应，改这里要同步改那边。
 */
export function toWatchEvent(record) {
  if (!record) return null
  return {
    key: String(record.key || ''),
    id: String(record.id || ''),
    name: String(record.name || ''),
    type: String(record.type || 'motion'),
    time: Number(record.time) || Date.now(),
    /** 一行摘要（手表列表里显示的那行） */
    brief: String(alarmBrief(record) || record.text || ''),
    text: String(record.text || ''),
    ratio: Number(record.ratio) || 0,
    /** 缩略图（小图，几十 KB）；原生侧只给最新几条带上 */
    thumb: String(record.thumb || ''),
    read: !!record.read,
    push: String(record.push || ''),
    pushError: String(record.pushError || ''),
    pushChannels: String(record.pushChannels || '')
  }
}

/** 查询配对/安装/可达状态，写进 watchState */
export async function refreshWatchStatus() {
  const p = watchPlugin()
  if (!p || typeof p.status !== 'function') {
    watchState.supported = false
    return watchState
  }
  watchState.supported = true
  try {
    const st = (await p.status()) || {}
    watchState.activated = !!st.activated
    watchState.paired = !!st.paired
    watchState.installed = !!st.installed
    watchState.reachable = !!st.reachable
    watchState.hasCache = !!st.hasCache
    watchState.error = ''
  } catch (e) {
    watchState.error = String((e && e.message) || e)
  }
  return watchState
}

/* ---------------------------------------------------------------------------
 * 下发节流：合并高频调用，永远只发最新的一份快照
 * ------------------------------------------------------------------------- */
const MIN_GAP_MS = 1200
let lastSentAt = 0
let pendingTimer = null
let pendingEvents = null
let pendingReason = ''

/**
 * 把当前事件列表推给手表（节流）。
 * @param events 事件数组（内存里那份轻量记录即可）
 * @param reason 仅用于排查：'startup' | 'append' | 'read' | 'reset' | 'manual'
 */
export function syncWatch(events, reason = 'change') {
  if (!watchPlugin()) return
  pendingEvents = Array.isArray(events) ? events : []
  pendingReason = reason
  const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastSentAt))
  if (pendingTimer) return
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    flushWatch()
  }, wait)
}

async function flushWatch() {
  const p = watchPlugin()
  if (!p) return
  const list = pendingEvents || []
  const reason = pendingReason
  pendingEvents = null
  lastSentAt = Date.now()
  watchState.syncing = true
  try {
    const payload = list
      .slice(0, 30)
      .map(toWatchEvent)
      .filter(Boolean)
    await p.syncEvents({ events: payload, reason })
    watchState.lastSyncAt = Date.now()
    watchState.lastCount = payload.length
    watchState.error = ''
  } catch (e) {
    watchState.error = String((e && e.message) || e)
  } finally {
    watchState.syncing = false
    // 节流期间又攒了新数据就再补一发
    if (pendingEvents) syncWatch(pendingEvents, pendingReason)
  }
}

/** 立即下发一次（设置页「立即同步」按钮 / 手表主动来要） */
export async function syncWatchNow(events, reason = 'manual') {
  pendingEvents = Array.isArray(events) ? events : []
  pendingReason = reason
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  await flushWatch()
}

/** 清空手表端列表（恢复初始化 / 清空报警记录时用） */
export async function clearWatch() {
  const p = watchPlugin()
  if (!p || typeof p.clear !== 'function') return
  try {
    await p.clear()
    watchState.lastSyncAt = Date.now()
    watchState.lastCount = 0
  } catch (e) {
    watchState.error = String((e && e.message) || e)
  }
}

/**
 * 订阅手表发来的指令。返回取消订阅函数。
 *
 * @param handlers {
 *   onMarkRead(key, read)  key === '*' 表示全部已读
 *   onRequestSync()
 *   onStateChange(state)   配对/安装状态变化
 * }
 */
export function onWatchCommand(handlers = {}) {
  const p = watchPlugin()
  if (!p || typeof p.addListener !== 'function') return () => {}
  const disposers = []

  if (handlers.onMarkRead || handlers.onRequestSync) {
    const h = p.addListener('watchCommand', (data = {}) => {
      if (data.cmd === 'markRead' && handlers.onMarkRead) {
        handlers.onMarkRead(String(data.key || ''), data.read !== false)
      } else if (data.cmd === 'requestSync' && handlers.onRequestSync) {
        handlers.onRequestSync()
      }
    })
    disposers.push(() => h && h.remove && h.remove())
  }

  if (handlers.onStateChange) {
    const h = p.addListener('watchState', (data = {}) => {
      watchState.paired = !!data.paired
      watchState.installed = !!data.installed
      watchState.reachable = !!data.reachable
      handlers.onStateChange(watchState)
    })
    disposers.push(() => h && h.remove && h.remove())
  }

  return () => disposers.forEach((d) => d())
}

/** 设置页用的一句人话状态 */
export function watchStatusText() {
  if (!watchState.supported) return '当前环境不支持（仅 iOS App 内可用）'
  if (!watchState.activated) return '正在连接手表…'
  if (!watchState.paired) return '没有配对的 Apple Watch'
  if (!watchState.installed) return '手表上还没安装「监控大屏」'
  if (watchState.reachable) return '手机在线，事件实时同步'
  return '已配对（手表现在不在线，下次抬腕会自动同步）'
}
