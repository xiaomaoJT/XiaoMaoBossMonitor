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
/*
 * 属性的解读口径（阈值 / 标签 / 年龄分桶）收在 faceAttr.js 一份 ——
 * 设置页徽标与这里的统计必须用同一套阈值，否则会出现「卡片上写着口罩、
 * 统计里没算他一顶」这种对不上的账。
 */
import { AGE_BUCKETS, FACE_ATTR_TAGS, ageBucket, faceAttrTags, hasFaceAttrs } from './faceAttr.js'

const KEY = 'monitor-wall-daily-stats-v1'
/**
 * 计数口径版本：1 = 记 60 秒采样条数，2 = 记累计经过人次快照，
 * 3 = 全类型按通道 + 区域快照，4 = 新增区域驻留质量（去重 / 峰值 / 停留）。
 * 写在存档根上；v1→v2 那次需要清掉旧条数，否则 max() 会永久压着新快照。
 * v3→v4 是纯加字段，prune() 补空即可，旧天保留原事件数口径。
 */
const COUNT_METRIC_VERSION = 4
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
  { id: 'flow', label: '走向' },
  { id: 'count', label: '计数' }
]

/**
 * 区域事件在事件库里是 enter / exit / loiter 三个细分，统计时**都归到 zone 一类**
 * （但细分本身也各自留一份计数，谁也不丢）。
 * 放在模块级：`statAlarm` 与 `normHourTypes` 都要用，写在两处迟早漂移。
 */
const ZONE_ALIASES = ['enter', 'exit', 'loiter']

/**
 * §5.184 需要按子维度分段的四种类型。count 不在这里 —— 它按「通道 + 区域」
 * 存人次快照（byZoneCounts），量纲与这里的事件次数不同，混在一张表里迟早对不上。
 * 白名单同时被主进程用来收口 IPC 数据，别在别处再手写一份。
 */
export const STAT_SUB_TYPES = ['face', 'zone', 'flow', 'pose']
/** 单一类型下最多保留多少个子维度键（防止脏子存档把 localStorage 撑爆） */
const SUB_KEYS_MAX = 32
/** §5.189 每区域最多留多少个去重身份键；超出后 unique 仍按聚合值保留 */
const UNIQ_KEYS_MAX = 512

/** 小时桶里允许出现的类型键：6 个已知类型 + 区域事件的 3 个细分（有上界，不会被子存档撑大） */
const HOUR_TYPE_KEYS = [...ALARM_TYPES.map((t) => t.id), ...ZONE_ALIASES]

/**
 * §5.191 通知抑制的原因白名单。键数固定，写入只是 O(1) 自增；
 * 不做自由键，避免脏指令把日存档撑大（与 faceAttrs.tags 同款纪律）。
 */
const SUPPRESS_REASONS = ['silent', 'throttle', 'unchecked', 'merge', 'faceSilent', 'digest', 'hardSilent', 'critical']

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

/** 属性分布的空结构（性别 / 年龄分桶 / 口罩眼镜等标签） */
function emptyAttrs() {
  return {
    /** 属性样本数 = 分母（只算真的算过属性的记录，见 faceAttr.hasFaceAttrs） */
    n: 0,
    gender: { male: 0, female: 0, unknown: 0 },
    /** 年龄分桶：{ [桶 id]: 次数 }，稀疏 */
    age: {},
    /** 标签命中次数：{ mask: n, glasses: n, ... }，稀疏 */
    tags: {}
  }
}

