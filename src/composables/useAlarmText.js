/**
 * 报警文案统一收口
 * ----------------------------------------------------------------------------
 * 事件类型从 2 种（画面移动 / 人形）扩展到 8 种之后（人脸、进出区域、徘徊、
 * 姿态、人员计数），三渠道推送 + 桌面通知 + 通知卡片 + 事件列表都要写标题，
 * 分散写必然会出现「钉钉写对了、企微漏了」这类不一致。
 * 所以这里做成唯一入口，各处只调用，不再自己拼文案。
 */

/** 事件类型 → 中文名（事件列表 / 筛选 / 推送标题都用它） */
export const ALARM_LABELS = {
  motion: '画面移动',
  person: '人形识别',
  face: '人脸识别',
  enter: '走入区域',
  exit: '走出区域',
  loiter: '区域徘徊',
  pose: '人形姿态',
  count: '人员计数',
  flow: '人员走向'
}

export function alarmLabel(type) {
  return ALARM_LABELS[type] || '异常事件'
}

/**
 * 推送渠道的「事件分组」。
 * 渠道设置里按组勾选，避免 8 个复选框把界面塞满：
 *   person 组同时管「人形识别」
 *   zone   组管「走入 / 走出 / 徘徊」
 */
export const EVENT_GROUPS = [
  { key: 'motion', label: '画面移动', desc: '画面出现明显变化' },
  { key: 'person', label: '人形识别', desc: '检测到人形' },
  { key: 'face', label: '人脸识别', desc: '识别到已录入的人 / 陌生人脸' },
  { key: 'zone', label: '区域进出 / 徘徊', desc: '走入、走出、逗留不走' },
  { key: 'pose', label: '人形姿态', desc: '跌倒、举手、蹲下等动作' },
  { key: 'count', label: '人员计数', desc: '定期上报画面人数（当前 / 累计进出）' }
]

/** 事件类型 → 所属分组 */
export const TYPE_GROUP = {
  motion: 'motion',
  person: 'person',
  face: 'face',
  enter: 'zone',
  exit: 'zone',
  loiter: 'zone',
  pose: 'pose',
  count: 'count'
}

/**
 * 新事件分组在老配置里的默认值。
 *
 * count 原本默认关（怕刷屏），用户明确要求「计数相关内容也要推送」，改为默认开。
 * 注意这是**第二层**开关：还要全局 `zone.countPush` 也开着才会真的推。
 * 老配置里显式写过 `count: false` 的会原样保留，不会被这里的默认值翻回去。
 */
export const EVENT_DEFAULTS = { motion: true, person: true, face: true, zone: true, pose: true, count: true }

/** 补齐历史配置里缺的事件开关 */
export function normalizeEvents(evt) {
  const src = evt && typeof evt === 'object' ? evt : {}
  const out = {}
  for (const g of EVENT_GROUPS) {
    out[g.key] = src[g.key] === undefined ? EVENT_DEFAULTS[g.key] : src[g.key] !== false
  }
  return out
}

/**
 * 一条事件的「短摘要」——通知弹窗、桌面通知正文、推送标题都用它。
 * 优先用采集端给的 text（那里知道区域名、人名、停留时长等细节）。
 */
export function alarmBrief(r) {
  if (!r) return ''
  if (r.text) return r.text
  switch (r.type) {
    case 'face':
      return r.faceName ? `识别到「${r.faceName}」` : '检测到未录入的人脸'
    case 'enter':
      return `有人走入「${r.zoneName || '区域'}」`
    case 'exit':
      return `有人走出「${r.zoneName || '区域'}」`
    case 'loiter':
      return `有人在「${r.zoneName || '区域'}」徘徊`
    case 'pose':
      return r.actionText ? `检测到动作：${r.actionText}` : '检测到人形动作'
    case 'count':
      return r.counts ? `人员计数：${countText(r.counts)}` : '人员计数更新'
    case 'person':
      return '检测到人形'
    default:
      return '检测到画面移动'
  }
}

