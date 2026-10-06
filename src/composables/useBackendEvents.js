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

export const backendState = ref('idle') // idle | polling | error
export const backendError = ref('')
/** 最近一次成功拉取时间（设置页显示「最后同步」用） */
export const backendLastSyncAt = ref(0)
/** 服务状态快照（来自 /api/status） */
export const backendStatus = ref(null)
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

function normalizeUrl(url) {
  return String(url || '').replace(/\/+$/, '')
}

/**
 * 把后端事件记录转成 onAlarm 的 payload。
 * thumb / faceThumb 已是绝对 URL（服务端拼好的），前端 <img> 直接能显示；
 * shot 留空（原图就在 thumb 指向的文件里，详情页复用 thumb）。
 *
 * 后端已经做完的附加分析（人脸是谁、什么动作、是否补过图）一并带过来，
 * 事件面板和详情页因此能显示得和本机检测一样完整。
 */
function toPayload(ev) {
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
    faceThumb: ev.faceThumb || '',
    actionText: ev.actionText || '',
    personShot: !!ev.personShot,
    /** 后端那条记录的 key：两边用同一个 key，已读 / 推送状态才能对齐 */
    backendKey: ev.key || '',
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
    const t = setTimeout(() => ctrl.abort(), 5000)
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

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
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
    const st = await fetchJson(`${normalizeUrl(options.backend.url)}/api/status`, 5000)
    backendStatus.value = st
    backendError.value = ''
    return st
  } catch (e) {
    backendError.value = (e && e.message) || '连接失败'
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

  const tick = async () => {
    try {
      const since = lastTime
      const data = await fetchJson(`${base}/api/events?since=${since}&limit=100`)
      lastTime = Math.max(lastTime, Number(data.now) || Date.now())
      errStreak = 0
      backendError.value = ''
      backendState.value = 'polling'
      backendLastSyncAt.value = Date.now()
      const events = Array.isArray(data.events) ? data.events : []
      for (const ev of events) {
        seq += 1
        const payload = toPayload(ev)
        payload._backendSeq = seq
        try {
          onEvent(payload)
        } catch (e) {
          /* 单条失败不影响其余 */
        }
      }
    } catch (e) {
      errStreak += 1
      backendError.value = (e && e.message) || '连接失败'
      // 连续失败才降级为 error 状态（偶发一次网络抖动不打脸）
      if (errStreak >= 2) backendState.value = 'error'
    }
  }

  tick()
  timer = setInterval(tick, pollMs)
}

export function stopBackendPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  backendState.value = 'idle'
  backendStatus.value = null
  backendWatchdog.value = null
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
    const t = setTimeout(() => ctrl.abort(), 20000)
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
