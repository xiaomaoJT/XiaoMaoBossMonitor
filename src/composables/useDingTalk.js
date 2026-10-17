/**
 * 钉钉群机器人推送（加签 + 详细报警内容 + 事件截图）
 *
 * 安全设置「加签」：
 *   sign = urlEncode(base64(HMAC-SHA256(timestamp + "\n" + secret, secret)))
 *   完整地址 = webhook & timestamp=xxx & sign=xxx
 *
 * oapi.dingtalk.com 没有 CORS 响应头，浏览器直连会被拦。
 * 不同运行环境用不同绕行方案（见 dingTalkBase()）：
 *   - 普通浏览器 / Electron 桌面端 → 同源前缀 /dingtalk-robot/**
 *     （开发时由 vite proxy 转发；打包后由 Electron 主进程的 app:// 协议处理器转发）
 *   - iOS / Android 原生壳（Capacitor）→ 直连官方域名，
 *     由 CapacitorHttp 插件用原生网络栈发请求，天然不受 CORS 限制
 *   - 也可在设置里手填 proxyBase 指向自建反向代理 / 云函数
 *
 * 关于事件截图：钉钉自定义机器人的 markdown 图片必须是「公网可访问的 http(s) 地址」，
 * 因此需要配置一个图片上传接口（返回图片 URL），未配置时消息里只提示截图已记录在本地。
 */
import { timeoutSignal } from './useNet.js'
import {
  alarmDetail,
  alarmLabel,
  alarmTitle,
  countText,
  dwellText,
  extraText,
  featureText,
  normalizeEvents
} from './useAlarmText.js'
import { runtimeLine } from './useDeviceInfo.js'
import { BRAND, digestIntervalLabel, silentOverlapSegments } from '../config/defaults.js'
import { collectAlarmVars, renderTemplate, DEFAULT_DING_TEMPLATE } from './useMessageTemplate.js'

const PROXY_PREFIX = '/dingtalk-robot'
const DINGTALK_ORIGIN = 'https://oapi.dingtalk.com'
/** 请求 / 上传都设上限，避免网络黑洞让事件永远停在「正在推送」 */
const API_TIMEOUT_MS = 20000
const UPLOAD_TIMEOUT_MS = 45000
const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

const FIELD_LABELS = {
  camera: '通道',
  cameraId: '通道编号',
  time: '时间',
  type: '事件类型',
  ratio: '变动幅度',
  confidence: '置信度',
  resolution: '分辨率',
  bitrate: '码率/帧率',
  url: '流地址',
  roi: '检测区域',
  seq: '事件序号',
  screenshot: '事件截图'
}

export const FIELD_KEYS = Object.keys(FIELD_LABELS)
export const fieldLabel = (k) => FIELD_LABELS[k] || k

/* ==================== 加签 / 地址 ==================== */

export async function buildSignedUrl(webhook, secret) {
  const url = String(webhook || '').trim()
  if (!url) throw new Error('未配置钉钉机器人 Webhook 地址')
  if (!secret) return url

  const timestamp = Date.now()
  const signature = await hmacSha256Base64(secret, `${timestamp}\n${secret}`)
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(signature)}`
}

async function hmacSha256Base64(key, message) {
  const subtle = window.crypto && window.crypto.subtle
  if (!subtle) throw new Error('当前环境不支持 WebCrypto 加签，请用 https 或 localhost 访问')
  const enc = new TextEncoder()
  const cryptoKey = await subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const buf = await subtle.sign('HMAC', cryptoKey, enc.encode(message))
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/* ==================== 运行环境探测 ==================== */

/**
 * 当前跑在哪儿：
 *   'electron'  → Electron 桌面客户端（主进程内置了钉钉代理）
 *   'capacitor' → iOS / Android 原生壳（CapacitorHttp 原生请求，无需代理）
 *   'web'       → 普通浏览器 / 小程序 web-view
 */
export function detectRuntime() {
  if (typeof window === 'undefined') return 'web'
  const shell = window.__MONITOR_SHELL__
  if (shell && shell.runtime) return shell.runtime
  const cap = window.Capacitor
  if (cap) {
    if (typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) return 'capacitor'
    if (cap.platform && cap.platform !== 'web') return 'capacitor'
    if (typeof cap.getPlatform === 'function' && cap.getPlatform() !== 'web') return 'capacitor'
  }
  return 'web'
}

/** 钉钉请求应该打到哪个基地址 */
export function dingTalkBase(cfg) {
  const custom = cfg && String(cfg.proxyBase || '').trim()
  if (custom) return custom.replace(/\/+$/, '')
  if (detectRuntime() === 'capacitor') return DINGTALK_ORIGIN
  return PROXY_PREFIX
}

export function toProxyUrl(fullUrl, cfg) {
  try {
    const u = new URL(fullUrl)
    if (!/(^|\.)dingtalk\.com$/i.test(u.hostname)) return fullUrl
    const base = dingTalkBase(cfg)
    if (/^https?:\/\//i.test(base)) return `${base}${u.pathname}${u.search}`
    /*
     * 浏览器里用同源前缀转发（vite dev / Electron / 便携版 serve-static / 后端 8787 都各有一份）。
     * Node（后端常驻检测服务）里没有 location —— 硬拼出来的是相对路径，
     * fetch 会直接抛「Failed to parse URL from /dingtalk-robot/robot/send?…」。
     * Node 侧不存在 CORS 限制，所以这里直接回到官方域名发请求，
     * 这也正是「关掉页面、只留后端」时该走的路径。
     */
    const origin = typeof location !== 'undefined' ? location.origin : ''
    if (!origin || origin === 'null') return fullUrl
    return `${origin}${base}${u.pathname}${u.search}`
  } catch (e) {
    return fullUrl
  }
}

/* ==================== 发送 ==================== */

/**
 * 发送钉钉消息
 * @param {object} cfg { webhook, secret, useProxy }
 * @param {object} msg { title, text, msgType: 'markdown'|'text', atAll, atMobiles }
 */
export async function sendDingTalk(cfg, msg) {
  const signed = await buildSignedUrl(cfg.webhook, cfg.secret)
  const target = cfg.useProxy === false ? signed : toProxyUrl(signed, cfg)
  const at = {
    isAtAll: !!msg.atAll,
    atMobiles: Array.isArray(msg.atMobiles) ? msg.atMobiles : []
  }

  const payload =
    msg.msgType === 'text'
      ? { msgtype: 'text', text: { content: msg.text || '' }, at }
      : {
          msgtype: 'markdown',
          markdown: { title: msg.title || '监控报警', text: msg.text || '' },
          at
        }

  let res
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: timeoutSignal(API_TIMEOUT_MS)
    })
  } catch (e) {
    throw new Error(
      `${(e && e.message) || '网络请求失败'}（若为跨域错误，请开启「使用本地代理」）`
    )
  }

  let data = null
  try {
    data = await res.json()
  } catch (e) {
    throw new Error(`钉钉返回内容无法解析（HTTP ${res.status}）`)
  }
  if (data.errcode !== 0) {
    throw new Error(`钉钉返回错误 ${data.errcode}：${data.errmsg || '未知错误'}`)
  }
  return data
}

/* ==================== 事件截图上传（可选） ==================== */

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = String(dataUrl).split(',')
  const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
  const binary = atob(b64 || '')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * 把截图上传到自定义接口，返回可公网访问的图片地址
 * 兼容常见返回：{url} / {data:{url}} / {data:{link}} / {result:{url}} / 纯文本 URL
 */
export async function uploadScreenshot(dataUrl, cfg) {
  if (!cfg || !cfg.uploadUrl) throw new Error('未配置截图上传接口')
  const blob = dataUrlToBlob(dataUrl)
  const name = `alarm-${Date.now()}.jpg`
  const form = new FormData()
  form.append(cfg.uploadField || 'file', blob, name)
  if (cfg.uploadExtra) {
    try {
      const extra = JSON.parse(cfg.uploadExtra)
      Object.keys(extra).forEach((k) => form.append(k, extra[k]))
    } catch (e) {
      /* 额外参数不是合法 JSON 时忽略 */
    }
  }

  const res = await fetch(cfg.uploadUrl, {
    method: 'POST',
    body: form,
    signal: timeoutSignal(UPLOAD_TIMEOUT_MS)
  })
  const text = await res.text()
  let url = ''
  try {
    const json = JSON.parse(text)
    url =
      json.url ||
      (json.data && (json.data.url || json.data.link || json.data)) ||
      (json.result && (json.result.url || json.result)) ||
      ''
  } catch (e) {
    url = /^https?:\/\//.test(text.trim()) ? text.trim() : ''
  }
  if (!url || !/^https?:\/\//.test(url)) throw new Error('上传接口未返回可用的图片地址')
  return url
}

/* ==================== 文案拼装 ==================== */

function pad(n) {
  return String(n).padStart(2, '0')
}

export function formatTime(ts, withWeek = true) {
  const d = new Date(ts)
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`
  return withWeek ? `${base}（${WEEK[d.getDay()]}）` : base
}

