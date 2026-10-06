/**
 * 推送消息模板引擎
 * ----------------------------------------------------------------------------
 * 三端（钉钉 / Telegram / 企业微信）的报警消息原来各自硬编码在
 * useDingTalk / useTelegram 里，排版是平铺的「标签：值」列表，
 * 开没开的功能混在一起，看不出重点。
 *
 * 现在抽成「模板 + 变量」：
 *   - 模板是带 {变量} 的文本骨架，存在三端各自的配置里（cfg.template）；
 *   - 空串 = 用这里的默认模板（就是优化排版后的当前消息）；
 *   - 变量由 collectAlarmVars 统一计算，功能没开的项值为空串，
 *     渲染后「标签：」结尾的空行会被自动清掉，不会留下一堆空字段。
 *
 * 排版约定（用户要求）：
 *   - 上段 = 重要信息（标题 / 通道 / 类型 / 时间），下段 = 详细信息；
 *   - 两段之间用字符分割线（{line}）隔开 —— 三个渠道都稳定渲染；
 *   - 功能状态用 ✅ / ❌ 表情表示开启与否，扫一眼就知道哪路没开。
 */
import { alarmDetail, alarmTitle, countText, dwellText } from './useAlarmText.js'
import { runtimeLine } from './useDeviceInfo.js'
import { BRAND } from '../config/defaults.js'

/* ==================== 事件类型 → emoji ==================== */
export const TYPE_ICONS = {
  motion: '🎥',
  person: '🚶',
  face: '👤',
  enter: '🚪',
  exit: '↩️',
  loiter: '🕰️',
  pose: '🤸',
  count: '🔢',
  offline: '🔴',
  online: '🟢'
}

/** 字符分割线（比 markdown 的 --- 兼容性好：TG 的 HTML 模式没有 <hr>） */
export const LINE = '━━━━━━━━━━━━━━'

/* ==================== 变量清单（设置页展示 & 点击插入用） ==================== */
export const TEMPLATE_VARS = [
  { key: 'icon', label: '事件图标', sample: '🚶', desc: '按事件类型自动变化' },
  { key: 'title', label: '报警标题', sample: '【监控报警】人形识别', desc: '含自定义前缀' },
  { key: 'channel', label: '通道名称', sample: '门口' },
  { key: 'channelId', label: '通道编号', sample: 'cam-1' },
  { key: 'time', label: '时间', sample: '2026-09-30 20:33:05 周三' },
  { key: 'type', label: '事件类型', sample: '人形识别（AI）', desc: '含人脸姓名 / 区域名等详情' },
  { key: 'confidence', label: '置信度', sample: '87%', desc: '仅人形识别有值' },
  { key: 'ratio', label: '变动幅度', sample: '12.50%', desc: '仅画面移动有值' },
  { key: 'features', label: '功能状态', sample: '✅人脸识别 ❌人形姿态', desc: '四项附加能力的开启快照' },
  { key: 'face', label: '人脸', sample: '张三（相似度 81%）' },
  { key: 'pose', label: '姿态', sample: '跌倒' },
  { key: 'zone', label: '区域规则', sample: '大门口' },
  { key: 'counts', label: '人数统计', sample: '当前 3 人 · 累计进入 12 人次' },
  { key: 'dwell', label: '停留时长', sample: '2 分 30 秒' },
  { key: 'resolution', label: '分辨率', sample: '1920×1080 · H265(HEVC)' },
  { key: 'bitrate', label: '码率/帧率', sample: '357 KB/s · 25 fps' },
  { key: 'roi', label: '检测区域', sample: '全画面', desc: '画面上圈选的检测框' },
  { key: 'url', label: '流地址', sample: 'ws://10.0.0.12:8080' },
  { key: 'seq', label: '事件序号', sample: '#12' },
  { key: 'device', label: '运行设备', sample: 'iOS App · iPhone 15 Pro' },
  { key: 'note', label: '附加提醒', sample: '⚠️ 本分钟额度仅剩 2 条', desc: '如限流提醒，无则空' },
  { key: 'shot', label: '截图说明', sample: '📷 见下方图片' },
  { key: 'link', label: '原图链接', sample: '[查看原图](https://…)', desc: '按端自动匹配格式' },
  { key: 'line', label: '分割线', sample: LINE }
]

