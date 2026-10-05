/**
 * 一键开发脚本：npm run electron:dev
 * 1. 启动 vite 开发服务器（热更新）
 * 2. 等端口真正可连接
 * 3. 拉起 Electron，并让它加载开发服务器地址
 * 4. Electron 退出时顺手关掉 vite
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, Socket } from 'node:net'
import path from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const ROOT = path.resolve(import.meta.dirname, '..')
const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT || 5173)
const DEV_URL = `http://${HOST}:${PORT}`

const nodeBin = process.execPath

function waitForPort(host, port, timeoutMs = 40000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = new Socket()
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        socket.destroy()
        if (ok) resolve(true)
        else if (Date.now() - started > timeoutMs) resolve(false)
        else setTimeout(tryOnce, 300)
      }
      socket.setTimeout(1200)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
      socket.connect(port, host)
    }
    tryOnce()
  })
}

/** 端口被占用时自动换一个，避免和已经在跑的服务打架 */
function findFreePort(host, start) {
  return new Promise((resolve) => {
    const probe = (port, left) => {
      const srv = createServer()
      srv.once('error', () => (left > 0 ? probe(port + 1, left - 1) : resolve(start)))
      srv.once('listening', () => srv.close(() => resolve(port)))
      srv.listen(port, host)
    }
    probe(start, 20)
  })
}

const port = await findFreePort(HOST, PORT)
const devUrl = `http://${HOST}:${port}`

console.log(`\n▶ 启动 Vite 开发服务器：${devUrl}`)
const vite = spawn(nodeBin, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env
})

const ready = await waitForPort(HOST, port)
if (!ready) {
  console.error('✗ Vite 启动超时，请检查端口是否被占用')
  vite.kill('SIGTERM')
  process.exit(1)
}

console.log('▶ 拉起 Electron 窗口…\n')

// 某些沙箱 / CI 环境会预置 ELECTRON_RUN_AS_NODE，那样 Electron 会退化成普通 Node，
// 拿不到 app / BrowserWindow。这里显式剔除，保证起的是真正的桌面客户端。
const electronEnv = { ...process.env, VITE_DEV_SERVER_URL: devUrl, ELECTRON_ENABLE_LOGGING: '1' }
delete electronEnv.ELECTRON_RUN_AS_NODE

const electron = spawn(electronPath, [ROOT], {
  cwd: ROOT,
  stdio: 'inherit',
  env: electronEnv
})

const shutdown = () => {
  if (!vite.killed) vite.kill('SIGTERM')
}
electron.on('close', () => {
  shutdown()
  process.exit(0)
})
process.on('SIGINT', () => {
  electron.kill('SIGTERM')
  shutdown()
  process.exit(0)
})
