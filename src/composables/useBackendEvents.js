/**
 * 后端检测服务轮询（headless 模式）
 * ----------------------------------------------------------------------------
 * 设置里打开「后端检测服务」后：
 *   - 各通道本地 AI 人形检测停掉（App.vue 会把 aiEnabled 临时置 false 传给画面），
 *     运动检测照旧（它几乎不占资源，且只对当前在看的画面有意义）；
 *   - 这里按 pollMs 间隔轮询 headless 服务的 /api/events，
 *     把新事件转换成和 onAlarm 完全同构的 payload 上抛 ——
 *     事件面板、推送调度、桌面通知、声音、Apple Watch 同步全部原样复用。
 *
 * 状态机：idle（关）→ polling（开）→ error（连不上，自动重试 + 退避提示）
 */
import { ref, computed } from 'vue'
import { netErrorText, timeoutReason } from './useNet.js'
// ⚠️ 相对 import 必须带 .js：后端用 Node ESM 直接加载前端模块，不补扩展名
import { syncStatsFromRemote } from './useDailyStats.js'
import { clientQuery } from './useClientId.js'

/**
 * 权威统计多久刷一次（按轮询次数计）。
 * 统计是低频数据，没必要每轮（默认 4s）都拉；5 轮 ≈ 20s 足够"看一眼就新"。
 * 刚开后端开关那一次由 App.vue 主动同步，这里只负责后续的定时刷新。
 */
const STATS_SYNC_EVERY = 5

export const backendState = ref('idle') // idle | polling | error
export const backendError = ref('')
/** 最近一次成功拉取时间（设置页显示「最后同步」用） */
export const backendLastSyncAt = ref(0)
/** 服务状态快照（来自 /api/status） */
export const backendStatus = ref(null)
/**
 * 后端当前配置版本号（来自 /api/events 响应里的 configRev）。
 *
 * 为什么轮询要顺带读它：远程指令（/digest、/cdigest、/hitfix、/hitblock…）
 * 改的是**后端**那份配置，改完 bump configRev。前端每 pollMs 就在轮询
 * /api/events，这个字段是现成的「后端配置变了」信号 ——
 * App.vue 拿它和本机 syncRev 比，后端更新就静默自动拉取（alignWithBackend），
 * 远程修正的人脸库 / 反例因此能传播进前端 source of truth。
 * 0 = 还没拉到过 / 后端没这个字段（老版本服务）。
 */
export const backendConfigRev = ref(0)
/**
 * 状态哨兵快照（来自 /api/watchdog）：
 * 掉线告警与定时巡检在后端跑，这里只取回来给设置页看（各通道状态 / 下次巡检时间）。
 */
export const backendWatchdog = ref(null)

let timer = null
let lastTime = 0
let errStreak = 0
/** 防止后端重启导致 key 撞车：进程内递增序号 */
let seq = 0
/** 轮询轮次计数，用来给"权威统计"做低频刷新（见 STATS_SYNC_EVERY） */
let pollCount = 0
/** 轮询实例标识：stop/重启后让旧 loop 自然退出，避免两套定时器并存 */
let pollRunId = 0

function normalizeUrl(url) {
  return String(url || '').replace(/\/+$/, '')
}

/**
 * 后端事件记录 → onAlarm 的 payload。
 * thumb / faceThumb / personThumb 已是绝对 URL（服务端拼好的），前端 <img> 直接能显示；
 * shot 留空（原图就在 thumb 指向的文件里，详情页复用 thumb）。
 *
 * ⚠️ thumb 是**事件原图**（事发那一帧）—— 后端只给这一个原图 URL，所以它不能是裁图。
 * 两张裁图各有各的字段：faceThumb 人脸特写、personThumb 补拍到的完整人形。
 * 后端 `/hits img`、`/collect img`、`/search img` 推的也是 thumb，同样依赖这条语义。
 *
 * 后端已经做完的附加分析（人脸是谁、什么动作、是否补过图）一并带过来，
 * 事件面板和详情页因此能显示得和本机检测一样完整。
 *
 * 导出给「历史回填」复用（App.vue 的 backfillHistoryFromBackend）——
 * 回填与实时轮询走**同一份**转换，两端形状不会漂。
 */
