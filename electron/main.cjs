/**
 * Electron 主进程
 * ------------------------------------------------------------
 * 为什么不用 loadFile() 直接加载 dist/index.html？
 *   1. file:// 协议下浏览器禁止 fetch 本地文件，Jessibuca 的 decoder.wasm、
 *      ONNX Runtime 的 .wasm/.mjs、AI Worker 全部会加载失败；
 *   2. 钉钉开放接口不返回 CORS 响应头，浏览器直连必被拦截。
 * 所以这里注册了一个自定义协议 app://local（等价于一个"本地 HTTP 服务器"），
 * 由主进程负责：
 *   - 把 dist/ 目录当静态站点吐给渲染进程（WASM / Worker / fetch 全部正常）；
 *   - 把 /dingtalk-robot/** 反向代理到 https://oapi.dingtalk.com（绕过 CORS）；
 *   - 把 /wecom-bot/** 反向代理到 https://qyapi.weixin.qq.com（同一套逻辑）。
 * 渲染进程里所有代码保持原样，跟浏览器里跑起来完全一致。
 */
const {
  app,
  BrowserWindow,
  Menu,
  shell,
  protocol,
  net,
  session,
  ipcMain,
  powerSaveBlocker,
  Notification
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || ''
const isDev = !!DEV_SERVER_URL
/** 自检模式：加载完页面后跑一遍资源/协议/代理检查，然后退出 */
const SMOKE = !!process.env.MONITOR_SMOKE_TEST

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

const SCHEME = 'app'
const APP_HOST = 'local'
const APP_URL = `${SCHEME}://${APP_HOST}/index.html`

/** 与 vite.config.js 里的 server.proxy 前缀保持一致（两个地方必须同步改！） */
const UPSTREAM_PROXIES = [
  { prefix: '/dingtalk-robot', target: 'https://oapi.dingtalk.com' },
  { prefix: '/wecom-bot', target: 'https://qyapi.weixin.qq.com' }
]

/** 自定义协议必须在 app ready 之前登记 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true, // 有正常的 origin，localStorage / IndexedDB 才能用
      secure: true, // 视为安全上下文，WASM、WebGL、Worker 才不被限制
      supportFetchAPI: true,
      stream: true, // 支持 <video>/Range 之类的流式响应
      corsEnabled: true
    }
  }
])

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8'
}

async function respondFile(filePath) {
  const res = await net.fetch(pathToFileURL(filePath).toString())
  const forced = MIME[path.extname(filePath).toLowerCase()]
  if (!forced) return res
  const headers = new Headers(res.headers)
  headers.set('content-type', forced)
  // 关闭协商缓存，重新打包后不会拿到旧文件
  headers.set('cache-control', 'no-cache')
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  })
}

async function serveStatic(url) {
  let pathname = decodeURIComponent(url.pathname)
  if (!pathname || pathname === '/') pathname = '/index.html'

  const filePath = path.normalize(path.join(DIST, pathname))
  // 防目录穿越
  if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
    return new Response('Forbidden', { status: 403 })
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return respondFile(filePath)
  }

  // SPA 回退：只有「看起来不是文件」的路径才回 index.html，
  // 否则缺失的 js/wasm 会被换成 html，报出莫名其妙的语法错误
  if (path.extname(pathname)) {
    return new Response('Not Found: ' + pathname, { status: 404 })
  }
  const fallback = path.join(DIST, 'index.html')
  if (fs.existsSync(fallback)) return respondFile(fallback)
  return new Response('Not Found: ' + pathname, { status: 404 })
}

/* ------------------------------------------------------------------ */
/* 钉钉 / 企业微信反向代理（本地开发由 vite 代理，打包后由主进程代理）    */
/* ------------------------------------------------------------------ */

async function proxyUpstream(request, url, rule) {
  const target = rule.target + url.pathname.slice(rule.prefix.length) + url.search
  const headers = {}
  const ct = request.headers.get('content-type')
  if (ct) headers['content-type'] = ct

  const init = { method: request.method, headers }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = Buffer.from(await request.arrayBuffer())
  }

  try {
    const res = await net.fetch(target, init)
    const outHeaders = new Headers(res.headers)
    outHeaders.set('access-control-allow-origin', '*')
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders
    })
  } catch (e) {
    return new Response(
      JSON.stringify({ errcode: -1, errmsg: '主进程代理请求失败：' + (e && e.message) }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' } }
    )
  }
}

