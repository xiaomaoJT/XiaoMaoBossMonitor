/**
 * 企业微信群机器人推送
 * ----------------------------------------------------------------------------
 * 接口：POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 * 消息类型：text / markdown / image / news / file / template_card
 *   - markdown 支持 # 标题、**加粗**、> 引用、<font color="info"></font>
 *   - image 直接收 base64 + md5（< 2MB），**不需要公网图床**，和 Telegram 一样能发截图
 *
 * 跨域：qyapi.weixin.qq.com 同样不返回 CORS 头，
 *   - 浏览器 / Electron → 同源前缀 /wecom-bot（vite 代理或 Electron 主进程代理）
 *   - iOS / Android 原生壳（Capacitor）→ 直连官方域名，走原生网络栈
 *
 * 限制：每个机器人 20 条/分钟，单条 image 必须 < 2MB（超限自动压缩）。
 */

import { timeoutSignal } from './useNet.js'
import { normalizeEvents } from './useAlarmText.js'

const WECOM_ORIGIN = 'https://qyapi.weixin.qq.com'
const PROXY_PREFIX = '/wecom-bot'
const IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** 请求设上限，避免网络黑洞让事件永远停在「正在推送」 */
const API_TIMEOUT_MS = 20000

/* ==================== 运行环境（与钉钉共用同一套判断） ==================== */

function runtime() {
  if (typeof window === 'undefined') return 'web'
  const shell = window.__MONITOR_SHELL__
  if (shell && shell.runtime) return shell.runtime
  const cap = window.Capacitor
  if (cap) {
    if (typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return 'capacitor'
    if (cap.platform && cap.platform !== 'web') return 'capacitor'
  }
  return 'web'
}

export function wecomBase(cfg) {
  const custom = cfg && String(cfg.proxyBase || '').trim()
  if (custom) return custom.replace(/\/+$/, '')
  if (runtime() === 'capacitor') return WECOM_ORIGIN
  return PROXY_PREFIX
}

/** 支持只填 key（自动补全前缀），也支持完整 webhook */
export function normalizeWeComWebhook(raw) {
  let v = String(raw || '').trim()
  if (!v) return ''
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    return `${WECOM_ORIGIN}/cgi-bin/webhook/send?key=${v}`
  }
  if (!/^https?:\/\//i.test(v) && /^[0-9a-f-]{16,}$/i.test(v)) {
    return `${WECOM_ORIGIN}/cgi-bin/webhook/send?key=${v}`
  }
  return v
}

function buildTarget(cfg) {
  const url = normalizeWeComWebhook(cfg && cfg.webhook)
  if (!url) return ''
  const base = wecomBase(cfg)
  if (/^https?:\/\//i.test(base)) {
    // 把官方域名换成代理基地址（保留 pathname + query）
    const u = new URL(url)
    return `${base}${u.pathname}${u.search}`
  }
  const origin = typeof location !== 'undefined' ? location.origin : ''
  const u = new URL(url)
  return `${origin}${base}${u.pathname}${u.search}`
}

/* ==================== MD5（WebCrypto 不支持，自己实现） ==================== */

