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
 *
 * 小时桶（v1 存档的增量，2026-10-10 加）
 * ----------------------------------------------------------------------------
 * 统计页的热力图是「日期 × 小时」的，光有按天汇总画不出来 —— 缺的是**小时维度**。
 * 所以每天额外挂一层 `hours`：
 *
 *   hours.alarms[24]        每个本地小时的报警次数
 *   hours.push[24]          每个小时**实际发出**的推送条数（成功 + 失败）
 *   hours.hits[24]          每个小时的识别人次
 *   hours.known[24]         每个小时的**人脸命中**次数（命中已录入人脸）
 *   hours.types[typeId][24] 每个小时按报警类型的次数（只给热力图「类型」维度用）
 *
 * 人脸命中（2026-10-12 加）
 * ----------------------------------------------------------------------------
 * 「识别到人」和「命中已录入人脸」是两件事，以前只记了前者：
 *   · personHits —— 识别人次（**含陌生人**），回答"摄像头看见过多少人"；
 *   · faceHits   —— 命中次数（**只算库内的人**），回答"自己人来了几次"。
 * 这次的诉求是后者要能"列出人员 / 各自命中几次 / 最近都谁来了"，所以每天额外挂：
 *
 *   faceHits              当天的命中总次数
 *   hitsByName[name]      { n: 命中次数, t: 最近一次命中的时刻 } —— 人员榜
 *   recentHits[]          最近若干条命中明细（时间倒序），给「最近命中记录」用
 *
 * 命中这块的三处取舍：
 *  1. **命中明细只留最近 HIT_LOG_MAX 条**（而不是全存）。这个页面要的是"最近
 *     谁来过"，不是完整审计；7 天 × 30 条 = 210 条小对象，存档不到 20KB，恒定。
 *     要完整明细去事件列表或后端 `/hits` 指令。
 *  2. **hitsByName 的值是对象 `{n,t}` 而不是数字**：这样"每人最近一次命中"和
 *     "每人命中几次"在同一处，不用再挂第二张表（两张表迟早对不上）。
 *  3. **命中判定不在本模块里写**。本模块只负责"记"，"什么算命中"是
 *     defaults.js 的 `isFaceHit`（推送 / 远程指令 / 统计三处共用一份），
 *     调用方判完再传进来 —— 否则这里会冒出第四份判定。
 *
 * 小时桶这三条同样是刻意的：
 *  1. **只存计数，不存明细**。7 天 × 24 小时 × 几种指标 = 几百个整数，JSON 十几 KB。
 *     存明细（哪一秒、哪一路）体积会随报警量线性涨，而这个页面只需要"哪几个小时忙"。
 *  2. **小时是本地小时**（`new Date(ts).getHours()`），和 `dayKey()` 同一套口径 ——
 *     用 UTC 会让 08:00 的报警记到 00:00 格子里，跨时区看起来像"半夜异常高发"。
 *  3. **存储 key 不做版本升级**。这是纯增量的字段追加：`prune()` 是唯一的归一化收口，
 *     旧存档（没有 `hours` 字段）载入时由它补零，日汇总一个数不丢。
 *     换 key 反而要写迁移 + 处理"迁移到一半失败"，收益是负的。
 *     （反过来，新版本写的存档被**旧版本**读到也没事：旧代码压根不看这些字段。）
 */
import { reactive } from 'vue'
/*
 * 「什么算人脸命中」的唯一判定在 defaults.js（推送收窄 / TG 关键事件直推 /
 * 后端 /hits / 统计四处共用）。这里 import 它，是为了让下面 statEvent 成为
 * 「一条事件该记哪些统计」的**唯一**入口 —— 前端 onAlarm 与后端 handleEvent
 * 都调它，两边不会各写一套"哪些算报警、哪些算命中"。
 */
import { isFaceHit } from '../config/defaults.js'

