/**
 * 后端配置同步（headless 模式）
 * ----------------------------------------------------------------------------
 * 解决「为什么要手改 server/config.json」这件事：**不用改**。
 *
 * 打开「后端检测服务」开关时，前端把当前这份配置整体 POST 到服务端
 * （POST /api/config），包括：
 *   - options  —— 推送凭据（钉钉 / 企微 / Telegram）、区域规则、人脸 / 姿态阈值、
 *                 静默时段、冷却、计数间隔……全都在里面；
 *   - cameras  —— 每路通道的流地址（含子码流）、区域多边形、通道级开关；
 *   - faces    —— 人脸库（向量 + 缩略图），后端比对人脸的同一份底库。
 *
 * 服务端收到后落盘 + 热生效，于是：
 *   - 关掉所有前端页面，后端照旧在检测、照旧在推；
 *   - 前端改了推送模板 / 换了流地址 / 新录了人脸，后端下一次同步就跟着变。
 *
 * 同步是**节流合并**的：配置在界面上连续拖动时只发最后一次，
 * 且同一时刻只允许一个请求在飞（在飞期间的变更标记为 dirty，回来再补一发）。
 *
 * ---------- 反方向：拉取（GET /api/config） ----------
 * 只有"推"是不够的：配置只活在**配它的那个浏览器**里，局域网里另一台机器
 * 打开同一个地址，看到的还是它自己的初始化配置（一块空大屏）。
 * pullConfig() 就是把后端那份整体取回来的入口，字段形状与推上去的那份一致。
 *
 * 「谁比谁新」靠版本号：后端每被同步一次 configRev +1，本机记录
 * **自己这份配置对应哪个 rev**（localRev，落盘）——于是
 *   localRev === 后端 rev → 已对齐
 *   localRev <  后端 rev → 别的设备改过后端（本机落后）
 *   localRev === 0       → 本机配置从没跟这个后端交换过
 * ⚠️ 别用 syncRev 当这个基准：它表示「后端当前版本」，每次轮询 /api/status
 *    都会被刷新，拿它当"本机版本"会让落后判定永远成立（自己推完就变落后）。
 */
import { ref, computed } from 'vue'

export const syncState = ref('idle') // idle | syncing | ok | error
export const syncError = ref('')
export const syncAt = ref(0)
export const syncRev = ref(0)
/** 后端回执的当前状态（通道数 / 模型 / 推送渠道），设置页展示用 */
export const remoteStatus = ref(null)

/** 拉取状态：idle | pulling | ok | error */
export const pullState = ref('idle')
export const pullError = ref('')
export const pullAt = ref(0)
/**
 * 本机这份配置对应的**后端版本号**（落盘）。
 * 0 = 本机配置从没跟后端交换过 —— 这也是「空白配置会不会把后端清空」
 * 那个闸门的判据（见 server/headless-monitor.mjs 的 checkBlankOverwrite）。
 */
export const localRev = ref(0)
/** 上一次推送把别的设备的改动覆盖掉了（服务端回执 overwrote） */
export const pushOverwrote = ref(false)

const SYNC_REV_KEY = 'monitor-wall-sync-rev-v1'

function store() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch (e) {
    return null
  }
}

function readSyncedRev() {
  const s = store()
  if (!s) return 0
  try {
    return Number(s.getItem(SYNC_REV_KEY)) || 0
  } catch (e) {
    return 0
  }
}

/**
 * 记下「本机这份配置对应后端的哪个版本」。
 * ⚠️ 只在配置**真的采用/推送成功**之后调，别在"要去拉"的时候先记上 ——
 *    记早了会让落后判定把一份没拉下来的配置当成已对齐。
 */
export function markSynced(rev) {
  const v = Number(rev) || 0
  localRev.value = v
  const s = store()
  if (!s) return
  try {
    s.setItem(SYNC_REV_KEY, String(v))
  } catch (e) {
    /* 存储不可用时只影响下次打开时的判定 */
  }
}

localRev.value = readSyncedRev()

let timer = null
let inflight = false
let dirty = false

export function backendBase(url) {
  return String(url || '').replace(/\/+$/, '')
}