/* ------------------------------------------------------------------ */
/* 屏幕常亮（电源保护）                                                 */
/* ------------------------------------------------------------------ */
/*
 * 为什么不让渲染进程直接用 navigator.wakeLock？
 *   1. 它只在**页面可见**时有效 —— 大屏值守时人常把窗口最小化去干别的，
 *      那一刻唤醒锁会被 Chromium 自动释放，屏幕照样睡；
 *   2. powerSaveBlocker 是**进程级**的，主进程说"别让显示器睡"就一直生效。
 * 所以桌面端统一走主进程，前端通过 __MONITOR_NATIVE__.keepAwake 这一个口子控制。
 *
 * 'prevent-display-sleep' = 连显示器一起保持点亮（对应我们「屏幕常亮」的语义）；
 * 另一个档位 'prevent-app-suspension' 只阻止睡眠、不阻止息屏，不是我们要的。
 */
let sleepBlockerId = null

function applyKeepAwake(on) {
  if (on) {
    if (sleepBlockerId === null && powerSaveBlocker) {
      sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep')
    }
  } else if (sleepBlockerId !== null && powerSaveBlocker) {
    if (powerSaveBlocker.isStarted(sleepBlockerId)) powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = null
  }
  return keepAwakeStatus()
}

function keepAwakeStatus() {
  const running =
    sleepBlockerId !== null && !!powerSaveBlocker && powerSaveBlocker.isStarted(sleepBlockerId)
  return {
    running,
    /** 系统是否支持电源保护（个别 Linux 环境没有） */
    supported: !!powerSaveBlocker
  }
}

function registerKeepAwakeIpc() {
  ipcMain.handle('monitor:keep-awake', (_e, on) => {
    try {
      return applyKeepAwake(!!on).running
    } catch (e) {
      console.log('[KEEPAWAKE] failed ' + (e && e.message))
      return false
    }
  })
  ipcMain.handle('monitor:keep-awake-status', () => {
    try {
      return keepAwakeStatus()
    } catch (e) {
      return { running: false, supported: false }
    }
  })
}

/* ------------------------------------------------------------------ */
/* 系统通知（原生）                                                     */
/* ------------------------------------------------------------------ */
/*
 * 为什么不让渲染进程直接 new Notification()？
 *   Chromium 里 Web Notification 在 Electron 是可用的（我们已放行权限），
 *   但它有两大硬伤：
 *     1. 点击通知只能 window.focus()，窗口最小化到托盘 / 别的 Space 时唤不回来；
 *     2. macOS 上依赖渲染进程存活，长时间值守 + 系统休眠后回调链路不可靠。
 *   走主进程 Notification 模块：点击事件在主进程里直接 show()/focus() 窗口，
 *   再把 tag 回传给渲染进程做「定位到对应画面」，链路短且稳。
 */