export function backendEventToPayload(ev) {
  return {
    id: ev.camId,
    name: ev.camName || ev.camId,
    type: ev.type,
    ratio: 0,
    thumb: ev.thumb || '',
    shot: '',
    time: ev.time,
    text: ev.text || '',
    zoneName: ev.zoneName || '',
    dwellMs: ev.dwellMs || 0,
    counts: ev.counts || null,
    known: ev.known === null || ev.known === undefined ? undefined : ev.known,
    faceName: ev.faceName || '',
    faceScore: ev.faceScore || 0,
    /** 人脸属性（后端 analyzer 顺手算的，与本地检测同源）：性别 / 年龄 / 口罩眼镜等 */
    gender: ev.gender || '',
    age: typeof ev.age === 'number' ? ev.age : null,
    attr: ev.attr && typeof ev.attr === 'object' ? ev.attr : null,
    faceThumb: ev.faceThumb || '',
    personThumb: ev.personThumb || '',
    actionText: ev.actionText || '',
    personShot: !!ev.personShot,
    /** 后端那条记录的 key：两边用同一个 key，已读 / 推送状态才能对齐 */
    backendKey: ev.key || '',
    /** 人员走向：起点出场截图与各节点（有序）截图，详情页渲染「流向轨迹」多图块用 */
    departureShot: ev.departureShot || '',
    /*
     * 流向规则名（用户在设置里给这条 A→B 走向起的名字）。
     * 不映射的话，后端模式的事件面板 / 通知卡片走 alarmDetail 时拿不到名字，
     * 「起了名却只在推送里露一面」—— 面板列表与详情也该显示是哪条规则。
     */
    flowName: ev.flowName || '',
    flowShots: Array.isArray(ev.flowShots) ? ev.flowShots : [],
    /**
     * 各节点整帧原图（与 flowShots 同长同序，'' = 该节点没存上原图）。
     * 详情页轨迹节点优先展示它、点击放大看它；长度与 flowShots 不一致时（脏数据）
     * 展示层整体忽略它回退小图，避免按错下标把节点图配到隔壁节点上。
     */
    flowFulls: Array.isArray(ev.flowFulls) ? ev.flowFulls : [],
    flowPath: Array.isArray(ev.flowPath) ? ev.flowPath : [],
    /** 后端推送状态（前端只展示，不再重复推） */
    backendPush: ev.push || '',
    backendPushError: ev.pushError || '',
    backendPushChannels: ev.pushChannels || '',
    /** 逐渠道回执（后端已解析好的对象），用于「已推送但失败/超时」的区分 */
    backendPushResults: ev.pushResults || null,
    source: 'backend',
    fps: null,
    kbps: null,
    info: null
  }
}

