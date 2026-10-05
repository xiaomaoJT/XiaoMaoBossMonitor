/**
 * Apple Watch 端构建（watchOS SwiftUI App）
 * ----------------------------------------------------------------------------
 * 用法：
 *   node scripts/build-watch.mjs                  # 类型检查 + 尝试完整编译
 *   node scripts/build-watch.mjs --strict          # xcodebuild 失败也算失败（CI 用）
 *   node scripts/build-watch.mjs --register-watch  # 把手表注册进团队签名（装表前必做）
 *
 * 做三件事：
 *   1. swiftc -typecheck：把手表端全部 Swift 源码对着 watchOS SDK 过一遍编译器。
 *      这一步是**硬门槛**——类型错误必须在这里暴露。
 *   2. xcodebuild 完整编译出 MonitorWatch.app 包（模拟器）。
 *   3. --register-watch：针对配对的真手表构建一次（带
 *      -allowProvisioningDeviceRegistration），让 Xcode 把**手表的 UDID** 注册进团队、
 *      并重新生成手表 App 的签名描述文件。
 *
 * 为什么「注册手表」这一步不能省：
 *   手表 App 有自己的 bundle id，需要**自己的描述文件**；而只有描述文件的
 *   设备列表里包含**手表 UDID**，iPhone 上的「手表」App 才可能把手表 App
 *   装到手表里。不注册时的现象特别隐蔽：点「安装」一直转圈，几秒后退回
 *   「安装」按钮，没有任何报错 —— 因为签名校验在手表侧被静默拒绝。
 *
 * 为什么手表端是原生 SwiftUI 而不是 WebView：
 *   watchOS 根本不提供 WKWebView，Monitor 大屏的 Web 技术栈在那边跑不起来，
 *   所以手表端只做「看事件 + 标已读」，数据走 WatchConnectivity（见
 *   ios/App/App/WatchBridgePlugin.swift 与 src/composables/useWatchBridge.js）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..')
const IOS_DIR = path.join(PROJECT, 'ios', 'App')
const WATCH_SRC = path.join(IOS_DIR, 'MonitorWatch')
const strict = process.argv.includes('--strict')
const registerWatch = process.argv.includes('--register-watch')

function fail(msg) {
  console.error('❌ ' + msg)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

/** 从 devicectl 里找出配对的手表（UDID + 名称 + 隧道状态） */
function findPairedWatch() {
  const tmp = path.join(os.tmpdir(), 'monitor-watch-devices.json')
  const r = run('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmp])
  if (r.code !== 0) return null
  try {
    const data = JSON.parse(fs.readFileSync(tmp, 'utf8'))
    const list = (data.result && data.result.devices) || []
    for (const d of list) {
      const h = d.hardwareProperties || {}
      if (h.platform !== 'watchOS') continue
      const c = d.connectionProperties || {}
      const p = d.deviceProperties || {}
      return { udid: h.udid, name: p.name || 'Apple Watch', tunnel: c.tunnelState, pairing: c.pairingState }
    }
  } catch {
    return null
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
  return null
}

/** 读出手表 App 描述文件当前授权了哪些设备（判定注册是否真的生效） */
function watchProfileDevices() {
  const dir = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles')
  if (!fs.existsSync(dir)) return null
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mobileprovision')) continue
    const p = path.join(dir, f)
    const decoded = run('security', ['cms', '-D', '-i', p])
    if (decoded.code !== 0) continue
    const text = decoded.out
    if (!/watchkitapp/.test(text)) continue
    const block = text.match(/<key>ProvisionedDevices<\/key>\s*<array>([\s\S]*?)<\/array>/)
    const devices = block ? [...block[1].matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]) : []
    return { file: f, devices }
  }
  return null
}

/* ---------- 0) 前置检查 ---------- */
if (!fs.existsSync(WATCH_SRC)) fail('找不到手表端源码目录 ios/App/MonitorWatch')
const sources = fs.readdirSync(WATCH_SRC).filter((f) => f.endsWith('.swift')).map((f) => path.join(WATCH_SRC, f))
if (!sources.length) fail('MonitorWatch 目录下没有 Swift 源文件')