/** 带超时的取 JSON（拉取与状态查询共用，省得每处各写一遍 AbortController） */
async function fetchJson(url, timeoutMs) {
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

export const syncStateText = computed(() => {
  if (syncState.value === 'syncing') return '同步中…'
  if (syncState.value === 'ok') return `已同步（rev ${syncRev.value}）`
  if (syncState.value === 'error') return `同步失败：${syncError.value || '未知错误'}`
  return '未同步'
})

/**
 * 从后端整体拉取一份配置（GET /api/config）。
 *
 * 只负责取回来 + 校验形状，**不**碰本机状态（不落盘、不标记 localRev）——
 * 采用与否由调用方决定（可能是用户取消了确认框），
 * 拉了却不采用却把 localRev 记上，落后判定就永久失效了。
 *
 * @returns {Promise<{ok:true, data:object}|{ok:false, error:string}>}
 */
export async function pullConfig(url) {
  const base = backendBase(url)
  if (!base) {
    pullState.value = 'error'
    pullError.value = '未配置服务地址'
    return { ok: false, error: pullError.value }
  }
  pullState.value = 'pulling'
  pullError.value = ''
  try {
    const data = await fetchJson(`${base}/api/config`, 20000)
    if (!data || !data.ok) throw new Error((data && data.error) || '服务端没有返回配置')
    pullState.value = 'ok'
    pullAt.value = Date.now()
    // 顺手刷新"后端当前版本"（/api/status 也会写它，两边同一个语义）
    syncRev.value = Number(data.configRev) || 0
    return { ok: true, data }
  } catch (e) {
    pullState.value = 'error'
    pullError.value = (e && e.message) || '拉取失败'
    return { ok: false, error: pullError.value }
  }
}

/**
 * 立即同步一次（推）。
 * @param {Function} getPayload () => { options, cameras, faces } | null，可为 async（人脸库要从 IndexedDB 读）
 *        **返回 null / undefined = 「跟后端手上那份一样，没什么可推的」**，
 *        本函数会直接跳过（不落状态、不发请求、回 { ok: true, skipped: true }）。
 * @param {object}   options    { url, silent }
 */
export async function syncConfigNow(getPayload, { url, silent = false } = {}) {
  const base = backendBase(url)
  if (!base) {
    syncState.value = 'idle'
    return { ok: false, error: '未配置服务地址' }
  }
  if (inflight) {
    dirty = true
    return { ok: false, error: 'busy' }
  }
  inflight = true

  try {
    /*
     * ⚠️ 这个判定必须发生在**取 payload 的那一刻**（也就是节流定时器醒来时），
     *    不能只在排程的地方做。
     *
     * 自动推送是 900ms 节流（scheduleConfigSync）：采用远端配置期间排上的定时器，
     * 醒来时"正在采用"那个瞬时标志早就复位了 —— 于是 payload 现算一份、
     * 原样推回后端，rev 空涨一格，别的机器立刻从"已对齐"变成"后端有更新"。
     * 本项目真踩过（探针里看得一清二楚：从没发过 POST 的页面 rev 却 +1）。
     */
    const payload = await getPayload()
    if (!payload) return { ok: true, skipped: true }

    if (!silent) syncState.value = 'syncing'
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 20000)
    let res
    try {
      res = await fetch(`${base}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /*
         * baseRev = 本机这份配置是基于后端哪个版本改的。
         * 服务端用它做两件事：拦住"从没对齐过的客户端推空白配置"（409），
         * 以及在覆盖了别的设备改动时回一句 overwrote。
         */
        body: JSON.stringify({ ...payload, baseRev: localRev.value }),
        signal: ctrl.signal
      })
    } finally {
      clearTimeout(t)
    }
    if (!res.ok) {
      /*
       * 服务端的**结论性拒绝**必须原样透出来。最常见的是 409
       * 「这份配置会把后端清空」—— 只报「HTTP 409」等于什么都没说，
       * 用户只会看到"同步失败"，然后反复点重试。
       */
      let msg = ''
      try {
        const j = await res.json()
        if (j && j.error) msg = String(j.error)
      } catch (e) {
        /* 不是 JSON 就用状态码兜底 */
      }
      throw new Error(msg || `HTTP ${res.status}`)
    }
    const data = await res.json()
    if (!data || !data.ok) throw new Error((data && data.error) || '服务端拒绝了配置')
    syncState.value = 'ok'
    syncError.value = ''
    syncAt.value = Date.now()
    syncRev.value = Number(data.configRev) || syncRev.value + 1
    // 推送成功 = 本机这份配置已经与后端对齐到这个版本
    markSynced(syncRev.value)
    pushOverwrote.value = !!data.overwrote
    return { ok: true, data }
  } catch (e) {
    syncState.value = 'error'
    syncError.value = (e && e.message) || '同步失败'
    return { ok: false, error: syncError.value }
  } finally {
    inflight = false
    // 在飞期间的变更：补一发
    if (dirty) {
      dirty = false
      setTimeout(() => syncConfigNow(getPayload, { url, silent }), 200)
    }
  }
}

/**
 * 节流同步（配置变化时调；连续改动只发最后一次）。
 * @param {Function} getPayload
 * @param {object}   opts { url, delay, silent }
 */
export function scheduleConfigSync(getPayload, { url, delay = 900, silent = true } = {}) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    syncConfigNow(getPayload, { url, silent })
  }, Math.max(100, delay))
  if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref()
}

export function stopConfigSync() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  syncState.value = 'idle'
  syncError.value = ''
}

/** 拉一次后端状态（通道数 / 模型 / 推送渠道 / 人脸库人数），设置页展示 */
export async function refreshRemoteStatus(url) {
  const base = backendBase(url)
  if (!base) return null
  try {
    const data = await fetchJson(`${base}/api/status`, 6000)
    remoteStatus.value = data
    // ⚠️ 这是「后端当前版本」，不是「本机版本」（后者是 localRev，见文件头说明）
    if (data && data.configRev !== undefined) syncRev.value = Number(data.configRev) || syncRev.value
    return data
  } catch (e) {
    return null
  }
}
