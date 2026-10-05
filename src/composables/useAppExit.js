/**
 * 强制终结 App（三端统一）
 * ============================================================================
 * 用户需求：配置方案里给一个「强制终结」按钮 —— 点下去应用立即退出，
 *          **不得在后台运行任何任务**。
 *
 * 三条落地路径，按平台自动挑选：
 *
 *   1. iOS 原生壳（Capacitor）
 *      → MonitorExtras.exitApp()，原生层把通知/常亮清干净后 exit(0)。
 *        exit(0) 直接杀进程：WKWebView、解码器、WebSocket、推送、常亮锁
 *        全部随之消失 —— 这是唯一能保证「后台什么都不剩」的办法。
 *        （Apple 不鼓励程序化退出，但「一键彻底停止」在自用值守工具里是刚需。）
 *
 *   2. Electron 桌面端
 *      → 主进程 app.quit()，并兜底 app.exit(0)。
 *        quit() 会正常走窗口关闭流程；万一有东西卡住 quit，
 *        1.2s 后的 exit(0) 强制结束，保证一定退得掉。
 *
 *   3. Web / H5（浏览器）
 *      → 浏览器**不允许**脚本关闭不是脚本自己打开的标签页（安全策略），
 *        所以只能尽力 window.close()，失败就挂一层全屏遮罩明确告知
 *        「已停止全部任务，请手动关闭标签页」—— 绝不能假装退干净了。
 *
 * 无论哪条路，退出前都会先执行调用方传入的 cleanup：
 * 停播放器、停检测、清推送队列、释放常亮锁、落盘配置。
 */
import { reactive } from 'vue'

/** 后端标识 → 展示名 */
export const EXIT_BACKEND_LABEL = {
  native: 'iOS 原生',
  electron: '桌面端',
  web: '浏览器页面',
  '': '未知'
}

export const exitState = reactive({
  /** idle = 没动过；running = 清理并退出中；done = 已尽力终止（web 遮罩显示用） */
  phase: 'idle',
  backend: '',
  message: ''
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Electron：preload 注入的受控 IPC 桥 */
function electronBridge() {
  if (typeof window === 'undefined') return null
  const b = window.__MONITOR_NATIVE__
  return b && typeof b.quitApp === 'function' ? b : null
}

/** Capacitor 原生壳里的本地插件（Plugins 是 Proxy，只能靠调用时 try/catch 兜底） */
function capPlugin() {
  if (typeof window === 'undefined') return null
  const cap = window.Capacitor
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null
  const p = cap.Plugins && cap.Plugins.MonitorExtras
  return p && typeof p.exitApp === 'function' ? p : null
}

/** 当前平台能走哪条退出路径 */
export function detectExitBackend() {
  if (typeof window === 'undefined') return 'web'
  if (electronBridge()) return 'electron'
  if (capPlugin()) return 'native'
  return 'web'
}

/**
 * 停掉一切并退出。
 * @param {{cleanup?: () => Promise<void>|void}} opts cleanup 在退出前执行，失败不阻断退出
 */
export async function exitAppNow(opts = {}) {
  if (exitState.phase === 'running') return
  exitState.phase = 'running'
  exitState.backend = detectExitBackend()
  exitState.message = ''

  // 1) 先把正在跑的东西全部停掉（播放 / 检测 / 推送队列 / 定时器 / 常亮 / 落盘）
  try {
    if (opts.cleanup) await opts.cleanup()
  } catch (e) {
    /* 退出路径上尽力而为，不能因为清理失败就不退了 */
  }

  // 2) 按平台退出
  if (exitState.backend === 'electron') {
    try {
      await Promise.race([electronBridge().quitApp(), sleep(1500)])
    } catch (e) {
      /* 同上 */
    }
    // 正常情况下主进程已经退出，进程没了；还能执行到这里说明没退掉
    exitState.phase = 'done'
    exitState.message = '桌面端未能自动退出，请手动关闭窗口'
    return
  }

  if (exitState.backend === 'native') {
    try {
      // exit(0) 会直接杀进程，这个 Promise 永远不会 resolve；
      // 能等到结果（或超时）都说明没退成，走提示。
      await Promise.race([capPlugin().exitApp(), sleep(2500)])
    } catch (e) {
      /* ignore */
    }
    exitState.phase = 'done'
    exitState.message = 'iOS 端未能自动退出，请手动上滑关闭 App'
    return
  }

  // 3) Web：能关就关，关不掉就明确告知
  try {
    window.close()
  } catch (e) {
    /* ignore */
  }
  await sleep(400)
  exitState.phase = 'done'
  exitState.message = window.closed
    ? '页面已关闭'
    : '已停止全部任务。浏览器不允许脚本关闭非脚本打开的页面，请手动关闭这个标签页'
}