/* ==================== 时间格式化（自带，避免与 useDingTalk 循环依赖） ==================== */
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function fmtTime(ts) {
  const t = ts ? new Date(ts) : new Date()
  if (isNaN(t.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ` +
    `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} ${WEEK[t.getDay()]}`
  )
}

/* ==================== 功能状态（emoji 版） ==================== */

/**
 * 「功能状态」的值 —— 用户要求用表情表示开 / 关：
 * ✅ 人脸识别 · ❌ 人形姿态 · ✅ 区域规则 · ❌ 人员计数
 * 扫一眼就知道哪些能力没开，不用去翻设置。
 */
export function featureTextEmoji(list) {
  if (!Array.isArray(list) || !list.length) return ''
  return list.map((f) => `${f.on ? '✅' : '❌'} ${f.label}`).join(' · ')
}

/* ==================== 变量收集 ==================== */

function htmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 收集一条报警的全部模板变量。
 * @param {object} record 报警记录
 * @param {object} [ctx]
 * @param {object} [ctx.cfg] 渠道配置（fields 字段开关 / titlePrefix 从这取）
 * @param {string} [ctx.screenshotUrl] 截图公网地址（钉钉用）
 * @param {string} [ctx.linkUrl] 原图链接（TG 消息链接，三端都带）
 * @param {string} [ctx.note] 附加提醒（限流提示等）
 * @param {'md'|'html'} [ctx.style] 链接格式：md = [文本](url)，html = <a>
 * @param {boolean} [ctx.omitShotLine] TG 的截图由图片本体承担，不需要文字行
 * @returns {Record<string, string>}
 */
export function collectAlarmVars(record, ctx = {}) {
  const { cfg, screenshotUrl = '', linkUrl = '', note = '', style = 'md', omitShotLine = false } = ctx
  const on = (cfg && cfg.fields) || {}
  const enabled = (k) => on[k] !== false
  const T = record.type

  const conf =
    enabled('confidence') && T === 'person' && Number(record.ratio) > 0
      ? `${(Number(record.ratio) * 100).toFixed(0)}%`
      : ''
  const ratio =
    enabled('ratio') && T !== 'person' && Number(record.ratio) > 0
      ? `${(Number(record.ratio) * 100).toFixed(2)}%`
      : ''

  const bitrateParts = []
  if (enabled('bitrate')) {
    if (record.kbps) bitrateParts.push(`${(record.kbps / 8).toFixed(0)} KB/s`)
    if (record.fps) bitrateParts.push(`${record.fps} fps`)
  }

  // 原图链接：md / html 两种形态
  let link = ''
  if (linkUrl) {
    link = style === 'html' ? `<a href="${htmlEsc(linkUrl)}">📷 查看事件原图</a>` : `[📷 点击查看事件原图](${linkUrl})`
  }

  let shot = ''
  if (!omitShotLine && enabled('screenshot')) {
    if (screenshotUrl) shot = '📷 事件截图：见下方图片'
    else if (record.thumb) shot = '📷 截图已记录（可在事件面板查看原图）'
  }

  const face =
    T !== 'face' && (record.faceName || Number(record.faceScore) > 0)
      ? record.faceName
        ? `${record.faceName}（相似度 ${Math.round((Number(record.faceScore) || 0) * 100)}%）`
        : '未录入的人脸'
      : ''
  const pose = T !== 'pose' && record.actionText ? record.actionText : ''
  const counts = T !== 'count' && record.counts ? countText(record.counts) : ''
  const dwell = Number(record.dwellMs) > 0 ? dwellText(record.dwellMs) : ''
  const zoneName = !['enter', 'exit', 'loiter'].includes(T) && record.zoneName ? record.zoneName : ''

  const r = record.roi
  const roi = enabled('roi')
    ? r
      ? `x ${(r.x * 100).toFixed(0)}% · y ${(r.y * 100).toFixed(0)}% · 宽 ${(r.w * 100).toFixed(0)}% · 高 ${(r.h * 100).toFixed(0)}%`
      : '全画面'
    : ''

  return {
    icon: TYPE_ICONS[T] || '⚠️',
    title: `${(cfg && cfg.titlePrefix) || '【监控报警】'}${alarmTitle(record)}`,
    channel: record.name || '未命名通道',
    channelId: enabled('cameraId') ? record.id || '' : '',
    time: fmtTime(record.time),
    type: alarmDetail(record),
    confidence: conf,
    ratio,
    features: featureTextEmoji(record.features),
    face,
    pose,
    zone: zoneName,
    counts,
    dwell,
    resolution: enabled('resolution') ? record.resolution || '' : '',
    bitrate: bitrateParts.join(' · '),
    roi,
    url: enabled('url') ? record.url || '' : '',
    seq: enabled('seq') && record.seq ? `#${record.seq}` : '',
    device: enabled('device') ? runtimeLine(BRAND) : '',
    note: note || '',
    shot,
    link,
    line: LINE
  }
}

