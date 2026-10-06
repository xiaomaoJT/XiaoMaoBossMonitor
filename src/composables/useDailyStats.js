/**
 * 每日统计（设置 →「统计」页的数据源）
 * ----------------------------------------------------------------------------
 * 为什么不能直接数 events：
 *   事件记录受 maxEvents 限制（默认 200 条循环淘汰），而且用户可以清空
 *   今日 / 昨日 / 全部。一天报警 300 次的话，前天的分布就再也算不出来了。
 *   所以这里做一份**按天汇总的独立计数**，与事件列表解耦：
 *   事件被淘汰、被清空，都不影响已经记进统计的数。
 *
 * 存储：localStorage，独立的 key（不放进 options）——
 *   「恢复初始化」清的是配置，不该把历史统计一起抹掉。
 *   只保留最近 7 天（KEEP_DAYS），旧的天直接裁掉，体积恒定。
 *
 * 指标设计（全部是"可计量"的）：
 *   - 报警：总次数 + 按类型分布（人形/人脸/区域/姿态/移动/计数）
 *   - 推送：三端各自的成功 / 失败次数 → 成功率
 *   - 识别：出现过的人次、唯一人数（按人名去重）
 *   - 通道：断线 / 恢复次数
 */
import { reactive } from 'vue'

const KEY = 'monitor-wall-daily-stats-v1'
/** 保留天数（含今天） */
export const KEEP_DAYS = 7

const CHANNELS = [
  { id: 'ding', label: '钉钉' },
  { id: 'wecom', label: '企微' },
  { id: 'tg', label: 'TG' }
]

const ALARM_TYPES = [
  { id: 'person', label: '人形' },
  { id: 'face', label: '人脸' },
  { id: 'zone', label: '区域' },
  { id: 'pose', label: '姿态' },
  { id: 'motion', label: '移动' },
  { id: 'count', label: '计数' }
]

export { CHANNELS as STAT_CHANNELS, ALARM_TYPES as STAT_ALARM_TYPES }

/** 本地日期键 YYYY-MM-DD（不用 toISOString，那是 UTC，会在时区上错一天） */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function emptyDay() {
  return {
    alarms: 0,
    /** 按类型的报警次数 */
    byType: {},
    /** 推送：{ ding:{ok,fail}, wecom:{...}, tg:{...} } */
    push: { ding: { ok: 0, fail: 0 }, wecom: { ok: 0, fail: 0 }, tg: { ok: 0, fail: 0 } },
    /** 出现过的人次（每条人脸/识别事件算一次） */
    personHits: 0,
    /** 唯一人数（按人名去重，存名字数组） */
    people: [],
    /** 通道断线 / 恢复次数 */
    offline: 0,
    online: 0
  }
}

function emptyState() {
  return { days: {} }
}

/** 只保留最近 KEEP_DAYS 天，顺手保证结构完整 */
function prune(days) {
  const keys = Object.keys(days).sort()
  const cutoff = keys.length > KEEP_DAYS ? keys.slice(-KEEP_DAYS) : keys
  const out = {}
  cutoff.forEach((k) => {
    const d = days[k] || {}
    const base = emptyDay()
    out[k] = {
      ...base,
      ...d,
      byType: { ...base.byType, ...(d.byType || {}) },
      push: {
        ding: { ...base.push.ding, ...((d.push || {}).ding || {}) },
        wecom: { ...base.push.wecom, ...((d.push || {}).wecom || {}) },
        tg: { ...base.push.tg, ...((d.push || {}).tg || {}) }
      },
      people: Array.isArray(d.people) ? d.people.slice(0, 200) : []
    }
  })
  return out
}

function load() {
  try {
    if (typeof localStorage === 'undefined') return emptyState()
    const raw = localStorage.getItem(KEY)
    if (!raw) return emptyState()
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || !saved.days) return emptyState()
    return { days: prune(saved.days) }
  } catch (e) {
    /* 存储坏了就从头统计，不影响功能 */
    return emptyState()
  }
}

/** 响应式统计状态；结构：{ days: { '2026-10-06': {...} } } */
export const dailyStats = reactive(load())

let saveTimer = null