const KEY = 'monitor-wall-daily-stats-v1'
/** 保留天数（含今天） */
export const KEEP_DAYS = 7
/** 每天最多保留多少条命中明细（给统计页「最近命中记录」用；完整明细看事件列表 / /hits） */
export const HIT_LOG_MAX = 30
/** 人员榜最多记多少个名字（防止脏名字把存档撑大） */
const HIT_NAMES_MAX = 200

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

/**
 * 区域事件在事件库里是 enter / exit / loiter 三个细分，统计时**都归到 zone 一类**
 * （但细分本身也各自留一份计数，谁也不丢）。
 * 放在模块级：`statAlarm` 与 `normHourTypes` 都要用，写在两处迟早漂移。
 */
const ZONE_ALIASES = ['enter', 'exit', 'loiter']

/** 小时桶里允许出现的类型键：6 个已知类型 + 区域事件的 3 个细分（有上界，不会被子存档撑大） */
const HOUR_TYPE_KEYS = [...ALARM_TYPES.map((t) => t.id), ...ZONE_ALIASES]

/** 热力图的指标维度（值取自 `hours[metric]`） */
const HOUR_METRICS = [
  { id: 'alarms', label: '报警' },
  { id: 'push', label: '推送' },
  { id: 'hits', label: '识别' },
  { id: 'known', label: '命中' }
]

/** 允许出现在 `hours[metric]` 里的键（写死上界，子存档里的脏键不会被带进来） */
const HOUR_METRIC_KEYS = HOUR_METRICS.map((m) => m.id)

export { CHANNELS as STAT_CHANNELS, ALARM_TYPES as STAT_ALARM_TYPES, HOUR_METRICS as STAT_HOUR_METRICS }

/** 本地日期键 YYYY-MM-DD（不用 toISOString，那是 UTC，会在时区上错一天） */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 某天的本地小时（0~23）；时间戳不可解析时落到 0，绝不产生 NaN 下标 */
function hourOf(ts) {
  const h = new Date(ts).getHours()
  return Number.isFinite(h) && h >= 0 && h <= 23 ? h : 0
}

/**
 * 24 个小时的零桶。
 * ⚠️ 必须是**函数**、每次调用都新建数组：写成模块级常量的话，
 * 所有天共用同一个数组，今天 +1 会让前天一起变（这种 bug 极难看出来）。
 */
function zeros24() {
  return new Array(24).fill(0)
}

/** 把「任意长度 / 缺失 / 脏值」的小时数组规整成 24 个非负整数 */
function norm24(a) {
  const out = zeros24()
  if (!Array.isArray(a)) return out
  for (let i = 0; i < 24; i += 1) {
    const v = Number(a[i])
    out[i] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  }
  return out
}

/**
 * 规整「类型 → 24 小时数组」这张表（只认白名单里的键，键序也固定下来）。
 *
 * **稀疏**：全零的行不写进存档。7 天 × 9 个类型键全量存 = 1512 个数字，
 * 其中绝大多数天数是全零 —— 存档体积会白涨几 KB，而读的地方本来就要兜"没有这一行"。
 */
function normHourTypes(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  HOUR_TYPE_KEYS.forEach((t) => {
    const a = norm24(src[t])
    if (a.some((v) => v > 0)) out[t] = a
  })
  return out
}

/** 某天的小时桶。缺了就补上零结构 —— 兼容"内存里手工构造出来的旧结构" */
function hoursOf(d) {
  if (!d.hours || typeof d.hours !== 'object') d.hours = emptyDay().hours
  const H = d.hours
  HOUR_METRIC_KEYS.forEach((k) => {
    if (!Array.isArray(H[k])) H[k] = zeros24()
  })
  if (!H.types || typeof H.types !== 'object') H.types = {}
  return H
}

