/**
 * 打出「Windows 部署包」：一个拷过去就能跑的文件夹
 * ----------------------------------------------------------------------------
 * 产物：release/BossMonitor-Win/
 *   ├─ dist/            大屏页面 + 前端 ORT wasm + AI 模型（后端也从这里读模型）
 *   ├─ server/          后端检测服务（含 config.json 与 data/ 事件库）
 *   ├─ node_modules/    已装好的运行依赖（--skip-modules 可不带）
 *   ├─ package.json
 *   ├─ start-windows.bat  双击启动（自动开浏览器）
 *   └─ 使用说明.txt
 *
 * ⚠️ 必须在**目标平台**上执行：node_modules 里 better-sqlite3 / onnxruntime-node /
 * ffmpeg-static 都是平台原生二进制（.node / .dll / .exe），mac 上打出来的包
 * 拿到 Windows 上是跑不起来的。正确姿势：
 *
 *   在 Windows A 机上：  npm install --omit=dev
 *                        node scripts/make-win-deploy.mjs
 *   然后把 release/BossMonitor-Win/ 整个拷到 Windows B 机，双击 bat 即可。
 *
 * 为什么不能只拷 node_modules（不带 dist）：后端模型、页面、wasm 都在 dist 里，
 * 只拷依赖等于什么都没跑起来。
 *
 * 用法：
 *   node scripts/make-win-deploy.mjs                # 完整部署包（含依赖、数据）
 *   node scripts/make-win-deploy.mjs --skip-data    # 带干净事件库
 *   node scripts/make-win-deploy.mjs --skip-modules # 不带 node_modules（目标机自己 npm i）
 *   node scripts/make-win-deploy.mjs --full         # 再带上 src/public/scripts，可重新 build
 *   node scripts/make-win-deploy.mjs --zip          # 额外压一个 zip（Windows 走 Compress-Archive）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..')
const OUT = path.join(PROJECT, 'release', 'BossMonitor-Win')

const has = (k) => process.argv.some((a) => a === `--${k}` || a.startsWith(`--${k}=`))

/* ---------------- 0. 前置检查 ---------------- */

if (!fs.existsSync(path.join(PROJECT, 'dist', 'index.html'))) {
  console.error('❌ 找不到 dist/index.html，请先执行 npm run build')
  process.exit(1)
}
if (!fs.existsSync(path.join(PROJECT, 'server', 'headless-monitor.mjs'))) {
  console.error('❌ 找不到 server/headless-monitor.mjs')
  process.exit(1)
}
if (process.platform === 'darwin') {
  console.log('⚠️  你在 macOS 上执行：node_modules 是 mac 的二进制，打出来的包在 Windows 上跑不了。')
  console.log('   这个脚本请在 Windows 上跑；mac 上只能先确认清单，实际安装得去 Windows。')
}

const hasModules = fs.existsSync(path.join(PROJECT, 'node_modules'))
if (!hasModules && !has('skip-modules')) {
  console.error('❌ 没有 node_modules。先执行 npm install --omit=dev（只装运行依赖），或加 --skip-modules')
  process.exit(1)
}

/* ---------------- 1. 复制清单 ---------------- */

/** 拷贝时跳过 .DS_Store —— 几百个文件的目录里它纯占体积 */
const FILTER = (src) => path.basename(src) !== '.DS_Store'

function copyInto(rel) {
  const from = path.join(PROJECT, rel)
  if (!fs.existsSync(from)) {
    console.log(`   · 跳过（不存在）${rel}`)
    return false
  }
  const to = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, filter: FILTER, dereference: true })
  const mb = (dirSize(to) / 1024 / 1024).toFixed(1)
  console.log(`   ✓ ${rel.padEnd(26)} ${mb} MB`)
  return true
}

function dirSize(target) {
  const st = fs.statSync(target)
  if (!st.isDirectory()) return st.size
  let n = 0
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    n += dirSize(path.join(target, e.name))
  }
  return n
}

try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch {
  /* Windows 上文件可能还被占用；残留不影响，继续往下 */
}
fs.mkdirSync(OUT, { recursive: true })

console.log(`\n📦 打包 Windows 部署包 → ${path.relative(PROJECT, OUT)}`)

/* 运行必需 */
copyInto('dist')
copyInto('server')
/*
 * src/ 也是运行必需（只有 836KB，但少了它后端起不来）：
 * server 会动态 import 前端这几个模块，为的是「推送文案 / 区域与计数判定」只有一份实现：
 *   composables/useTracker.js      目标跟踪（区域判定、滞留时长）
 *   composables/useAiDetector.js   人脸裁剪 / 对齐 / 缩略图
 *   composables/useAlertPush.js    推送主流程
 *   composables/useDingTalk.js     钉钉文案（含状态告警 / 巡检）
 *   composables/useTelegram.js     Telegram 文案
 *   config/features.js             功能开关
 * 别因为「它是前端代码」就以为可以不拷 —— 整份 src 一起带上最省心。
 */
copyInto('src')
if (has('full')) {
  /* 只想「跑起来」时这几个都可以不带；要在那台机器上改代码/重新 build 才需要 */
  copyInto('public')
  copyInto('scripts')
  copyInto('index.html')
  copyInto('vite.config.js')
  if (hasModules) copyInto('package-lock.json')
}
if (!has('skip-data')) {
  const dataFrom = path.join(PROJECT, 'server', 'data')
  if (fs.existsSync(dataFrom)) console.log('   ✓ server/data（事件库 + 人脸库）随包带上，历史记录和人脸不丢')
  else console.log('   · server/data 还不存在，部署后首次运行自动创建')
} else {
  const dataFrom = path.join(OUT, 'server', 'data')
  if (fs.existsSync(dataFrom)) fs.rmSync(dataFrom, { recursive: true, force: true })
  console.log('   · 按要求去掉了 server/data（部署包是干净库）')
}