/* ---------- 1) 选 SDK ---------- */
const sdkOut = run('xcrun', ['--sdk', 'watchsimulator', '--show-sdk-path'])
const SDK = sdkOut.out.trim()
if (!SDK || sdkOut.code !== 0 || !fs.existsSync(SDK)) {
  console.error('⚠️ 没找到 watchOS Simulator SDK（需要完整版 Xcode）。跳过类型检查。')
  if (strict) process.exit(1)
  process.exit(0)
}
console.log(`  · SDK: ${SDK}`)

/* ---------- 2) 类型检查（硬门槛） ---------- */
console.log('  · swiftc 类型检查（' + sources.length + ' 个源文件）…')
const tc = run('xcrun', ['--sdk', 'watchsimulator', 'swiftc', '-typecheck', '-swift-version', '5',
  '-target', 'arm64-apple-watchos10.0-simulator', '-sdk', SDK, ...sources])
const tcLog = (tc.out + '\n' + tc.err).trim()
if (tcLog) console.log(tcLog.split('\n').map((l) => '    ' + l).join('\n'))
if (tc.code !== 0) fail('类型检查未通过（见上方报错）')
console.log('  ✅ 类型检查通过')

/* ---------- 3) xcodebuild 完整编译（尽力而为） ---------- */
console.log('  · xcodebuild 编译 MonitorWatch（watchOS Simulator）…')
const dd = path.join(PROJECT, 'ios', 'DerivedData-watch')
/*
 * 清理只能「尽力而为」：某些受管环境会给 fs.rmSync 套一层批量删除守卫
 * （目录里几千个文件时直接抛错）。清理失败不该让整个脚本崩掉 ——
 * xcodebuild 对已存在的 derivedDataPath 会自己做增量构建，不影响正确性。
 */
try {
  fs.rmSync(dd, { recursive: true, force: true })
} catch {
  console.log('  · 上次的构建目录没能清掉（受管环境限制），交给 xcodebuild 增量处理')
}
const xb = run('xcodebuild', [
  '-project', 'App.xcodeproj', '-scheme', 'MonitorWatch',
  '-configuration', 'Debug',
  '-destination', 'generic/platform=watchOS Simulator',
  '-derivedDataPath', dd,
  'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'build'
], { cwd: IOS_DIR })

const log = xb.out + '\n' + xb.err
const tail = log.split('\n').filter((l) => l.trim()).slice(-25)
const built = fs.existsSync(path.join(dd, 'Build', 'Products', 'Debug-watchsimulator', 'MonitorWatch.app'))

if (xb.code === 0 && built) {
  console.log('  ✅ MonitorWatch.app 编译成功：' + path.relative(PROJECT, path.join(dd, 'Build', 'Products', 'Debug-watchsimulator', 'MonitorWatch.app')))
  if (registerWatch) {
    process.exit(registerWatchDevice() ? 0 : 1)
  }
  process.exit(0)
}

