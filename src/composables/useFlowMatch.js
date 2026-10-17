/**
 * 人员走向（跨摄像头）匹配引擎 —— 纯逻辑单例。
 *
 * 设计要点（见可行性计划 §5 / §7）：
 *   · 每个摄像头一个 useAiExtras 实例，出场（A 路退出）与入场（B 路进入）
 *     分属不同实例，必须用**模块级单例**共享进行中的链路，否则无法配对。
 *   · 默认人脸档几乎零额外推理：只消费已算好的人脸 identity（gid）做哈希配对。
 *   · 内存受 TTL + LRU 硬上限约束（ENGINE_MAX），惰性淘汰，防膨胀。
 *   · 方向单向（出场必须早于入场）；空值拦截：拿不到身份且 requireFace → 丢弃。
 *   · **多跳（A→B→C…）**：path 是有序节点数组，逐跳推进状态机；任一跳超时或错序即断链。
 *
 * ⚠️ 本模块**不碰任何图像 / 推送 / 渲染**——只做「多路本地进出事件按身份 + 时间窗串起来」。
 *    截图由调用方在 record 时传入 `shot`（字符串），引擎只存不取。
 */
import { flowValid, clampFlowWindowSec } from '../config/defaults.js'

/** 进行中的链路硬上限（与 useAlertPush 的 BUFFER_CAP 同源思路） */
export const FLOW_ENGINE_MAX = 2000

/**
 * 创建一个独立引擎实例（供真实运行与探针测试各持一份，互不污染）。
 * 真实运行请用 getFlowEngine() 拿全局单例。
 */