/* ==================== 渲染 ==================== */

/**
 * 渲染模板。
 * 未知变量保留原样（用户能一眼看到拼错了），而不是悄悄吞掉。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.escapeValue] 渲染 HTML 模板（Telegram）时对变量值转义
 * @param {string[]} [opts.skipEscapeKeys] 不转义的变量 —— {link} 的值本身就是
 *   可信 HTML（<a href>），转义会把标签变成可见文本
 */
export function renderTemplate(tpl, vars, opts = {}) {
  const escapeValue = !!opts.escapeValue
  const skip = opts.skipEscapeKeys || []
  let out = String(tpl || '').replace(/\{(\w+)\}/g, (m, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return m
    const v = vars[key]
    const s = v === null || v === undefined ? '' : String(v)
    if (escapeValue && !skip.includes(key)) return htmlEsc(s)
    return s
  })

  // 清理变量为空留下的残行：以「：/ :」结尾的行整行删掉
  out = out
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      if (!t) return true
      return !/[：:]$/.test(t)
    })
    .join('\n')

  // 连续 3 个以上换行压成 1 个空行；首尾去空行
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return out
}

/* ==================== 三端默认模板 ==================== */
/*
 * 上下两段：上段「发生了什么」（重要，扫一眼），下段「细节」（想看再看）。
 * 变量为空的行会被自动清掉，所以没开置信度的消息里不会出现孤零零的「- 置信度：」。
 */

export const DEFAULT_DING_TEMPLATE = `### 🚨 {title} · {channel}

> {icon} 事件：**{type}**
> 🕐 {time}
{note}

{line}

**📌 告警详情**
- 通道：{channel}
- 置信度：{confidence}
- 变动幅度：{ratio}
- 检测区域：{roi}

**⚙️ 功能状态**
{features}

**🖥️ 设备信息**
- 分辨率：{resolution}
- 码率/帧率：{bitrate}
- 运行设备：{device}

{shot}
{link}

> BossMonitor 实时分析生成`

export const DEFAULT_TG_TEMPLATE = `{icon} <b>{title} · {channel}</b>

🕐 {time}
事件：<b>{type}</b>
{note}

{line}

<b>📌 告警详情</b>
· 通道：<b>{channel}</b>
· 置信度：{confidence}
· 检测区域：{roi}

<b>⚙️ 功能状态</b>
{features}

<b>🖥️ 设备信息</b>
· 分辨率：{resolution}
· 码率/帧率：{bitrate}
· 运行设备：{device}

{link}

<i>BossMonitor 实时分析生成</i>`

export const DEFAULT_WECOM_TEMPLATE = `**🚨 {title} · {channel}**

> {icon} 事件：**{type}**
> 🕐 {time}
{note}

{line}

**📌 告警详情**
> 通道：{channel}
> 置信度：{confidence}
> 检测区域：{roi}

**⚙️ 功能状态**
{features}

**🖥️ 设备信息**
> 分辨率：{resolution}
> 码率/帧率：{bitrate}
> 运行设备：{device}

{shot}
{link}

BossMonitor 实时分析生成`

/** 三端默认模板速查（设置页「恢复默认」用） */
export const DEFAULT_TEMPLATES = {
  ding: DEFAULT_DING_TEMPLATE,
  tg: DEFAULT_TG_TEMPLATE,
  wecom: DEFAULT_WECOM_TEMPLATE
}