const typeText = (t) => alarmLabel(t)

/** 组装事件字段列表（返回 [{label, value}]，按勾选顺序过滤）
 *  screenshotUrl —— 图片直链：钉钉 markdown 会 ![]() 渲染成图片
 *  linkUrl       —— 非图片的跳转链接（例如 Telegram 消息链接），只能放成可点击文字
 *  两者互斥：有图片就嵌图，没图片但有链接就放链接，都没有就只留一句本地留存提示。
 */
export function buildEventFields(record, cfg, screenshotUrl, linkUrl) {
  const on = (cfg && cfg.fields) || {}
  const enabled = (k) => on[k] !== false
  const rows = []

  if (enabled('camera')) rows.push({ label: '通道', value: record.name || '未命名通道' })
  if (enabled('cameraId')) rows.push({ label: '通道编号', value: record.id || '-' })
  if (enabled('time')) rows.push({ label: '时间', value: formatTime(record.time) })
  if (enabled('type')) rows.push({ label: '事件类型', value: alarmDetail(record) })

  /*
   * ============ 附加分析（人脸 / 姿态 / 区域 / 计数）============
   *
   * 用户要求：「开了啥推送信息就要加上啥，没开就展示该功能状态未开启」。
   * 所以这里分两层：
   *   1) 功能状态 —— 四项的开关快照，**总是输出**，没开的显式写「未开启」；
   *      收到消息就能立刻判断"怎么没识别到人脸"，不用回设置页翻。
   *   2) 明细 —— 只在「事件类型」那一行说不全的时候才单独成行。
   *      人脸事件的事件类型本身就是「人脸识别（张三 · 81%）」，
   *      再单列一行「人脸」就是同一句话在一条消息里说三遍。
   */
  if (Array.isArray(record.features) && record.features.length) {
    rows.push({ label: '功能状态', value: featureText(record.features) })
  }
  const T = record.type
  if (T !== 'face' && (record.faceName || Number(record.faceScore) > 0)) {
    rows.push({
      label: '人脸',
      value: record.faceName
        ? `${record.faceName}（相似度 ${Math.round((Number(record.faceScore) || 0) * 100)}%）`
        : '未录入的人脸'
    })
  }
  if (T !== 'pose' && record.actionText) rows.push({ label: '姿态', value: record.actionText })
  if (!['enter', 'exit', 'loiter'].includes(T) && record.zoneName) {
    rows.push({ label: '区域', value: record.zoneName })
  }
  // 事件类型行里已经带了人数数字，就不重复一行
  if (T !== 'count' && record.counts) rows.push({ label: '人数统计', value: countText(record.counts) })
  // 停留时长是「事件类型」没说到的部分，任何事件只要有就补
  if (Number(record.dwellMs) > 0) rows.push({ label: '停留时长', value: dwellText(record.dwellMs) })
  // 兜底：未来新增的事件类型（上面几支都没覆盖）至少把采集端给的文字带上
  const known = ['motion', 'person', 'face', 'enter', 'exit', 'loiter', 'pose', 'count']
  if (!known.includes(T) && record.text && record.text !== alarmDetail(record)) {
    rows.push({ label: '详情', value: record.text })
  }
  if (enabled('confidence') && record.type === 'person') {
    rows.push({ label: '置信度', value: `${(Number(record.ratio) * 100).toFixed(0)}%` })
  }
  // 变动幅度只对画面移动有意义，其它事件 ratio 恒为 0，不要输出「0.00%」误导人
  if (enabled('ratio') && record.type !== 'person' && Number(record.ratio) > 0) {
    rows.push({ label: '变动幅度', value: `${(Number(record.ratio) * 100).toFixed(2)}%` })
  }
  if (enabled('resolution') && record.resolution) rows.push({ label: '分辨率', value: record.resolution })
  if (enabled('bitrate')) {
    const parts = []
    if (record.kbps) parts.push(`${(record.kbps / 8).toFixed(0)} KB/s`)
    if (record.fps) parts.push(`${record.fps} fps`)
    if (record.fps || record.kbps) rows.push({ label: '码率/帧率', value: parts.join(' · ') })
  }
  if (enabled('roi')) {
    const r = record.roi
    rows.push({
      label: '检测区域',
      value: r
        ? `x ${(r.x * 100).toFixed(0)}% · y ${(r.y * 100).toFixed(0)}% · 宽 ${(r.w * 100).toFixed(0)}% · 高 ${(
            r.h * 100
          ).toFixed(0)}%`
        : '全画面'
    })
  }
  if (enabled('url') && record.url) rows.push({ label: '流地址', value: record.url })
  if (enabled('seq') && record.seq) rows.push({ label: '事件序号', value: `#${record.seq}` })
  // 多端同时在线时，靠这一行分辨消息是哪个端发出来的
  if (enabled('device')) rows.push({ label: '运行设备', value: runtimeLine(BRAND) })
  if (enabled('screenshot')) {
    if (screenshotUrl) {
      rows.push({ label: '事件截图', value: '见下方图片' })
    } else if (record.thumb) {
      rows.push({ label: '事件截图', value: '已记录（可在本地事件面板查看原图）' })
    }
  }
  return rows
}

