#!/usr/bin/env node
/**
 * 小程序构建 / 上传前体检脚本
 *
 * 用法：
 *   node scripts/build-mp.mjs                 # 校验 + 体积报告
 *   node scripts/build-mp.mjs --url=https://x # 把 H5 地址写进 utils/config.js 后再校验
 *
 * 校验内容（对应微信上传规范）：
 *   - 工程结构完整性（app.json / sitemap / project.config / 页面四件套）
 *   - 主包 ≤ 2MB（微信硬性）、总包 ≤ 20MB（普通账号）
 *   - 单文件体积、文件总数、垃圾文件（.DS_Store 等）
 *   - JSON 语法、页面文件是否齐全
 *   - H5_URL 是否已配置
 * 报告写入 build/mp-size-report.json；硬性违规时退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MP_DIR = path.join(ROOT, 'miniprogram');
const H5_DIR = path.join(ROOT, 'dist');
const REPORT_DIR = path.join(ROOT, 'build');

// 微信官方上限
const MAIN_LIMIT = 2 * 1024 * 1024;      // 主包 2MB（硬性）
const MAIN_SOFT = 1.95 * 1024 * 1024;    // 主包软阈值（留缓冲）
const TOTAL_LIMIT = 20 * 1024 * 1024;    // 总包 20MB（普通账号；服务商 30MB）
const FILE_WARN = 300 * 1024;            // 单文件超 300KB 提示
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep']);

const urlArgRaw = (process.argv.find((a) => a.startsWith('--url=')) || '').slice(6);
const hasUrlArg = process.argv.some((a) => a.startsWith('--url='));
const problems = [];
const warnings = [];

const human = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

function fail(msg) { problems.push(msg); }
function warn(msg) { warnings.push(msg); }

/* ---------- 0. 可选：写入 H5 地址 ---------- */
if (hasUrlArg) {
  const cfgPath = path.join(MP_DIR, 'utils', 'config.js');
  let src = fs.readFileSync(cfgPath, 'utf8');
  src = src.replace(/const H5_URL = ('[^']*'|"[^"]*")?;?/, `const H5_URL = '${urlArgRaw.replace(/'/g, '')}';`);
  fs.writeFileSync(cfgPath, src);
  console.log(`✅ 已写入 H5_URL = ${urlArgRaw || '(空，未配置)'}\n`);
}

/* ---------- 1. 结构校验 ---------- */
const REQUIRED = [
  'app.js', 'app.json', 'app.wxss', 'sitemap.json',
  'project.config.json', 'project.private.config.json',
  'utils/config.js'
];
for (const rel of REQUIRED) {
  if (!fs.existsSync(path.join(MP_DIR, rel))) fail(`缺少必需文件：${rel}`);
}

let appJson = null;
try {
  appJson = JSON.parse(fs.readFileSync(path.join(MP_DIR, 'app.json'), 'utf8'));
} catch (e) {
  fail(`app.json 不是合法 JSON：${e.message}`);
}

const pages = (appJson && Array.isArray(appJson.pages)) ? appJson.pages : [];
if (!pages.length) fail('app.json 缺少 pages');

const missingExt = ['.js', '.wxml', '.json'];
for (const p of pages) {
  for (const ext of missingExt) {
    if (!fs.existsSync(path.join(MP_DIR, `${p}${ext}`))) fail(`页面 ${p} 缺少 ${p}${ext}`);
  }
  if (!fs.existsSync(path.join(MP_DIR, `${p}.wxss`))) warn(`页面 ${p} 没有 ${p}.wxss（可省略）`);
}

for (const f of ['app.json', 'sitemap.json', 'project.config.json', 'project.private.config.json']) {
  const p = path.join(MP_DIR, f);
  if (!fs.existsSync(p)) continue;
  try { JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { fail(`${f} JSON 语法错误：${e.message}`); }
}

let appid = 'touristappid';
try {
  const pc = JSON.parse(fs.readFileSync(path.join(MP_DIR, 'project.config.json'), 'utf8'));
  appid = pc.appid || 'touristappid';
} catch { /* 已在上面报错 */ }
if (appid === 'touristappid') {
  warn('appid 仍是 touristappid（游客模式）：真机预览/上传前要在 project.config.json 里换成自己的 AppID');
}

/* ---------- 2. H5_URL 配置检查 ---------- */
let h5Url = '';
try {
  const cfg = fs.readFileSync(path.join(MP_DIR, 'utils', 'config.js'), 'utf8');
  const m = cfg.match(/const H5_URL = '([^']*)'/);
  h5Url = (m && m[1]) || '';
} catch { /* 结构校验已报 */ }
if (!h5Url) warn('H5_URL 未配置：编译/上传可通过，但真机会进入配置引导页');
else if (!h5Url.startsWith('https://')) fail(`H5_URL 必须是 https:// 开头，当前：${h5Url}`);

/* ---------- 3. 体积统计 ---------- */
function walk(dir, base = MP_DIR) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(base, full);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push({ rel: rel.split(path.sep).join('/'), size: st.size, junk: JUNK.has(name) });
  }
  return out;
}

const files = fs.existsSync(MP_DIR) ? walk(MP_DIR) : [];
if (!files.length) fail(`小程序目录不存在或为空：${MP_DIR}`);

const totalSize = files.reduce((s, f) => s + f.size, 0);
const junkFiles = files.filter((f) => f.junk);
if (junkFiles.length) warn(`发现垃圾文件（已配置 packOptions.ignore，不会上传）：${junkFiles.map((f) => f.rel).join(', ')}`);

const bigFiles = files.filter((f) => f.size > FILE_WARN).sort((a, b) => b.size - a.size);
for (const f of bigFiles) warn(`单文件偏大 ${f.rel} = ${human(f.size)}（阈值 ${human(FILE_WARN)}，考虑挪到 CDN）`);

if (totalSize > MAIN_LIMIT) fail(`主包超限：${human(totalSize)} > 上限 ${human(MAIN_LIMIT)}`);
else if (totalSize > MAIN_SOFT) warn(`主包接近上限：${human(totalSize)} / ${human(MAIN_LIMIT)}`);
if (totalSize > TOTAL_LIMIT) fail(`总包超限：${human(totalSize)} > 上限 ${human(TOTAL_LIMIT)}`);
if (files.length > 3000) warn(`文件数偏多：${files.length} 个（微信对包内文件数有隐性限制，建议精简）`);

/* ---------- 4. H5 产物体积（供部署参考，不进小程序包） ---------- */
let h5Report = null;
if (fs.existsSync(H5_DIR)) {
  const h5Files = walk(H5_DIR, H5_DIR);
  const sum = (pred) => h5Files.filter(pred).reduce((s, f) => s + f.size, 0);
  h5Report = {
    total: h5Files.reduce((s, f) => s + f.size, 0),
    ai: sum((f) => f.rel.startsWith('ai/')),
    js: sum((f) => f.rel.startsWith('js/')),
    assets: sum((f) => f.rel.startsWith('assets/')),
    other: sum((f) => !['ai/', 'js/', 'assets/'].some((p) => f.rel.startsWith(p)))
  };
  if (h5Report.ai > 5 * 1024 * 1024) {
    warn(`H5 里 public/ai 有 ${human(h5Report.ai)}（AI 模型）：必须部署在 CDN/静态托管，不能也不需要放进小程序包`);
  }
}

/* ---------- 5. 输出报告 ---------- */
const top = [...files].sort((a, b) => b.size - a.size).slice(0, 10);
const report = {
  generatedAt: new Date().toISOString(),
  appid,
  h5Url: h5Url || null,
  pages,
  miniprogram: {
    path: path.relative(ROOT, MP_DIR),
    fileCount: files.length,
    mainPackageBytes: totalSize,
    mainPackageLimitBytes: MAIN_LIMIT,
    totalPackageLimitBytes: TOTAL_LIMIT,
    topFiles: top.map((f) => ({ file: f.rel, size: f.size }))
  },
  h5Dist: h5Report,
  warnings,
  problems
};
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(path.join(REPORT_DIR, 'mp-size-report.json'), JSON.stringify(report, null, 2));

console.log('━'.repeat(56));
console.log('📦 BossMonitor 小程序上传前体检');
console.log('━'.repeat(56));
console.log(`appid        : ${appid}`);
console.log(`页面         : ${pages.join(', ')}`);
console.log(`主包体积     : ${human(totalSize)} / 上限 ${human(MAIN_LIMIT)}  ${totalSize <= MAIN_LIMIT ? '✅' : '❌'}`);
console.log(`总包体积     : ${human(totalSize)} / 上限 ${human(TOTAL_LIMIT)}  ✅`);
console.log(`文件数       : ${files.length}`);
if (h5Report) {
  console.log('─'.repeat(56));
  console.log(`H5 产物（远端托管，不进小程序包）：合计 ${human(h5Report.total)}`);
  console.log(`   AI 模型 ${human(h5Report.ai)} | 播放器/脚本 ${human(h5Report.js)} | 前端资源 ${human(h5Report.assets)} | 其他 ${human(h5Report.other)}`);
}
if (top.length) {
  console.log('─'.repeat(56));
  console.log('包内体积 TOP：');
  for (const f of top) console.log(`   ${human(f.size).padStart(10)}  ${f.rel}`);
}
if (warnings.length) {
  console.log('─'.repeat(56));
  for (const w of warnings) console.log(`⚠️  ${w}`);
}
if (problems.length) {
  console.log('─'.repeat(56));
  for (const p of problems) console.log(`❌ ${p}`);
  console.log('━'.repeat(56));
  console.log('结论：存在硬性违规，先修复再上传。报告：build/mp-size-report.json');
  process.exit(1);
}
console.log('━'.repeat(56));
console.log('结论：符合微信上传规范，可用微信开发者工具打开 miniprogram/ 上传。报告：build/mp-size-report.json');
