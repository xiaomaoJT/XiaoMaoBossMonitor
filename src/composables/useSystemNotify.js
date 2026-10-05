/**
 * 系统通知（三端统一）
 * ============================================================================
 * 以前桌面通知只用 window.Notification（Web API），实际表现为：
 *   - 浏览器 / Electron：能用，但 Electron 里点击通知唤不回最小化的窗口；
 *   - iOS（WKWebView）：**完全没有** Notification 构造器 ——
 *     值守时人不在屏幕前，报警就只能靠开着的页面自己闪，等于没通知。
 *
 * 现在三端各走各的原生能力，对外一个接口：
 *
 *   1. Electron → 主进程 Notification 模块（IPC）
 *      点击通知由主进程直接 restore()/show()/focus() 窗口，再把 tag 回传页面定位，
 *      「最小化 / 别的 Space / 长时间值守」场景都稳。
 *
 *   2. iOS（Capacitor 原生壳）→ 本地插件 UNUserNotificationCenter
 *      前台用 willPresent 兜住「开着 App 却看不到通知」；点击通知由
 *      didReceive 把 tag 回传给页面（notifyListeners('notifyClick')）。
 *      授权状态用 getNotificationSettings 读，避免"每次都弹框"。
 *
 *   3. Web / H5 → window.Notification（原来的行为，向后兼容）
 *
 * 后端在 init 时探测一次，不可用时静默降级 —— 调用方永远只管发，不用关心平台。
 */
import { reactive } from 'vue'

export const sysNotifyState = reactive({
  /** 实际后端：electron / ios / web / none */
  backend: '',
  /** default | granted | denied | unsupported */
  permission: 'default',
  /** 最近一次失败原因（诊断用） */
  error: ''
})

/** 后端标识 → 展示名（设置面板用） */
export const NOTIFY_BACKEND_LABEL = {
  electron: '系统通知（桌面端原生）',
  ios: '系统通知（iOS 原生）',
  web: '浏览器通知',
  none: '不可用'
}

/** Electron preload 注入的桥 */
function electronNative() {
  if (typeof window === 'undefined') return null
  const b = window.__MONITOR_NATIVE__
  return b && typeof b.notify === 'function' ? b : null
}

/** Capacitor 本地插件 */
function capPlugin() {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null
  const p = cap.Plugins && cap.Plugins.MonitorExtras
  return p && typeof p.notify === 'function' ? p : null
}

/* ------------------------------------------------------------------ */
/* 探测与初始化                                                        */
/* ------------------------------------------------------------------ */

/** 探测一次平台能力，App 挂载后调用 */
export async function initSystemNotify() {
  if (electronNative()) {
    sysNotifyState.backend = 'electron'
    try {
      const p = await electronNative().notifyPermission()
      sysNotifyState.permission = p && p.granted ? 'granted' : p && p.supported === false ? 'unsupported' : 'default'
    } catch (e) {
      sysNotifyState.permission = 'granted' // 主进程通知默认可用
    }
    return sysNotifyState.backend
  }

  const ios = capPlugin()
  if (ios && typeof ios.notifyPermission === 'function') {
    sysNotifyState.backend = 'ios'
    try {
      const p = await ios.notifyPermission()
      sysNotifyState.permission = (p && p.status) || 'default'
    } catch (e) {
      sysNotifyState.permission = 'default'
    }
    return sysNotifyState.backend
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    sysNotifyState.backend = 'web'
    sysNotifyState.permission = Notification.permission || 'default'
  } else {
    sysNotifyState.backend = 'none'
    sysNotifyState.permission = 'unsupported'
  }
  return sysNotifyState.backend
}

/**
 * 申请通知权限（幂等）。
 * iOS：首次会弹系统授权框；Web：浏览器授权框；Electron：无需授权，直接 granted。
 * @returns {Promise<boolean>} 是否已授权
 */
export async function requestNotifyPermission() {
  const b = sysNotifyState.backend || (await initSystemNotify())

  if (b === 'electron') {
    sysNotifyState.permission = 'granted'
    return true
  }

  if (b === 'ios') {
    const p = capPlugin()
    try {
      const res = await p.requestNotifyPermission()
      sysNotifyState.permission = res && res.granted ? 'granted' : 'denied'
    } catch (e) {
      sysNotifyState.error = (e && e.message) || String(e)
      sysNotifyState.permission = 'denied'
    }
    return sysNotifyState.permission === 'granted'
  }

  if (b === 'web') {
    try {
      if (Notification.permission === 'default') {
        const r = await Notification.requestPermission()
        sysNotifyState.permission = r || Notification.permission
      } else {
        sysNotifyState.permission = Notification.permission
      }
    } catch (e) {
      /* 部分浏览器要求用户手势 */
    }
    return sysNotifyState.permission === 'granted'
  }

  sysNotifyState.permission = 'unsupported'
  return false
}

/**
 * 发一条系统通知。
 * @param {{title:string, body?:string, tag?:string, silent?:boolean, icon?:string,
 *          onclick?:Function}} opts
 * @returns {Promise<boolean>} 是否真的发出去了（用于调用方决定要不要走页面内提示兜底）
 */
export async function sendSystemNotify(opts) {
  const o = opts || {}
  const title = String(o.title || '').slice(0, 120)
  if (!title) return false

  const b = sysNotifyState.backend || (await initSystemNotify())

  if (b === 'electron' && sysNotifyState.permission === 'granted') {
    try {
      const r = await electronNative().notify({ title, body: o.body || '', tag: o.tag, silent: o.silent })
      return !!(r && r.supported)
    } catch (e) {
      sysNotifyState.error = (e && e.message) || String(e)
      return false
    }
  }

  if (b === 'ios' && sysNotifyState.permission === 'granted') {
    const p = capPlugin()
    try {
      await p.notify({ title, body: o.body || '', tag: o.tag, silent: o.silent })
      return true
    } catch (e) {
      sysNotifyState.error = (e && e.message) || String(e)
      return false
    }
  }

  if (b === 'web' && sysNotifyState.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body: o.body || '',
        tag: o.tag,
        icon: o.icon || undefined
      })
      if (typeof o.onclick === 'function') {
        n.onclick = () => {
          try {
            window.focus()
          } catch (e) {
            /* ignore */
          }
          o.onclick()
          n.close()
        }
      }
      return true
    } catch (e) {
      sysNotifyState.error = (e && e.message) || String(e)
      return false
    }
  }

  return false
}

/**
 * 订阅「点击系统通知」事件（Electron / iOS）。
 * Web 路径的点击在 sendSystemNotify 的 onclick 里就地处理，不走这里。
 * @param {(tag: string) => void} cb
 */
export function onSystemNotifyClick(cb) {
  if (typeof cb !== 'function') return
  const bridge = electronNative()
  if (bridge && typeof bridge.onNotifyClick === 'function') {
    bridge.onNotifyClick((tag) => cb(String(tag || '')))
    return
  }
  const p = capPlugin()
  if (p && typeof p.addListener === 'function') {
    try {
      p.addListener('notifyClick', (ev) => cb(String((ev && ev.tag) || '')))
    } catch (e) {
      /* 老版本插件没有这个事件，忽略 */
    }
  }
}

/** 给设置面板用的一句话状态 */
export function sysNotifySummary() {
  if (sysNotifyState.permission === 'granted') {
    return NOTIFY_BACKEND_LABEL[sysNotifyState.backend] || '可用'
  }
  if (sysNotifyState.permission === 'denied') return '⚠️ 已被拒绝（请到系统设置里手动允许）'
  if (sysNotifyState.permission === 'unsupported') return '当前环境不支持'
  return '尚未授权'
}