/* ---------- 4) 注册真手表（--register-watch） ---------- */
function registerWatchDevice() {
  console.log('')
  console.log('  · 查找配对的 Apple Watch…')
  const watch = findPairedWatch()
  if (!watch) {
    console.log('  ⚠️ 没找到配对的 Apple Watch。先在 iPhone 上把手表配对好再来。')
    return false
  }
  console.log(`  · 找到：${watch.name}（${watch.udid}）· 隧道 ${watch.tunnel || '未知'}`)

  const ddDev = path.join(PROJECT, 'ios', 'DerivedData-watch-device')
  const xr = run('xcodebuild', [
    '-project', 'App.xcodeproj', '-scheme', 'MonitorWatch',
    '-configuration', 'Debug',
    '-destination', `platform=watchOS,id=${watch.udid}`,
    '-derivedDataPath', ddDev,
    '-allowProvisioningUpdates',
    '-allowProvisioningDeviceRegistration',
    'build'
  ], { cwd: IOS_DIR })

  const xlog = (xr.out + '\n' + xr.err)
  // Xcode 会把所有不匹配的 destination 全列出来（模拟器/本机一堆噪音），只留手表那条和真正的 error
  const errs = xlog
    .split('\n')
    .filter((l) => /^\s*(\{|xcodebuild: error|error:)|platform:watchOS/.test(l))
    .filter((l) => /platform:watchOS|error:/.test(l))
    .slice(0, 4)

  if (xr.code !== 0) {
    console.log('')
    console.log('  ⚠️ 针对手表的构建没成功（退出码 ' + xr.code + '）。关键输出：')
    for (const l of errs) console.log('    ' + l.trim())
    console.log('')
    console.log('')
    console.log('  Mac 读不到手表时，安装必然失败（手表上会显示「无法验证其完整性」）。')
    console.log('  按顺序做完这 4 步，缺一步都不行：')
    console.log('')
    console.log('   ① 手表上开「开发者模式」—— 最关键，Apple 强制要求')
    console.log('      手表 → 设置 → 隐私与安全性 → 拉到底 → 开发者模式 → 打开（会重启手表）')
    console.log('      ⚠️ 必须是**手表本身的**设置，不是 iPhone「手表」App 里那个')
    console.log('      ⚠️ 如果这一项根本不存在：iPhone 先插线连上 Mac，然后在')
    console.log('         iPhone → 设置 → 开发者 里勾上 "WidgetKit Developer Mode"，')
    console.log('         再回手表看，开关就出现了（社区公认的绕法）')
    console.log('   ② iPhone 用**数据线**连这台 Mac，手机上点「信任此电脑」')
    console.log('      （Wi-Fi 连不上，必须插线；插拔两次更容易成功）')
    console.log('   ③ 打开 Xcode → Window → Devices and Simulators，')
    console.log('      手表会出现在 iPhone 下面（可能要等十几秒，或右键 iPhone 点 reconnect）')
    console.log('   ④ 手表解锁并戴在手上，与 iPhone 的 Wi-Fi 频段保持一致')
    console.log('')
    console.log('  做完再跑一次：npm run watch:register')
    return false
  }

  console.log('')
  console.log('  ✅ 针对手表的构建成功，设备注册已完成。')
  const prof = watchProfileDevices()
  if (prof) {
    console.log('  · 描述文件设备列表：' + (prof.devices.length ? prof.devices.join(', ') : '（空）'))
    if (prof.devices.includes(watch.udid)) {
      console.log('  ✅ 手表 UDID 已在描述文件里 —— 现在可以正常安装到手表了。')
    } else {
      console.log('  ⚠️ 描述文件里还没看到手表 UDID。到 Apple Developer 后台确认设备已注册，')
      console.log('     或在 Xcode → Settings → Accounts → Manage Certificates 里重签一次。')
    }
  }
  console.log('')
  console.log('  下一步：npm run build:all（重装手机端）→ iPhone「手表」App → 我的手表 → 可用 App → 安装')
  console.log('')
  console.log('  手表上首次打开 App 若提示证书不受信任：')
  console.log('    iPhone → 设置 → 通用 → VPN 与设备管理 → 信任该开发者证书。')
  console.log('    （开发版 App 第一次启动要拿证书跟 Apple 服务器核验一次，所以手表得联网）')
  return true
}

if (registerWatch) {
  const ok = registerWatchDevice()
  process.exit(ok ? 0 : 1)
}

/* 编译失败：降级 */
console.log('')
console.log('  ⚠️ xcodebuild 没能产出 MonitorWatch.app（退出码 ' + xb.code + '）。最近输出：')
for (const l of tail) console.log('    ' + l)
console.log('')
console.log('  这台机器多半没装 watchOS 运行时（Xcode → Settings → Platforms 里看）或工具链不完整。')
console.log('  类型检查已经通过，源码本身没问题；手表 App 的正式安装走 Xcode：')
console.log('    1. Xcode 打开 ios/App/App.xcodeproj，选 MonitorWatch scheme')
console.log('    2. **真机/手表需要先在 Xcode → Settings → Accounts 登录 Apple ID**：')
console.log('       手表 App 的 bundle id（com.mao.monitorwall.watchkitapp）要单独的描述文件，')
console.log('       没登录账号时命令行无法自动生成（会报 No profiles / No Accounts）。')
console.log('    3. 装到手表前先跑：npm run watch:register（把手表 UDID 注册进签名描述文件）')
console.log('    4. 手表与 iPhone 配对后，Xcode 选 MonitorWatch + 手表为目标直接 Run，')
console.log('       或挂回 Embed Watch Content 后用 iPhone「手表」App 安装。')
if (strict) process.exit(1)
console.log('  （--strict 可把这一步变成硬失败）')
process.exit(0)