function emptyDay() {
  return {
    alarms: 0,
    /** 按类型的报警次数 */
    byType: {},
    /** 推送：{ ding:{ok,fail}, wecom:{...}, tg:{...} } */
    push: { ding: { ok: 0, fail: 0 }, wecom: { ok: 0, fail: 0 }, tg: { ok: 0, fail: 0 } },
    /** 出现过的人次（每条人脸/识别事件算一次，**含陌生人**） */
    personHits: 0,
    /** 唯一人数（按人名去重，存名字数组） */
    people: [],
    /**
     * 人脸命中次数（**只算命中库内的人**，含陌生人的人次见 personHits）。
     * 与 personHits 是两个概念，别混：前者回答"自己人来了几次"，
     * 后者回答"摄像头看见过多少人"。
     */
    faceHits: 0,
    /** 人员榜：{ [名字]: { n: 命中次数, t: 最近一次命中时刻 } } */
    hitsByName: {},
    /** 最近命中明细（时间**倒序**，最多 HIT_LOG_MAX 条）：{ n:名字, t:时刻, c:通道, s:相似度 } */
    recentHits: [],
    /** 通道断线 / 恢复次数 */
    offline: 0,
    online: 0,
    /** 小时桶（热力图用），见文件头说明 */
    hours: { alarms: zeros24(), push: zeros24(), hits: zeros24(), known: zeros24(), types: {} }
  }
}

function emptyState() {
  return { days: {} }
}

/**
 * 规整人员榜：只留 `{ n, t }` 两个字段，键数有上限，脏值一律丢。
 *
 * 为什么不直接把 `d.hitsByName` 透传：这是从 localStorage 读回来的**外部输入** ——
 * 可能是旧版本写的、也可能被手工改过。直接信它，后面排序 / 求和就无从预判
 * （字符串、负数、null 全都能进来）。归一化只在这一处做，读的地方就不用判空。
 */
function normHitsByName(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  let used = 0
  Object.keys(src).forEach((raw) => {
    if (used >= HIT_NAMES_MAX) return
    const name = String(raw || '').trim()
    if (!name) return
    const v = src[raw] || {}
    const n = Math.max(0, Math.floor(Number(v.n) || 0))
    const t = Math.max(0, Number(v.t) || 0)
    if (!n && !t) return
    out[name] = { n, t }
    used += 1
  })
  return out
}

/**
 * 规整命中明细：去脏 → **按时间倒序** → 截断。
 * 顺序在这里统一（而不是留给页面）：存档里的顺序取决于写入路径，
 * 页面只需要"最新的在最上面"这一个保证。
 */
function normRecentHits(src) {
  if (!Array.isArray(src)) return []
  return src
    .filter((h) => h && String(h.n || '').trim())
    .map((h) => ({
      n: String(h.n).trim(),
      t: Math.max(0, Number(h.t) || 0),
      c: String(h.c || ''),
      s: Math.max(0, Number(h.s) || 0)
    }))
    .sort((a, b) => b.t - a.t)
    .slice(0, HIT_LOG_MAX)
}

/**
 * 只保留最近 KEEP_DAYS 天，顺手保证结构完整。
 *
 * ⚠️ 这里是**唯一的归一化收口** —— 载入（load）与落盘（save）都走它，
 *    所以「旧存档没有小时桶」这件事只需要在这里补一次，不必写独立的迁移步骤。
 *    任何新增字段都照这个套路加：在这里补缺省，读的地方就不用到处判空。
 */
