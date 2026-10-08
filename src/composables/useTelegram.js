/**
 * Telegram Bot 推送
 *
 * 为什么用 Telegram 发图片：
 *   钉钉自定义机器人的 markdown 图片必须是「公网可访问的 http(s) 地址」，
 *   本地部署时很难提供一个公网图床；而 Telegram Bot API 支持直接上传文件
 *   （multipart/form-data），浏览器不需要任何中转服务就能把截图发出去。
 *
 * 关于跨域：api.telegram.org 会返回 `Access-Control-Allow-Origin: *`，
 *   并且允许 content-type 头的预检，所以浏览器可以直连，无需代理。
 *
 * 关于 chat_id：超级群 / 频道的 id 必须带 -100 前缀
 *   （例如群里显示的 1234567890 → 实际要填 -1001234567890），
 *   否则接口会返回 400 chat not found。
 */
import { buildEventFields, formatDuration, formatTime, stateLabel, switchText, techText } from './useDingTalk.js'
import { timeoutSignal } from './useNet.js'
import { alarmDetail, alarmTitle, extraText } from './useAlarmText.js'
import { collectAlarmVars, renderTemplate, DEFAULT_TG_TEMPLATE } from './useMessageTemplate.js'

const API_ORIGIN = 'https://api.telegram.org'
/** 普通接口调用：迟迟不返回就别再等了，否则事件会一直停在「正在推送」 */
const API_TIMEOUT_MS = 20000
/** 上传截图：外网 + 大文件（几 MB），给宽松一点但也有上限 */
const UPLOAD_TIMEOUT_MS = 60000

/* ==================== 基础调用 ==================== */

export function normalizeTelegram(tg) {
  if (!tg) return tg
  if (tg.enabled === undefined) tg.enabled = true
  if (tg.token === undefined) tg.token = ''
  if (tg.chatId === undefined) tg.chatId = ''
  if (tg.groupUsername === undefined) tg.groupUsername = ''
  if (tg.sendMode === undefined) tg.sendMode = 'photo'
  if (tg.withPhoto === undefined) tg.withPhoto = true
  if (tg.silent === undefined) tg.silent = false
  if (tg.alsoSendOriginal === undefined) tg.alsoSendOriginal = false
  // 推送消息模板：空串 = 用内置默认模板（见 useMessageTemplate.js）
  if (typeof tg.template !== 'string') tg.template = ''

  /* ---- 远程控制（方案 C）配置 ----
   * 逐字段兜底而不是整体替换：老配置里没有 remote 这一块，
   * 直接整体赋值会把已经配好的字段冲掉。 */
  const r = tg.remote || (tg.remote = {})
  if (r.enabled === undefined) r.enabled = false
  if (!Array.isArray(r.allowUserIds)) r.allowUserIds = []
  if (r.pollMs === undefined) r.pollMs = 3000
  if (r.allowReboot === undefined) r.allowReboot = false
  // 静默查岗（/check duty）：单次最多推几张截图（0 = 不限，仍受代码内的防呆上限约束）
  if (r.dutyMaxImages === undefined) r.dutyMaxImages = 0
  // 两张截图之间的间隔，避免连续 sendPhoto 触发 Telegram 限流
  if (r.dutyImageGapMs === undefined) r.dutyImageGapMs = 700
  return tg
}

function apiUrl(token, method) {
  return `${API_ORIGIN}/bot${String(token || '').trim()}/${method}`
}

function assertReady(cfg) {
  const token = String((cfg && cfg.token) || '').trim()
  const chatId = String((cfg && cfg.chatId) || '').trim()
  if (!token) throw new Error('未配置 Telegram 机器人 Token')
  if (!chatId) throw new Error('未配置 Telegram 会话 ID')
  if (!/^\d+:[\w-]+$/.test(token)) throw new Error('Token 格式不对，应形如 123456789:AA...')
  return { token, chatId }
}

async function parse(res) {
  let data = null
  const text = await res.text()
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error(`Telegram 返回内容无法解析（HTTP ${res.status}）`)
  }
  if (!data.ok) {
    throw new Error(`${translateError(data.description || '未知错误')}（错误码 ${data.error_code}）`)
  }
  return data.result
}