function md5(bytes) {
  const rl = (n, c) => (n << c) | (n >>> (32 - c))
  const au = (x, y) => {
    const l = (x & 0xffff) + (y & 0xffff)
    return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff)
  }
  const cm = (q, a, b, x, s, t) => au(rl(au(au(a, q), au(x, t)), s), b)
  const ff = (a, b, c, d, x, s, t) => cm((b & c) | (~b & d), a, b, x, s, t)
  const gg = (a, b, c, d, x, s, t) => cm((b & d) | (c & ~d), a, b, x, s, t)
  const hh = (a, b, c, d, x, s, t) => cm(b ^ c ^ d, a, b, x, s, t)
  const ii = (a, b, c, d, x, s, t) => cm(c ^ (b | ~d), a, b, x, s, t)

  const len = bytes.length
  const words = []
  for (let i = 0; i < len; i += 1) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8))
  words[len >> 2] = (words[len >> 2] || 0) | (0x80 << ((len % 4) * 8))
  const nBlocks = (((len + 8) >> 6) + 1) * 16
  for (let i = (len >> 2) + 2; i < nBlocks; i += 1) words[i] = 0
  // 末尾 8 字节是「原始比特长度」的小端表示：低 32 位在前、高 32 位在后。
  // （写在 nBlocks-1 上等于把长度左移 32 位，算出来的摘要必然不对。）
  words[nBlocks - 2] = (len * 8) >>> 0
  words[nBlocks - 1] = Math.floor((len * 8) / 4294967296)

  let a = 1732584193
  let b = -271733879
  let c = -1732584194
  let d = 271733878
  const x = new Array(16)

  for (let i = 0; i < nBlocks; i += 16) {
    for (let j = 0; j < 16; j += 1) x[j] = words[i + j] | 0
    const [oa, ob, oc, od] = [a, b, c, d]

    a = ff(a, b, c, d, x[0], 7, -680876936)
    d = ff(d, a, b, c, x[1], 12, -389564586)
    c = ff(c, d, a, b, x[2], 17, 606105819)
    b = ff(b, c, d, a, x[3], 22, -1044525330)
    a = ff(a, b, c, d, x[4], 7, -176418897)
    d = ff(d, a, b, c, x[5], 12, 1200080426)
    c = ff(c, d, a, b, x[6], 17, -1473231341)
    b = ff(b, c, d, a, x[7], 22, -45705983)
    a = ff(a, b, c, d, x[8], 7, 1770035416)
    d = ff(d, a, b, c, x[9], 12, -1958414417)
    c = ff(c, d, a, b, x[10], 17, -42063)
    b = ff(b, c, d, a, x[11], 22, -1990404162)
    a = ff(a, b, c, d, x[12], 7, 1804603682)
    d = ff(d, a, b, c, x[13], 12, -40341101)
    c = ff(c, d, a, b, x[14], 17, -1502002290)
    b = ff(b, c, d, a, x[15], 22, 1236535329)

    a = gg(a, b, c, d, x[1], 5, -165796510)
    d = gg(d, a, b, c, x[6], 9, -1069501632)
    c = gg(c, d, a, b, x[11], 14, 643717713)
    b = gg(b, c, d, a, x[0], 20, -373897302)
    a = gg(a, b, c, d, x[5], 5, -701558691)
    d = gg(d, a, b, c, x[10], 9, 38016083)
    c = gg(c, d, a, b, x[15], 14, -660478335)
    b = gg(b, c, d, a, x[4], 20, -405537848)
    a = gg(a, b, c, d, x[9], 5, 568446438)
    d = gg(d, a, b, c, x[14], 9, -1019803690)
    c = gg(c, d, a, b, x[3], 14, -187363961)
    b = gg(b, c, d, a, x[8], 20, 1163531501)
    a = gg(a, b, c, d, x[13], 5, -1444681467)
    d = gg(d, a, b, c, x[2], 9, -51403784)
    c = gg(c, d, a, b, x[7], 14, 1735328473)
    b = gg(b, c, d, a, x[12], 20, -1926607734)

    a = hh(a, b, c, d, x[5], 4, -378558)
    d = hh(d, a, b, c, x[8], 11, -2022574463)
    c = hh(c, d, a, b, x[11], 16, 1839030562)
    b = hh(b, c, d, a, x[14], 23, -35309556)
    a = hh(a, b, c, d, x[1], 4, -1530992060)
    d = hh(d, a, b, c, x[4], 11, 1272893353)
    c = hh(c, d, a, b, x[7], 16, -155497632)
    b = hh(b, c, d, a, x[10], 23, -1094730640)
    a = hh(a, b, c, d, x[13], 4, 681279174)
    d = hh(d, a, b, c, x[0], 11, -358537222)
    c = hh(c, d, a, b, x[3], 16, -722521979)
    b = hh(b, c, d, a, x[6], 23, 76029189)
    a = hh(a, b, c, d, x[9], 4, -640364487)
    d = hh(d, a, b, c, x[12], 11, -421815835)
    c = hh(c, d, a, b, x[15], 16, 530742520)
    b = hh(b, c, d, a, x[2], 23, -995338651)

    a = ii(a, b, c, d, x[0], 6, -198630844)
    d = ii(d, a, b, c, x[7], 10, 1126891415)
    c = ii(c, d, a, b, x[14], 15, -1416354905)
    b = ii(b, c, d, a, x[5], 21, -57434055)
    a = ii(a, b, c, d, x[12], 6, 1700485571)
    d = ii(d, a, b, c, x[3], 10, -1894986606)
    c = ii(c, d, a, b, x[10], 15, -1051523)
    b = ii(b, c, d, a, x[1], 21, -2054922799)
    a = ii(a, b, c, d, x[8], 6, 1873313359)
    d = ii(d, a, b, c, x[15], 10, -30611744)
    c = ii(c, d, a, b, x[6], 15, -1560198380)
    b = ii(b, c, d, a, x[13], 21, 1309151649)
    a = ii(a, b, c, d, x[4], 6, -145523070)
    d = ii(d, a, b, c, x[11], 10, -1120210379)
    c = ii(c, d, a, b, x[2], 15, 718787259)
    b = ii(b, c, d, a, x[9], 21, -343485551)

    a = au(a, oa)
    b = au(b, ob)
    c = au(c, oc)
    d = au(d, od)
  }

  /** 32 位整数 → 8 位小写十六进制（注意：一个 word 只有 4 字节，
   *  每个字节取 (n >>> i*8) & 0xff 补成两位，别把高低半字节各补一次）。 */
  const hex = (n) => {
    let s = ''
    for (let i = 0; i < 4; i += 1) {
      s += `0${((n >>> (i * 8)) & 0xff).toString(16)}`.slice(-2)
    }
    return s
  }
  return hex(a) + hex(b) + hex(c) + hex(d)
}

