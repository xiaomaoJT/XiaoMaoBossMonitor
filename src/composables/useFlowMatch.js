/**
 * 人员走向（跨摄像头）匹配引擎 —— 纯逻辑单例。
 *
 * 设计要点（见可行性计划 §5 / §7）：
 *   · 每个摄像头一个 useAiExtras 实例，departure（A 路退出）与 arrival（B 路进入）
 *     分属不同实例，必须用**模块级单例**共享 pendingDepartures，否则无法配对。
 *   · 默认人脸档几乎零额外推理：只消费已算好的 embedding 归组名（gid）做哈希配对。
 *   · 内存受 TTL + LRU 硬上限约束（ENGINE_MAX），惰性淘汰，防膨胀。
 *   · 配对成功即一次性消费 departure（防重复推送）；方向单向（出场必须早于入场）；
 *   · 空值拦截：拿不到身份（gid / reidKey）且 requireFace → 直接丢弃，绝不拿「无名氏」凑配对。
 *
 * ⚠️ 本模块**不碰任何图像 / 推送 / 渲染**——只做「两路本地进出事件按身份 + 时间窗串起来」。
 *    截图由调用方在 record 时传入 `shot`（字符串），引擎只存不取。
 */
import { flowValid, clampFlowWindowSec } from '../config/defaults.js'

/** pending departures 硬上限（与 useAlertPush 的 BUFFER_CAP 同源思路） */
export const FLOW_ENGINE_MAX = 2000

/**
 * 创建一个独立引擎实例（供真实运行与探针测试各持一份，互不污染）。
 * 真实运行请用 getFlowEngine() 拿全局单例。
 */