/** 把常见报错翻译成人话 */
function translateError(desc) {
  const d = String(desc || '')
  if (/chat not found/i.test(d)) {
    return '找不到该会话：群/频道的 ID 需要带 -100 前缀（例如 1234567890 → -1001234567890），且机器人必须已在群里'
  }
  if (/Unauthorized|invalid token/i.test(d)) return 'Token 无效，请检查是否复制完整'
  if (/not enough rights|CHAT_WRITE_FORBIDDEN/i.test(d)) return '机器人没有在该群发言的权限'
  if (/bot was kicked/i.test(d)) return '机器人已被移出该群'
  if (/Too Many Requests/i.test(d)) return '触发 Telegram 频率限制，稍后再试'
  if (/PHOTO_INVALID_DIMENSIONS/i.test(d)) return '图片尺寸不符合 Telegram 要求'
  if (/failed to get HTTP URL content|wrong file identifier/i.test(d)) return '图片上传失败，请重试'
  return d || '未知错误'
}

/** 把 dataURL 转成 Blob */
export function dataUrlToBlob(dataUrl) {
  const [meta, b64] = String(dataUrl || '').split(',')
  const mime = (meta || '').match(/data:([^;]+)/)?.[1] || 'image/jpeg'
  const binary = atob(b64 || '')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/* ==================== 具体接口 ==================== */

/** 校验机器人凭证，返回机器人信息 */
export async function getBotInfo(token) {
  const res = await fetch(apiUrl(token, 'getMe'), { signal: timeoutSignal(API_TIMEOUT_MS) })
  return parse(res)
}

/**
 * 校验会话：返回 { id, title, type }
 * 用于设置页的「校验会话」按钮，能立刻发现 chat_id 写错 / 机器人不在群里
 */
export async function getChatInfo(cfg) {
  const { token, chatId } = assertReady(cfg)
  const res = await fetch(`${apiUrl(token, 'getChat')}?chat_id=${encodeURIComponent(chatId)}`, {
    signal: timeoutSignal(API_TIMEOUT_MS)
  })
  return parse(res)
}

/** 发送纯文本（HTML 子集：<b> <i> <code> <a> <pre>） */
export async function sendTelegramText(cfg, html, opts = {}) {
  const { token, chatId } = assertReady(cfg)
  const res = await fetch(apiUrl(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_notification: opts.silent !== undefined ? !!opts.silent : !!cfg.silent,
      link_preview_options: { is_disabled: true }
    }),
    signal: timeoutSignal(API_TIMEOUT_MS)
  })
  return parse(res)
}

/**
 * 发送图片（直接上传文件，不需要公网地址）
 * @param {string} dataUrl  data:image/jpeg;base64,...
 * @param {string} caption  HTML 说明文字
 * @param {'photo'|'document'} mode
 */
export async function sendTelegramPhoto(cfg, dataUrl, caption, mode = 'photo') {
  const { token, chatId } = assertReady(cfg)
  if (!dataUrl) throw new Error('没有可发送的图片')
  const blob = dataUrlToBlob(dataUrl)
  const method = mode === 'document' ? 'sendDocument' : 'sendPhoto'
  const field = mode === 'document' ? 'document' : 'photo'

  const form = new FormData()
  form.append('chat_id', chatId)
  form.append(field, blob, `alarm-${Date.now()}.jpg`)
  if (caption) {
    form.append('caption', caption.slice(0, 1024))
    form.append('parse_mode', 'HTML')
  }
  form.append('disable_notification', String(!!cfg.silent))

  const res = await fetch(apiUrl(token, method), {
    method: 'POST',
    body: form,
    signal: timeoutSignal(UPLOAD_TIMEOUT_MS)
  })
  return parse(res)
}

/**
 * 发一条报警消息：有图就发图（图 + 说明），没图就发文字。
 * Telegram 的图片说明上限 1024 字，超长时拆成「图片 + 另一条完整文字」两条。
 *
 * 返回值：{ message, fileId }
 *   message —— Telegram 返回的 Message 对象（含 message_id）
 *   fileId  —— 本次上传图片的文件标识，可用于 getTelegramFileUrl() 换公网直链，
 *              钉钉 / 企业微信就是靠它复用同一张图，避免重复上传。
 */