function emptyDay() {
  return {
    alarms: 0,
    /** 按类型的报警次数 */
    byType: {},
    /**
     * §5.182 所有报警类型都按通道分段：{ [类型]: { [通道名]: 次数 } }。
     * count 存「累计经过人次」快照，其余类型存该通道当天事件次数；
     * 用通道名做 key，托盘统计的白名单快照拿去显示，不用再查配置里的 id→name。
     */
    byTypeCam: { count: {} },
    /**
     * §5.182 计数按「通道 + 区域」两级分段：
     * { [通道名]: { [zoneId]: { name, totalIn, totalOut } } }。
     * 只存开启计数的真实区域当日累计快照；与 byTypeCam.count 通道汇总同源。
     */
    byZoneCounts: {},
    /**
     * §5.189 区域驻留质量（与 byZoneCounts 的人次量纲分开存）：
     * { [通道名]: { [zoneId]: { name, unique, peak, dwellSum, dwellSamples, keys } } }。
     * unique 是区内去重人数，peak 是峰值同时人数，平均停留 = dwellSum / dwellSamples；
     * keys 只留有限个身份键，供重启后继续去重（faces 用库内 id，陌生人用 trackId）。
     * 老存档没有这一维时留空，展示层退回旧事件数口径并标注。
     */
    byZoneQuality: {},
    /**
     * §5.184 四种类型按各自子维度拆事件次数：
     *   face = { 在库人脸, 未录入人脸 }
     *   zone = { 通道·区域名 }（划分且正在监听的区域）
     *   flow = { 走向规则名 }
     *   pose = { 姿态类型 }
     * 老事件没有这些字段时留空，统计图退回按通道分段（§5.182 的旧口径）。
     */
    byTypeSub: {},
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
    /**
     * §5.191 人脸命中的事后纠正（**独立正向计数，不回减 faceHits**）。
     * falseHits = 被 /hitblock 判为误报的样本；correctedHits = 被 /hitfix 补录纠正的样本。
     * 已同步到前端的历史日桶无法回滚，回减只会让两端对不上，所以只记"发生了多少次纠正"。
     */
    falseHits: 0,
    correctedHits: 0,
    /**
     * §5.191 应发未发的通知条数（静默 / 限流 / 未勾选 / 合并 / 人脸组静默 / 摘要 / 硬静默）。
     * 与 push.ok/fail 并列，不改 old 成功率口径；suppressedBy 只记固定原因键。
     */
    suppressed: 0,
    suppressedBy: {},
    /** 人员榜：{ [名字]: { n: 命中次数, t: 最近一次命中时刻 } } */
    hitsByName: {},
    /** 最近命中明细（时间**倒序**，最多 HIT_LOG_MAX 条）：{ n:名字, t:时刻, c:通道, s:相似度 } */
    recentHits: [],
    /**
     * 人脸属性分布（性别 / 年龄分桶 / 口罩眼镜等标签）。
     * 回答的是"看见的人都是些什么人"，与"谁来过"（hitsByName）是两件事。
     * n 是**分母**：只累计真的算过属性的记录 —— 属性模型可以关
     * （face.genderAge / face.attrib），关掉之后每条记录都没属性字段，
     * 把它们算进分母只会得到「样本 1200、男 0 女 0」，看着像模型坏了。
     */
    faceAttrs: emptyAttrs(),
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
 * 规整属性分布：计数一律夹成非负整数，**年龄桶与标签只认白名单键**。
 * 白名单不只是防脏数据 —— 它同时给出体积上界：子存档里塞 500 个假标签键，
 * 也只会保留恰好 FACE_ATTR_TAGS.length + AGE_BUCKETS.length 个。
 * 空桶不写（稀疏），与小时桶同一套取舍。
 */
function normAttrs(src) {
  const base = emptyAttrs()
  if (!src || typeof src !== 'object') return base
  const int = (v) => Math.max(0, Math.floor(Number(v) || 0))
  base.n = int(src.n)
  const g = src.gender || {}
  base.gender.male = int(g.male)
  base.gender.female = int(g.female)
  base.gender.unknown = int(g.unknown)
  ;[...AGE_BUCKETS.map((b) => b.id), 'unknown'].forEach((id) => {
    const v = int((src.age || {})[id])
    if (v) base.age[id] = v
  })
  FACE_ATTR_TAGS.forEach((t) => {
    const v = int((src.tags || {})[t.id])
    if (v) base.tags[t.id] = v
  })
  return base
}

/** §5.191 抑制原因归一化：固定白名单 + 非负整数 + 空桶不写（体积有上界） */
function normSuppressBy(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const reason of SUPPRESS_REASONS) {
    const n = Math.max(0, Math.floor(Number(src[reason]) || 0))
    if (n) out[reason] = n
  }
  return out
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
      byTypeCam: normTypeCam(d.byTypeCam),
      byZoneCounts: normZoneCounts(d.byZoneCounts),
      byZoneQuality: normZoneQuality(d.byZoneQuality),
      byTypeSub: normTypeSub(d.byTypeSub),
      push: {
        ding: { ...base.push.ding, ...((d.push || {}).ding || {}) },
        wecom: { ...base.push.wecom, ...((d.push || {}).wecom || {}) },
        tg: { ...base.push.tg, ...((d.push || {}).tg || {}) }
      },
      people: Array.isArray(d.people) ? d.people.slice(0, 200) : [],
      // 命中：次数是标量，直接夹成非负整数；两张表各自规整（见上面两个函数）
      faceHits: Math.max(0, Math.floor(Number(d.faceHits) || 0)),
      // §5.191 纠正与抑制：老存档缺字段由 ...base 补 0，脏值在这里夹住
      falseHits: Math.max(0, Math.floor(Number(d.falseHits) || 0)),
      correctedHits: Math.max(0, Math.floor(Number(d.correctedHits) || 0)),
      suppressed: Math.max(0, Math.floor(Number(d.suppressed) || 0)),
      suppressedBy: normSuppressBy(d.suppressedBy),
      hitsByName: normHitsByName(d.hitsByName),
      recentHits: normRecentHits(d.recentHits),
      // 属性分布：白名单键 + 稀疏，`...d` 带进来的那份会被这里整段覆盖成规整版
      faceAttrs: normAttrs(d.faceAttrs),
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

/**
 * 通道分段的归一化：类型只认 ALARM_TYPES 白名单（区域细分不单列，统一归 zone），
 * 通道名限长、计数夹成非负整数、空桶丢掉。旧存档只有 count 一类时其余为空，
 * 页面照旧退回类型单色。
 */
function normTypeCam(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const t of ALARM_TYPES) {
    const table = src[t.id] && typeof src[t.id] === 'object' ? src[t.id] : {}
    const bucket = {}
    for (const raw of Object.keys(table).slice(0, 32)) {
      const name = String(raw).trim().slice(0, 24)
      const n = Math.max(0, Math.floor(Number(table[raw]) || 0))
      if (name && n) bucket[name] = n
    }
    if (Object.keys(bucket).length) out[t.id] = bucket
  }
  return out
}

/**
 * 计数区域快照的归一化：{ 通道: { zoneId: { name, totalIn, totalOut } } }。
 * 通道 / 区域名限长、zoneId 限长、次数夹成非负整数，且每通道最多 32 个区域 ——
 * 防止脏子存档把 localStorage 撑爆（与通道白名单同一个理由）。
 */
function normZoneCounts(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const rawCam of Object.keys(src).slice(0, 32)) {
    const cam = String(rawCam).trim().slice(0, 24)
    const table = src[rawCam] && typeof src[rawCam] === 'object' ? src[rawCam] : {}
    const bucket = {}
    for (const rawZone of Object.keys(table).slice(0, 32)) {
      const id = String(rawZone).trim().slice(0, 64)
      const z = table[rawZone] && typeof table[rawZone] === 'object' ? table[rawZone] : {}
      const ti = Math.max(0, Math.floor(Number(z.totalIn) || 0))
      const to = Math.max(0, Math.floor(Number(z.totalOut) || 0))
      const name = String(z.name || '区域').trim().slice(0, 24)
      if (id) bucket[id] = { name, totalIn: ti, totalOut: to }
    }
    if (cam && Object.keys(bucket).length) out[cam] = bucket
  }
  return out
}

