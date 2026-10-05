/**
 * BossMonitor 便携版本地服务
 * ----------------------------------------------------------------------------
 * 为什么需要它：打包产物**没法双击 index.html 直接打开** ——
 * Vite 会给入口脚本打上 `crossorigin`，浏览器把 file:// 视为 origin 'null'，
 * 于是 module script / CSS / fetch / Worker 全部被 CORS 拦掉，页面直接白屏。
 * 而且即使绕过 CORS，`fetch()` 读本地文件在 file:// 下也是被禁止的，
 * 108MB 的 ONNX 模型、ORT 的 wasm、播放器的 decoder.wasm 一个都加载不了。
 *
 * 所以这里起一个**零依赖**的本地静态服务（只用 Node 内置模块），
 * 双击启动脚本即可，功能和 `npm run dev` 完全一致。
 *
 * ⚠️ 两个代理前缀必须与 `vite.config.js` 的 server.proxy、以及
 *    `electron/main.cjs` 保持一致 —— 不一致的话某个渠道会静默失效
 *    （钉钉 / 企微开放接口没有 CORS 响应头，浏览器直连必被拦）。
 *
 * 用法：
 *   node serve-static.mjs                 # 服务默认目录，不开浏览器
 *   node serve-static.mjs --open          # 起服务并自动打开浏览器
 *   node serve-static.mjs --root=dist --port=9000
 *   node serve-static.mjs --host=0.0.0.0  # 允许局域网访问（手机上看大屏）
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/* ==================== 参数 ==================== */

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

/**
 * 要服务的目录。
 * 便携版里 serve-static.mjs 和 index.html 是同一个目录，直接用它；
 * 在仓库里跑（scripts/ 下）时，默认指向构建产物 dist。
 */
function pickRoot() {
  const custom = argValue('root')
  if (custom) return path.resolve(HERE, custom)
  if (fs.existsSync(path.join(HERE, 'index.html'))) return HERE
  const dist = path.resolve(HERE, '..', 'dist')
  if (fs.existsSync(path.join(dist, 'index.html'))) return dist
  return HERE
}

const ROOT = pickRoot()
const HOST = argValue('host') || '127.0.0.1'
const PORT_START = Math.max(1, Number(argValue('port')) || 8800)
const OPEN = hasFlag('open')
const LAN = HOST !== '127.0.0.1' && HOST !== 'localhost'

/* ==================== 反代（绕 CORS） ==================== */

const PROXY_RULES = [
  { prefix: '/dingtalk-robot', host: 'oapi.dingtalk.com', port: 443 },
  { prefix: '/wecom-bot', host: 'qyapi.weixin.qq.com', port: 443 }
]

function handleProxy(req, res, rule) {
  const targetPath = req.url.slice(rule.prefix.length) || '/'
  const headers = { ...req.headers, host: rule.host }
  // 让上游返回未压缩内容：省掉手动解 gzip，也避免 length 对不上
  headers['accept-encoding'] = 'identity'
  delete headers.connection

  const up = https.request(
    { hostname: rule.host, port: rule.port, path: targetPath, method: req.method, headers },
    (pr) => {
      res.writeHead(pr.statusCode || 502, { ...pr.headers, 'access-control-allow-origin': '*' })
      pr.pipe(res)
    }
  )
  up.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    res.end(`代理请求失败：${e.message}`)
  })
  // 超时兜底：上游黑洞时不要让连接永远挂着
  up.setTimeout(20000, () => up.destroy(new Error('上游 20 秒未响应')))
  req.pipe(up)
}

/* ==================== 静态文件 ==================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
}

function sendFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (e) {
    return false
  }
  if (!stat.isFile()) return false

  const headers = {
    'content-type': type,
    'content-length': stat.size,
    // 便携版是本地文件，缓存只会让人改了配置看不到效果；大文件靠磁盘速度足够
    'cache-control': 'no-cache',
    // ⚠️ 不要加 COOP/COEP：加了之后跨域资源需要 CORP 头，
    //    Telegram 的图片上传会直接被拦，推送反而挂掉。
    'access-control-allow-origin': '*'
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(filePath)
    .on('error', () => res.end())
    .pipe(res)
  return true
}

function serveStatic(req, res) {
  const raw = (req.url || '/').split('?')[0].split('#')[0]
  let urlPath
  try {
    urlPath = decodeURIComponent(raw)
  } catch (e) {
    urlPath = raw
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html'

  // 防目录穿越：normalize 后必须仍在 ROOT 之内
  const rel = path.normalize(urlPath).replace(/^([/\\])+/, '')
  const filePath = path.join(ROOT, rel)
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('403 越界访问')
  }

  if (sendFile(req, res, filePath)) return

  // 没有扩展名才回退到 index.html（避免把「少了一个 .js」变成一段 HTML 报错）
  if (!path.extname(filePath)) {
    if (sendFile(req, res, path.join(ROOT, 'index.html'))) return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(`404 找不到 ${urlPath}`)
}

/* ==================== 服务 ==================== */

const server = http.createServer((req, res) => {
  const rule = PROXY_RULES.find((r) => (req.url || '').startsWith(r.prefix))
  if (rule) return handleProxy(req, res, rule)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('405 只支持 GET / HEAD')
  }
  serveStatic(req, res)
})

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
  } catch (e) {
    /* 打不开就算了，地址已经打印出来了 */
  }
}

function banner(url) {
  console.log('')
  console.log('  ╔═══════════════════════════════════════════════╗')
  console.log('  ║        BossMonitor 监控大屏 · 本地服务         ║')
  console.log('  ╚═══════════════════════════════════════════════╝')
  console.log('')
  console.log(`  目录：${ROOT}`)
  console.log(`  地址：${url}`)
  if (LAN) console.log('  局域网：已开启（同一网络下的手机 / 平板可直接访问上面的地址）')
  console.log('')
  console.log('  钉钉 / 企业微信的跨域代理已就绪，推送可正常使用。')
  console.log('  关闭这个窗口（或按 Ctrl+C）即可停止服务。')
  console.log('')
}

/** 端口被占用就往后找一个空位，最多试 20 个 */
function listen(port, left = 20) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && left > 0) {
      console.log(`  端口 ${port} 被占用，换 ${port + 1} 试试…`)
      listen(port + 1, left - 1)
      return
    }
    console.error('启动失败：', e.message)
    process.exit(1)
  })
  server.listen(port, HOST, () => {
    const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST
    const url = `http://${shown}:${port}/`
    banner(url)
    if (OPEN) openBrowser(url)
  })
}

listen(PORT_START)