/* ==================== 压缩图片到 2MB 以内 ==================== */

function dataUrlToBytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || ''
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * 字节数组 → base64。
 * ⚠️ 千万别写 btoa(String.fromCharCode(...bytes))：展开运算符会把每个字节
 * 都变成一个函数实参，十几万个参数就足以撑爆调用栈，直接抛
 * 「Maximum call stack size exceeded」——一张 3200×1800 的截图必然超。
 * 这里分块处理，任意大小都不会出问题。
 */
function bytesToBase64(bytes) {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

async function shrinkImage(dataUrl, maxBytes = IMAGE_MAX_BYTES) {
  let cur = dataUrl
  let bytes = dataUrlToBytes(cur)
  if (bytes.length <= maxBytes) return { dataUrl: cur, bytes }

  // 先解码，再逐档缩小 + 降质量
  const img = await new Promise((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('截图解码失败'))
    i.src = cur
  })
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const qualities = [0.85, 0.75, 0.6, 0.5]
  for (const scale of [1, 0.75, 0.5, 0.35]) {
    canvas.width = Math.max(320, Math.round(img.naturalWidth * scale))
    canvas.height = Math.round((img.naturalHeight * canvas.width) / img.naturalWidth)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    for (const q of qualities) {
      const out = canvas.toDataURL('image/jpeg', q)
      const b = dataUrlToBytes(out)
      if (b.length <= maxBytes) return { dataUrl: out, bytes: b }
      cur = out
      bytes = b
    }
  }
  return { dataUrl: cur, bytes }
}

/* ==================== 发送 ==================== */

/**
 * 发送一条企业微信消息
 * @param {object} cfg { webhook, proxyBase }
 * @param {object} msg { msgType: 'markdown'|'text', content, atAll, atMobiles }
 */