/**
 * §5.189 区域驻留快照归一化：有界、非负、keys 去重限长。
 * 与 normZoneCounts 分开存 —— 那边会整段重建 zone 对象，塞进去会被静默吃掉。
 */
function normZoneQuality(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const rawCam of Object.keys(src).slice(0, 32)) {
    const cam = String(rawCam).trim().slice(0, 24)
    const table = src[rawCam] && typeof src[rawCam] === 'object' ? src[rawCam] : {}
    const bucket = {}
    for (const rawZone of Object.keys(table).slice(0, 32)) {
      const id = String(rawZone).trim().slice(0, 64)
      const z = table[rawZone] && typeof table[rawZone] === 'object' ? table[rawZone] : {}
      const keys = []
      const seen = new Set()
      if (Array.isArray(z.keys)) {
        for (const rawKey of z.keys.slice(0, UNIQ_KEYS_MAX)) {
          const k = String(rawKey).trim().slice(0, 32)
          if (k && !seen.has(k)) { seen.add(k); keys.push(k) }
        }
      }
      const uniq = Math.max(0, Math.floor(Number(z.unique) || 0))
      const peak = Math.max(0, Math.floor(Number(z.peak) || 0))
      const dwellSum = Math.max(0, Math.floor(Number(z.dwellSum) || 0))
      const dwellSamples = Math.max(0, Math.floor(Number(z.dwellSamples) || 0))
      if (id && (uniq || peak || dwellSum || keys.length)) {
        bucket[id] = {
          name: String(z.name || '区域').trim().slice(0, 24),
          unique: Math.max(uniq, keys.length),
          peak,
          dwellSum,
          dwellSamples,
          keys
        }
      }
    }
    if (cam && Object.keys(bucket).length) out[cam] = bucket
  }
  return out
}