export async function sendTelegramAlarm(cfg, { image, caption, mode }) {
  const cap = String(caption || '')
  if (!image) return { message: await sendTelegramText(cfg, cap), fileId: '' }
  if (cap.length <= 1024) {
    const message = await sendTelegramPhoto(cfg, image, cap, mode)
    return { message, fileId: pickFileId(message, mode) }
  }
  const message = await sendTelegramPhoto(cfg, image, `${cap.slice(0, 900)}…`, mode)
  await sendTelegramText(cfg, cap)
  return { message, fileId: pickFileId(message, mode) }
}

/** 从发送结果里取出最大的那张图的 file_id（photo 数组按尺寸升序，取最后一个） */
function pickFileId(message, mode) {
  if (!message) return ''
  if (mode === 'document') return (message.document && message.document.file_id) || ''
  const arr = Array.isArray(message.photo) ? message.photo : []
  return arr.length ? arr[arr.length - 1].file_id : ''
}

/**
 * 把 file_id 换成「公网可直接访问的图片地址」：
 *   getFile → file_path → https://api.telegram.org/file/bot<token>/<file_path>
 *
 * 这个地址不需要额外鉴权（token 就在路径里），可以直接写进钉钉 markdown 的 ![]()。
 * 同一个 Token 不变的话，链接长期有效，所以适合随报警一起发出去复用。
 *
 * ⚠️ api.telegram.org 在中国大陆需要代理才能访问，若加载不出来，
 *    可以改用设置里的「零配置图床（litterbox）」模式。
 */
export async function getTelegramFileUrl(cfg, fileId) {
  const { token } = assertReady(cfg)
  if (!fileId) return ''
  const res = await fetch(`${apiUrl(token, 'getFile')}?file_id=${encodeURIComponent(fileId)}`, {
    signal: timeoutSignal(API_TIMEOUT_MS)
  })
  const info = await parse(res)
  if (!info || !info.file_path) return ''
  return `${API_ORIGIN}/file/bot${token}/${info.file_path}`
}

/** 规范化群用户名：用户可能贴完整链接、带 @、带结尾斜杠 */
function cleanGroupUsername(cfg) {
  return String((cfg && cfg.groupUsername) || '')
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/+$/, '')
}

/**
 * 生成「在 Telegram 里打开这条消息」的链接。
 * 优先用配置里的群用户名（形如 https://t.me/my_monitor_group/2105，最通用）；
 * 没填时按 chat_id 推断：私有超级群用 /c/<去掉 -100 前缀的 id>/<message_id>。
 */
export function telegramMessageLink(cfg, messageId) {
  if (!messageId) return ''
  const uname = cleanGroupUsername(cfg)
  if (uname) return `https://t.me/${uname}/${messageId}`

  const chatId = String((cfg && cfg.chatId) || '').trim()
  if (!chatId) return ''
  const sup = /^-100(\d+)$/.exec(chatId)
  if (sup) return `https://t.me/c/${sup[1]}/${messageId}`
  const name = chatId.startsWith('@') ? chatId.slice(1) : ''
  return name ? `https://t.me/${name}/${messageId}` : ''
}

/**
 * 只要「群」的链接，不带具体消息：https://t.me/<群用户名>
 * 用在「这次没推 TG、拿不到消息 id」的时候兜底 ——
 * 钉钉 / 企业微信的消息里至少要有个能回去看原图的入口。
 */
export function telegramGroupLink(cfg) {
  const uname = cleanGroupUsername(cfg)
  return uname ? `https://t.me/${uname}` : ''
}

/* ==================== 文案拼装（HTML） ==================== */

const esc = (s) =>
  String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** 各事件类型的图标（文案统一走 useAlarmText，这里只负责配个表情） */
const TYPE_ICON = {
  person: '🧍',
  motion: '🏃',
  face: '🙂',
  enter: '➡️',
  exit: '⬅️',
  loiter: '🕰',
  pose: '🤸',
  count: '🔢',
  offline: '🔴',
  online: '🟢'
}

/**
 * 单条报警事件的说明文字（HTML 格式，走可配置模板）。
 *
 * @param {object} record 报警记录
 * @param {object} cfg 渠道配置（titlePrefix / fields 从这取）
 * @param {string} [template] 自定义模板（TG 配置里的 template 字段），空 = 默认模板
 */
