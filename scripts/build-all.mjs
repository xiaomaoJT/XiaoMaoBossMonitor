/**
 * 全平台一条命令打包：Web 产物 → 便携版 → macOS 桌面端 → iOS App → Apple Watch → 微信小程序
 * ----------------------------------------------------------------------------
 * 用法：
 *   npm run build:all                             # 六步全跑
 *   npm run build:all -- --skip=ios               # 跳过 iOS，其余照跑
 *   npm run build:all -- --only=portable,electron # 只跑指定步骤
 *   npm run build:all -- --dir                    # macOS 只出 .app 目录，不做 dmg（快很多）
 *   npm run build:all -- --target=<模拟器UDID>     # 指定 iOS 部署目标
 *   npm run build:all -- --target-name="iPhone 17"
 *   npm run build:all -- --keep-going             # 某一步失败也继续往下跑
 *   npm run build:all -- --strict-watch           # watch 编译失败也按失败处理
 *   npm run build:all -- --mp-url=https://x/      # 顺手把 H5 地址写进小程序配置
 *
 * 为什么不直接在 package.json 里串 `&&`：
 *   pack:portable / electron:build / ios:run 这三个脚本各自都带一次 `npm run build`，
 *   串起来就是**构建 4 次**；而且 vite.config.js 的 __BUILD_TIME__ 每次构建都不同，
 *   四个产物会拿到四个不同的构建时间戳（「关于系统」页里看到的对不上，排障时误导人）。
 *   这里只构建一次，后面三步复用同一份 dist，四个平台产物完全同源。
 *
 * 零依赖：只用 Node 内置模块；三个 CLI 都用 `node <入口文件>` 直调，
 * 不经过 shell，macOS / Windows / Linux 行为一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..')
const NODE = process.execPath
const at = (...p) => path.join(PROJECT, ...p)

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2)

const has = (name) => argv.some((a) => a === '--' + name || a.startsWith('--' + name + '='))

function val(name, fallback = '') {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='))
  if (!hit) return fallback
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1)
  const next = argv[argv.indexOf(hit) + 1]
  return next && !next.startsWith('--') ? next : fallback
}

const asList = (name) =>
  val(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

if (has('help') || has('h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, '').trim())
  process.exit(0)
}

const skip = asList('skip')
const only = asList('only')
const keepGoing = has('keep-going')

/* ------------------------------------------------------------------ */
/* 步骤定义                                                            */
/* ------------------------------------------------------------------ */

/*
 * 桌面端 target 跟着当前机器走：
 *   macOS   → --mac（dmg + zip，本地签名/公证链路现成）
 *   Windows → --win（portable + nsis 安装器）
 *   Linux   → --linux
 * 只在 Windows 机器上跑 `npm run build:all` 就能出 exe；在 macOS 上交叉打 win 包
 * 只能出 portable（nsis 需要 wine），真要出安装器还是得在 Win 上跑一次。
 */
const HOST_WIN = process.platform === 'win32'
const HOST_LINUX = process.platform === 'linux'
const HOST_TARGET = HOST_WIN ? 'win' : HOST_LINUX ? 'linux' : 'mac'
const electronArgs = ['--' + HOST_TARGET, ...(has('dir') ? ['--dir'] : [])]

const iosArgs = ['run', 'ios']
if (val('target')) iosArgs.push('--target', val('target'))
if (val('target-name')) iosArgs.push('--target-name', val('target-name'))
if (val('scheme')) iosArgs.push('--scheme', val('scheme'))

/* 手表编译默认「尽力而为」（类型检查是硬门槛，产物合成失败只降级提示）；
   --strict-watch 让失败变成真正的失败，适合在装好 watchOS 运行时的机器上用。 */
const watchArgs = []
if (has('strict-watch')) watchArgs.push('--strict')

/* 小程序：--mp-url=... 直接把 H5 地址写进 miniprogram/utils/config.js 再体检 */
const mpArgs = []
if (val('mp-url')) mpArgs.push('--url=' + val('mp-url'))

/**
 * cap sync 只做「增量复制」，dist 里换掉哈希后，旧的那几个 index-*.js / index-*.css
 * 会一直留在 ios/App/App/public/assets 里，跟着 App 一起打进包（之前就踩过：
 * 包里同时存在三份不同哈希的入口脚本，看日志时完全分不清跑的是哪份）。
 * 复制前先清掉这两类文件，保证 iOS 包里的 Web 产物和本次构建**一模一样**。
 */