/** 节流落盘：报警高峰可能连发很多条，没必要每条都同步写 */
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      if (typeof localStorage === 'undefined') return
      dailyStats.days = prune(dailyStats.days)
      localStorage.setItem(KEY, JSON.stringify({ days: dailyStats.days }))
    } catch (e) {
      /* 写不进去就算了，统计不该影响主流程 */
    }
  }, 800)
}

/** 取某天的桶（不存在就建） */
function bucket(ts) {
  const k = dayKey(ts)
  if (!dailyStats.days[k]) dailyStats.days[k] = emptyDay()
  return dailyStats.days[k]
}

/* ==================== 记录接口（供各处调用） ==================== */

/** 记一次报警（事件产生时调） */
export function statAlarm(type, ts = Date.now()) {
  try {
    const d = bucket(ts)
    d.alarms += 1
    if (type) d.byType[type] = (d.byType[type] || 0) + 1
    // 区域事件在库里是 enter/exit/loiter 三个细分，归到 zone 一类
    if (['enter', 'exit', 'loiter'].includes(type)) {
      d.byType.zone = (d.byType.zone || 0) + 1
    }
    save()
  } catch (e) {
    /* 统计失败绝不影响报警 */
  }
}

/** 记一次识别到人（faceName 可为空，只计人次） */
export function statPersonHit(faceName, ts = Date.now()) {
  try {
    const d = bucket(ts)
    d.personHits += 1
    const name = String(faceName || '').trim()
    if (name && !d.people.includes(name) && d.people.length < 200) d.people.push(name)
    save()
  } catch (e) {
    /* 忽略 */
  }
}

/** 记一次推送结果 */
export function statPush(channelId, ok, ts = Date.now()) {
  try {
    if (!channelId) return
    const d = bucket(ts)
    if (!d.push[channelId]) d.push[channelId] = { ok: 0, fail: 0 }
    if (ok) d.push[channelId].ok += 1
    else d.push[channelId].fail += 1
    save()
  } catch (e) {
    /* 忽略 */
  }
}

/** 记一次通道断线 / 恢复 */
export function statChannelState(state, ts = Date.now()) {
  try {
    const d = bucket(ts)
    if (state === 'offline') d.offline += 1
    else if (state === 'online') d.online += 1
    save()
  } catch (e) {
    /* 忽略 */
  }
}

/** 清零统计 */
export function resetDailyStats() {
  dailyStats.days = {}
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY)
  } catch (e) {
    /* 忽略 */
  }
}

/* ==================== 读取 / 聚合 ==================== */

/** 最近 n 天的日期键，从早到晚 */
export function recentDayKeys(n = KEEP_DAYS, now = Date.now()) {
  const out = []
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(dayKey(now - i * 86400000))
  }
  return out
}

/** 取某天的数据（没有就返回全零结构，页面上不用到处判空） */
export function statsOf(key) {
  return dailyStats.days[key] || emptyDay()
}

/**
 * 把若干天合并成一个周期。
 * @param {string[]} keys 日期键（早→晚）
 * @returns {{alarms:number, byType:object, push:object, personHits:number, people:string[], offline:number, online:number, days:number}}
 */
export function aggregate(keys) {
  const total = emptyDay()
  keys.forEach((k) => {
    const d = dailyStats.days[k]
    if (!d) return
    total.alarms += d.alarms || 0
    total.offline += d.offline || 0
    total.online += d.online || 0
    total.personHits += d.personHits || 0
    Object.keys(d.byType || {}).forEach((t) => {
      total.byType[t] = (total.byType[t] || 0) + (d.byType[t] || 0)
    })
    CHANNELS.forEach(({ id }) => {
      const s = (d.push || {})[id] || {}
      total.push[id].ok += s.ok || 0
      total.push[id].fail += s.fail || 0
    })
    // 唯一人数跨天合并：名字集合取并集（同一个"张三"三天各来一次也只算 1 人）
    ;(d.people || []).forEach((n) => {
      if (!total.people.includes(n)) total.people.push(n)
    })
  })
  total.days = keys.length
  return total
}

/** 某渠道的推送成功率（0~1，无数据返回 -1 表示"暂无数据"） */
export function successRate(pushStat) {
  const ok = (pushStat && pushStat.ok) || 0
  const fail = (pushStat && pushStat.fail) || 0
  if (!ok && !fail) return -1
  return ok / (ok + fail)
}