export function buildTelegramCaption(record, cfg, template) {
  const dt = cfg || {}
  // 模板为空（未自定义）→ 直接用默认模板，变量值 HTML 转义（{link} 除外，它本身就是可信标签）
  const tpl = template || DEFAULT_TG_TEMPLATE
  const vars = collectAlarmVars(record, { cfg: dt, style: 'html', omitShotLine: true })
  return renderTemplate(tpl, vars, { escapeValue: true, skipEscapeKeys: ['link'] })
}

/** 多路合并/汇总（超频时） */
export function buildTelegramMergedText(list, cfg) {
  const dt = cfg || {}
  const lines = [`⚠️ <b>${esc(dt.titlePrefix || '【监控报警】')}共 ${list.length} 条报警事件</b>`, '']
  list.slice(0, 30).forEach((r) => {
    const detail = alarmDetail(r)
    const extra = extraText(r) ? ` · ${extraText(r)}` : ''
    lines.push(`• ${esc(formatTime(r.time, false))} · <b>${esc(r.name)}</b> · ${esc(detail)}${esc(extra)}`)
  })
  if (list.length > 30) lines.push(`• …另有 ${list.length - 30} 条`)
  lines.push('', '<i>短时间内触发较多，已合并推送</i>')
  return lines.join('\n')
}

/** 通道异常 / 恢复 */
export function buildTelegramStatusText({ kind, cam, state, text, overview, downtimeMs, cfg, item }) {
  const dt = cfg || {}
  const isDown = kind === 'down'
  const it = item || {}
  const sw = switchText(it)
  const tech = techText(it)
  const lines = [
    isDown ? '🔴 <b>监控异常告警</b>' : '🟢 <b>监控恢复正常</b>',
    '',
    `<b>通道</b>：${esc(cam.name)}`,
    `<b>状态</b>：${esc(stateLabel(state, text))}`,
    `<b>时间</b>：${esc(formatTime(Date.now()))}`
  ]
  if (sw) lines.push(`<b>功能开关</b>：${esc(sw)}`)
  if (tech) lines.push(`<b>画面参数</b>：${esc(tech)}`)
  if (downtimeMs) lines.push(`<b>${isDown ? '已中断' : '中断时长'}</b>：${esc(formatDuration(downtimeMs))}`)
  if (overview) lines.push(`<b>在线情况</b>：${esc(overview)}`)
  if (cam.url) lines.push(`<b>流地址</b>：<code>${esc(cam.url)}</code>`)
  lines.push('', isDown ? '<i>请检查摄像机电源、网络或流媒体服务器状态。</i>' : '<i>画面已恢复正常播放。</i>')
  return lines.join('\n')
}

/** 定时巡检报告（逐通道展示功能开关状态） */
export function buildTelegramPatrolText({ items, overview, cfg, reason, pushChannels }) {
  const prefix = esc((cfg && cfg.titlePrefix) || '【监控报警】')
  const watched = items.filter((i) => i.watched)
  const others = items.filter((i) => !i.watched)
  const line = (i) => {
    const sw = switchText(i)
    const tech = techText(i)
    const out = [`• <b>${esc(i.name)}</b> · ${esc(stateLabel(i.state, i.text))}`]
    if (sw) out.push(`  <i>${esc(sw)}</i>`)
    if (tech) out.push(`  <i>${esc(tech)}</i>`)
    return out.join('\n')
  }
  const lines = [
    `📋 <b>${prefix.replace(/[【】]/g, '')} · 定时巡检报告</b>`,
    '',
    `<b>巡检时间</b>：${esc(formatTime(Date.now()))}`,
    `<b>在线概览</b>：${esc(overview.short)}`,
    `<b>明细统计</b>：正常 ${overview.playing} · 异常 ${overview.error} · 连接中 ${overview.connecting} · 已关闭 ${overview.closed}`
  ]
  if (Array.isArray(pushChannels) && pushChannels.length) {
    lines.push(`<b>本次推送渠道</b>：${esc(pushChannels.join(' / '))}`)
  }
  if (watched.length) {
    lines.push('', `<b>监听通道（${watched.length} 路）</b>`, ...watched.map(line))
  }
  if (others.length) {
    lines.push('', `<b>其它通道（${others.length} 路）</b>`, ...others.map(line))
  }
  lines.push('', reason ? `<i>${esc(reason)}</i>` : '<i>由 BossMonitor 定时自动巡检生成</i>')
  return lines.join('\n')
}
