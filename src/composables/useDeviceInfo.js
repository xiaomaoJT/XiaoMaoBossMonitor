/**
 * 运行设备信息
 * ----------------------------------------------------------------------------
 * 报警推送里要写清楚「这条是哪个端发出来的」，否则多端同时在线时
 * 收到消息根本分不清是谁在监控：
 *   - 网页端   → 要详细：页面地址、浏览器与版本、系统、屏幕分辨率
 *   - 手机 App → iOS App / Android App + 系统版本 + 设备型号
 *   - 桌面端   → macOS / Windows 桌面端 + 应用版本 + 系统版本
 *
 * 全部信息都是本地读取，不请求任何外部接口。
 */

/** 把 UA 里的系统版本号洗成人能读的形式 */
function systemText(ua) {
  let m = ua.match(/Windows NT ([\d.]+)/)
  if (m) {
    const map = { '10.0': 'Windows 10/11', '6.3': 'Windows 8.1', '6.2': 'Windows 8', '6.1': 'Windows 7' }
    return map[m[1]] || `Windows ${m[1]}`
  }
  // iPhone / iPad 的 UA 形如 `CPU iPhone OS 18_2 like Mac OS X`
  m = ua.match(/\(([^)]*?iPhone OS|CPU OS) ([\d_]+)/)
  if (m) return `iOS ${m[2].replace(/_/g, '.')}`
  m = ua.match(/Android ([\d.]+)/)
  if (m) return `Android ${m[1]}`
  m = ua.match(/Mac OS X ([\d_]+)/)
  if (m) return `macOS ${m[1].replace(/_/g, '.')}`
  if (/Linux/.test(ua)) return 'Linux'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  return '未知系统'
}

/** 浏览器名 + 主版本号（顺序有讲究：Edg / OPR 的 UA 里也含 Chrome） */
function browserText(ua) {
  let m = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/)
  if (m) return `Edge ${m[1].split('.')[0]}`
  m = ua.match(/(?:OPR|OPiOS)\/([\d.]+)/)
  if (m) return `Opera ${m[1].split('.')[0]}`
  m = ua.match(/Firefox\/([\d.]+)/)
  if (m) return `Firefox ${m[1].split('.')[0]}`
  // ⚠️ 必须排除 Electron：它的 UA 里同样带 Chrome/xxx
  if (!/Electron\//.test(ua)) {
    m = ua.match(/Chrome\/([\d.]+)/)
    if (m) return `Chrome ${m[1].split('.')[0]}`
  }
  m = ua.match(/Version\/([\d.]+).*Safari/)
  if (m) return `Safari ${m[1].split('.')[0]}`
  if (/Safari/.test(ua)) return 'Safari'
  return '未知浏览器'
}

/** Capacitor 原生壳的端（iOS / Android），非原生环境返回空串 */
function nativePlatform() {
  try {
    const cap = typeof window !== 'undefined' ? window.Capacitor : null
    if (cap && typeof cap.getPlatform === 'function') {
      const p = cap.getPlatform()
      if (p === 'ios' || p === 'android') return p
    }
  } catch (e) {
    /* 忽略 */
  }
  return ''
}

/**
 * 无浏览器环境（后端 Node 进程）的运行环境描述。
 *
 * 后端复用前端的推送代码，但它没有 navigator / window / screen，
 * 设备信息只能从 Node 自己的 os 模块取 —— 这样通过终端启动后端时，
 * 推送里的「运行设备」会显示成「后端服务 · Node 22 · Linux · 10.0.0.12」，
 * 而不是让 UA 解析兜底成「未知浏览器 · 未知系统」。
 *
 * os 模块是 Node 内置的；万一拿不到（极老的运行时）也不影响推送，静默降级即可。
 */