function registerNotifyIpc() {
  if (!ipcMain) return
  ipcMain.handle('monitor:notify', (_e, payload) => {
    try {
      const p = payload || {}
      if (!Notification.isSupported()) return { supported: false }
      const n = new Notification({
        title: String(p.title || 'BossMonitor').slice(0, 120),
        body: String(p.body || '').slice(0, 400),
        silent: !!p.silent
      })
      n.on('click', () => {
        // 点击通知：把窗口拉回前台，再把 tag 发给页面做定位
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
        try {
          mainWindow && mainWindow.webContents.send('monitor:notify-click', String(p.tag || ''))
        } catch (e) {
          /* 窗口正在销毁时忽略 */
        }
      })
      n.show()
      return { supported: true }
    } catch (e) {
      console.log('[NOTIFY] failed ' + (e && e.message))
      return { supported: false, error: e && e.message }
    }
  })
  ipcMain.handle('monitor:notify-permission', () => ({
    supported: !!Notification.isSupported(),
    // 桌面端主进程通知没有「用户授权」这一步，视为已授权
    granted: !!Notification.isSupported()
  }))

  /**
   * 强制终结：先走正常 quit（关窗口、触发 before-quit），
   * 1.2s 后还没退出去（有东西卡住了 before-quit / will-quit）就 app.exit(0) 硬退。
   * 用户要求「终结后不得在后台运行任何任务」，所以必须有这道兜底。
   */
  ipcMain.handle('monitor:quit', () => {
    try {
      app.quit()
      setTimeout(() => {
        try {
          app.exit(0)
        } catch (e) {
          /* 进程都要没了，忽略 */
        }
      }, 1200)
      return true
    } catch (e) {
      return false
    }
  })

  /**
   * 重启整个桌面端：先 app.relaunch() 登记「退出后重启」，再 quit。
   * 1.2s 兜底 app.exit(0) 保证一定重启（与 monitor:quit 同款保险）。
   * ⚠️ 后端若是独立 node 进程（非主进程托管），它的重启由后端自身负责，
   * 这里只重启桌面端 GUI。
   */
  ipcMain.handle('monitor:restart', () => {
    try {
      try {
        app.relaunch()
      } catch (e) {
        /* 某些平台 relaunch 可能抛，忽略后走 exit 兜底 */
      }
      app.quit()
      setTimeout(() => {
        try {
          app.exit(0)
        } catch (e) {
          /* 进程都要没了，忽略 */
        }
      }, 1200)
      return true
    } catch (e) {
      return false
    }
  })
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#07090f',
    title: 'BossMonitor',
    show: !SMOKE,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 窗口在后台时不要降频，否则检测会掉帧
      webSecurity: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!SMOKE) mainWindow.show()
  })

  // 外链一律用系统浏览器打开，不在应用内跳走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const okDev = isDev && url.startsWith(DEV_SERVER_URL)
    const okApp = url.startsWith(`${SCHEME}://`)
    if (!okDev && !okApp) {
      e.preventDefault()
      if (/^https?:/.test(url)) shell.openExternal(url)
    }
  })

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadURL(APP_URL)
  }

  if (SMOKE) runSmokeTest(mainWindow)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * 自检：确认 app:// 协议能正确提供 dist 资源（WASM / Worker 都靠它）、
 * 钉钉代理链路通、页面无 JS 报错。
 * 用法：npm run electron:smoke
 */