/**
 * §5.184 子维度表的归一化：只留四种已知类型、键名限长、次数夹成非负整数。
 * 与 normTypeCam 同款有界策略 —— 脏子存档不能靠一个超长名字撑爆 localStorage。
 */
function normTypeSub(src) {
  const out = {}
  if (!src || typeof src !== 'object') return out
  for (const t of STAT_SUB_TYPES) {
    const table = src[t] && typeof src[t] === 'object' ? src[t] : {}
    const bucket = {}
    for (const raw of Object.keys(table).slice(0, SUB_KEYS_MAX)) {
      const name = String(raw).trim().slice(0, 24)
      const n = Math.max(0, Math.floor(Number(table[raw]) || 0))
      if (name && n) bucket[name] = n
    }
    if (Object.keys(bucket).length) out[t] = bucket
  }
  return out
}

/** §5.184 子维度计数：一次事件 +1，键名限长；只写已知类型，别处不许另写一份 */
function bumpSub(d, type, key) {
  const name = String(key == null ? '' : key).trim().slice(0, 24)
  if (!name || !STAT_SUB_TYPES.includes(type)) return
  if (!d.byTypeSub || typeof d.byTypeSub !== 'object') d.byTypeSub = {}
  const table = d.byTypeSub[type] || (d.byTypeSub[type] = {})
  table[name] = (Number(table[name]) || 0) + 1
}