export function createFlowEngine() {
  /** key = gid（人脸档，groupName）或 `reid:<量化键>`（降级档） */
  const pending = new Map() // key -> departure[]
  let seq = 0

  const state = {
    flows: [],
    cameras: []
  }

  /** 运行时喂入当前配置（flows + 通道列表）。配置变化即重设，引擎据此判断哪些 flow 生效 */
  function setConfig(flows, cameras) {
    state.flows = Array.isArray(flows) ? flows : []
    state.cameras = Array.isArray(cameras) ? cameras : []
  }

  /** 找出「出场」命中该 (cam, zone) 且**有效**（启用 + 区域已画）的 flow */
  function departFlowsFor(camId, zoneId) {
    return state.flows.filter(
      (f) => flowValid(f, state.cameras).valid && f.from.cam === camId && f.from.zone === zoneId
    )
  }
  /** 找出「入场」命中该 (cam, zone) 且**有效**的 flow */
  function arriveFlowsFor(camId, zoneId) {
    return state.flows.filter(
      (f) => flowValid(f, state.cameras).valid && f.to.cam === camId && f.to.zone === zoneId
    )
  }

  /** 某条 flow 的匹配 key：人脸档用 gid，降级档用 reidKey（前缀区分，避免两类 key 串台） */
  function keyFor(flow, p) {
    if (flow.requireFace) return p.gid || null
    return p.gid || (p.reidKey ? `reid:${p.reidKey}` : null)
  }

  /** 惰性淘汰过期项 + LRU 硬上限 */
  function evictExpired(now) {
    for (const [key, arr] of pending) {
      const kept = arr.filter((d) => d.expireAt > now)
      if (kept.length) pending.set(key, kept)
      else pending.delete(key)
    }
    if (pending.size > FLOW_ENGINE_MAX) {
      const all = []
      for (const arr of pending.values()) for (const d of arr) all.push(d)
      all.sort((a, b) => a.at - b.at)
      const dropSet = new Set(all.slice(0, all.length - FLOW_ENGINE_MAX))
      for (const [key, arr] of pending) {
        const kept = arr.filter((d) => !dropSet.has(d))
        if (kept.length) pending.set(key, kept)
        else pending.delete(key)
      }
    }
  }

  /**
   * 记录一次「出场」事件。
   * @param {object} p { cam, zone, gid?, reidKey?, name?, faceName?, at?, shot?, box?, flowId? }
   *   - 传 flowId 则只针对该 flow；否则按 (cam, zone) 自动匹配所有启用的 from flow。
   * @returns {{ok:boolean, reason?:string, records?:Array}}
   */
  function recordDeparture(p) {
    if (!p || !p.cam || !p.zone) return { ok: false, reason: 'bad-args' }
    const now = typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : Date.now()
    evictExpired(now)
    const flows = p.flowId
      ? state.flows.filter((f) => f.id === p.flowId)
      : departFlowsFor(p.cam, p.zone)
    if (!flows.length) return { ok: false, reason: 'no-flow' }
    const recs = []
    for (const f of flows) {
      const key = keyFor(f, p)
      if (!key) continue // 空值拦截：这条 flow 拿不到身份 → 跳过
      const expireAt = now + clampFlowWindowSec(f.windowSec) * 1000
      const rec = {
        id: ++seq,
        flowId: f.id,
        key,
        cam: p.cam,
        zone: p.zone,
        gid: f.requireFace ? p.gid || null : null,
        reidKey: f.requireFace ? null : p.reidKey || null,
        name: p.name || null,
        faceName: p.faceName || null,
        at: now,
        expireAt,
        shot: p.shot || null,
        box: p.box || null
      }
      if (!pending.has(key)) pending.set(key, [])
      pending.get(key).push(rec)
      recs.push(rec)
    }
    if (!recs.length) return { ok: false, reason: 'no-gid' }
    return { ok: true, records: recs }
  }

  /**
   * 记录一次「入场」事件，并尝试与已记录的出场配对。
   * @param {object} p 同 recordDeparture（至少含 cam / zone / gid / at）
   * @returns {{ok:boolean, reason?:string, matches?:Array}}
   *   matches[].flow         命中的 flow 配置
   *   matches[].departure    配对的出场记录
   *   matches[].spanSec      出场到入场的间隔（秒）
   */
  function recordArrival(p) {
    if (!p || !p.cam || !p.zone) return { ok: false, reason: 'bad-args' }
    const now = typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : Date.now()
    evictExpired(now)
    const flows = p.flowId
      ? state.flows.filter((f) => f.id === p.flowId)
      : arriveFlowsFor(p.cam, p.zone)
    if (!flows.length) return { ok: false, reason: 'no-flow' }
    const matches = []
    for (const f of flows) {
      const key = keyFor(f, p)
      if (!key) continue
      const arr = pending.get(key)
      if (!arr || !arr.length) continue
      // 找该 flow 下、方向单向（出场 < 入场）、未过期的**最近**一次出场
      let best = null
      for (const d of arr) {
        if (d.flowId !== f.id) continue
        if (d.at >= now) continue // 方向单向：出场必须在入场之前
        if (d.expireAt <= now) continue // 已过期：窗口内没走到，作废
        if (best === null || d.at > best.at) best = d
      }
      if (best) matches.push({ flow: f, departure: best, spanSec: Math.round((now - best.at) / 1000) })
    }
    if (!matches.length) return { ok: false, reason: 'no-match' }
    // 配对成功 → 一次性消费（避免同一出场被重复推送）
    for (const m of matches) {
      const arr = pending.get(m.departure.key)
      if (!arr) continue
      const idx = arr.indexOf(m.departure)
      if (idx >= 0) arr.splice(idx, 1)
      if (!arr.length) pending.delete(m.departure.key)
    }
    return { ok: true, matches }
  }

  /** 周期性清理过期（可每帧 / 每数秒调用一次；O(过期项) 惰性） */
  function tick(now = Date.now()) {
    evictExpired(now)
  }

  /** 调试 / UI 用：当前缓冲概览 */
  function snapshot() {
    let count = 0
    const byKey = {}
    for (const [key, arr] of pending) {
      count += arr.length
      byKey[key] = arr.length
    }
    return { pendingCount: count, limit: FLOW_ENGINE_MAX, keys: byKey }
  }

  /** 取当前通道列表（集成层用它解析出场 / 入场摄像头的展示名） */
  function getCameras() {
    return state.cameras
  }

  /** 清空缓冲（探针 / 重置用） */
  function reset() {
    pending.clear()
    seq = 0
  }

  return {
    setConfig,
    recordDeparture,
    recordArrival,
    tick,
    snapshot,
    getCameras,
    reset,
    _state: state
  }
}

/* ---------------- 模块级单例（跨摄像头实例共享） ---------------- */
let _engine = null

/** 取全局单例引擎（所有摄像头共用同一份 pendingDepartures） */
export function getFlowEngine() {
  if (!_engine) _engine = createFlowEngine()
  return _engine
}