/** 把「已读」同步回后端，保持两端一致（失败无所谓，只是提示用途） */
export async function markReadOnBackend(options, keys) {
  if (!backendOn(options)) return false
  const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => k && !String(k).startsWith('b'))
  if (!list.length) return false
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('标记已读', 5000)), 5000)
    try {
      await fetch(`${normalizeUrl(options.backend.url)}/api/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: list }),
        signal: ctrl.signal
      })
    } finally {
      clearTimeout(t)
    }
    return true
  } catch (e) {
    return false
  }
}

/**
 * 合并「本机已有事件」与「刚回填回来的事件」：按 key 去重 → 按时间倒序 → 截断到上限。
 *
 * 纯函数（不改入参），放这里是为了能被探针直接验 —— App.vue 只负责把它算出来的
 * 结果落库并赋值给 `events.value`，不再自己写一遍排序/去重/截断。
 *
 * ⚠️ 重复时**以后端那份为准**（fresh 在前）：回填带回来的 `read` / `push` 是
 * 共享状态，而本机那份可能是"这条还没标已读"的旧副本。内存列表里只放轻量记录，
 * 用哪一份对截图没影响（IndexedDB 那边同 key 不重复写入，本机的原图不会被冲掉）。
 *
 * @param {object[]} existing 本机现有记录
 * @param {object[]} fresh    回填回来的记录
 * @param {number}   max      保留上限（与 maxEvents 同源）
 */
export function mergeEventLists(existing, fresh, max) {
  const limit = Math.max(1, Number(max) || 200)
  const seen = new Set()
  const all = []
  // fresh 在前：同一个 key 先入为主，于是"重复时以后端为准"是自然结果
  for (const r of [...(fresh || []), ...(existing || [])]) {
    if (!r || !r.key || seen.has(r.key)) continue
    seen.add(r.key)
    all.push(r)
  }
  all.sort((a, b) => (b.time || 0) - (a.time || 0))
  return all.slice(0, limit)
}

/**
 * 从后端一次性取回最近 N 条事件（不带 since）——「历史回填」用。
 *
 * 为什么需要它：轮询是**增量**的，首拉只覆盖最近 1 分钟（startBackendPolling 里
 * `lastTime = Date.now() - 60000`）。于是每台机器打开页面时，事件列表里都只有
 * 「自己打开之后」发生的那部分 —— A 机看到的和 B 机看到的对不上，
 * 明明后端库里躺着同一份完整历史。
 *
 * 这里把最近一批整体取回来，交给 App.vue 合并进本机库 + 内存列表，
 * 三台机器打开看到的就是**同一份内容**（已读状态也一样：它是从后端读的，
 * 任何一台标已读都会 POST /api/read 回后端）。
 *
 * 失败不抛：回填是"锦上添花"，失败了顶多是列表短一些，实时轮询照常工作。
 * @returns {Promise<{ok:boolean, events:object[], error?:string}>}
 */
export async function fetchBackendHistory(url, limit = 200) {
  const base = normalizeUrl(url)
  if (!base) return { ok: false, events: [] }
  const n = Math.max(1, Math.min(2000, Number(limit) || 200))
  try {
    const data = await fetchJson(`${base}/api/events?limit=${n}${clientQuery()}`, 20000)
    return { ok: true, events: Array.isArray(data.events) ? data.events : [] }
  } catch (e) {
    return { ok: false, events: [], error: netErrorText(e, '历史事件回填') }
  }
}

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(timeoutReason('后端接口', timeoutMs)), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

export function backendOn(options) {
  const b = options && options.backend
  return !!(b && b.enabled && b.url)
}

export async function refreshBackendStatus(options) {
  if (!backendOn(options)) {
    backendStatus.value = null
    return null
  }
  try {
    const st = await fetchJson(`${normalizeUrl(options.backend.url)}/api/status${clientQuery(true)}`, 5000)
    backendStatus.value = st
    backendError.value = ''
    return st
  } catch (e) {
    // netErrorText：超时要翻成「后端状态超时…」，别把引擎那句 signal is aborted… 透出去
    backendError.value = netErrorText(e, '后端状态')
    return null
  }
}

/**
 * 启动 / 停止轮询。App.vue 里 watch options.backend.deep 调它。
 * @param {object} options 全局配置（读 backend 块）
 * @param {(payload: object) => void} onEvent 新事件回调（直接接 App.vue 的 onAlarm）
 */
export function startBackendPolling(options, onEvent) {
  stopBackendPolling()
  if (!backendOn(options)) {
    backendState.value = 'idle'
    return
  }
  backendState.value = 'polling'
  backendError.value = ''
  errStreak = 0
  lastTime = Date.now() - 60000 // 首拉覆盖最近 1 分钟，防漏

  const base = normalizeUrl(options.backend.url)
  const pollMs = Math.max(1500, Number(options.backend.pollMs) || 4000)
  const myRun = ++pollRunId

  // 链式 setTimeout：上一轮没回来（含 8s 超时 abort）绝不发下一轮 ——
  // 这是「大量接口 pending 然后 canceled」的根因：原 setInterval 不等人，
  // 后端一慢就重叠堆积，各自超时 abort，前端看到的全是 canceled。
  const loop = async () => {
    if (myRun !== pollRunId) return // 已被 stop/重启取代
    // 后台标签页 / 最小化：跳过无谓请求省资源；回到前台后在 finally 自然续上
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      timer = setTimeout(loop, pollMs)
      return
    }
    try {
      const since = lastTime
      // cid：顺带让后端把"这台设备还在看"记一笔（设备列表的唯一心跳来源）
      const data = await fetchJson(`${base}/api/events?since=${since}&limit=100${clientQuery()}`)
      lastTime = Math.max(lastTime, Number(data.now) || Date.now())
      /*
       * 后端配置版本号：远程指令改后端配置后会 +1。只记**变大**的值 ——
       * 服务重启 / 换了一台 rev 更小的后端时，不能把本机已对齐的状态冲掉。
       */
      const cfgRev = Number(data.configRev) || 0
      if (cfgRev > backendConfigRev.value) backendConfigRev.value = cfgRev
      errStreak = 0
      backendError.value = ''
      backendState.value = 'polling'
      backendLastSyncAt.value = Date.now()
      /*
       * 顺带低频刷一次权威统计（GET /api/stats）：后端模式下统计只在服务端累计，
       * 前端展示的就是这一份。失败不打扰事件轮询 —— 下次再刷即可。
       */
      pollCount += 1
      if (pollCount % STATS_SYNC_EVERY === 0) syncStatsFromRemote().catch(() => {})
      const events = Array.isArray(data.events) ? data.events : []
      for (const ev of events) {
        seq += 1
        const payload = backendEventToPayload(ev)
        payload._backendSeq = seq
        try {
          onEvent(payload)
        } catch (e) {
          /* 单条失败不影响其余 */
        }
      }
    } catch (e) {
      errStreak += 1
      backendError.value = netErrorText(e, '后端事件轮询')
      // 连续失败才降级为 error 状态（偶发一次网络抖动不打脸）
      if (errStreak >= 2) backendState.value = 'error'
    } finally {
      // 完成（或超时）后才排下一轮 —— 保证在途最多 1 个请求
      if (myRun === pollRunId) timer = setTimeout(loop, pollMs)
    }
  }

  loop()
}

export function stopBackendPolling() {
  pollRunId += 1 // 让任何在跑的 loop 自然退出
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  backendState.value = 'idle'
  backendStatus.value = null
  backendWatchdog.value = null
  // 配置版本号归零：换后端 / 重开开关时重新学，别拿旧后端的 rev 比新后端的
  backendConfigRev.value = 0
}

/**
 * 手动触发一次后端巡检（设置页「立即推送巡检」按钮）。
 * 后端模式下推送只在服务端跑，所以这个动作必须发到服务端去，前端自己发不出去。
 * @returns {Promise<boolean>} 是否已成功发出
 */
export async function runBackendPatrol(url) {
  const base = normalizeUrl(url)
  if (!base) return false
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('手动巡检', 20000)), 20000)
    try {
      const res = await fetch(`${base}/api/patrol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual' }),
        signal: ctrl.signal
      })
      const data = await res.json().catch(() => ({}))
      return res.ok && !!data.ok
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    return false
  }
}