/**
 * 单条事件消息
 *
 * markdown 模式走**可配置模板**（cfg.template，空 = 默认模板）：
 * 上下两段式排版、功能状态用 ✅/❌ 表示，见 useMessageTemplate.js。
 * text 模式保持旧的紧凑排版 —— 模板是 markdown 写的，转纯文本会失去层级。
 *
 * @param {string} [note] 附加提醒（目前用于「本分钟推送额度即将用尽」），会放在正文最前面
 */
export function buildAlarmMessage(record, cfg, screenshotUrl, linkUrl, note) {
  const prefix = (cfg && cfg.titlePrefix) || '【监控报警】'
  const title = `${prefix}${alarmTitle(record)} · ${record.name}`
  const time = formatTime(record.time)

  if (cfg && cfg.msgType === 'text') {
    const rows = buildEventFields(record, cfg, screenshotUrl, linkUrl)
    const lines = [`${prefix}${record.name} ${typeText(record.type)}`, time, '------------']
    if (note) lines.push(note)
    rows.forEach((r) => lines.push(`${r.label}：${r.value}`))
    if (screenshotUrl) lines.push(`事件截图：${screenshotUrl}`)
    // ⚠️ 链接「必须带上」：不受「事件截图」字段开关影响，拿到就无条件附在末尾。
    // 它指向 Telegram 那条消息，点开就能看到原图。
    if (linkUrl) lines.push(`事件原图：${linkUrl}`)
    return { title, text: lines.join('\n') }
  }

  const vars = collectAlarmVars(record, { cfg, screenshotUrl, linkUrl, note, style: 'md' })
  const tpl = (cfg && cfg.template) || DEFAULT_DING_TEMPLATE
  return { title, text: renderTemplate(tpl, vars) }
}

/** 合并消息（触发钉钉频率上限时使用） */
export function buildMergedMessage(list, cfg) {
  const prefix = (cfg && cfg.titlePrefix) || '【监控报警】'
  const first = list[0]
  const title = `${prefix}${list.length} 条事件汇总`
  const lines = [`### ${prefix}共 ${list.length} 条报警事件`, '', `> 短时间内触发较多，已合并推送（钉钉机器人限制 20 条/分钟）`, '']
  list.slice(0, 30).forEach((r) => {
    const detail = alarmDetail(r)
    const extra = extraText(r) ? ` · ${extraText(r)}` : ''
    lines.push(`- ${formatTime(r.time, false)} · **${r.name}** · ${detail}${extra}`)
  })
  if (list.length > 30) lines.push(`- …另有 ${list.length - 30} 条`)
  lines.push('', `> 由 BossMonitor 实时分析生成 · ${formatTime(first.time)}`)
  return { title, text: lines.join('\n') }
}

/**
 * 静默时段汇总消息（在静默结束时一次性推送，代替期间被收存的所有实时报警）。
 *
 * 用户要求「汇总信息要详尽，比如人数」——所以这里把所有维度都摊开：
 *   总览（总数 / 覆盖通道 / 时段跨度）
 *   人员与识别（人形条数 / 人脸条数 / 已识别具体是谁 / 累计到访人次 / 峰值同时在线）
 *   按通道（每路各多少条，细分类型）
 *   按类型（人形 / 人脸 / 区域 / 移动…）
 *   事件明细（前若干条，带时间 / 通道 / 类型 / 关键细节）
 *
 * @param {Array<object>} records 静默时段内收存的报警记录（见 useAlertPush 的 silentBuffer 快照）
 * @param {object} cfg     options.silent（暂未用，预留给将来按渠道定制）
 * @param {object} ctx     { startMs, endMs } 静默窗口的起止时间戳
 * @returns {{ title:string, markdown:string, plain:string }}
 *   markdown 给钉钉 / 企业微信；plain 给 Telegram（去掉 markdown 标记，避免乱码）
 */