async function runSmokeTest(win) {
  const errors = []
  win.webContents.on('console-message', (...args) => {
    const ev = args[0]
    let level
    let message
    let sourceId
    let line
    if (ev && typeof ev === 'object' && 'message' in ev) {
      level = ev.level
      message = ev.message
      sourceId = ev.sourceId
      line = ev.lineNumber
    } else {
      level = args[1]
      message = args[2]
      line = args[3]
      sourceId = args[4]
    }
    const isErr = level === 'error' || level === 3
    if (isErr) errors.push(`${message} @ ${sourceId}:${line}`)
  })
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[SMOKE] renderer-gone ' + JSON.stringify(d))
  })

  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  await wait(5000)

  try {
    const page = await win.webContents.executeJavaScript(
      `JSON.stringify({
        url: location.href,
        ready: document.readyState,
        tiles: document.querySelectorAll('.tile').length,
        topbar: !!document.querySelector('.topbar'),
        jessibuca: typeof window.Jessibuca,
        shell: window.__MONITOR_SHELL__ ? window.__MONITOR_SHELL__.runtime : null,
        storage: (() => { try { localStorage.setItem('__t','1'); localStorage.removeItem('__t'); return 'ok' } catch (e) { return String(e) } })()
      })`
    )
    console.log('[SMOKE] page ' + page)

    const wasm = await win.webContents.executeJavaScript(
      `fetch('js/decoder.wasm', { method: 'HEAD' })
         .then(r => 'decoder.wasm -> ' + r.status + ' ' + (r.headers.get('content-type')||''))
         .catch(e => 'decoder.wasm FAIL ' + e.message)`
    )
    console.log('[SMOKE] ' + wasm)

    const worker = await win.webContents.executeJavaScript(
      `new Promise((res) => {
         try {
           const w = new Worker(new URL('assets/aiWorker-___NOPE___.js', location.href))
           w.onerror = () => res('worker bad-path -> error event (expected)')
         } catch (e) { res('worker construct -> ' + e.message) }
         setTimeout(() => res('worker -> no crash'), 800)
       })`
    )
    console.log('[SMOKE] ' + worker)

    const proxy = await win.webContents.executeJavaScript(
      `fetch('/dingtalk-robot/robot/send?access_token=invalid', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ msgtype: 'text', text: { content: 'ping' } })
       }).then(r => r.text()).then(t => 'dingtalk-proxy -> ' + t.slice(0, 140))
         .catch(e => 'dingtalk-proxy FAIL ' + e.message)`
    )
    console.log('[SMOKE] ' + proxy)

    // 企业微信同样的代理链路（用无效 key，只验证代理转发真的打到了官方接口）
    const wecomProxy = await win.webContents.executeJavaScript(
      `fetch('/wecom-bot/cgi-bin/webhook/send?key=invalid', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ msgtype: 'text', text: { content: 'ping' } })
       }).then(r => r.text()).then(t => 'wecom-proxy -> ' + t.slice(0, 140))
         .catch(e => 'wecom-proxy FAIL ' + e.message)`
    )
    console.log('[SMOKE] ' + wecomProxy)

    // Telegram 是渲染进程直连（不走主进程代理），单独探一次：
    // 挂住 / 被 CORS 拦 / 通，三种结果在日志里能直接区分。
    const tgProbe = await win.webContents.executeJavaScript(
      `Promise.race([
         fetch('https://api.telegram.org/bot123456:invalid/getMe')
           .then(r => 'telegram -> http ' + r.status)
           .catch(e => 'telegram -> FAIL ' + (e && e.message)),
         new Promise(res => setTimeout(() => res('telegram -> TIMEOUT 12s（请求挂住，未返回）'), 12000))
       ])`
    )
    console.log('[SMOKE] ' + tgProbe)

    const hostProbe = await win.webContents.executeJavaScript(
      `Promise.race([
         fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'HEAD' })
           .then(r => 'litterbox -> http ' + r.status)
           .catch(e => 'litterbox -> FAIL ' + (e && e.message)),
         new Promise(res => setTimeout(() => res('litterbox -> TIMEOUT 12s（请求挂住，未返回）'), 12000))
       ])`
    )
    console.log('[SMOKE] ' + hostProbe)

    // 屏幕常亮 IPC：验证 preload 桥 + 主进程 powerSaveBlocker 链路
    const keepAwake = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__MONITOR_NATIVE__ || typeof window.__MONITOR_NATIVE__.keepAwake !== 'function') {
           return 'no __MONITOR_NATIVE__ bridge'
         }
         const on = await window.__MONITOR_NATIVE__.keepAwake(true)
         const status = await window.__MONITOR_NATIVE__.keepAwakeStatus()
         const off = await window.__MONITOR_NATIVE__.keepAwake(false)
         return JSON.stringify({ on, status, off })
       })()`
    )
    console.log('[SMOKE] keepAwake ' + keepAwake)

    // 系统通知 IPC：验证 preload 桥 + 主进程 Notification 链路（不真发，只探测能力）
    const notify = await win.webContents.executeJavaScript(
      `(async () => {
         if (!window.__MONITOR_NATIVE__ || typeof window.__MONITOR_NATIVE__.notify !== 'function') {
           return 'no notify bridge'
         }
         const perm = await window.__MONITOR_NATIVE__.notifyPermission()
         const sent = await window.__MONITOR_NATIVE__.notify({
           title: 'BossMonitor 自检', body: '这是一条 smoke 测试通知'
         })
         return JSON.stringify({ perm, sent })
       })()`
    )
    console.log('[SMOKE] notify ' + notify)

    // 当前配置快照：只看「有没有配、开关是开还是关」，不打印密钥本身
    const cfgSnap = await win.webContents.executeJavaScript(
      `(() => {
         try {
           const raw = localStorage.getItem('monitor-wall-config-v1') || ''
           if (!raw) return 'no saved config'
           const parsed = JSON.parse(raw)
           const o = (parsed && parsed.options) || {}
           const d = o.dingtalk || {}
           const w = o.wecom || {}
           const t = o.telegram || {}
           const brief = (v) => (v ? String(v).length + '字符' : '空')
           return JSON.stringify({
             dingtalk: {
               enabled: d.enabled,
               webhook: brief(d.webhook),
               useProxy: d.useProxy,
               screenshotMode: d.screenshotMode,
               cameras: Array.isArray(d.cameras) ? d.cameras.length : 0
             },
             wecom: {
               enabled: w.enabled,
               webhook: brief(w.webhook),
               screenshotMode: w.screenshotMode,
               cameras: Array.isArray(w.cameras) ? w.cameras.length : 0
             },
             telegram: {
               enabled: t.enabled,
               token: brief(t.token),
               chatId: t.chatId,
               withPhoto: t.withPhoto,
               sendMode: t.sendMode,
               cameras: Array.isArray(t.cameras) ? t.cameras.length : 0
             }
           })
         } catch (e) { return 'cfg-snapshot FAIL ' + e.message }
       })()`
    )
    console.log('[SMOKE] cfg ' + cfgSnap)

    const idbSnap = await win.webContents.executeJavaScript(
      `new Promise((resolve) => {
         const fail = (m) => resolve('idb ' + m)
         let q
         try { q = indexedDB.open('monitor-wall-db') } catch (e) { return fail('open threw ' + e.message) }
         q.onerror = () => fail('open error')
         q.onsuccess = () => {
           const db = q.result
           if (!db.objectStoreNames.contains('events')) return fail('no events store')
           const all = db.transaction('events', 'readonly').objectStore('events').getAll()
           all.onerror = () => fail('getAll error')
           all.onsuccess = () => {
             const list = all.result || []
             const counts = {}
             list.forEach((e) => { const k = e.push || 'none'; counts[k] = (counts[k] || 0) + 1 })
             const recent = list
               .slice()
               .sort((a, b) => (b.time || 0) - (a.time || 0))
               .slice(0, 4)
               .map((e) => {
                 const o = { ...e }
                 ;['shot', 'thumb'].forEach((k) => {
                   if (o[k]) o[k] = '<' + k + ' ' + String(o[k]).length + 'B>'
                 })
                 return o
               })
             resolve(JSON.stringify({ total: list.length, counts, recent }))
           }
         }
       })`
    )
    console.log('[SMOKE] idb ' + idbSnap)

    // 上传测速：验证「大图 multipart 上传」这条链路。
    // 用法：MONITOR_PROBE_TG="<token>|<chat_id>" ，chat_id 故意用无效值，
    // 只测上传速度与是否挂住，不会真的发到群里。
    const probe = process.env.MONITOR_PROBE_TG || ''
    if (probe) {
      const [tk] = probe.split('|')
      const probeJs = `(async () => {
        const bytes = new Uint8Array(2 * 1024 * 1024)
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        const form = new FormData()
        form.append('chat_id', '1')
        form.append('document', blob, 'probe.jpg')
        const t0 = performance.now()
        try {
          const res = await fetch('https://api.telegram.org/bot' + ${JSON.stringify(tk)} + '/sendDocument', {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(60000)
          })
          const txt = (await res.text()).slice(0, 90)
          return 'tg-upload -> http ' + res.status + ' in ' + Math.round(performance.now() - t0) + 'ms | ' + txt
        } catch (e) {
          return 'tg-upload -> FAIL after ' + Math.round(performance.now() - t0) + 'ms | ' + (e && e.message)
        }
      })()`
      const up = await win.webContents.executeJavaScript(probeJs)
      console.log('[SMOKE] ' + up)
    }
  } catch (e) {
    console.log('[SMOKE] exception ' + e.message)
  }

  console.log('[SMOKE] consoleErrors ' + JSON.stringify(errors.slice(0, 8)))
  console.log('[SMOKE] DONE')
  app.exit(0)
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: '关于 BossMonitor' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '显示全部' },
              { type: 'separator' },
              { role: 'quit', label: '退出' }
            ]
          }
        ]
      : []),
    {
      label: '画面',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        {
          label: '全屏切换',
          accelerator: 'Ctrl+Cmd+F',
          click: () => mainWindow && mainWindow.setFullScreen(!mainWindow.isFullScreen())
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

// 单实例：重复打开时聚焦已有窗口
if (!app.getSingleInstanceLock || app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
} else {
  app.quit()
}

// 允许网页直接自动播放（否则多路监控必须手动点播放）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 受限环境（容器 / 无桌面会话 / 无头自检）里 Chromium 沙箱起不来，
// 用 MONITOR_NO_SANDBOX=1 打开兜底开关；正常桌面环境不要设置。
if (process.env.MONITOR_NO_SANDBOX || SMOKE) {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}

app.whenReady().then(() => {
  // 桌面通知权限：Electron 里默认需要显式放行
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission))
  })

  registerKeepAwakeIpc()
  registerNotifyIpc()

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const rule = UPSTREAM_PROXIES.find((r) => url.pathname.startsWith(r.prefix))
    if (rule) return proxyUpstream(request, url, rule)
    return serveStatic(url)
  })

  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 退出前一定要停掉电源保护，否则在个别系统上会残留「显示器不许睡」的持有
  applyKeepAwake(false)
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  applyKeepAwake(false)
})
