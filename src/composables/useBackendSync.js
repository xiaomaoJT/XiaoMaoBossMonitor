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
 */
import { ref, computed } from 'vue'

export const syncState = ref('idle') // idle | syncing | ok | error
export const syncError = ref('')
export const syncAt = ref(0)
export const syncRev = ref(0)
/** 后端回执的当前状态（通道数 / 模型 / 推送渠道），设置页展示用 */
export const remoteStatus = ref(null)

let timer = null
let inflight = false
let dirty = false

export function backendBase(url) {
  return String(url || '').replace(/\/+$/, '')
}

export const syncStateText = computed(() => {
  if (syncState.value === 'syncing') return '同步中…'
  if (syncState.value === 'ok') return `已同步（rev ${syncRev.value}）`
  if (syncState.value === 'error') return `同步失败：${syncError.value || '未知错误'}`
  return '未同步'
})

/**
 * 立即同步一次。
 * @param {Function} getPayload () => { options, cameras, faces }，可为 async（人脸库要从 IndexedDB 读）
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
  if (!silent) syncState.value = 'syncing'

  try {
    const payload = await getPayload()
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 20000)
    let res
    try {
      res = await fetch(`${base}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      })
    } finally {
      clearTimeout(t)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data || !data.ok) throw new Error((data && data.error) || '服务端拒绝了配置')
    syncState.value = 'ok'
    syncError.value = ''
    syncAt.value = Date.now()
    syncRev.value = Number(data.configRev) || syncRev.value + 1
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
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 6000)
    let res
    try {
      res = await fetch(`${base}/api/status`, { signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    remoteStatus.value = data
    if (data && data.configRev !== undefined) syncRev.value = Number(data.configRev) || syncRev.value
    return data
  } catch (e) {
    return null
  }
}
