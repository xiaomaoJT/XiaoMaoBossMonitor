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
import { BRAND } from '../config/defaults.js'
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
    const origin = typeof location !== 'undefined' ? location.origin : ''
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

  if (cfg && cfg.msgType === 'text') {
    const lines = [
      isDown ? `${prefix}${cam.name} 出现异常` : `${prefix}${cam.name} 已恢复正常`,
      `时间：${time}`,
      `状态：${stateLabel(state, text)}`,
      `功能开关：${switchText(it)}`,
      techText(it) ? `画面参数：${techText(it)}` : '',
      overview ? `在线情况：${overview}` : '',
      cam.url ? `流地址：${cam.url}` : '',
      downtimeMs ? `中断时长：${formatDuration(downtimeMs)}` : '',
      isDown ? '请检查摄像机、网络或流媒体服务。' : ''
    ].filter(Boolean)
    return { title, text: lines.join('\n') }
  }

  const lines = [
    `### ${isDown ? '🔴 监控异常告警' : '🟢 监控恢复正常'}`,
    '',
    `- **通道**：${cam.name}`,
    `- **状态**：${stateLabel(state, text)}`,
    `- **时间**：${time}`,
    `- **功能开关**：${switchText(it)}`
  ]
  if (techText(it)) lines.push(`- **画面参数**：${techText(it)}`)
  if (downtimeMs) lines.push(`- **${isDown ? '已中断' : '中断时长'}**：${formatDuration(downtimeMs)}`)
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