function prune(days) {
  const keys = Object.keys(days).sort()
  const cutoff = keys.length > KEEP_DAYS ? keys.slice(-KEEP_DAYS) : keys
  const out = {}
  cutoff.forEach((k) => {
    const d = days[k] || {}
    const base = emptyDay()
    const dh = d.hours && typeof d.hours === 'object' ? d.hours : {}
    out[k] = {
      ...base,
      ...d,
      byType: { ...base.byType, ...(d.byType || {}) },
      push: {
        ding: { ...base.push.ding, ...((d.push || {}).ding || {}) },
        wecom: { ...base.push.wecom, ...((d.push || {}).wecom || {}) },
        tg: { ...base.push.tg, ...((d.push || {}).tg || {}) }
      },
      people: Array.isArray(d.people) ? d.people.slice(0, 200) : [],
      // 命中：次数是标量，直接夹成非负整数；两张表各自规整（见上面两个函数）
      faceHits: Math.max(0, Math.floor(Number(d.faceHits) || 0)),
      hitsByName: normHitsByName(d.hitsByName),
      recentHits: normRecentHits(d.recentHits),
      // 小时桶：旧存档（无 hours / 长度不对 / 脏值）在这里被补成整齐的 24 长数组。
      // `...d` 已经把 dh 带进来了，这里整段覆盖成规整过的版本。
      hours: {
        alarms: norm24(dh.alarms),
        push: norm24(dh.push),
        hits: norm24(dh.hits),
        known: norm24(dh.known),
        types: normHourTypes(dh.types)
      }
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

/** 给「类型 → 24 小时」表加一次（顺手把类型键补出来） */
function bumpTypeHour(types, type, h) {
  if (!Array.isArray(types[type])) types[type] = zeros24()
  types[type][h] += 1
}

/** 记一次报警（事件产生时调） */
export function statAlarm(type, ts = Date.now()) {
  try {
    const d = bucket(ts)
    const h = hourOf(ts)
    const H = hoursOf(d)
    d.alarms += 1
    H.alarms[h] += 1
    if (type) {
      d.byType[type] = (d.byType[type] || 0) + 1
      bumpTypeHour(H.types, type, h)
      // 区域事件在库里是 enter/exit/loiter 三个细分，归到 zone 一类
      // （细分与 zone 各记一份，日汇总与小时桶保持同一口径）
      if (ZONE_ALIASES.includes(type)) {
        d.byType.zone = (d.byType.zone || 0) + 1
        bumpTypeHour(H.types, 'zone', h)
      }
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
    const H = hoursOf(d)
    d.personHits += 1
    H.hits[hourOf(ts)] += 1
    const name = String(faceName || '').trim()
    if (name && !d.people.includes(name) && d.people.length < 200) d.people.push(name)
    save()
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 记一次**人脸命中**（命中人脸库里已录入的人）。
 *
 * ⚠️ 调用方必须先自己判「算不算命中」（defaults.js 的 `isFaceHit`），
 *    这里只做**兜底**：名字空的直接丢掉。
 *    为什么不在这里再判一次类型：那就会多出第四份"什么算命中"的判定，
 *    而判定一旦有两份，迟早出现"面板说 5 次、TG 只推了 4 条"。
 *
 * @param {string} faceName 命中的姓名（空 = 不是命中，直接忽略）
 * @param {{camName?:string, camId?:string, score?:number}} [meta] 明细里要展示的现场信息
 * @param {number} [ts]     发生时刻
 */
export function statFaceHit(faceName, meta = {}, ts = Date.now()) {
  try {
    const name = String(faceName || '').trim()
    // 没有名字就不是"命中"（陌生人脸不算），直接返回 —— 不产生任何计数
    if (!name) return
    const d = bucket(ts)
    const H = hoursOf(d)
    d.faceHits += 1
    const cur = d.hitsByName[name]
    if (cur) {
      cur.n += 1
      cur.t = ts
    } else if (Object.keys(d.hitsByName).length < HIT_NAMES_MAX) {
      // 上限只做防呆（人脸库默认上限 50，正常永远到不了）：
      // 真到上限时总数照涨、人员榜不再加新行，而不是把存档撑爆。
      d.hitsByName[name] = { n: 1, t: ts }
    }
    H.known[hourOf(ts)] += 1
    /*
     * 明细：先追加，再**按时间排序**，最后截断。
     *
     * ⚠️ 刻意不用裸 `unshift`：那只保证"插入顺序倒序"，而事件**会迟到** ——
     *    后端轮询一次可能带回好几条（它们的 time 各自不同），一条推送失败重试后
     *    也会补上来。迟到的那条如果直接 unshift，就会带着**更早**的时刻出现在
     *    "最近命中记录"最上面，把这一栏直接读错。
     *    明细表对外的唯一承诺就是"按时间倒序"，所以这里老实排一次。
     *    代价可忽略：数组长度上限是 HIT_LOG_MAX + 1。
     */
    d.recentHits.push({
      n: name,
      t: ts,
      c: String(meta.camName || meta.camId || ''),
      s: Number(meta.score) || 0
    })
    d.recentHits.sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0))
    if (d.recentHits.length > HIT_LOG_MAX) d.recentHits.length = HIT_LOG_MAX
    save()
  } catch (e) {
    /* 统计失败绝不影响报警 */
  }
}

/** 记一次推送结果（小时桶只关心"这个小时发了几条"，成功失败在日汇总里分开看） */export function statPush(channelId, ok, ts = Date.now()) {
  try {
    if (!channelId) return
    const d = bucket(ts)
    const H = hoursOf(d)
    if (!d.push[channelId]) d.push[channelId] = { ok: 0, fail: 0 }
    if (ok) d.push[channelId].ok += 1
    else d.push[channelId].fail += 1
    H.push[hourOf(ts)] += 1
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

/**
 * 一条事件该记哪些统计 —— **唯一判定**。
 * ----------------------------------------------------------------------------
 * 前端 App.vue 的 onAlarm（本机检测 / 后端轮询事件都走它）与后端
 * headless-monitor.mjs 的 handleEvent（后端检测出来的事件）都调这里。
 *
 * 为什么必须收拢成一份：
 *   "掉线算不算报警"、"识别到人脸算不算命中"这类判定一旦在前端和后端各写
 *   一遍，两边的统计迟早对不上（面板说 5 次、远端说 4 次）。现在——包括
 *   「后端权威统计」上线后——前端的按天统计是**从后端读回来**的，
 *   所以真正写这份统计的只有后端一处，判定也只留这一处。
 *
 * @param {object} rec 事件记录（前端 record / 后端 record 同构：至少有
 *                      type / time / faceName / name / id / faceScore）
 */
export function statEvent(rec) {
  if (!rec) return
  const t = Number(rec.time) || Date.now()
  // 掉线 / 恢复单列一类，不计入"报警"（否则报警数会被断线刷高）
  if (rec.type === 'offline' || rec.type === 'online') {
    statChannelState(rec.type, t)
    return
  }
  statAlarm(rec.type, t)
  // 识别人次（含陌生人）：人脸事件、或任何带人名的记录都算
  if (rec.type === 'face' || rec.faceName) statPersonHit(rec.faceName, t)
  // 命中（只算库内的人）：判据用 defaults.isFaceHit，与推送 / 远端 /hits 同一份
  if (isFaceHit(rec)) {
    statFaceHit(rec.faceName, { camName: rec.name, camId: rec.id, score: rec.faceScore }, t)
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
  /*
   * 后端模式下这份统计的**权威在后端**（见文件尾「后端权威统计」一段）：
   * 只清本机的话，下一次同步又会把后端那份原样拉回来，用户看到"清了又回来"。
   * 所以清零必须一起下发（fire-and-forget，失败不阻塞本地清零）。
   */
  if (remoteUrl) {
    try {
      fetch(`${remoteUrl}/api/stats/reset`, { method: 'POST' }).catch(() => {})
    } catch (e) {
      /* 忽略 */
    }
  }
}

/* ==================== 后端权威统计（多端一致） ==================== */
/*
 * 为什么要这一段：
 *   按天统计以前只活在**开着的那个浏览器**的 localStorage 里 —— 页面关掉就
 *   不记了，换台机器打开就是从零开始。而报警/识别/命中本来就是后端常驻进程
 *   产生的（它 7×24 在跑），统计却没跟着走。
 *
 * 现在的分工（后端模式）：
 *   · **后端累计并落盘**（复用本模块的 statAlarm/statPersonHit/statFaceHit/
 *     statChannelState/statPush，存 server/data 下），任何机器都拿得到；
 *   · **前端只读**：定时把 GET /api/stats 拉回来替换本机 days，页面展示
 *     （aggregate / 热力图 / 命中榜）全部照旧吃 dailyStats.days，不用改；
 *   · **清零双向**：resetDailyStats 同时下发 POST /api/stats/reset。
 *
 * 前端独立模式（没开后端）时 remoteUrl 为空，本机自己累计 —— 与旧行为一致。
 */
let remoteUrl = ''

/** 设置/清除「权威统计所在的后端地址」；传空字符串 = 回到本机自统计 */
export function setStatsRemote(url) {
  remoteUrl = String(url || '').replace(/\/+$/, '')
}

/** 当前权威统计地址（空 = 本机自统计）；测试与诊断用 */
export function statsRemote() {
  return remoteUrl
}

/** 用后端那一份整体替换本机 days（会走 prune 归一化，旧结构自动补齐） */
export function replaceStatsDays(days) {
  dailyStats.days = prune(days && typeof days === 'object' ? days : {})
}

/**
 * 从后端拉一次权威统计并替换本机。
 * @returns {Promise<boolean>} 是否成功拉到并应用
 */
export async function syncStatsFromRemote(timeoutMs = 8000) {
  if (!remoteUrl) return false
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${remoteUrl}/api/stats`, { signal: ctrl.signal })
    if (!res.ok) return false
    const data = await res.json()
    if (!data || !data.days || typeof data.days !== 'object') return false
    replaceStatsDays(data.days)
    return true
  } catch (e) {
    return false
  } finally {
    clearTimeout(to)
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
 * @returns {{alarms:number, byType:object, push:object, personHits:number, people:string[],
 *            faceHits:number, hitsByName:object, recentHits:Array, offline:number, online:number, days:number}}
 */
export function aggregate(keys) {
  const total = emptyDay()
  const th = hoursOf(total)
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
    /* ---------- 人脸命中 ---------- */
    total.faceHits += d.faceHits || 0
    /*
     * 人员榜跨天合并：同名次数相加 + 最近时刻取**最大**。
     * 「张三三天各来一次」在这个周期里就是 3 次，而"最近一次"是三天里最晚那个时刻 ——
     * 两者口径不同，不能用同一套合并规则（一个求和、一个求最大）。
     * 必须是 Math.max 而不是直接覆盖：keys 的顺序由调用方决定，
     * 面板今天按「早 → 晚」传，但倒着传也得给出同一个最近时刻。
     */
    Object.keys(d.hitsByName || {}).forEach((name) => {
      const v = d.hitsByName[name] || {}
      const n = Number(v.n) || 0
      const t = Number(v.t) || 0
      const cur = total.hitsByName[name]
      if (cur) {
        cur.n += n
        cur.t = Math.max(cur.t, t)
      } else if (Object.keys(total.hitsByName).length < HIT_NAMES_MAX) {
        total.hitsByName[name] = { n, t }
      }
    })
    // 明细先全收，循环结束后统一定序截断（每天只留自己最近 30 条，合并后可能超过上限）
    ;(d.recentHits || []).forEach((h) => total.recentHits.push(h))
    // 小时桶按位相加：**遍历指标表**而不是逐个手写 ——
    // 以后再加指标（如 hours.known）不用回来改这里（漏改的表现是"这个维度全为 0"）
    const dh = d.hours || {}
    HOUR_METRIC_KEYS.forEach((m) => {
      const src = norm24(dh[m])
      const dst = th[m]
      for (let i = 0; i < 24; i += 1) dst[i] += src[i]
    })
    // 类型 × 小时是稀疏的：没数的行直接跳过，有数才建
    const dt = dh.types || {}
    HOUR_TYPE_KEYS.forEach((t) => {
      const arr = norm24(dt[t])
      if (!arr.some((v) => v > 0)) return
      if (!Array.isArray(th.types[t])) th.types[t] = zeros24()
      const dst = th.types[t]
      for (let i = 0; i < 24; i += 1) dst[i] += arr[i]
    })
  })
  total.recentHits = total.recentHits.sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0)).slice(0, HIT_LOG_MAX)
  total.days = keys.length
  return total
}

/**
 * 「日期 × 小时」的热力行（热力图默认维度）。
 * @param {string[]} keys 日期键（早 → 晚）
 * @param {'alarms'|'push'|'hits'|'known'} metric 取哪个指标的小时桶
 * @returns {{id:string,label:string,cells:number[],sum:number}[]}
 */
export function hourRows(keys, metric = 'alarms') {
  // 白名单取 HOUR_METRICS 的键：指标表加一项，这里自动跟着认（不用两处各写一遍）
  const m = HOUR_METRIC_KEYS.includes(metric) ? metric : 'alarms'
  return keys.map((k) => {
    const d = dailyStats.days[k] || {}
    const cells = norm24((d.hours || {})[m])
    return {
      id: k,
      // 只显示"月/日"，跨度大时更清爽（与趋势图同一个写法）
      label: k.slice(5).replace('-', '/'),
      cells,
      sum: cells.reduce((a, b) => a + b, 0)
    }
  })
}

/**
 * 人员榜：谁来过、各来过几次、最近一次是什么时候。
 *
 * 刻意做成「吃已聚合结果」的纯函数而不是自己再 `aggregate(keys)` 一次：
 * 统计页同一个周期已经聚合过一遍了（`total`），再聚一次是白算；
 * 更要紧的是**两处各算一遍会漂** —— 万一以后 aggregate 的口径改了，
 * 榜单和上面的总数就会出现"对不上的账"。
 *
 * 排序：命中次数降序；次数相同时最近来过的在前。
 *
 * @param {object} total aggregate() 的结果
 * @returns {{id:string, label:string, n:number, lastAt:number}[]}
 */
export function hitPeopleOf(total) {
  const map = (total && total.hitsByName) || {}
  return Object.keys(map)
    .map((name) => ({ id: name, label: name, n: Number(map[name].n) || 0, lastAt: Number(map[name].t) || 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || b.lastAt - a.lastAt)
}

/**
 * 「报警类型 × 小时」的热力行（热力图「类型」维度：哪种报警在哪个时段高发）。
 * 只列**本周期内有数**的类型，顺序按总数从多到少 —— 零行不占版面。
 * @returns {{id:string,label:string,cells:number[],sum:number}[]}
 */
export function hourTypeRows(keys) {
  const merged = {}
  HOUR_TYPE_KEYS.forEach((t) => (merged[t] = zeros24()))
  keys.forEach((k) => {
    const d = dailyStats.days[k]
    const t = (d && d.hours && d.hours.types) || {}
    HOUR_TYPE_KEYS.forEach((id) => {
      const arr = norm24(t[id])
      for (let i = 0; i < 24; i += 1) merged[id][i] += arr[i]
    })
  })
  return ALARM_TYPES.map((t) => {
    const cells = merged[t.id]
    return { id: t.id, label: t.label, cells, sum: cells.reduce((a, b) => a + b, 0) }
  })
    .filter((r) => r.sum > 0)
    .sort((a, b) => b.sum - a.sum)
}

/** 小时分布里最忙的那个小时（全零返回 -1，代表"没有可说的峰值"） */
export function peakHour(arr) {
  const a = norm24(arr)
  let best = -1
  let bestV = 0
  for (let i = 0; i < 24; i += 1) {
    if (a[i] > bestV) {
      bestV = a[i]
      best = i
    }
  }
  return best
}

/** 某渠道的推送成功率（0~1，无数据返回 -1 表示"暂无数据"） */
export function successRate(pushStat) {
  const ok = (pushStat && pushStat.ok) || 0
  const fail = (pushStat && pushStat.fail) || 0
  if (!ok && !fail) return -1
  return ok / (ok + fail)
}