/**
 * 让后端发一条静默提醒（设置页「试发开始/结束提醒」「立即推送静默汇总」）。
 *
 * 为什么必须走后端：后端模式下推送只在服务端跑，页面里既没有待汇总的缓冲、
 * 也不该由浏览器去发 —— 否则同一件事会被两个进程各推一遍。
 * 以前这三个按钮只弹一句「后端模式下推送在服务端」，点了等于没点。
 *
 * @param {string} url      后端地址
 * @param {'pre'|'post'|'flush'} kind
 * @param {string[]} [channels] 限定渠道（试发按「静默期间暂停推送的渠道」勾选走）；
 *                              空数组 / 不传 = 后端发全部已配置渠道
 * @returns {Promise<{ok:boolean, reason?:string, title?:string}>}
 */
export async function sendBackendSilentNotice(url, kind, channels) {
  const base = normalizeUrl(url)
  if (!base) return { ok: false, reason: '后端地址无效' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('静默提醒', 30000)), 30000)
    try {
      const res = await fetch(`${base}/api/silent-notice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, channels: Array.isArray(channels) ? channels : [] }),
        signal: ctrl.signal
      })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok && !!data.ok, reason: data.reason || '', title: data.title || '' }
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || '无法连接后端服务' }
  }
}

/**
 * 让后端做一次 Telegram 连接自检（设置页远程控制区的「测试连接」）。
 * @returns {Promise<{ok:boolean, probe?:object, diagnostic?:object, reason?:string}>}
 */
export async function testBackendTgRemote(url) {
  const base = normalizeUrl(url)
  if (!base) return { ok: false, reason: '后端地址无效' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('远程控制自检', 20000)), 20000)
    try {
      const res = await fetch(`${base}/api/tg-remote/test`, { method: 'POST', signal: ctrl.signal })
      return await res.json().catch(() => ({ ok: false, reason: '返回内容无法解析' }))
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || '无法连接后端服务' }
  }
}

/**
 * 让后端删除 Telegram Webhook（getUpdates 与 Webhook 互斥，
 * 这是「机器人配好了却收不到指令」的常见成因）。
 */
export async function deleteBackendTgWebhook(url) {
  const base = normalizeUrl(url)
  if (!base) return { ok: false, reason: '后端地址无效' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('删除 Webhook', 20000)), 20000)
    try {
      const res = await fetch(`${base}/api/tg-remote/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete' }),
        signal: ctrl.signal
      })
      return await res.json().catch(() => ({ ok: false, reason: '返回内容无法解析' }))
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    return { ok: false, reason: (e && e.message) || '无法连接后端服务' }
  }
}

/** 拉一次状态哨兵快照（设置页展示掉线监控与下次巡检时间） */
export async function refreshBackendWatchdog(options) {
  if (!backendOn(options)) {
    backendWatchdog.value = null
    return null
  }
  try {
    const st = await fetchJson(`${normalizeUrl(options.backend.url)}/api/watchdog`, 5000)
    backendWatchdog.value = st
    return st
  } catch (e) {
    backendWatchdog.value = null
    return null
  }
}

export const backendStateText = computed(() => {
  if (backendState.value === 'polling') return '已连接'
  if (backendState.value === 'error') return backendError.value || '连接失败'
  return '未启用'
})
