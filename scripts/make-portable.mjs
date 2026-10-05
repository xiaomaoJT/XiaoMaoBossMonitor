/**
 * 打出「便携版」目录：一个可以整个拷给别人、双击就能跑的文件夹。
 * ----------------------------------------------------------------------------
 * 产物：release/BossMonitor-便携版/
 *   ├─ index.html / assets / ai / js / logo   ← 构建产物原样搬过来
 *   ├─ serve-static.mjs                        ← 零依赖本地服务（含钉钉/企微代理）
 *   ├─ 启动监控.command                        ← macOS / Linux 双击启动
 *   ├─ start-windows.bat                       ← Windows 双击启动
 *   └─ 使用说明.txt
 *
 * 为什么不直接双击 index.html：
 *   Vite 产物带 `crossorigin`，file:// 下 origin 是 'null'，module script / CSS /
 *   fetch / Worker 全被 CORS 拦；即使绕过，fetch 读本地文件本身也是禁止的，
 *   108MB 的 ONNX 模型与播放器 wasm 都加载不了。必须走 http。
 *
 * 用法：npm run pack:portable
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.resolve(HERE, '..')
const DIST = path.join(PROJECT, 'dist')
const OUT = path.join(PROJECT, 'release', 'BossMonitor-便携版')

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('❌ 找不到 dist/index.html，请先执行 npm run build')
  process.exit(1)
}

/* ---------------- 1. 搬运构建产物 ---------------- */

/*
 * 清理只能「尽力而为」：某些受管环境会给 fs.rmSync 套一层批量删除守卫，
 * 目录里文件一多（几千个）就直接抛错。清理失败不能把整个打包流程打断 ——
 * vite 产物都是 hash 命名的，旧文件残留只是让目录大一点，不影响运行。
 */
try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch {
  console.log('  · 旧产物没清掉（受管环境限制），继续覆盖生成；可能残留少量旧哈希文件')
}
fs.mkdirSync(OUT, { recursive: true })
for (const item of fs.readdirSync(DIST)) {
  if (item === '.DS_Store') continue
  fs.cpSync(path.join(DIST, item), path.join(OUT, item), { recursive: true })
}

/* ---------------- 2. 服务脚本 ---------------- */

fs.copyFileSync(path.join(HERE, 'serve-static.mjs'), path.join(OUT, 'serve-static.mjs'))

/* ---------------- 3. 双击启动器 ---------------- */

/*
 * macOS / Linux 的 .command。
 *
 * ⚠️ 从访达双击时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 *    nvm / fnm / homebrew 装的 node 都找不到 —— 这是"明明装了却说没装"的根因，
 *    所以这里先把常见路径和版本管理器补进 PATH。
 */
const SH_LAUNCHER = `#!/bin/sh
# BossMonitor 监控大屏 · 双击启动（macOS / Linux）
cd "$(dirname "$0")" || exit 1

# 双击启动时 PATH 很干净，先把常见位置和版本管理器补上
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/bin"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
for d in "$HOME/.local/share/fnm/aliases/default/bin" "$HOME/.asdf/shims" "$HOME/.volta/bin"; do
  [ -d "$d" ] && export PATH="$PATH:$d"
done

printf '\\033]0;BossMonitor 监控大屏\\007'
clear
echo "==================================================="
echo "   BossMonitor 监控大屏 · 正在启动本地服务"
echo "==================================================="
echo ""

if command -v node >/dev/null 2>&1; then
  exec node serve-static.mjs --open
fi

if command -v python3 >/dev/null 2>&1; then
  echo "⚠️  未找到 Node.js，改用 Python 内置静态服务器。"
  echo "    注意：钉钉 / 企业微信的跨域代理不可用，这两个渠道推送会失败，"
  echo "    只有 Telegram 正常。需要完整功能请装 Node.js：https://nodejs.org"
  echo ""
  ( sleep 2; open "http://127.0.0.1:8800" 2>/dev/null || xdg-open "http://127.0.0.1:8800" 2>/dev/null ) &
  exec python3 -m http.server 8800 --bind 127.0.0.1
fi

echo "❌ 没有找到 Node.js 或 Python，无法启动本地服务。"
echo ""
echo "   请先安装 Node.js（LTS 版即可）：https://nodejs.org"
echo "   装好后重新双击本文件。"
echo ""
printf "按回车键关闭…"
read -r _
exit 1
`