export function buildSilentSummary(records, cfg, ctx = {}) {
  const list = Array.isArray(records) ? records : []
  const total = list.length
  const startMs = ctx.startMs || (total ? Math.min(...list.map((r) => r.time || Date.now())) : Date.now())
  const endMs = ctx.endMs || Date.now()

  /*
   * 措辞变体。`silent`（默认）用于「静默结束汇总」与「静默查岗」；
   * `range` 用于 /collect 这类「按绝对时段回查历史」—— 那时根本没有发生静默，
   * 标题里写「静默时段」会让人以为系统记错了，或者以为自己开过静默；
   * `cam` 用于「通道静默」—— 只静默了**一路**通道，标题里必须带上那是哪一路，
   * 否则同时开了几路通道静默时，几条汇总长得一模一样，分不清是谁的；
   * `digest` 用于「日常事件静默」—— 它压根不是"某个时段被静默了"，而是
   * **按间隔**把零碎事件摊平成定期播报。标题里写"静默时段"会让人以为配了免打扰，
   * 所以单列一个变体，并在引言里点明间隔时长。
   * 只换标题与引言两处措辞，下面所有统计口径完全共用（这是刻意的：同一批事件
   * 不论从哪个入口看，数字与分区必须一致）。
   */
  const isRange = ctx.variant === 'range'
  const isCam = ctx.variant === 'cam'
  const isDigest = ctx.variant === 'digest'
  /*
   * 展示层两个开关（只影响"怎么摆"，不影响任何统计口径 —— 数字与分区始终共用）：
   *   faceHitDetail   —— 人脸命中**逐条**列（时间·通道·是谁）。默认**开**：
   *                       「按人聚合」回答"谁来了几次"，「逐条明细」回答"每次几点"，
   *                       两类信息互补，用户明确要求汇总里两样都要（可传 false 关掉）。
   *   hideEventDetail —— 省掉「事件明细（前 N 条）」。除 /collect 这类手动回查外的
   *                       **推送类**汇总（静默结束 / 日常汇总 / 通道静默汇总）一律
   *                       不摆通用明细：人脸命中已单独分区逐条列，其余事件看
   *                       「按通道 / 按类型」统计就够了（用户：其他明细可简化或取消）。
   */
  const faceHitDetail = ctx.faceHitDetail !== false
  const hideEventDetail = ctx.hideEventDetail === true || !isRange
  const scopeName = String(ctx.scopeName || '').trim()
  const scopeSuffix = scopeName ? ` · ${scopeName}` : ''
  const titleName = isRange
    ? '监控事件汇总'
    : isDigest
      ? `监控日常汇总${scopeSuffix}`
      : isCam
        ? `监控通道静默汇总${scopeSuffix}`
        : '监控静默时段汇总'
  /*
   * 推送通知的标题沿用原来的短名（`【监控静默汇总】`），别顺手改成和正文标题一样 ——
   * 那会改变静默结束那条通知的文案，属于"顺手改坏既有行为"。
   */
  const shortName = isRange
    ? '监控事件汇总'
    : isDigest
      ? `日常汇总${scopeSuffix}`
      : isCam
        ? `通道静默汇总${scopeSuffix}`
        : '监控静默汇总'
  /** 日常汇总的间隔文案与执行层**共用一份**（defaults.digestIntervalLabel） */
  const everyLabel = isDigest ? digestIntervalLabel(ctx.intervalMinutes) : ''
  const introText = isRange
    ? `该时段内共 **${total}** 条报警，已汇总于此。`
    : isDigest
      ? `通道「${scopeName || '（未命名）'}」的日常事件按 **${everyLabel}** 汇总，本批共 **${total}** 条。`
      : isCam
        ? `通道「${scopeName || '（未命名）'}」在静默时段内共 **${total}** 条报警，已汇总于此。`
        : `静默时段内共 **${total}** 条报警，已统一汇总于此。`

  const p2 = (n) => String(n).padStart(2, '0')
  const fmtClock = (ms) => {
    const d = new Date(ms)
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`
  }
  /** 逐条命中用秒级：同一分钟内多人/多次命中时能排出先后 */
  const fmtClockSec = (ms) => {
    const d = new Date(ms)
    return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  }
  const fmtDateTime = (ms) => {
    const d = new Date(ms)
    return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  }
  const crossDay = new Date(endMs).getDate() !== new Date(startMs).getDate()
  const rangeLabel = `${fmtDateTime(startMs)} ~ ${crossDay ? '次日 ' : ''}${fmtClock(endMs)}`

  // 聚合
  const byCamera = {}
  const byType = {}
  let personN = 0
  let faceN = 0
  const knownSet = new Set()
  let totalIn = 0
  let maxCur = 0
  list.forEach((r) => {
    const name = r.name || '未知通道'
    if (!byCamera[name]) byCamera[name] = { count: 0, person: 0, face: 0, zone: 0, motion: 0, flow: 0, other: 0 }
    const c = byCamera[name]
    c.count += 1
    const t = r.type || 'motion'
    if (t === 'person') {
      c.person += 1
      personN += 1
    } else if (t === 'face') {
      c.face += 1
      faceN += 1
      if (r.faceName) knownSet.add(String(r.faceName))
    } else if (t === 'zone' || t === 'enter' || t === 'exit' || t === 'loiter') {
      c.zone += 1
    } else if (t === 'flow') {
      // 人员走向：独立一类，别和「其他」混在一起（否则会虚高"其他"且看不出走向）
      c.flow += 1
    } else if (t === 'motion') {
      c.motion += 1
    } else {
      c.other += 1
    }
    byType[t] = (byType[t] || 0) + 1
    const cnt = r.counts || null
    if (cnt) {
      totalIn += Number(cnt.totalIn) || 0
      maxCur = Math.max(maxCur, Number(cnt.current) || 0)
    }
    if (r.faceName) knownSet.add(String(r.faceName))
  })

  /*
   * 人脸命中（在库）单独聚合。
   *
   * 判据：**事件是脸、且有名字** —— 有 faceName 才代表"认出了库里的人"。
   * 只 type === 'face' 是不够的：未录入的陌生人脸也会走这个 type，
   * 把陌生人当"命中"列出来等于每次门口过人都是命中，这块就废了。
   *
   * 按人聚合而不是逐条列：用户要的是"这期间谁来过、来了几次、最近一次什么时候"，
   * 同一个人一晚上来 20 次，逐条列反而是噪音。
   */
  const hitMap = new Map() // name -> { count, best, firstAt, lastAt, cams:Set }
  let strangerFaces = 0
  list.forEach((r) => {
    const isFace = r.type === 'face' || !!r.faceName
    if (!isFace) return
    const nm = String(r.faceName || '').trim()
    if (!nm) {
      strangerFaces += 1
      return
    }
    let h = hitMap.get(nm)
    if (!h) {
      h = { count: 0, best: 0, firstAt: 0, lastAt: 0, cams: new Set() }
      hitMap.set(nm, h)
    }
    h.count += 1
    h.best = Math.max(h.best, Number(r.faceScore) || 0)
    const t = Number(r.time) || 0
    if (t) {
      if (!h.firstAt || t < h.firstAt) h.firstAt = t
      if (t > h.lastAt) h.lastAt = t
    }
    if (r.name) h.cams.add(String(r.name))
  })
  const faceHits = [...hitMap.entries()].sort((a, b) => b[1].count - a[1].count)
  const hitTotal = faceHits.reduce((n, [, h]) => n + h.count, 0)

  const camNames = Object.keys(byCamera)
  const typeLabel = (t) => alarmLabel(t) || t
  const durMin = Math.max(1, Math.round((endMs - startMs) / 60000))
  const durText = durMin >= 60 ? `${(durMin / 60).toFixed(durMin % 60 ? 1 : 0)} 小时` : `${durMin} 分钟`
  const knownNames = [...knownSet]
  // 日常汇总里有多少条报警并入了「完整人形补图」（由 pushExtraShot 在 digest 激活时打标）
  const personImgN = list.filter((r) => r.personShot).length

  const camLines = camNames.length
    ? camNames
        .map((n) => {
          const c = byCamera[n]
          const parts = [`人形 ${c.person}`, `人脸 ${c.face}`, `区域 ${c.zone}`, `移动 ${c.motion}`, `走向 ${c.flow}`]
            .filter((s) => !/ 0$/.test(s))
            .join(' / ')
          return `- **${n}**：${c.count} 条${parts ? `（${parts}）` : ''}`
        })
        .join('\n')
    : '- 无'

  const typeLines = Object.keys(byType).length
    ? Object.keys(byType)
        .map((t) => `- ${typeLabel(t)}：${byType[t]} 条`)
        .join('\n')
    : '- 无'

  /*
   * 「人脸命中（在库）」分区的正文行。
   * 没有命中、也没有陌生人脸时整块不出现 —— 空着摆一行"0 次"只会占地方。
   */
  const hitLines = faceHits.length
    ? faceHits
        .map(([nm, h]) => {
          const bits = [`**${nm}**：${h.count} 次`]
          if (h.lastAt) bits.push(`最近 ${fmtClock(h.lastAt)}`)
          if (h.cams.size) bits.push([...h.cams].join('、'))
          if (h.best) bits.push(`相似度 ${Math.round(h.best * 100)}%`)
          return `- ${bits.join(' · ')}`
        })
        .join('\n')
    : '- 无'

  /*
   * 人脸命中「逐条」明细（faceHitDetail 时使用）。
   * 与上面按人聚合的 hitLines 互补：聚合回答"谁来了几次"，逐条回答"每次几点、哪路、是谁"。
   * 判据与命中聚合完全一致（有 faceName 才算命中），只是不折叠成一行。
   * 按时间正序列出（迟到补图/乱序事件也能排好），不截断。
   */
  const perHitLines = (() => {
    if (!faceHitDetail) return ''
    const all = list
      .filter((r) => (r.type === 'face' || r.faceName) && String(r.faceName || '').trim())
      .sort((a, b) => (a.time || 0) - (b.time || 0))
    // 命中明细截断：超过 LIMIT 条只列前 LIMIT，末尾补"另有 N 次"（用户确认 100 条可接受）。
    // 纯前端显示节流，不影响缓冲/统计（全部命中仍计入 hitTotal）。
    const LIMIT = 100
    const over = Math.max(0, all.length - LIMIT)
    const shown = over ? all.slice(0, LIMIT) : all
    const body = shown
      .map((r) => {
        const sc = Number(r.faceScore) > 0 ? `（相似度 ${Math.round(Number(r.faceScore) * 100)}%）` : ''
        return `- ${fmtClockSec(r.time || Date.now())} · ${r.name || '未知通道'} · ${String(r.faceName).trim()}${sc}`
      })
      .join('\n')
    return over ? `${body}\n- …另有 ${over} 次命中未列出` : body
  })()

  const detailLines = (() => {
    const top = [...list].sort((a, b) => (a.time || 0) - (b.time || 0)).slice(0, 20)
    return top
      .map((r) => {
        const detail = alarmDetail(r)
        const extra = extraText(r) ? ` · ${extraText(r)}` : ''
        const who = r.faceName ? ` · ${r.faceName}` : ''
        return `- ${fmtClock(r.time || Date.now())} · **${r.name || ''}** · ${detail || r.type}${who}${extra}`
      })
      .join('\n')
  })()
  const detailNote = list.length > 20 ? `\n- …另有 ${list.length - 20} 条` : ''

  /*
   * 本汇总时段与免打扰时段的重叠段（仅 digest 变体用于后面的提示块）。
   * cfg 是静默配置（含 slots），silentOverlapSegments 按"今天零点 + 距天分钟数"展开
   * 跨零点时段并求交，返回毫秒区间；再格式化成"HH:MM~HH:MM"文案。
   */
  const overlapSegs = isDigest
    ? silentOverlapSegments(cfg, startMs, endMs).map((s) => {
        const p2 = (n) => String(n).padStart(2, '0')
        const fmt = (ms) => {
          const d = new Date(ms)
          return `${p2(d.getHours())}:${p2(d.getMinutes())}`
        }
        const cross = new Date(s.to).getDate() !== new Date(s.from).getDate()
        return { ...s, label: `${fmt(s.from)} ~ ${cross ? '次日 ' : ''}${fmt(s.to)}` }
      })
    : []

  const lines = [
    `### 【${titleName}】${rangeLabel}`,
    '',
    `> ${introText}`,
    '',
    '**📊 概览**',
    `- 报警总数：${total} 条`,
    `- 覆盖通道：${camNames.join(' / ') || '无'}（${camNames.length} 路）`,
    `- 时段跨度：${rangeLabel}（约 ${durText}）`,
    '',
    '**👤 人员与识别**',
    `- 人形识别：${personN} 条`,
    `- 人脸识别：${faceN} 条${knownNames.length ? `（已识别 ${knownNames.length} 人：${knownNames.join('、')}）` : ''}`,
    `- 累计到访：${totalIn} 人次（区域计数）`,
    `- 峰值同时在线：${maxCur} 人`,
    '',
    // 「人脸命中」单独成区：静默期间最该被一眼看到的就是这条（谁来过），
    // 埋在下面的事件明细里等于没有。**无论是否有命中都始终显示这一区** ——
    // 用户明确要求：哪怕是 0 次命中也要把这一区摆出来（"有没有库里的人来过"一眼可辨），
    // 不像其它统计那样"没数据就整块省掉"。区里两样都给：先"共 N 次命中 · M 人"
    // 总账 + 按人计数，再逐条明细（每次几点、哪路、是谁、相似度）。
    '**🚨 人脸命中（在库）**',
    ...(faceHits.length
      ? [
          `- 共 **${hitTotal}** 次命中 · ${faceHits.length} 人`,
          ...hitLines.split('\n'),
          ...(faceHitDetail && perHitLines ? ['', '**命中明细（逐条）**', perHitLines] : [])
        ]
      : ['- 本时段无在库人员命中']),
    ...(strangerFaces ? [`- 另有 ${strangerFaces} 次未识别的人脸（陌生人，不计入命中）`] : []),
    '',
    '**📋 按通道**',
    camLines,
    '',
    '**📋 按类型**',
    typeLines,
    '',
    /*
     * 日常汇总与免打扰时段的**交集**提示（仅 digest 变体）。
     * 日常静默在免打扰时段里会让位（不吸收新事件），本批汇总的时段若与免打扰重叠，
     * 重叠期间的事件是由免打扰汇总单独推送的、不会进日常汇总 —— 不点明的话，
     * 用户会以为"今天门口明明有人、怎么日常汇总里没有"。
     * 只在真的重叠时才出现（没开免打扰 / 不重叠则整块不出现）。
     */
    ...(isDigest && overlapSegs.length
      ? [
          '**⚠️ 与免打扰时段重叠**',
          ...overlapSegs.map(
            (s) => `- 本汇总时段与免打扰 ${s.label} 重叠，重叠期间事件由「免打扰汇总」单独推送、未计入本汇总`
          ),
          ''
        ]
      : []),
    // 日常汇总：本批里并入了「完整人形补图」的，点一句（原图已在事件面板，不在聊天里重发）
    ...(isDigest && personImgN
      ? ['- 含完整人形补图 **' + personImgN + '** 张（原图见事件面板）', '']
      : []),
    // 通用「事件明细（前 N 条）」只在 /collect 这类手动回查（range）里摆：
    // 推送类汇总（静默结束 / 日常汇总 / 通道静默汇总）有人脸命中逐条分区 +
    // 按通道/按类型统计就够了，通用明细属噪音，整块省掉。
    ...(hideEventDetail
      ? []
      : [
          `**📝 事件明细（前 ${Math.min(20, total)} 条）**`,
          detailLines,
          detailNote,
          ''
        ]),
    `> 由 ${BRAND.fullName} 实时分析生成 · ${formatTime(endMs, false)}`
  ]

  const markdown = lines.join('\n')
  // 纯文本（去 markdown 标记，给 Telegram 用）
  const plain = lines
    .join('\n')
    .replace(/^###\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^[>]\s?/gm, '')
    .trim()

  return { title: `【${shortName}】${rangeLabel}`, markdown, plain }
}

/**
 * 系统通知的「日常汇总」正文：把这一间隔内收存的状态异常/恢复 + 定时巡检
 * 摊平成一条定期播报（与 buildSilentSummary 同款排版，但输入是系统通知而非报警事件）。
 *
 * 与 buildSilentSummary 的分工：
 *   · buildSilentSummary 收的是「某一路通道的报警事件」（人形/人脸/区域/移动…）；
 *   · 这里收的是跨通道的系统通知（设备掉线/恢复、巡检报告），归不到任何一路报警。
 *   所以单独成一份构建器，而不是硬塞进那套按通道/类型聚合的逻辑。
 *
 * @param {Array<object>} items digestSystemBuf 的快照（见 useAlertPush 的吸收分支）
 * @param {object} ctx { startMs, endMs, intervalMinutes, scopeName }
 * @returns {{ title:string, markdown:string, plain:string }}
 */
export function buildSystemDigestSummary(items, ctx = {}) {
  const list = Array.isArray(items) ? items : []
  const now = Number(ctx.endMs) || Date.now()
  const times = list.map((i) => Number(i.time) || 0).filter(Boolean)
  const startMs = Number(ctx.startMs) || (times.length ? Math.min(...times) : now)
  const p2 = (n) => String(n).padStart(2, '0')
  const clock = (ms) => {
    const d = new Date(ms)
    return `${p2(d.getHours())}:${p2(d.getMinutes())}`
  }
  const rangeLabel = `${clock(startMs)} ~ ${clock(now)}`
  const everyLabel = digestIntervalLabel(ctx.intervalMinutes)
  const statusItems = list.filter((i) => i.kind === 'status')
  const patrolItems = list.filter((i) => i.kind === 'patrol')
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

  const lines = [
    `### 【系统日常汇总】${rangeLabel}`,
    '',
    `> 系统通知（状态异常/恢复、定时巡检）按 **${everyLabel}** 汇总，本批共 **${list.length}** 条。`,
    ''
  ]

  if (statusItems.length) {
    lines.push('**🔧 设备状态变动**')
    statusItems.forEach((i) => {
      lines.push(`- ${clock(i.time)} · ${strip(i.title) || '状态变动'}`)
    })
    lines.push('')
  }
  if (patrolItems.length) {
    lines.push('**🧭 定时巡检**')
    patrolItems.forEach((i) => {
      lines.push(`- ${clock(i.time)} · ${strip(i.title) || '巡检报告'}`)
      const body = strip(i.text)
      if (body) {
        body
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .forEach((l) => lines.push(`  - ${l}`))
      }
    })
    lines.push('')
  }
  if (!statusItems.length && !patrolItems.length) {
    lines.push('- 本时段无系统通知', '')
  }
  lines.push(`> 由 ${BRAND.fullName} 实时分析生成 · ${formatTime(now, false)}`)

  const markdown = lines.join('\n')
  const plain = markdown
    .replace(/^###\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^[>]\s?/gm, '')
    .trim()
  return { title: `【系统日常汇总】${rangeLabel}`, markdown, plain }
}

/**
 * 「免打扰时段已结束」提醒（时段结束时一律发一条，与开始提醒配对）。
 *
 * 和 buildSilentSummary 的分工：
 *   - 汇总正文只在「时段内真的收存到报警」时才有内容，缓冲为空就没得汇总；
 *   - 结束提醒是**状态通知**：本时段结束了、期间收存了多少条、接下来是恢复实时推送
 *     还是仍在另一个免打扰时段里，一眼看清。
 *   所以这条不能因为缓冲为空被跳过 —— 否则「静默结束了没有报警」时用户什么都收不到，
 *   反而以为静默卡住了（用户明确要求：静默开始前与结束后都要有推送）。
 *
 * @param {Array<object>} records 时段内收存的报警快照（可为空数组）
 * @param {object} cfg   options.silent（暂未用，预留给将来按渠道定制）
 * @param {object} ctx   { startMs, endMs, rangeLabel, stillSilent, stillLabel }
 * @returns {{ title:string, markdown:string, html:string, plain:string }}
 */
export function buildSilentEndMessages(records, cfg, ctx = {}) {
  const list = Array.isArray(records) ? records : []
  const endMs = Number(ctx.endMs) || Date.now()
  const times = list.map((r) => Number(r.time) || 0).filter(Boolean)
  const startMs = Number(ctx.startMs) || (times.length ? Math.min(...times) : endMs)

  const clock = (ms) => {
    const d = new Date(ms)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const crossDay = new Date(endMs).getDate() !== new Date(startMs).getDate()
  const rangeLabel = ctx.rangeLabel || `${clock(startMs)} ~ ${crossDay ? '次日 ' : ''}${clock(endMs)}`
  const durMin = Math.max(1, Math.round((endMs - startMs) / 60000))
  const durText = durMin >= 60 ? `${(durMin / 60).toFixed(durMin % 60 ? 1 : 0)} 小时` : `${durMin} 分钟`
  const total = list.length

  /*
   * 结束后是不是还处在另一个免打扰窗口里（典型场景：临时静默到期，夜里那场还在跑）。
   * 这时候写「实时推送已恢复」就是错的 —— 会让人以为消息马上就来。
   */
  const stillText = ctx.stillSilent
    ? `免打扰仍在生效${ctx.stillLabel ? `（${ctx.stillLabel}）` : ''}，期间的报警继续收存，结束后再汇总。`
    : '实时逐条推送已恢复。'

  const mdLines = [
    '### 🔔 免打扰时段已结束',
    '>',
    `> **时段**：${rangeLabel}　（时长约 ${durText}）`,
    `> **本时段报警**：${total} 条　·　${stillText}`
  ]
  const plainLines = [
    '🔔 免打扰时段已结束',
    `时段：${rangeLabel}（时长约 ${durText}）`,
    `本时段报警：${total} 条 · ${stillText}`
  ]
  const htmlLines = [
    '🔔 <b>免打扰时段已结束</b>',
    `时段：<b>${rangeLabel}</b>（时长约 ${durText}）`,
    `本时段报警：<b>${total}</b> 条 · ${stillText}`
  ]

  const summary = total ? buildSilentSummary(list, cfg, { startMs, endMs }) : null
  if (summary) {
    mdLines.push('', summary.markdown)
    plainLines.push('', summary.plain)
    htmlLines.push('', summary.plain)
  } else {
    mdLines.push('>', '> 本时段内**没有捕获到报警**，无需汇总。', '', `> 由 ${BRAND.fullName} 自动通知 · ${formatTime(endMs, false)}`)
    plainLines.push('本时段内没有捕获到报警，无需汇总。', '', `由 ${BRAND.fullName} 自动通知 · ${formatTime(endMs, false)}`)
    htmlLines.push('本时段内<b>没有捕获到报警</b>，无需汇总。', '', `由 ${BRAND.fullName} 自动通知 · ${formatTime(endMs, false)}`)
  }

  return {
    title: total ? `🔔 免打扰结束 · 本时段 ${total} 条报警汇总` : '🔔 免打扰时段已结束',
    markdown: mdLines.join('\n'),
    html: htmlLines.join('\n'),
    plain: plainLines.join('\n')
  }
}

/** 状态文案 */
export const STATE_LABEL = {
  playing: '✅ 正常播放',
  connecting: '⏳ 连接中',
  error: '❌ 异常',
  paused: '⏸ 已暂停',
  closed: '⛔ 已关闭（不显示）',
  idle: '⚪ 未启动'
}

export function stateLabel(state, text) {
  const base = STATE_LABEL[state] || '⚪ 未知'
  return text ? `${base} · ${text}` : base
}

/** 功能开关摘要：移动✓ · 人形✗ · 盲视✓ · 推送→钉钉/TG */
export function switchText(item) {
  const parts = [`移动${item.motion ? '✓' : '✗'}`, `人形${item.ai ? '✓' : '✗'}`]
  if (item.blind) parts.push('盲视✓')
  if (item.push === false) parts.push('推送已关')
  else if (Array.isArray(item.pushTo) && item.pushTo.length) parts.push(`推送→${item.pushTo.join('/')}`)
  else parts.push('推送未启用')
  return parts.join(' · ')
}

/** 画面技术参数：分辨率 · 编码 · 帧率 · 码率 · 检测区域 */
export function techText(item) {
  const parts = []
  if (item.resolution) parts.push(item.resolution)
  if (item.fps) parts.push(`${item.fps}fps`)
  if (item.kbps) parts.push(`${(item.kbps / 8 / 1024).toFixed(2)}MB/s`)
  if (item.roiText) parts.push(`检测区域 ${item.roiText}`)
  return parts.join(' · ')
}

/** 单路状态明细（markdown，多行块） */
export function statusBlock(item) {
  const lines = [`**${item.name}**　${stateLabel(item.state, item.text)}`]
  const sw = switchText(item)
  if (sw) lines.push(`> ${sw}`)
  const tech = techText(item)
  if (tech) lines.push(`> ${tech}`)
  return lines.join('\n')
}

/** 单路状态明细（纯文本） */
export function statusBlockPlain(item) {
  const lines = [`${item.name} ${stateLabel(item.state, item.text)}`]
  const sw = switchText(item)
  if (sw) lines.push(`  ${sw}`)
  const tech = techText(item)
  if (tech) lines.push(`  ${tech}`)
  return lines.join('\n')
}

/** 旧的行式写法（保留给合并消息里用） */
function statusLine(item) {
  const parts = [stateLabel(item.state, item.text)]
  if (item.resolution) parts.push(item.resolution)
  if (item.fps) parts.push(`${item.fps}fps`)
  if (item.kbps) parts.push(`${(item.kbps / 8).toFixed(0)}KB/s`)
  return `${parts.slice(0, 1).join('')} · ${item.name}${parts.length > 1 ? ` · ${parts.slice(1).join(' · ')}` : ''}`
}

/**
 * 异常原因文案（item 6）。
 *
 * 以前原因只拼在「状态」那一行里（`❌ 异常 · 解码中断：xxx`），
 * 收到消息的人得自己从状态行里剥出原因。现在拆成独立一行，
 * 并且把持续异常的前缀「持续异常 · 」也剥掉 —— 那是提醒节奏，不是原因本身。
 */
function reasonText(text) {
  if (!text) return ''
  return String(text)
    .replace(/^持续异常\s*·\s*/, '')
    .replace(/^持续异常\s*/, '')
    .trim()
}

/** 监控异常 / 恢复通知 */
export function buildStatusAlertMessage({ kind, cam, state, text, overview, downtimeMs, cfg, item }) {
  const prefix = (cfg && cfg.titlePrefix) || '【监控报警】'
  const time = formatTime(Date.now())
  const isDown = kind === 'down'
  const title = isDown ? `${prefix}监控异常 · ${cam.name}` : `${prefix}监控恢复 · ${cam.name}`
  const it = item || {
    id: cam.id,
    name: cam.name,
    state,
    text,
    url: cam.url,
    motion: cam.motion,
    ai: cam.ai,
    blind: cam.blind,
    push: cam.push !== false,
    pushTo: [],
    roiText: cam.roi ? `${Math.round(cam.roi.w * 100)}×${Math.round(cam.roi.h * 100)}%` : '全画面'
  }
  // 异常时单独给出「原因」和「已中断」，比混在状态行里更好读
  const reason = isDown ? reasonText(text) : ''
  // 恢复类消息里 text 形如「中断 128 秒」，那是中断时长不是原因
  const downTag = isDown ? '已中断' : '中断时长'

  if (cfg && cfg.msgType === 'text') {
    const lines = [
      isDown ? `${prefix}${cam.name} 出现异常` : `${prefix}${cam.name} 已恢复正常`,
      `时间：${time}`,
      `状态：${stateLabel(state, isDown ? '' : text)}`,
      reason ? `异常原因：${reason}` : '',
      `功能开关：${switchText(it)}`,
      techText(it) ? `画面参数：${techText(it)}` : '',
      overview ? `在线情况：${overview}` : '',
      cam.url ? `流地址：${cam.url}` : '',
      downtimeMs ? `${downTag}：${formatDuration(downtimeMs)}` : '',
      isDown ? '请检查摄像机、网络或流媒体服务。' : ''
    ].filter(Boolean)
    return { title, text: lines.join('\n') }
  }

  const lines = [
    `### ${isDown ? '🔴 监控异常告警' : '🟢 监控恢复正常'}`,
    '',
    `- **通道**：${cam.name}`,
    `- **状态**：${stateLabel(state, isDown ? '' : text)}`,
    `- **时间**：${time}`
  ]
  if (reason) lines.push(`- **异常原因**：${reason}`)
  lines.push(`- **功能开关**：${switchText(it)}`)
  if (techText(it)) lines.push(`- **画面参数**：${techText(it)}`)
  if (downtimeMs) lines.push(`- **${downTag}**：${formatDuration(downtimeMs)}`)
  if (overview) lines.push(`- **在线情况**：${overview}`)
  if (cam.url) lines.push(`- **流地址**：${cam.url}`)
  lines.push('', isDown ? '> 请检查摄像机电源、网络或流媒体服务器状态。' : '> 画面已恢复正常播放。')
  return { title, text: lines.join('\n') }
}

/** 定时巡检报告（逐通道展示功能开关状态） */
export function buildPatrolMessage({ items, overview, cfg, reason, pushChannels }) {
  const prefix = (cfg && cfg.titlePrefix) || '【监控报警】'
  const title = `${prefix}监控巡检 · ${overview.short}`
  const watched = items.filter((i) => i.watched)
  const others = items.filter((i) => !i.watched)
  const channelsLine =
    Array.isArray(pushChannels) && pushChannels.length ? pushChannels.join(' / ') : ''

  if (cfg && cfg.msgType === 'text') {
    const lines = [
      `${prefix}监控巡检报告`,
      `时间：${formatTime(Date.now())}`,
      `概览：${overview.short}`,
      `明细：正常 ${overview.playing} · 异常 ${overview.error} · 连接中 ${overview.connecting} · 已关闭 ${overview.closed}`,
      channelsLine ? `推送渠道：${channelsLine}` : '',
      '------------'
    ].filter(Boolean)
    if (watched.length) {
      lines.push('【监听通道】')
      watched.forEach((i) => lines.push(statusBlockPlain(i), ''))
    }
    if (others.length) {
      lines.push('【其它通道】')
      others.forEach((i) => lines.push(statusBlockPlain(i), ''))
    }
    return { title, text: lines.join('\n').trim() }
  }

  const lines = [
    `### ${prefix.replace(/[【】]/g, '')} · 定时巡检报告`,
    '',
    `- **巡检时间**：${formatTime(Date.now())}`,
    `- **在线概览**：${overview.short}`,
    `- **明细统计**：正常 ${overview.playing} 路 · 异常 ${overview.error} 路 · 连接中 ${overview.connecting} 路 · 已关闭 ${overview.closed} 路`
  ]
  if (channelsLine) lines.push(`- **本次推送渠道**：${channelsLine}`)

  if (watched.length) {
    lines.push('', `**监听通道（${watched.length} 路）**`, '')
    watched.forEach((i) => lines.push(statusBlock(i), ''))
  }
  if (others.length) {
    lines.push('', `**其它通道（${others.length} 路）**`, '')
    others.forEach((i) => lines.push(statusBlock(i), ''))
  }
  lines.push('', reason ? `> ${reason}` : '> 由 BossMonitor 定时自动巡检生成')
  return { title, text: lines.join('\n').trim() }
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/** 兼容旧版配置（pushMotion/pushPerson → events） */
export function normalizeDingTalk(dt) {
  if (!dt) return dt
  if (!Array.isArray(dt.cameras)) dt.cameras = []
  const events = dt.events || {}
  if (dt.pushMotion !== undefined || dt.pushPerson !== undefined) {
    if (events.motion === undefined) events.motion = dt.pushMotion !== false
    if (events.person === undefined) events.person = dt.pushPerson !== false
  }
  /*
   * ⚠️ 这里以前是硬写成 { motion, person } 两项的 —— 后来事件分组扩到 6 组
   * （人脸 / 区域 / 姿态 / 计数）之后，这一行会把 face / zone / pose / count 全砍掉，
   * 再被 normalizeEvents 按默认值补回来，结果就是"用户关掉的分组又被自动打开"。
   * 改成走 normalizeEvents：已有的键原样保留，缺的键才用默认值补。
   */
  dt.events = normalizeEvents(events)
  if (dt.rateLimitPerMin === undefined) dt.rateLimitPerMin = 18
  if (dt.globalMinIntervalSec === undefined) dt.globalMinIntervalSec = 3
  if (dt.overflowMode === undefined) dt.overflowMode = 'merge'
  if (dt.msgType === undefined) dt.msgType = 'markdown'
  // 推送消息模板：空串 = 用内置默认模板（见 useMessageTemplate.js）
  if (typeof dt.template !== 'string') dt.template = ''
  if (dt.titlePrefix === undefined) dt.titlePrefix = '【监控报警】'
  if (dt.screenshotMode === undefined) dt.screenshotMode = 'none'
  if (dt.uploadUrl === undefined) dt.uploadUrl = ''
  if (dt.uploadField === undefined) dt.uploadField = 'file'
  if (dt.minRatioPercent === undefined) dt.minRatioPercent = 0
  if (dt.quietEnabled === undefined) dt.quietEnabled = false
  if (dt.quietStart === undefined) dt.quietStart = '22:00'
  if (dt.quietEnd === undefined) dt.quietEnd = '07:00'
  if (!dt.statusAlerts) dt.statusAlerts = { enabled: true, notifyRecover: true, repeatMinutes: 10 }
  if (dt.statusAlerts.repeatMinutes === undefined) dt.statusAlerts.repeatMinutes = 10
  if (!dt.patrol) dt.patrol = { enabled: true, intervalMinutes: 30, onlyWhenAbnormal: false, includeAll: true }
  if (!dt.fields) {
    dt.fields = {
      camera: true,
      cameraId: false,
      time: true,
      type: true,
      ratio: true,
      confidence: true,
      resolution: true,
      bitrate: true,
      url: false,
      roi: true,
      seq: true,
      screenshot: true
    }
  }
  return dt
}