function cleanStaleIosAssets() {
  const dir = at('ios', 'App', 'App', 'public', 'assets')
  if (!fs.existsSync(dir)) return 0
  let n = 0
  for (const f of fs.readdirSync(dir)) {
    if (!/^index-.*\.(js|css|js\.map|css\.map)$/.test(f)) continue
    try {
      fs.rmSync(path.join(dir, f), { force: true })
      n++
    } catch {
      /* 删不掉就算了：cap sync 会用同名文件覆盖，残留只占一点体积、不影响运行。
         这里**绝不能抛** —— 清理失败不该把整个打包流程带崩（踩过一次）。 */
    }
  }
  return n
}

const STEPS = [
  {
    id: 'web',
    label: '构建 Web 产物',
    hint: 'vite build → dist/',
    cmd: [at('node_modules/vite/bin/vite.js'), ['build']]
  },
  {
    id: 'portable',
    label: '生成便携版',
    hint: 'release/BossMonitor-便携版/',
    cmd: [at('scripts/make-portable.mjs'), []]
  },
  {
    id: 'electron',
    label: `打包桌面端（${HOST_TARGET === 'win' ? 'Windows' : HOST_TARGET === 'linux' ? 'Linux' : 'macOS'}）`,
    hint: has('dir')
      ? `electron-builder --${HOST_TARGET} --dir`
      : `electron-builder --${HOST_TARGET}` + (HOST_WIN ? '（portable + nsis 安装器）' : '（dmg + zip）'),
    cmd: [at('node_modules/electron-builder/cli.js'), electronArgs]
  },
  {
    id: 'ios',
    label: '构建并部署 iOS App',
    hint: 'cap run ios' + (val('target-name') ? ` · ${val('target-name')}` : ''),
    before: cleanStaleIosAssets,
    cmd: [at('node_modules/@capacitor/cli/bin/capacitor'), iosArgs]
  },
  {
    id: 'watch',
    label: '编译 Apple Watch App',
    hint: 'swiftc 类型检查 + xcodebuild（watchOS SwiftUI 单目标 App）',
    cmd: [at('scripts/build-watch.mjs'), watchArgs]
  },
  {
    id: 'mp',
    label: '微信小程序体检',
    hint: '结构/JSON/页面完整性 + 主包≤2MB、总包≤20MB 体积规范校验',
    cmd: [at('scripts/build-mp.mjs'), mpArgs]
  }
]

const picked = STEPS.filter((s) => (only.length ? only.includes(s.id) : !skip.includes(s.id)))

if (!picked.length) {
  console.error('❌ 没有选中任何步骤，检查 --skip / --only 的写法（可选：' + STEPS.map((s) => s.id).join(' / ') + '）')
  process.exit(1)
}

// 依赖没装的话，spawn 只会报一句看不懂的 ENOENT，这里提前说清楚
for (const step of picked) {
  if (!fs.existsSync(step.cmd[0])) {
    console.error('❌ 缺少依赖：' + path.relative(PROJECT, step.cmd[0]))
    console.error('   先执行 npm install，再重跑本命令。')
    process.exit(1)
  }
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

const LINE = '─'.repeat(66)
const startedAt = Date.now()

function banner(i, total, step) {
  console.log('')
  console.log(LINE)
  console.log(`  [${i}/${total}] ${step.label}`)
  console.log(`          ${step.hint}`)
  console.log(LINE)
  console.log('')
}

/** 跑一个子进程：输出实时透传，同时留最后 40 行供失败时定位。 */
function runChild([file, args]) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    if (!process.env.NO_COLOR) env.FORCE_COLOR = env.FORCE_COLOR || '1'

    const child = spawn(NODE, [file, ...args], {
      cwd: PROJECT,
      env,
      stdio: ['inherit', 'pipe', 'pipe']
    })

    const tail = []
    const relay = (buf, out) => {
      out.write(buf)
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 40) tail.shift()
      }
    }
    child.stdout.on('data', (b) => relay(b, process.stdout))
    child.stderr.on('data', (b) => relay(b, process.stderr))
    child.on('error', (e) => {
      console.error('  ❌ 无法启动子进程：' + e.message)
      resolve({ code: 1, tail })
    })
    child.on('close', (code) => resolve({ code: code == null ? 1 : code, tail }))
  })
}

function readAppId() {
  try {
    return JSON.parse(fs.readFileSync(at('capacitor.config.json'), 'utf8')).appId || 'com.mao.monitorwall'
  } catch {
    return 'com.mao.monitorwall'
  }
}

/**
 * cap 部署到模拟器前要先启动 Simulator.app；本机的 Xcode 27 没带它
 * （/Applications/Xcode.app/Contents/Developer/Applications 整个目录都不存在），
 * 于是每次都停在「编译成功、部署失败」。这里用 simctl 把同样的事补完：
 * boot → install → launch，让一条命令真的能把 App 装进模拟器。
 * 真机部署不走这条路（真机需要签名，由 Xcode 正常流程处理）。
 */