const SH_NAME = '启动监控.command'
fs.writeFileSync(path.join(OUT, SH_NAME), SH_LAUNCHER, { mode: 0o755 })
fs.chmodSync(path.join(OUT, SH_NAME), 0o755)

/*
 * Windows 的 .bat。
 * 内容刻意保持**纯 ASCII**：cmd 默认代码页不是 UTF-8，
 * 中文写进去会变乱码（文件名同理，所以这里用英文名）。
 */
const BAT_LAUNCHER = `@echo off
cd /d "%~dp0"
title BossMonitor
echo ===================================================
echo    BossMonitor - starting local server
echo ===================================================
echo.

where node >nul 2>nul
if %errorlevel%==0 (
  node serve-static.mjs --open
  goto done
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo Node.js not found, falling back to Python http.server.
  echo NOTE: DingTalk / WeCom cross-origin proxy is unavailable in this mode,
  echo       those two channels will fail. Only Telegram works.
  echo Install Node.js from https://nodejs.org for full features.
  echo.
  start "" http://127.0.0.1:8800
  python -m http.server 8800 --bind 127.0.0.1
  goto done
)

echo Node.js / Python not found. Please install Node.js LTS from https://nodejs.org
:done
echo.
pause
`

fs.writeFileSync(path.join(OUT, 'start-windows.bat'), BAT_LAUNCHER)

/* ---------------- 4. 使用说明 ---------------- */

const README = `BossMonitor 监控大屏 · 便携版使用说明
==================================================

【怎么启动】

  macOS / Linux ：双击 「${SH_NAME}」
  Windows       ：双击 「start-windows.bat」

  双击后会自己起一个本地服务并打开浏览器。
  启动成功后**不要关闭那个终端窗口**，关掉窗口 = 停止服务。

  如果 macOS 提示"无法打开，因为来自身份不明的开发者"：
  右键点该文件 → 选「打开」→ 再点「打开」；
  或者打开「终端」执行：
      cd 到这个文件夹
      xattr -dr com.apple.quarantine .
      chmod +x "${SH_NAME}"

【为什么不能直接双击 index.html】

  直接双击会白屏，这是浏览器的同源策略，不是软件的 bug：
  file:// 页面会被当成 origin 'null'，于是 module 脚本、CSS、fetch、Worker
  全部被 CORS 拦截；而且 fetch 读本地文件在 file:// 下本来就被禁止，
  100MB 级的 AI 模型和播放器解码器根本加载不了。
  所以必须走 http —— 本启动脚本就是干这件事的。

【需要什么】

  推荐：Node.js（LTS 版即可）      https://nodejs.org
  备用：Python 3

  只装了 Python 也能跑：画面播放、Telegram 推送都正常，
  但钉钉 / 企业微信依赖跨域代理，这种模式下用不了。

【局域网访问（手机 / 平板看大屏）】

  在终端里手动跑：
      node serve-static.mjs --host=0.0.0.0 --open
  然后用手机访问终端里打印的 http://<这台电脑的IP>:8800

【数据存在哪】

  报警记录、人脸库、配置都保存在**浏览器本地**（IndexedDB / localStorage），
  换一个浏览器或清空浏览器数据就会丢，不会写进这个文件夹。

【端口被占用】

  默认 8800，被占用会自动往后找（8801、8802…），
  以终端里打印的地址为准。
`

fs.writeFileSync(path.join(OUT, '使用说明.txt'), README)

/* ---------------- 5. 汇报 ---------------- */

function dirSize(p) {
  let total = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name)
      if (e.isDirectory()) walk(fp)
      else total += fs.statSync(fp).size
    }
  }
  walk(p)
  return total
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'
console.log('')
console.log('✅ 便携版已生成：' + OUT)
console.log('   总大小：' + mb(dirSize(OUT)))
console.log('')
console.log('   双击 「' + SH_NAME + '」 即可启动（macOS / Linux）')
console.log('   双击 「start-windows.bat」    即可启动（Windows）')
console.log('')
