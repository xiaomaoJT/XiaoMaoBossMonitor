/**
 * 屏幕常亮（三端统一开关）
 * ============================================================================
 * 场景：监控大屏大多是**长时间挂着值守**的 —— 挂墙上的 iPad、工位副屏、
 *       Mac 外接显示器。系统默认「几分钟无操作就息屏」会直接把画面黑掉，
 *       而值守时人本来就不会去碰键鼠，所以这个开关几乎是大屏的刚需。
 *
 * 三条落地路径，按「可靠程度」自动挑选：
 *
 *   1. Electron 桌面端（macOS / Windows）
 *      → 走 preload 暴露的 IPC，让主进程调 powerSaveBlocker.start('prevent-display-sleep')。
 *        这是唯一**不受页面可见性影响**的方案：窗口最小化、切到别的 Space、
 *        人离开工位，屏幕都不会睡。渲染进程的唤醒锁做不到这一点。
 *
 *   2. iOS 原生壳（Capacitor）
 *      → 走本地原生插件 MonitorExtras.setKeepAwake，底层是 UIApplication.isIdleTimerDisabled。
 *        WKWebView 里的 navigator.wakeLock 在 iOS 上并不可靠（切后台即失效、
 *        部分系统版本压根没实现），所以原生壳必须落到原生实现。
 *
 *   3. Web / H5（浏览器直接打开）
 *      → navigator.wakeLock.request('screen')。
 *        ⚠️ 浏览器会在页面隐藏时**强制释放**这条锁（规范如此，防滥用）。
 *        因此必须监听 visibilitychange，回到前台时重新申请 ——
 *        少了这一步，用户切一次标签页，常亮就永久失效了，而且悄无声息。
 *
 * 失败不抛错：所有异常都收进 wakeLockState.error，由设置面板展示。
 */
import { reactive } from 'vue'

/** 后端标识 → 展示名（设置面板 / 关于系统用） */
export const BACKEND_LABEL = {
  electron: '桌面端电源保护',
  native: 'iOS 原生常亮',
  web: '浏览器唤醒锁',
  '': '未生效'
}

export const wakeLockState = reactive({
  /** 当前**真的**处于常亮状态吗（申请成功才算，不是「用户想开」） */
  active: false,
  /** 生效的后端：electron / native / web / 空串 */
  backend: '',
  /** 本平台是否具备常亮能力。null = 还没探测过 */
  supported: null,
  /** 最近一次失败原因，成功时清空 */
  error: ''
})

/** 用户意图：由 options.keepAwake 驱动。页面恢复可见时要靠它决定是否重申请 */
let want = false
/** 浏览器唤醒锁的 sentinel */
let sentinel = null
/** 原生插件句柄缓存（探到就复用，避免每次调用都去翻 Capacitor 代理） */
let nativePlugin = null
/** 事件是否已绑（幂等保护，多次 init 不会重复绑） */
let wired = false
/** 防止 release 后的重试风暴 */
let retryTimer = null

/* ------------------------------------------------------------------ */
/* 各后端探测与开关                                                    */
/* ------------------------------------------------------------------ */

/** Electron：preload 注入的受控 IPC 桥 */
function electronBridge() {
  if (typeof window === 'undefined') return null
  const b = window.__MONITOR_NATIVE__
  return b && typeof b.keepAwake === 'function' ? b : null
}

/** Capacitor 原生壳里的本地插件 */
function capPlugin() {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null
  if (nativePlugin) return nativePlugin
  const p = cap.Plugins && cap.Plugins.MonitorExtras
  // Capacitor 的 Plugins 是 Proxy，未注册插件也会返回一个「壳」对象，
  // 所以这里不能用 typeof 判断是否存在，只能先认下来、调用时靠 try/catch 兜底。
  nativePlugin = p || null
  return nativePlugin
}

function canUseWebLock() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/** 探测本平台有哪条路可走，结果写进 state.supported */
function detect() {
  if (electronBridge()) return 'electron'
  if (capPlugin()) return 'native'
  if (canUseWebLock()) return 'web'
  return ''
}

async function applyElectron(on) {
  const bridge = electronBridge()
  if (!bridge) return false
  const res = await bridge.keepAwake(!!on)
  // 主进程回 true 表示 powerSaveBlocker 正在跑
  if (on) return res === true || res === undefined
  return true
}

async function applyNative(on) {
  const p = capPlugin()
  if (!p || typeof p.setKeepAwake !== 'function') return false
  await p.setKeepAwake({ enabled: !!on })
  return true
}