function load() {
  try {
    if (typeof localStorage === 'undefined') return emptyState()
    const raw = localStorage.getItem(KEY)
    if (!raw) return emptyState()
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || !saved.days) return emptyState()
    const days = prune(saved.days)
    const savedV = Number(saved.v)
    if (!Number.isFinite(savedV) || savedV < 2) {
      // v1 的 byTypeCam.count / byType.count 是采样条数，与人次快照量纲不同。
      // 清掉后由事件库 countCamByDay() 按 totalIn 回填，老数据照样能分色。
      for (const d of Object.values(days)) {
        d.byTypeCam = { count: {} }
        d.byType.count = 0
      }
    }
    // v2 → v3：只新增全类型按通道 + 区域快照维度，不动已有人次值，无需清数据。
    return { days }
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
      localStorage.setItem(KEY, JSON.stringify({ v: COUNT_METRIC_VERSION, days: dailyStats.days }))
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

/**
 * 记一次报警（事件产生时调）
 * @param {string} type 类型
 * @param {number} ts 时间
 * @param {object} [meta] 事件记录；§5.174 只从它取通道名给 count 拆分用
 */
export function statAlarm(type, ts = Date.now(), meta) {
  try {
    /*
     * §5.177：没划真实区域的通道，它的「计数」只是画面实时人数（totalIn 恒 0，
     * 文案里 §5.174 已不显示累计），**不算一次计数报警**。这类事件若也记进来，
     * 三个开了计数的通道会同频每 60s 各采样一次 → byTypeCam.count 条数完全相同，
     * 分段里就冒出一条本不该存在的通道段。这里在统计唯一入口一次性挡掉：
     * 采样（countStatOnly）、落库事件（countLogSlot）两条路径都经 statEvent → 本函数，
     * 统一按 countZoned 判定；老事件没有该字段（undefined）照旧记，向后兼容。
     */
    if (type === 'count' && meta && meta.countZoned === false) return
    const d = bucket(ts)
    const h = hourOf(ts)
    const H = hoursOf(d)
    d.alarms += 1
    H.alarms[h] += 1
    if (type) {
      d.byType[type] = (d.byType[type] || 0) + 1
      /*
       * §5.182 全类型按通道分段：count 记「累计经过人次」快照，其余类型记事件次数。
       * 后端 record 用 name/id，分析器直接 emit 的事件用 camName/camId —— 两边都认。
       */
      const cam = String((meta && (meta.name || meta.camName || meta.id || meta.camId)) || '').trim().slice(0, 24)
      /*
       * §5.184 四种类型按各自子维度再拆一份事件次数（与通道分段并列、互不代替）：
       * 区域取「通道·区域名」—— 只认事件里带着 zoneName 的，也就是真划了且在监听
       * 的区域；人脸分在库 / 未录入；走向取规则名；姿态取姿态类型。count 不在这儿，
       * 它走 byZoneCounts 的人次快照口径。
       */
      if (type === 'face') {
        bumpSub(d, 'face', meta && meta.known === true ? '在库人脸' : '未录入人脸')
      } else if (type === 'flow') {
        const flow = meta && meta.flowName
          ? meta.flowName
          : `${(meta && (meta.fromZoneName || meta.fromZone)) || '?'}→${(meta && (meta.toZoneName || meta.toZone)) || '?'}`
        bumpSub(d, 'flow', flow)
      } else if (type === 'pose') {
        bumpSub(d, 'pose', meta && (meta.actionText || meta.action))
      } else if (ZONE_ALIASES.includes(type) || type === 'zone') {
        const zone = String((meta && (meta.zoneName || meta.zone)) || '').trim()
        bumpSub(d, 'zone', cam && zone ? `${cam}·${zone}` : (zone || cam))
      }
      if (cam) {
        if (!d.byTypeCam || typeof d.byTypeCam !== 'object') d.byTypeCam = {}
        if (type === 'count') {
          if (!d.byTypeCam.count || typeof d.byTypeCam.count !== 'object') d.byTypeCam.count = {}
          /*
           * 分段数字直接对齐通道画面上的「累计经过人次」，记 totalIn 快照而非条数。
           * totalIn 单调递增，取 max 即该通道最新累计人次；重启归零也不会抹小历史。
           */
          const ti = Math.max(0, Math.floor(Number(meta.counts && meta.counts.totalIn) || 0))
          if (ti > (d.byTypeCam.count[cam] || 0)) d.byTypeCam.count[cam] = ti
          // 区域级快照：只认 counts.byZone，老事件没有就跳过（页面退回通道单段）
          const byZone = meta.counts && meta.counts.byZone
          if (byZone && typeof byZone === 'object') {
            if (!d.byZoneCounts || typeof d.byZoneCounts !== 'object') d.byZoneCounts = {}
            if (!d.byZoneCounts[cam] || typeof d.byZoneCounts[cam] !== 'object') d.byZoneCounts[cam] = {}
            for (const [zoneId, raw] of Object.entries(byZone)) {
              const id = String(zoneId).trim().slice(0, 64)
              const z = raw && typeof raw === 'object' ? raw : {}
              const zti = Math.max(0, Math.floor(Number(z.totalIn) || 0))
              const zto = Math.max(0, Math.floor(Number(z.totalOut) || 0))
              const cur = d.byZoneCounts[cam][id] || { name: '区域', totalIn: 0, totalOut: 0 }
              d.byZoneCounts[cam][id] = {
                name: String(z.name || cur.name || '区域').trim().slice(0, 24),
                // 同区域取 max：采样/落库两条路径可能交错，谁新都不许把累计抹小
                totalIn: Math.max(cur.totalIn, zti),
                totalOut: Math.max(cur.totalOut, zto)
              }
            }
          }
          /*
           * §5.189 驻留质量与 totalIn 分开写。60 秒采样是同一区域的当日累计快照，
           * 同名取 max（谁新都不许把当日峰值 / 去重抹小）；keys 取并集供重启续去重。
           * 老事件没有 byZoneQuality 时整段跳过，展示层据此走 legacy 口径。
           */
          const byQuality = meta.counts && meta.counts.byZoneQuality
          if (byQuality && typeof byQuality === 'object') {
            if (!d.byZoneQuality || typeof d.byZoneQuality !== 'object') d.byZoneQuality = {}
            if (!d.byZoneQuality[cam] || typeof d.byZoneQuality[cam] !== 'object') d.byZoneQuality[cam] = {}
            for (const [zoneId, raw] of Object.entries(byQuality)) {
              const id = String(zoneId).trim().slice(0, 64)
              const z = raw && typeof raw === 'object' ? raw : {}
              const cur = d.byZoneQuality[cam][id] || { name: '区域', unique: 0, peak: 0, dwellSum: 0, dwellSamples: 0, keys: [] }
              const seen = new Set(Array.isArray(cur.keys) ? cur.keys : [])
              if (Array.isArray(z.keys)) {
                for (const k of z.keys.slice(0, UNIQ_KEYS_MAX)) {
                  const key = String(k).trim().slice(0, 32)
                  if (key) seen.add(key)
                }
              }
              const keys = Array.from(seen).slice(0, UNIQ_KEYS_MAX)
              d.byZoneQuality[cam][id] = {
                name: String(z.name || cur.name || '区域').trim().slice(0, 24),
                unique: Math.max(cur.unique || 0, Math.floor(Number(z.unique) || 0), keys.length),
                peak: Math.max(cur.peak || 0, Math.floor(Number(z.peak) || 0)),
                dwellSum: Math.max(cur.dwellSum || 0, Math.floor(Number(z.dwellSum) || 0)),
                dwellSamples: Math.max(cur.dwellSamples || 0, Math.floor(Number(z.dwellSamples) || 0)),
                keys
              }
            }
          }
          // 类型总数同步改成各通道累计人次之和 —— 分段之和与总数天生对平
          d.byType.count = Object.keys(d.byTypeCam.count)
            .reduce((s, k) => s + (Number(d.byTypeCam.count[k]) || 0), 0)
        } else if (ALARM_TYPES.some((t) => t.id === type)) {
          // 其余类型：每通道当天事件次数累加，与 byType[type] 总量同源
          const table = d.byTypeCam[type] || (d.byTypeCam[type] = {})
          table[cam] = (Number(table[cam]) || 0) + 1
        } else if (ZONE_ALIASES.includes(type)) {
          // 区域细分统一归 zone 分段，与下面 byType.zone 的归并口径一致
          const table = d.byTypeCam.zone || (d.byTypeCam.zone = {})
          table[cam] = (Number(table[cam]) || 0) + 1
        }
      }
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

/**
 * 记一条记录的**人脸属性**（性别 / 年龄桶 / 口罩眼镜标签）。
 *
 * 判定「要不要记」的闸门在 faceAttr.hasFaceAttrs（不是这里）：只有真的算过属性的
 * 记录才进分母。属性模型可以关（face.genderAge / face.attrib），关掉之后
 * 每条记录都没有属性字段 —— 那种记录算进分母只会得到「样本 1200、男 0 女 0」。
 *
 * 注意与 statFaceHit 的分工：那个记「谁来过」（只算库内的人），
 * 这个记「看见的人是什么样」（含陌生人）—— 人口画像不该只有自己人。
 *
 * @param {object} rec 事件记录（需要 gender / age / attr）
 * @param {number} [ts]
 * @returns {boolean} 是否真的计入了一条
 */
export function statFaceAttrs(rec, ts = Date.now()) {
  try {
    if (!hasFaceAttrs(rec)) return false
    const d = bucket(ts)
    if (!d.faceAttrs || typeof d.faceAttrs !== 'object') d.faceAttrs = emptyAttrs()
    const A = d.faceAttrs
    A.n += 1
    if (rec.gender === 'male') A.gender.male += 1
    else if (rec.gender === 'female') A.gender.female += 1
    else A.gender.unknown += 1
    const ab = ageBucket(rec.age)
    A.age[ab] = (A.age[ab] || 0) + 1
    faceAttrTags(rec.attr).forEach((id) => {
      A.tags[id] = (A.tags[id] || 0) + 1
    })
    save()
    return true
  } catch (e) {
    /* 统计失败绝不影响报警 */
    return false
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
 * §5.191 记一次人脸命中的事后纠正。只做正向计数，**绝不回减 faceHits** ——
 * 已同步到前端的日桶无法回滚，减了只会让两端对不上。
 */
export function statFalseHit(ts = Date.now(), n = 1) {
  try {
    bucket(ts).falseHits += Math.max(0, Math.floor(Number(n) || 0))
    save()
  } catch (e) {
    /* 统计失败绝不影响修正指令 */
  }
}
export function statCorrectedHit(ts = Date.now(), n = 1) {
  try {
    bucket(ts).correctedHits += Math.max(0, Math.floor(Number(n) || 0))
    save()
  } catch (e) {
    /* 同上 */
  }
}

/**
 * §5.191 记一条应发未发的通知。原因走白名单，避免自由键撑大存档；
 * 不碰 push.ok/fail，老成功率口径保持原样。
 */
export function statSuppressed(reason, ts = Date.now(), n = 1) {
  try {
    const key = SUPPRESS_REASONS.includes(reason) ? reason : 'unchecked'
    const add = Math.max(0, Math.floor(Number(n) || 0))
    const d = bucket(ts)
    d.suppressed += add
    d.suppressedBy[key] = (d.suppressedBy[key] || 0) + add
    save()
  } catch (e) {
    /* 同上 */
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
 *                      type / time / faceName / name(id 或 camName/camId) / faceScore）
 */
export function statEvent(rec) {
  if (!rec) return
  const t = Number(rec.time) || Date.now()
  // 掉线 / 恢复单列一类，不计入"报警"（否则报警数会被断线刷高）
  if (rec.type === 'offline' || rec.type === 'online') {
    statChannelState(rec.type, t)
    return
  }
  statAlarm(rec.type, t, rec)
  // 识别人次（含陌生人）：人脸事件、或任何带人名的记录都算
  if (rec.type === 'face' || rec.faceName) statPersonHit(rec.faceName, t)
  // 命中（只算库内的人）：判据用 defaults.isFaceHit，与推送 / 远端 /hits 同一份
  if (isFaceHit(rec)) {
    statFaceHit(rec.faceName, { camName: rec.name, camId: rec.id, score: rec.faceScore }, t)
  }
  /*
   * 属性（性别 / 年龄 / 口罩眼镜）：与上面两条**并列**、互不代替 ——
   * 陌生人脸没有名字，不会进「人员榜」，但它一样有性别年龄，
   * 人口画像要是只统计自己人就废了。闸门（是否算过属性）在函数内部。
   */
  statFaceAttrs(rec, t)
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
 *            faceHits:number, hitsByName:object, recentHits:Array, faceAttrs:object,
 *            offline:number, online:number, days:number}}
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
    // §5.191 纠正与抑制都是"发生次数"，与 faceHits 同类跨天求和（不取 max）
    total.falseHits += d.falseHits || 0
    total.correctedHits += d.correctedHits || 0
    total.suppressed += d.suppressed || 0
    for (const reason of SUPPRESS_REASONS) {
      const n = Number((d.suppressedBy || {})[reason]) || 0
      if (n) total.suppressedBy[reason] = (total.suppressedBy[reason] || 0) + n
    }
    Object.keys(d.byType || {}).forEach((t) => {
      total.byType[t] = (total.byType[t] || 0) + (d.byType[t] || 0)
    })
    /*
     * §5.178：通道值现在是「累计经过人次」快照（单调递增），跨天合并取**最大值**，
     * 不能像别的类型那样求和 —— 否则同一批人在今天和明天各被记一次就会翻倍。
     */
    const dbtc = (d.byTypeCam && typeof d.byTypeCam === 'object') ? d.byTypeCam : {}
    for (const t of ALARM_TYPES) {
      const src = dbtc[t.id] && typeof dbtc[t.id] === 'object' ? dbtc[t.id] : {}
      const dst = total.byTypeCam[t.id] || (total.byTypeCam[t.id] = {})
      for (const [name, raw] of Object.entries(src)) {
        const v = Math.max(0, Math.floor(Number(raw) || 0))
        if (!name || !v) continue
        // count 是当日人次快照，跨天取 max；其余类型是事件次数，跨天求和
        if (t.id === 'count') {
          if (v > (dst[name] || 0)) dst[name] = v
        } else {
          dst[name] = (Number(dst[name]) || 0) + v
        }
      }
    }
    // 区域快照：同名区域取 max（与 cnt 快照同口径），跨天不累加
    const dbz = d.byZoneCounts && typeof d.byZoneCounts === 'object' ? d.byZoneCounts : {}
    for (const [cam, table] of Object.entries(dbz)) {
      const c = String(cam).trim().slice(0, 24)
      if (!c || !table || typeof table !== 'object') continue
      const dstCam = total.byZoneCounts[c] || (total.byZoneCounts[c] = {})
      for (const [id, raw] of Object.entries(table)) {
        const z = raw && typeof raw === 'object' ? raw : {}
        const cur = dstCam[id] || { name: '区域', totalIn: 0, totalOut: 0 }
        dstCam[id] = {
          name: String(z.name || cur.name || '区域'),
          totalIn: Math.max(cur.totalIn, Math.floor(Number(z.totalIn) || 0)),
          totalOut: Math.max(cur.totalOut, Math.floor(Number(z.totalOut) || 0))
        }
      }
    }
    /*
     * §5.189 区域驻留质量跨天合并：keys 并集决定区间去重（同一身份两天都来
     * 只算 1），峰值取 max，停留时长 / 样本数相加算区间平均；没有 keys 的老快照
     * 退回 daily unique 的 max，绝不拿事件数冒充人数。
     */
    const dbq = d.byZoneQuality && typeof d.byZoneQuality === 'object' ? d.byZoneQuality : {}
    for (const [cam, table] of Object.entries(dbq)) {
      const c = String(cam).trim().slice(0, 24)
      if (!c || !table || typeof table !== 'object') continue
      const dstCam = total.byZoneQuality[c] || (total.byZoneQuality[c] = {})
      for (const [id, raw] of Object.entries(table)) {
        const z = raw && typeof raw === 'object' ? raw : {}
        const cur = dstCam[id] || { name: '区域', unique: 0, peak: 0, dwellSum: 0, dwellSamples: 0, keys: [] }
        const seen = new Set(Array.isArray(cur.keys) ? cur.keys : [])
        if (Array.isArray(z.keys)) {
          for (const k of z.keys.slice(0, UNIQ_KEYS_MAX)) {
            const key = String(k).trim().slice(0, 32)
            if (key) seen.add(key)
          }
        }
        const keys = Array.from(seen).slice(0, UNIQ_KEYS_MAX)
        dstCam[id] = {
          name: String(z.name || cur.name || '区域').trim().slice(0, 24),
          unique: Math.max(cur.unique || 0, Math.floor(Number(z.unique) || 0), keys.length),
          peak: Math.max(cur.peak || 0, Math.floor(Number(z.peak) || 0)),
          dwellSum: (cur.dwellSum || 0) + Math.max(0, Math.floor(Number(z.dwellSum) || 0)),
          dwellSamples: (cur.dwellSamples || 0) + Math.max(0, Math.floor(Number(z.dwellSamples) || 0)),
          keys
        }
      }
    }
    /*
     * §5.184 子维度全是事件次数：跨天直接相加（与 byType 同源）。
     * 键名白名单 + 上限，避免跨天聚合时把脏数据放大到 IPC 快照里。
     */
    const dsub = d.byTypeSub && typeof d.byTypeSub === 'object' ? d.byTypeSub : {}
    for (const t of STAT_SUB_TYPES) {
      const src = dsub[t] && typeof dsub[t] === 'object' ? dsub[t] : {}
      const dst = total.byTypeSub[t] || (total.byTypeSub[t] = {})
      for (const [name, raw] of Object.entries(src)) {
        const key = String(name).trim().slice(0, 24)
        const v = Math.max(0, Math.floor(Number(raw) || 0))
        if (!key || !v) continue
        dst[key] = (Number(dst[key]) || 0) + v
      }
    }
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
    /* ---------- 人脸属性：全部按位求和（都是计数，没有"取最大"那种口径） ---------- */
    const da = d.faceAttrs
    if (da) {
      const A = total.faceAttrs
      A.n += Number(da.n) || 0
      const dg = da.gender || {}
      A.gender.male += Number(dg.male) || 0
      A.gender.female += Number(dg.female) || 0
      A.gender.unknown += Number(dg.unknown) || 0
      Object.keys(da.age || {}).forEach((id) => {
        A.age[id] = (A.age[id] || 0) + (Number(da.age[id]) || 0)
      })
      Object.keys(da.tags || {}).forEach((id) => {
        A.tags[id] = (A.tags[id] || 0) + (Number(da.tags[id]) || 0)
      })
    }
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
  // §5.178：跨天取 max 之后重算计数类型总数 = 各通道累计人次之和
  total.byType.count = Object.keys(total.byTypeCam.count)
    .reduce((s, k) => s + (Number(total.byTypeCam.count[k]) || 0), 0)
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