copyInto('package.json')
copyInto('start-windows.bat')
if (!has('skip-modules')) copyInto('node_modules')

/* ---------------- 2. 使用说明 ---------------- */

/* Windows 记事本对「无 BOM 的 UTF-8」中文会显示成乱码，所以这里显式加 BOM */
const BOM = '\uFEFF'
const readme = `BossMonitor · Windows 部署包
================================================================

【怎么启动】
  双击  start-windows.bat
  浏览器会自动打开 http://localhost:8787  —— 这就是大屏 + 检测服务，同一个端口。
  想让它一直跑：不要关掉这个黑窗口（关掉即停止）。

  黑窗口一闪而过/提示找不到 node？
  先装 Node.js 20 或 22 LTS：https://nodejs.org  （一路下一步即可）

【别的设备要看大屏】
  在同一 Wi-Fi 下，手机 / 平板 / 另一台电脑浏览器打开：
      http://<这台电脑的局域网IP>:8787
  查本机 IP：命令提示符里输入  ipconfig
  第一次运行 Windows 防火墙会问「是否允许 Node 通信」—— 勾「专用网络」并允许，
  否则手机/别的电脑访问不了。同一台机器自己访问 localhost 不受影响。

【首次使用要做的事】
  1. 打开大屏 → 右上角「设置」→「检测识别」→「后端检测服务」
  2. 开关打开，地址填  http://127.0.0.1:8787  （就本机时填这个最稳）
  3. 配置会自动同步到后端：通道地址、区域线、监听时段、推送渠道都不用手改文件
  4. 回到大屏「通道」页添加摄像头；「监听」列打开的通道才会被检测

【推送】
  推送由后端发，页面关掉、浏览器关掉都照发。
  钉钉 / 企业微信 / Telegram 在设置页填 webhook 即可。
  注意：后端模式下前端不再自己发，所以「代理」相关报错可以忽略。

【数据在哪】
  server/data/monitor.db   事件库 + 人脸库（SQLite，备份直接拷这个文件）
  server/config.json       服务配置（通道配置由前端同步覆盖）
  dist/ai/models/*.onnx    AI 模型（人形/人脸/特征/姿态）

【常见问题】
  Q: 页面打开是 404 / 空白？
  A: dist/ 没拷全。部署包里应该整个 dist 目录都在，重新整份拷过去。
  Q: 提示 onnxruntime-node 加载失败 / .node 不是有效的 Win32 应用？
  A: node_modules 是从别的系统拷来的。删掉 node_modules，在本机执行
     npm install --omit=dev  （原生模块必须在目标系统上装）
  Q: better-sqlite3 编译报错（缺 python / 缺 MSVC）？
  A: 装 Python 3 与「Visual Studio 生成工具 - 使用 C++ 的桌面开发」，再
     npm rebuild better-sqlite3 --build-from-source
  Q: 摄像头画面黑屏但检测有数据？
  A: 走的是后端解码（ffmpeg），前端只是播放。H.265 流在部分机器上浏览器
     硬解不了，让摄像头改 H.264 子码流最稳。
  Q: 要开机就自动跑？
  A: 把 start-windows.bat 做成快捷方式放进
     C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup
     或用 nssm 把它注册成服务（崩溃能自动拉起，更适合长期无人值守）。

【包里有什么 / 没什么】
  必带：dist（含 AI 模型 + wasm）· server · src（后端要 import 它的推送与判定模块）·
        package.json · start-windows.bat${
    has('skip-modules') ? '' : ' · node_modules'
  }${has('full') ? ' · public/scripts/index.html（才能重新 build）' : ''}
  没有：ios/ miniprogram/ release/ build/ electron/（打包 iOS、小程序、桌面 exe 用，
         在这台机器上做不了，也不需要）
`
fs.writeFileSync(path.join(OUT, '使用说明.txt'), BOM + readme, 'utf8')

/* ---------------- 3. 可选：压 zip ---------------- */

let zipPath = ''
if (has('zip')) {
  zipPath = OUT + '.zip'
  console.log('\n🗜️  压缩中（node_modules 很大，第一次可能要几分钟）…')
  const r =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zipPath}' -Force`
          ],
          { stdio: 'inherit' }
        )
      : spawnSync('tar', ['-a', '-cf', zipPath, '-C', OUT, '.'], { stdio: 'inherit' })
  if (r.status === 0) {
    const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)
    console.log(`   ✓ ${path.basename(zipPath)}  ${mb} MB`)
  } else {
    console.log('   ⚠️  压缩失败，不影响文件夹直接拷贝')
  }
}

const total = (dirSize(OUT) / 1024 / 1024).toFixed(0)
console.log(`\n✅ 完成：${path.relative(PROJECT, OUT)}（${total} MB）`)
console.log('   把这个文件夹整个拷到目标 Windows 电脑，双击 start-windows.bat。')
if (!hasModules) {
  console.log('\n⚠️  包里没有 node_modules —— 目标机上要先执行： npm install --omit=dev')
}