async function applyWeb(on) {
  if (!canUseWebLock()) return false

  if (!on) {
    if (sentinel) {
      const s = sentinel
      sentinel = null
      try {
        await s.release()
      } catch (e) {
        /* 已经自动释放了，忽略 */
      }
    }
    return true
  }

  // 页面不可见时浏览器会直接拒绝申请，等 visibilitychange 再补
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false

  try {
    const s = await navigator.wakeLock.request('screen')
    // 浏览器随时可能单方面释放（切后台 / 电量策略），必须挂 release
    s.addEventListener('release', () => {
      if (sentinel === s) sentinel = null
      wakeLockState.active = false
      wakeLockState.backend = ''
      // 如果是系统策略释放、而用户仍想常亮且页面可见 → 稍后重试一次
      if (want && typeof document !== 'undefined' && document.visibilityState === 'visible') {
        clearTimeout(retryTimer)
        retryTimer = setTimeout(() => {
          if (want) void applyWakeLock(true, { silent: true })
        }, 1500)
      }
    })
    sentinel = s
    return true
  } catch (e) {
    wakeLockState.error = (e && e.message) || String(e)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 应用常亮状态。
 * @param {boolean} on 用户想要的状态（对应 options.keepAwake）
 * @param {{silent?: boolean}} opts silent = 自动重试，失败不写 error 覆盖用户可见的提示
 */
export async function applyWakeLock(on, opts = {}) {
  want = !!on

  // 关：三条路都走一遍释放（哪条生效过就释哪条，多余的调用无害）
  if (!want) {
    clearTimeout(retryTimer)
    retryTimer = null
    let ok = false
    try {
      if (sentinel) ok = (await applyWeb(false)) || ok
      if (electronBridge()) ok = (await applyElectron(false)) || ok
      if (capPlugin()) ok = (await applyNative(false)) || ok
    } catch (e) {
      if (!opts.silent) wakeLockState.error = (e && e.message) || String(e)
    }
    wakeLockState.active = false
    wakeLockState.backend = ''
    return wakeLockState.active
  }

  const kind = detect()
  wakeLockState.supported = !!kind

  if (!kind) {
    wakeLockState.active = false
    wakeLockState.backend = ''
    if (!opts.silent) wakeLockState.error = '当前环境不支持屏幕常亮（建议用桌面端或 iOS App）'
    return false
  }

  let ok = false
  try {
    if (kind === 'electron') ok = await applyElectron(true)
    else if (kind === 'native') ok = await applyNative(true)
    else ok = await applyWeb(true)
  } catch (e) {
    if (!opts.silent) wakeLockState.error = (e && e.message) || String(e)
    ok = false
  }

  wakeLockState.active = !!ok
  wakeLockState.backend = ok ? kind : ''
  // web 路径在页面隐藏时返回 false 属于「正常待命」，不该报错
  if (ok) wakeLockState.error = ''
  else if (kind !== 'web' && !opts.silent) {
    wakeLockState.error = `申请失败（${BACKEND_LABEL[kind]}）`
  }
  return wakeLockState.active
}

/** 事件线：页面可见性 + 原生壳前后台切换 */
function onVisibility() {
  if (!want) return
  if (document.visibilityState === 'visible') {
    // 回到前台：浏览器一定把旧锁释放掉了，重新申请
    void applyWakeLock(true, { silent: true })
  }
}

/** Capacitor 的 appStateChange 在 iOS 上比 visibilitychange 更早更准 */
function onNativeStateChange(st) {
  if (!st || typeof st.isActive !== 'boolean') return
  if (!want) return
  if (st.isActive) void applyWakeLock(true, { silent: true })
}

/** 绑定事件（幂等）。App.vue 挂载后调一次即可 */
export function initWakeLock() {
  if (wired || typeof document === 'undefined') return
  wired = true
  document.addEventListener('visibilitychange', onVisibility)
  // iOS 原生壳：Capacitor 的 app state 事件在「从后台回前台」时更可靠
  const cap = typeof window !== 'undefined' ? window.Capacitor : null
  if (cap && cap.Plugins && cap.Plugins.App && typeof cap.Plugins.App.addListener === 'function') {
    try {
      cap.Plugins.App.addListener('appStateChange', onNativeStateChange)
    } catch (e) {
      /* 老版本没有这个插件，忽略 */
    }
  }
}

/** 卸载时释放（页面销毁 / 组件卸载） */
export async function dropWakeLock() {
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility)
  }
  wired = false
  clearTimeout(retryTimer)
  retryTimer = null
  const bridge = electronBridge()
  if (bridge) {
    try {
      await bridge.keepAwake(false)
    } catch (e) {
      /* 窗口都要关了，失败无所谓 */
    }
  }
  if (sentinel) {
    const s = sentinel
    sentinel = null
    try {
      await s.release()
    } catch (e) {
      /* ignore */
    }
  }
  // 原生壳不退到后台就一直是 active，这里主动关掉避免「用户在设置里关了但屏幕还亮着」
  const p = capPlugin()
  if (p && typeof p.setKeepAwake === 'function') {
    try {
      await p.setKeepAwake({ enabled: false })
    } catch (e) {
      /* ignore */
    }
  }
  want = false
  wakeLockState.active = false
  wakeLockState.backend = ''
}

/** 给设置面板用的一句话状态描述 */
export function wakeLockSummary() {
  if (wakeLockState.active) return `已生效 · ${BACKEND_LABEL[wakeLockState.backend] || '未知后端'}`
  if (wakeLockState.supported === false) return '当前环境不支持'
  if (!want) return '已关闭'
  return '待命（页面回到前台后自动生效）'
}