function simctlFallback() {
  const dd = at('ios', 'DerivedData')
  let best = null
  for (const d of fs.readdirSync(dd)) {
    const app = path.join(dd, d, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app')
    if (!fs.existsSync(app)) continue
    const m = fs.statSync(app).mtimeMs
    if (!best || m > best.m) best = { udid: d, app, m }
  }
  if (!best) return { ok: false, reason: 'ios/DerivedData 下没有 Debug-iphonesimulator/App.app' }

  const exec = (args) => {
    const r = spawnSync('xcrun', ['simctl', ...args], { cwd: PROJECT, encoding: 'utf8' })
    return { ok: r.status === 0, out: String(r.stdout || '') + String(r.stderr || '') }
  }

  exec(['boot', best.udid]) // 已在运行会报错，忽略
  const install = exec(['install', best.udid, best.app])
  if (!install.ok) return { ok: false, reason: 'simctl install 失败：' + install.out.trim().slice(-200) }

  const launch = exec(['launch', best.udid, readAppId()])
  if (!launch.ok) return { ok: false, reason: 'simctl launch 失败：' + launch.out.trim().slice(-200) }

  return { ok: true, udid: best.udid }
}

/** 针对常见翻车点给一句能直接照做的提示。 */function diagnose(stepId, tail) {
  const text = tail.join('\n')

  if (stepId === 'ios') {
    if (/sandbox_apply|Operation not permitted/i.test(text)) {
      return [
        'Xcode 的 SwiftPM 清单沙箱被外层沙箱拦住了。先执行一次下面这行，再重跑本命令：',
        '',
        '    defaults write com.apple.dt.Xcode IDEPackageSupportDisableManifestSandbox -bool true'
      ]
    }
    if (/Unable to find a target|No devices|not connected|Unable to find|requires a connected/i.test(text)) {
      return [
        '没有找到可部署的目标。可以先启动模拟器，或用参数指定：',
        '',
        "    xcrun simctl boot 'iPhone 17'",
        '    npm run build:all -- --target-name="iPhone 17"'
      ]
    }
    if (/Simulator\.app does not exist|error opening simulator/i.test(text)) {
      return [
        '编译已经成功，只是 cap 要先启动 Simulator.app 再安装，而本机 Xcode 没带它：',
        '',
        '    /Applications/Xcode.app/Contents/Developer/Applications/  ← 不存在',
        '',
        '默认已自动改用 simctl 安装（见上方 ⚠️ 提示）；想关掉这个兜底用 --no-simctl-fallback，',
        '或者手动装：xcrun simctl install booted ios/DerivedData/<模拟器UDID>/Build/Products/Debug-iphonesimulator/App.app'
      ]
    }
    if (/Code Sign|signing|Provisioning/i.test(text)) {
      const tips = ['真机部署需要签名：用 Xcode 打开 ios/App/App.xcodeproj，在 Signing & Capabilities 里选好 Team。']
      if (/watchkitapp/i.test(text)) {
        tips.push(
          '报错针对的是手表 App 的 bundle id（com.mao.monitorwall.watchkitapp）：',
          '手表 App 嵌进手机包后要**单独一份**描述文件，而 Xcode 里没登录 Apple 账号时',
          '命令行没法自动生成（No Accounts）。',
          '',
          '两条路任选：',
          '  A. 不带手表打包（默认，当前工程已是这个状态）：重跑即可，上面的报错不应再出现；',
          '  B. 想把手表 App 装到手表上：Xcode → Settings → Accounts 登录 Apple ID →',
          '     打开工程选中 MonitorWatch target 选好 Team（Xcode 会自动注册 App ID + 描述文件），',
          '     然后按 project.pbxproj 里 App target 的注释把 Embed Watch Content 挂回去。'
        )
      }
      return tips
    }
    if (/xcode-select|requires Xcode/i.test(text)) {
      return ['没装完整 Xcode（只有 Command Line Tools）。装好后执行：sudo xcode-select -s /Applications/Xcode.app']
    }
  }

  if (stepId === 'electron' && /Cannot download|ENOTFOUND|ETIMEDOUT|net::/i.test(text)) {
    return ['electron-builder 需要联网下载 Electron 运行时（首次）。检查网络/代理后重跑即可，已下载的会走缓存。']
  }

  if (stepId === 'portable' && /找不到 dist\/index\.html/.test(text)) {
    return ['便携版依赖 dist，把 web 步骤一起跑：npm run build:all -- --only=web,portable']
  }

  if (stepId === 'watch' && /swiftc|typecheck|error:/i.test(text)) {
    return [
      '手表端类型检查失败：上面是 swiftc 的原始报错（文件:行号）。',
      '手表源码在 ios/App/MonitorWatch/，字段与 src/composables/useWatchBridge.js 的 toWatchEvent 一一对应，两边要一起改。'
    ]
  }

  return []
}

const results = []

for (const [i, step] of picked.entries()) {
  banner(i + 1, picked.length, step)

  if (step.before) {
    // 预清理一律是「尽力而为」：任何异常都只提示、不中断
    try {
      const n = step.before()
      if (n) console.log(`  · 清理 iOS 旧产物 ${n} 个文件`)
    } catch (e) {
      console.log('  · 预清理跳过：' + ((e && e.message) || e))
    }
  }

  const t = Date.now()
  const { code, tail } = await runChild(step.cmd)
  const secs = ((Date.now() - t) / 1000).toFixed(1)
  let ok = code === 0
  let note = ''

  // iOS 编译成功、只是 cap 起不来模拟器 GUI 时，用 simctl 把部署补完（--no-simctl-fallback 关掉）
  if (!ok && step.id === 'ios' && !has('no-simctl-fallback')) {
    const fb = simctlFallback()
    if (fb.ok) {
      ok = true
      note = '本机 Xcode 没带 Simulator.app，cap 起不来模拟器 GUI；已改用 simctl 装进模拟器并启动'
      console.log(`  ⚠️ ${note}`)
      console.log(`     模拟器 ${fb.udid} · App 已启动`)
    } else {
      console.log('  ⚠️ simctl 兜底也失败了：' + fb.reason)
    }
  }

  results.push({ step, ok, secs, note })

  console.log('')
  console.log(ok ? `  ✅ ${step.label} · ${secs}s` : `  ❌ ${step.label} · 失败（退出码 ${code}）· ${secs}s`)
  if (note) console.log(`     ${note}`)

  if (!ok) {
    const tips = diagnose(step.id, tail)
    if (tips.length) {
      console.log('')
      for (const l of tips) console.log('  ' + l)
    }
    if (!keepGoing) {
      console.log('')
      console.log(LINE)
      console.log('  已中断。修好上面这步后用 --skip / --only 只补跑剩下的，例如：')
      const rest = picked.slice(i + 1).map((s) => s.id)
      console.log('    npm run build:all -- --only=' + [step.id, ...rest].join(','))
      console.log(LINE)
      process.exit(1)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

function dirSize(p) {
  let total = 0
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const fp = path.join(p, e.name)
    total += e.isDirectory() ? dirSize(fp) : fs.statSync(fp).size
  }
  return total
}

function countFiles(p) {
  let n = 0
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(p, e.name))
    else n++
  }
  return n
}

const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB'

// 只列本次新生成的：mtime 晚于开始时刻
const fresh = (p) => {
  try {
    return fs.statSync(p).mtimeMs >= startedAt - 1000
  } catch {
    return false
  }
}

const lines = []
const dist = at('dist')
if (fresh(path.join(dist, 'index.html'))) {
  lines.push(['dist/', `${countFiles(dist)} 个文件`, mb(dirSize(dist))])
}

const portable = at('release', 'BossMonitor-便携版')
if (fresh(portable)) {
  lines.push(['release/BossMonitor-便携版/', '', mb(dirSize(portable))])
}

const relDir = at('release')
if (fs.existsSync(relDir)) {
  for (const f of fs.readdirSync(relDir)) {
    const fp = path.join(relDir, f)
    if (fs.statSync(fp).isFile() && /\.(dmg|zip)$/.test(f) && fresh(fp)) {
      lines.push(['release/' + f, '', mb(fs.statSync(fp).size)])
    }
  }
}

const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(1)
const failed = results.filter((r) => !r.ok)

console.log('')
console.log(LINE)
console.log(failed.length ? `  完成（有 ${failed.length} 步失败）· 共 ${totalSecs}s` : `  🎉 全部完成 · 共 ${totalSecs}s`)
console.log(LINE)

console.log('')
// 中文与英文混排时 padEnd 对不齐（终端里汉字占两格），用「 · 」分隔更稳
for (const r of results) {
  console.log(`  ${r.ok ? '✅' : '❌'} ${r.step.label} · ${r.secs}s${r.note ? ' ·（' + r.note + '）' : ''}`)
}

if (lines.length) {
  console.log('')
  console.log('  本次产物')
  for (const [name, note, size] of lines) {
    console.log(`    ${name}${note ? ' · ' + note : ''} · ${size}`)
  }
}

console.log('')
if (picked.some((s) => s.id === 'ios') && results.find((r) => r.step.id === 'ios' && r.ok)) {
  console.log('  iOS 已构建部署完成（cap sync 顺带把 dist 同步进了 ios/App/App/public）。')
}
console.log('')

process.exit(failed.length ? 1 : 0)