export function createFlowEngine() {
  /**
   * 进行中的链路：progKey(flowId|身份key) -> state
   *   head      当前已抵达的节点下标（settled）；-1 表示尚未开始
   *   open      在途：已离场上一个节点、正等待抵达下一个；{ from, at, shot } 或 null
   *   startedAt 这一程的起点出场时刻（用于算总间隔）
   *   nodeShots 各节点的截图（字符串，调用方传入）：nodeShots[0] = 起点出场帧，
   *             nodeShots[k] (k>=1) = 抵达节点 k 的入场帧；走完全程时按 0..last 排出 flowShots
   *   lastAt    最近一次活动时刻（LRU 淘汰用）
   *   expireAt  该链路整体过期时刻（TTL + 断链宽限）
   */
  const progress = new Map()
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

  /** 找出「出场」命中该 (cam, zone) 的所有 (flow, 段下标)，要求 flow 有效 */
  function departFlowsFor(camId, zoneId) {
    const out = []
    for (const f of state.flows) {
      if (!flowValid(f, state.cameras).valid) continue
      const path = Array.isArray(f.path) ? f.path : []
      for (let i = 0; i < path.length - 1; i++) {
        if (path[i].cam === camId && path[i].zone === zoneId) out.push({ flow: f, segIdx: i })
      }
    }
    return out
  }
  /** 找出「入场」命中该 (cam, zone) 的所有 (flow, 段下标)，要求 flow 有效 */
  function arriveFlowsFor(camId, zoneId) {
    const out = []
    for (const f of state.flows) {
      if (!flowValid(f, state.cameras).valid) continue
      const path = Array.isArray(f.path) ? f.path : []
      for (let i = 0; i < path.length - 1; i++) {
        if (path[i + 1].cam === camId && path[i + 1].zone === zoneId) out.push({ flow: f, segIdx: i })
      }
    }
    return out
  }

  /** 某条 flow 的匹配 key：人脸档用 gid，降级档用 reidKey（前缀区分，避免两类 key 串台） */
  function keyFor(flow, p) {
    if (flow.requireFace) return p.gid || null
    return p.gid || (p.reidKey ? `reid:${p.reidKey}` : null)
  }
  function progKey(flowId, key) {
    return `${flowId}|${key}`
  }

  /** 惰性淘汰过期链路 + LRU 硬上限 */
  function evictExpired(now) {
    for (const [pk, st] of progress) {
      if (st.expireAt > now) continue
      progress.delete(pk)
    }
    if (progress.size > FLOW_ENGINE_MAX) {
      const all = [...progress.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)
      const drop = all.slice(0, all.length - FLOW_ENGINE_MAX)
      for (const [pk] of drop) progress.delete(pk)
    }
  }

  /**
   * 记录一次「出场」事件（离场上一个节点）。
   * @param {object} p { cam, zone, gid?, reidKey?, name?, faceName?, at?, shot?, box? }
   * @returns {{ok:boolean, reason?:string}}
   */
  function recordDeparture(p) {
    if (!p || !p.cam || !p.zone) return { ok: false, reason: 'bad-args' }
    const now = typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : Date.now()
    evictExpired(now)
    const hits = departFlowsFor(p.cam, p.zone)
    if (!hits.length) return { ok: false, reason: 'no-flow' }
    let n = 0
    for (const { flow, segIdx } of hits) {
      const key = keyFor(flow, p)
      if (!key) continue // 空值拦截：这条 flow 拿不到身份 → 跳过
      const pk = progKey(flow.id, key)
      let st = progress.get(pk)
      if (!st) {
        st = { flowId: flow.id, key, head: -1, open: null, startedAt: null, lastAt: now, expireAt: 0, nodeShots: {} }
        progress.set(pk, st)
      }
      if (segIdx === 0) {
        // 起点：开新一程（允许从任意阶段重新开始，重置起点时刻 + 节点截图）
        st.head = 0
        st.startedAt = now
        st.nodeShots = {}
      } else {
        // 途经 / 终点前的出场：必须恰好站在该节点上（上一跳已完成）才能继续
        if (st.head !== segIdx) continue
      }
      st.open = { from: segIdx, at: now, shot: p.shot || null }
      // 节点 0 的图 = 起点出场帧（其余节点的图在 recordArrival 完成对应入场时记）
      if (segIdx === 0 && p.shot) st.nodeShots[0] = p.shot
      st.lastAt = now
      st.expireAt = now + clampFlowWindowSec(flow.windowSec) * 1000
      n++
    }
    if (!n) return { ok: false, reason: 'no-gid' }
    return { ok: true }
  }

  /**
   * 记录一次「入场」事件，并尝试推进 / 完成链路。
   * @param {object} p 同 recordDeparture（至少含 cam / zone / gid / at）
   * @returns {{ok:boolean, reason?:string, matches?:Array}}
   *   matches[].flow         命中的 flow 配置
   *   matches[].startedAt    这一程起点出场时刻
   *   matches[].arrivedAt    终点入场时刻
   *   matches[].spanSec      整程间隔（秒）
   *   matches[].shot         终点入场截图
   *   matches[].departureShot 起点出场截图（节点 0 的那张，即 A 摄像头的图）
   *   matches[].flowShots    各节点截图（有序）：节点 0 = 出场帧、节点 k≥1 = 入场帧；
   *                          A→B 为 [A出场, B入场] 共两张，A→B→C 为三张
   */
  function recordArrival(p) {
    if (!p || !p.cam || !p.zone) return { ok: false, reason: 'bad-args' }
    const now = typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : Date.now()
    evictExpired(now)
    const hits = arriveFlowsFor(p.cam, p.zone)
    if (!hits.length) return { ok: false, reason: 'no-flow' }
    const matches = []
    for (const { flow, segIdx } of hits) {
      const key = keyFor(flow, p)
      if (!key) continue
      const pk = progKey(flow.id, key)
      const st = progress.get(pk)
      if (!st || !st.open) continue
      if (st.open.from !== segIdx) continue // 不是正在等的这一跳
      if (now - st.open.at > clampFlowWindowSec(flow.windowSec) * 1000) {
        // 这一跳超时：链路在半路断掉，清掉在途，保留 head 等可能补救（短暂宽限后整体淘汰）
        st.open = null
        st.lastAt = now
        st.expireAt = now + 1000
        continue
      }
      // 成功完成这一跳
      st.head = segIdx + 1
      st.open = null
      st.lastAt = now
      // 抵达节点 (segIdx+1) 的图 = 该节点入场帧（多跳时每个节点各留一张）
      if (p.shot) st.nodeShots[segIdx + 1] = p.shot || null
      const lastIdx = (Array.isArray(flow.path) ? flow.path.length : 0) - 1
      if (st.head >= lastIdx) {
        // 走完全程：把各节点截图按 0..last 顺序排出（节点 0 = 出场帧，其余 = 入场帧）
        const spanSec = st.startedAt != null ? Math.round((now - st.startedAt) / 1000) : 0
        const departureShot = st.nodeShots[0] || null
        const flowShots = []
        for (let i = 0; i <= lastIdx; i++) {
          if (st.nodeShots[i]) flowShots.push(st.nodeShots[i])
        }
        matches.push({
          flow,
          startedAt: st.startedAt,
          arrivedAt: now,
          spanSec,
          shot: p.shot || null,
          departureShot,
          flowShots
        })
        progress.delete(pk)
      } else {
        st.expireAt = now + clampFlowWindowSec(flow.windowSec) * 1000
      }
    }
    if (!matches.length) return { ok: false, reason: 'no-match' }
    return { ok: true, matches }
  }

  /** 周期性清理过期（可每帧 / 每数秒调用一次；O(过期项) 惰性） */
  function tick(now = Date.now()) {
    evictExpired(now)
  }

  /** 调试 / UI 用：当前链路概览 */
  function snapshot() {
    return { pendingCount: progress.size, limit: FLOW_ENGINE_MAX }
  }

  /** 取当前通道列表（集成层用它解析出场 / 入场摄像头的展示名） */
  function getCameras() {
    return state.cameras
  }

  /** 是否存在「已启用且配置有效」的流向（集成层用它决定是否把走入/走出事件喂给引擎） */
  function hasActiveFlows() {
    return state.flows.some((f) => flowValid(f, state.cameras).valid)
  }

  /** 清空缓冲（探针 / 重置用） */
  function reset() {
    progress.clear()
    seq = 0
  }

  return {
    setConfig,
    recordDeparture,
    recordArrival,
    tick,
    snapshot,
    getCameras,
    hasActiveFlows,
    reset,
    _state: state
  }
}

/* ---------------- 模块级单例（跨摄像头实例共享） ---------------- */
let _engine = null

/** 取全局单例引擎（所有摄像头共用同一份进行中链路） */
export function getFlowEngine() {
  if (!_engine) _engine = createFlowEngine()
  return _engine
}