export async function sendWeCom(cfg, msg) {
  const target = buildTarget(cfg)
  if (!target) throw new Error('未配置企业微信机器人 Webhook 地址')

  const body = { msgtype: msg.msgType || 'markdown' }
  if (body.msgtype === 'text') {
    body.text = { content: msg.content || '' }
    const mobiles = Array.isArray(msg.atMobiles)
      ? msg.atMobiles
      : String(msg.atMobiles || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
    if (msg.atAll) body.text.mentioned_list = ['@all']
    if (mobiles.length) body.text.mentioned_mobile_list = mobiles
  } else {
    body.markdown = { content: msg.content || '' }
  }

  let res
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(API_TIMEOUT_MS)
    })
  } catch (e) {
    throw new Error(`${(e && e.message) || '网络请求失败'}（若为跨域错误，请检查代理配置）`)
  }

  let data = null
  try {
    data = await res.json()
  } catch (e) {
    throw new Error(`企业微信返回内容无法解析（HTTP ${res.status}）`)
  }
  if (data.errcode !== 0) {
    throw new Error(`企业微信返回错误 ${data.errcode}：${data.errmsg || '未知错误'}`)
  }
  return data
}

/** 发送报警截图（image 消息，自动压缩到 2MB 内） */
export async function sendWeComImage(cfg, dataUrl) {
  if (!dataUrl) return null
  const { bytes } = await shrinkImage(dataUrl)
  const target = buildTarget(cfg)
  let res
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'image',
        image: { base64: bytesToBase64(bytes), md5: md5(bytes) }
      }),
      signal: timeoutSignal(API_TIMEOUT_MS)
    })
  } catch (e) {
    throw new Error(`${(e && e.message) || '网络请求失败'}`)
  }
  const data = await res.json().catch(() => null)
  if (!data || data.errcode !== 0) {
    throw new Error(`企业微信图片推送失败 ${data ? data.errcode : res.status}：${(data && data.errmsg) || ''}`)
  }
  return data
}

/** 报警推送：markdown 文本 + 可选截图（截图算第二条消息）
 *  返回 { text, shotError }：文字消息失败会抛错，图片失败只记录原因，
 *  因为文字其实已经送达了，不该把整条推送判为失败。 */
export async function sendWeComAlarm(cfg, { content, shot }) {
  const r1 = await sendWeCom(cfg, { msgType: cfg.msgType || 'markdown', content })
  if (cfg.screenshotMode === 'image' && shot) {
    try {
      await sendWeComImage(cfg, shot)
    } catch (e) {
      return { text: r1, shotError: (e && e.message) || '未知错误' }
    }
  }
  return { text: r1, shotError: '' }
}

/** 兼容旧版配置 */
export function normalizeWeCom(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg
  if (!Array.isArray(cfg.cameras)) cfg.cameras = []
  // 事件分组补齐到当前的 6 组（旧配置里只有 motion / person 两项）
  cfg.events = normalizeEvents(cfg.events)
  if (typeof cfg.minIntervalSec !== 'number') cfg.minIntervalSec = 30
  if (typeof cfg.rateLimitPerMin !== 'number') cfg.rateLimitPerMin = 18
  if (!cfg.overflowMode) cfg.overflowMode = 'merge'
  if (!cfg.msgType) cfg.msgType = 'markdown'
  if (!cfg.titlePrefix) cfg.titlePrefix = '【监控报警】'
  if (!cfg.fields) cfg.fields = {}
  // 推送消息模板：空串 = 用内置默认模板（见 useMessageTemplate.js）
  if (typeof cfg.template !== 'string') cfg.template = ''
  if (!cfg.statusAlerts) cfg.statusAlerts = { enabled: true, notifyRecover: true, repeatMinutes: 10 }
  if (!cfg.patrol) cfg.patrol = { enabled: true, intervalMinutes: 30, onlyWhenAbnormal: false, includeAll: true }
  return cfg
}