/** 通知标题里的类型短名（带人脸姓名时优先显示姓名） */
export function alarmTitle(r) {
  if (r && r.type === 'face' && r.faceName) return r.faceName
  return alarmLabel(r && r.type)
}

/**
 * 「功能状态」一行的值。
 *
 * 用户要求：**开了啥就把啥写进推送，没开的也要显式说明「未开启」** ——
 * 这样收到消息时能立刻判断「怎么没识别到人脸」，而不是去翻设置。
 *
 * 例：人脸识别 已开启 · 人形姿态 未开启 · 区域规则 已开启 · 人员计数 未开启
 *
 * @param {Array<{label:string,on:boolean}>} list 由 useAiExtras 的 featureState() 产出
 */
export function featureText(list) {
  if (!Array.isArray(list) || !list.length) return ''
  return list.map((f) => `${f.label} ${f.on ? '已开启' : '未开启'}`).join(' · ')
}

/** 人数统计一行的值：当前 / 累计进入 / 累计离开 */
export function countText(c) {
  if (!c) return ''
  const n = (v) => Number(v) || 0
  return `当前 ${n(c.current)} 人 · 累计进入 ${n(c.totalIn)} 人次 · 累计离开 ${n(c.totalOut)} 人次`
}

/** 秒 → 「x 分 y 秒」/「y 秒」 */
export function dwellText(ms) {
  const sec = Math.round((Number(ms) || 0) / 1000)
  if (sec <= 0) return ''
  if (sec < 60) return `${sec} 秒`
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
}

/**
 * 合并消息里挂在事件行后面的补充说明。
 *
 * 扩展分析的 alarmDetail 已经把人名 / 区域 / 动作 / 人数都写全了，
 * 再挂一句采集端的原文就是同一句话说两遍（合并消息本来就短，重复特别显眼）。
 */
export function extraText(r) {
  if (!r) return ''
  if (['face', 'enter', 'exit', 'loiter', 'pose', 'count'].includes(r.type)) return ''
  const d = alarmDetail(r)
  const t = String(r.text || '')
  return t && t !== d ? t : ''
}

/**
 * 推送正文里的「事件类型」一行，把关键细节一并写进去。
 * 分成两行（类型 + 详情）在手机上太占地方，所以这里合并成一行。
 */
export function alarmDetail(r) {
  if (!r) return ''
  switch (r.type) {
    case 'motion':
      return '画面移动（帧差检测）'
    case 'person':
      return '人形识别（AI）'
    case 'face':
      return r.faceName
        ? `人脸识别（${r.faceName} · 相似度 ${Math.round((Number(r.faceScore) || 0) * 100)}%）`
        : '人脸识别（未录入的人脸）'
    case 'enter':
      return `走入区域（${r.zoneName || '-'}）`
    case 'exit':
      return `走出区域（${r.zoneName || '-'}）`
    case 'loiter':
      return `区域徘徊（${r.zoneName || '-'}）`
    case 'pose':
      return `人形姿态（${r.actionText || '-'}）`
    case 'count':
      // 计数事件的正文必须带上数字本身，否则「人员计数」四个字没有任何信息量
      return r.counts ? `人员计数（${countText(r.counts)}）` : '人员计数'
    case 'flow': {
      // 人员走向（跨摄像头）：把「谁从哪去了哪、间隔多久」写进一行，
      // 比 type 原值更有信息量；名字/区域缺省时退化为「未知」以免空着。
      const who = r.faceName || r.name || '未知人员'
      const route = `${r.fromCamName || r.fromCam || '?'}·${r.fromZoneName || r.fromZone || '?'} → ${r.toCamName || r.toCam || '?'}·${r.toZoneName || r.toZone || '?'}`
      const span = r.spanSec != null ? `（间隔 ${r.spanSec} 秒）` : ''
      return `人员走向（${who} 从 ${route}${span}）`
    }
    case 'offline':
      return '通道异常'
    case 'online':
      return '通道恢复'
    default:
      return alarmLabel(r.type)
  }
}