function serverRuntime(app, version) {
  const parts = []
  try {
    // 只用 process 上就有的字段，不 require('node:os')：
    // 本文件是 ESM（require 不存在），而且它同时被浏览器打包，静态引入 node 模块会直接构建失败。
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      parts.push(`Node ${process.versions.node.split('.')[0]}`)
      const p = process.platform
      const osName =
        p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p || ''
      if (osName) parts.push(osName)
      if (process.arch) parts.push(process.arch)
    }
  } catch (e) {
    /* 拿不到就只报一个笼统的服务端标识，不影响推送 */
  }
  const detail = parts.join(' · ')
  return {
    kind: 'server',
    label: '后端服务',
    detail,
    line: `后端服务${detail ? ` · ${detail}` : ''}`
  }
}

/**
 * 识别当前运行环境。
 * @param {object} [brand] 品牌信息，用于拼桌面端名称
 * @returns {{kind:string, label:string, detail:string, line:string}}
 */
export function detectRuntime(brand) {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  const app = (brand && brand.fullName) || 'BossMonitor'
  const version = (brand && brand.version) || ''

  /*
   * ⚠️ 后端（Node）没有 navigator / window / screen，ua 恒为空串，
   * 往下走会一路落到「未知浏览器 / 未知系统」。而通过终端 `npm run server`
   * 启动恰恰是最常见的部署方式，推送里却显示「未知浏览器 · 未知系统」，
   * 收信人根本判断不出消息来自哪台机器 —— 这里显式识别为「后端服务」。
   */
  if (!ua) return serverRuntime(app, version)

  const isElectron = /Electron\//.test(ua)
  const native = nativePlatform()
  const isIOS = native === 'ios' || /iPhone|iPad|iPod/.test(ua)
  const isAndroid = native === 'android' || /Android/.test(ua)

  let kind = 'web'
  let label = '网页端'
  const parts = []

  if (isElectron) {
    kind = 'desktop'
    // Electron 的 UA 里同样有 Macintosh / Windows，按系统区分
    const os = /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : 'Linux'
    label = `${os} 桌面端`
    const ev = ua.match(/Electron\/([\d.]+)/)
    parts.push(`${app}${version ? ` ${version}` : ''}`)
    if (ev) parts.push(`Electron ${ev[1].split('.')[0]}`)
    parts.push(systemText(ua))
  } else if (isIOS) {
    kind = 'ios'
    label = 'iOS App'
    parts.push('iPhone / iPad')
    parts.push(systemText(ua))
    if (!native) parts.push('浏览器访问')
  } else if (isAndroid) {
    kind = 'android'
    label = 'Android App'
    const m = ua.match(/Android [\d.]+;\s*([^)]+?)(?:\s+Build|\))/)
    if (m && m[1]) parts.push(m[1].trim())
    parts.push(systemText(ua))
    if (!native) parts.push('浏览器访问')
  } else {
    kind = 'web'
    label = '网页端'
    // 网页端要「详细」：浏览器、系统、地址、分辨率都给上
    parts.push(browserText(ua))
    parts.push(systemText(ua))
    try {
      if (typeof location !== 'undefined' && /^https?:/.test(location.protocol)) {
        parts.push(location.origin)
      }
    } catch (e) {
      /* 忽略 */
    }
    // PWA 独立窗口（已经从浏览器里"安装"出来了）
    try {
      const standalone =
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        (navigator.standalone === true)
      if (standalone) parts.push('已安装为应用')
    } catch (e) {
      /* 忽略 */
    }
  }

  try {
    if (typeof screen !== 'undefined' && screen.width && screen.height) {
      parts.push(`${screen.width}×${screen.height}`)
    }
  } catch (e) {
    /* 忽略 */
  }

  const detail = parts.filter(Boolean).join(' · ')
  return {
    kind,
    label,
    detail,
    /** 推送消息里直接用这一行 */
    line: `${label}${detail ? ` · ${detail}` : ''}`
  }
}

let cached = null

/** 带缓存的读取（设备信息在一次运行里不会变） */
export function runtimeInfo(brand) {
  if (!cached) cached = detectRuntime(brand)
  return cached
}

/** 推送消息里的「运行设备」一行 */
export function runtimeLine(brand) {
  return runtimeInfo(brand).line
}
