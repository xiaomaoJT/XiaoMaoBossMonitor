/**
 * AI 扩展分析
 * ----------------------------------------------------------------------------
 * 在人形检测的基础上再叠三层能力，全部由配置控制、默认关闭：
 *
 *   1. 区域规则（进出 / 徘徊）—— 纯几何，零模型，靠 Tracker 的轨迹连续性
 *   2. 人脸识别              —— SCRFD 检测 + MobileFaceNet 特征 + 本地人脸库比对
 *   3. 人形姿态              —— YOLOv8n-pose 17 关键点，做基础动作判定
 *
 * 性能上的两个关键约定（实测结论，别改）：
 *   - 人脸、姿态**只在检出人形的帧上才跑**，空帧直接跳过；
 *   - 同一个人的脸**不会每个分析周期都重提特征**（靠轨迹去重），
 *     否则 0.6 次/秒的检测频率下，同一个人站着不动会白白烧掉大量算力。
 */
import { ref } from 'vue'
import { Tracker, attachFacesToTracks, pickFaceFor, tracksDueForFace, faceReuseFresh, faceRetryDue, faceTuning, pendingFullConf } from './useTracker.js'
import {
  alignFace,
  cropBox,
  detectFaces,
  detectFacesInHead,
  detectPose,
  faceEmbedding,
  faceThumb,
  frameShotWithFace,
  loadModel,
  mapCropBack,
  isSlotReady
} from './useAiDetector.js'
import {
  DEFAULT_FACE_MAX,
  DEFAULT_FACE_THRESHOLD,
  PENDING_MAX,
  matchFaceGroup,
  pushPendingFace,
  readGroupSim
} from './useFaceLib.js'
import { getFlowEngine } from './useFlowMatch.js'
import { pendingDedupeSec, hitMarginThreshold } from './vecMatch.js'
import { FLOW_FULL_ZONE_NAME, fullFrameZone, isFlowFullZone, hitConfirmConf, hitConfirmStep, faceQualityConf, faceQualityPassed, yawFromKps, faceMaxFaces } from '../config/defaults.js'
import { faceSampleScore, toGray } from './faceSampleScore.js'

/** COCO 17 关键点下标 */
const KP = {
  nose: 0,
  lEye: 1,
  rEye: 2,
  lEar: 3,
  rEar: 4,
  lSh: 5,
  rSh: 6,
  lEl: 7,
  rEl: 8,
  lWr: 9,
  rWr: 10,
  lHip: 11,
  rHip: 12,
  lKn: 13,
  rKn: 14,
  lAn: 15,
  rAn: 16
}

/** 动作中文名（事件与推送文案共用） */
export const ACTION_LABEL = {
  fall: '疑似跌倒',
  handUp: '举手',
  crouch: '蹲下',
  stand: '站立'
}

/**
 * 人脸特写的边长。
 * 96 是给人脸库/事件网格看小图的；推送要单独发一张「放大的人脸照片」，
 * 96 在手机上点开就是马赛克，所以这里统一用 256（JPEG 约 15~25KB，可忽略不计）。
 */
const FACE_SHOT_SIZE = 256

/** 安全截取人形缩略图（区域事件框），失败返回空串（不影响走向匹配，只是没图） */
function safeThumb(canvas, box) {
  try {
    return faceThumb(canvas, box, FACE_SHOT_SIZE) || ''
  } catch (e) {
    return ''
  }
}

/**
 * 采集时顺手算「样本质量」（人脸尺寸 / 清晰度 / 正脸程度）。
 * 与后端 analyzer 同名函数同一套口径（判定都在 faceSampleScore.js）。
 * ⚠️ 必须此刻算：等 pushPendingFace 只留 thumb（96px）之后，
 * 原帧尺寸 / 清晰度都已经不可恢复。
 */
function sampleMetrics(canvas, face, aligned) {
  try {
    let gray = null
    if (aligned) {
      const id = aligned.getContext('2d').getImageData(0, 0, aligned.width, aligned.height)
      gray = toGray(id.data, id.width, id.height)
    }
    return faceSampleScore({
      box: face,
      kps: face.kps,
      frameW: canvas.width,
      frameH: canvas.height,
      gray,
      cropW: aligned ? aligned.width : 0,
      cropH: aligned ? aligned.height : 0,
      det: face.score,
      yaw: yawFromKps(face.kps)
    })
  } catch (e) {
    return null
  }
}

/**
 * 把一次走向配对结果（可能多跳）转成「flow 事件」并上抛（复用现有 emit('alarm') 管道，
 * 推送 / 事件面板 / 通知卡片零改造即可接收）。展示名从引擎持有的通道列表里解析。
 * ctx 携带本帧的身份（gid / person）与截图，保证多跳结束后仍能拿到「是谁」。
 */
function emitFlowEvent(engine, m, ctx, emit) {
  const f = m.flow
  const cams = engine.getCameras() || []
  const camOf = (id) => cams.find((c) => c && c.id === id)
  // 「画面全区域」没有真实区域可查，展示名走 defaults 的统一口径
  const zoneNameOf = (cam, zid) =>
    isFlowFullZone(zid)
      ? FLOW_FULL_ZONE_NAME
      : cam && Array.isArray(cam.zones)
        ? (cam.zones.find((z) => z && z.id === zid) || {}).name || zid
        : zid
  const route = (Array.isArray(f.path) ? f.path : []).map((node) => {
    const cam = camOf(node.cam)
    return {
      camId: node.cam,
      camName: (cam && cam.name) || node.cam,
      zoneId: node.zone,
      zoneName: zoneNameOf(cam, node.zone)
    }
  })
  const first = route[0] || { camName: '', zoneName: '' }
  const last = route[route.length - 1] || first
  const person = (ctx.person && ctx.person !== 'unknown:') || ''
  const who = person || '未知人员'
  const routeText = route.map((r) => `${r.camName}·${r.zoneName}`).join(' → ')
  /*
   * 用户在设置里给这条流向规则起的名字：起了名就织进正文最前面（【名字】）。
   * text 是**唯一的原文**（后端终端日志的 label、事件列本文本、/flow 的
   * 回退行都取它），推送正文则另外走 alarmDetail 的 flow 分支 ——
   * 两边都会带上规则名，用户要求的「推送和日志都要能看出是哪条流向规则」。
   * 没起名时保持原样，不塞空括号。
   */
  const ruleName = String(f.name || '').trim()
  const text = ruleName
    ? `🚶【${ruleName}】${who} 从 ${routeText}（间隔 ${m.spanSec} 秒）`
    : `🚶 ${who} 从 ${routeText}（间隔 ${m.spanSec} 秒）`
  emit({
    type: 'flow',
    source: 'flow',
    flowId: f.id,
    flowName: f.name || routeText,
    fromCam: first.camName,
    fromZone: first.zoneName,
    toCam: last.camName,
    toZone: last.zoneName,
    fromCamName: first.camName,
    toCamName: last.camName,
    fromZoneName: first.zoneName,
    toZoneName: last.zoneName,
    flowPath: route.map((r) => ({ camName: r.camName, zoneName: r.zoneName })),
    gid: ctx.gid || '',
    name: who,
    faceName: person,
    spanSec: m.spanSec,
    departureAt: m.startedAt || 0,
    departureShot: m.departureShot || '',
    /**
     * 各节点人形小图（有序）：节点 0 = 起点出场帧、节点 k≥1 = 入场帧。
     * A→B 为 [A 出场, B 入场] 共两张；A→B→C 为三张。空数组时详情页不显示轨迹块。
     */
    flowShots: Array.isArray(m.flowShots) ? m.flowShots : [],
    /**
     * 各节点整帧原图（与 flowShots 同长同序，缺项为 ''）：详情页轨迹节点优先展示它，
     * 点击放大看的就是这一张；老事件 / 采集失败时回退到 flowShots。
     */
    flowFulls: Array.isArray(m.flowFulls) ? m.flowFulls : [],
    shot: ctx.shot || '',
    box: null,
    at: ctx.at,
    text,
    asCritical: f.asCritical === true
  })
}

/**
 * 四项附加分析能力的权威定义放在 src/config/features.js —— 那里零依赖，
 * 后端 server/ 也直接复用它算推送消息里的「功能状态」，前后端不会各说各话。
 * 这里只做转发，保持原有导出路径不变。
 */
export { camExtOn, EXT_FEATURES, activeFeatures, featureState, motionOn, activeDetects, DETECT_FEATURES } from '../config/features.js'
import { camExtOn } from '../config/features.js'


export function useAiExtras(options) {
  const tracker = new Tracker()

  /** 画面叠加用的响应式数据 */
  const tracks = ref([])
  const faces = ref([])
  const poses = ref([])
  const counts = ref({ current: 0, totalIn: 0, totalOut: 0 })
  /** 扩展功能的运行状态，给设置页显示 */
  const status = ref({ face: '', pose: '', tracks: 0 })

  /** 同一张脸的重复事件冷却：key（faceId 或 unknown）→ 上次触发时间 */
  const faceEventAt = new Map()
  /**
   * 命中确认的计数表：归类名 → {n, at}（默认关时不写任何东西）。
   * 与 faceEventAt 分开两张表：冷却键按样本 id（既有行为不动），
   * 确认键必须按人（同一个人多条样本，按样本 id 计数永远数不满）。
   */
  const faceConfirmAt = new Map()
  let lastCountPushAt = 0
  let zonesKey = ''

  function faceConf() {
    const c = options.face || {}
    return {
      enabled: !!c.enabled,
      score: Number(c.score) || 0.5,
      threshold: Number(c.matchThreshold) || DEFAULT_FACE_THRESHOLD,
      libMax: Number(c.libMax) || DEFAULT_FACE_MAX,
      cooldownSec: Math.max(3, Number(c.cooldownSec) || 20),
      eventOnKnown: c.eventOnKnown !== false,
      eventOnUnknown: !!c.eventOnUnknown,
      collectUnknown: c.collectUnknown !== false,
      // 采集调优三旋钮：解析收口在 useTracker.faceTuning（前后端同一份判定）
      ...faceTuning(c),
      // 待录入内存队列容量（= 满库阈值）：与 App.vue 的满库 watcher 共用同一份解析
      ...pendingFullConf(c, PENDING_MAX),
      // 重复捕获合并间隔（秒）：与后端 store.addPendingFace 共用同一份解析
      dedupeWin: pendingDedupeSec(c),
      // 命中确认（默认关）：判定收口在 defaults.hitConfirmStep，与后端 analyzer 共用
      hitConfirm: hitConfirmConf(c),
      // 命中分差门槛（默认 0.08）：判定收口在 vecMatch.hitMarginThreshold / hitMarginPassed，
      // 与后端 analyzer 共用同一份口径
      hitMargin: hitMarginThreshold(c),
      // 命中质量门槛（默认关）：判定收口在 defaults.faceQualityConf / faceQualityPassed，
      // 与后端 analyzer 共用同一份口径
      quality: faceQualityConf(c),
      // 每帧识别人数上限（默认 2，性能保护）：判定收口在 defaults.faceMaxFaces，
      // 与后端 analyzer 共用同一份口径
      maxFaces: faceMaxFaces(c)
    }
  }

  function poseConf() {
    const c = options.pose || {}
    return {
      enabled: !!c.enabled,
      score: Number(c.score) || 0.4,
      maxPersons: Math.max(1, Math.min(4, Number(c.maxPersons) || 2)),
      actions: c.actions || {}
    }
  }

  function zoneConf() {
    return options.zone || {}
  }

  /** 把通道上的区域配置同步给跟踪器（只在真的变了的时候重建） */
  function syncZones(cam) {
    /*
     * 通道级「区域规则」关掉时，这一路按"没有区域"处理。
     * 注意跟踪器本身照常跑 —— 它是零成本的，而且人脸的"同一个人不重复提特征"
     * 就是靠它的轨迹连续性，不能因为关了区域规则就一起停掉。
     *
     * 「画面全区域」虚拟区域：这一路若有生效流向节点选了它，就注入一个铺满
     * 全画面的区域（rect 0,0,1,1）—— 没圈选区域的摄像头也要能产进出事件
     * （轨迹出现 = enter、消失 = exit），否则流向配了也是静默失效。
     * 虚拟区域带 virtual 标记：只喂流向引擎，不当报警、不计入人员计数。
     */
    const list = camExtOn(cam, 'zone') ? (cam && cam.zones) || [] : []
    let zones = getFlowEngine().hasFullZoneNode(cam && cam.id) ? [...list, fullFrameZone()] : list
    // 通道级「走入/走」捕获总闸：关掉时把这一路所有区域（含虚拟全区域）的 enterExit 剥掉，
    // tracker 便不会产出进入/离开事件 —— 既不报报警，也不喂流向引擎（彻底"关闭捕获"语义）
    if (!camExtOn(cam, 'enterExit')) {
      zones = zones.map((z) => ({ ...z, enterExit: false }))
    }
    const key = JSON.stringify(zones.map((z) => [z.id, z.rect, z.enterExit, z.loiter, z.loiterSec, z.loiterRadius, !!z.virtual]))
    if (key === zonesKey) return
    zonesKey = key
    tracker.setZones(zones)
  }

  function reset() {
    tracker.reset()
    tracks.value = []
    faces.value = []
    poses.value = []
    counts.value = { current: 0, totalIn: 0, totalOut: 0 }
    faceEventAt.clear()
  }

  /**
   * 每个分析周期调用一次。
   * @param {object} frame 采样帧 { canvas }
   * @param {Array} persons 本帧人形（归一化）
   * @param {number} now 时间戳
   * @param {object} ctx { cam, emit }
   * @returns {Promise<void>}
   */
  async function step(frame, persons, now, ctx) {
    const cam = (ctx && ctx.cam) || {}
    const emit = (ctx && ctx.emit) || (() => {})
    const zc = zoneConf()

    /* ---------- 1. 跟踪（零成本，始终跑） ---------- */
    syncZones(cam)
    const res = tracker.update(persons || [], now)
    const live = res.tracks.filter((t) => t.hits >= tracker.minHits)
    tracks.value = live
    counts.value = { ...tracker.stats }
    status.value = { ...status.value, tracks: live.length }

    /* ---------- 2. 区域事件 ----------
     * 报警开关（走入 / 走出 / 徘徊）只控制「事件是否作为报警上抛到事件面板 / 推送」。
     * 走入 / 走出事件**无论报警开关如何**，只要通道区域规则开着、zone 的 enterExit 开着，
     * 都会喂给「人员流向」引擎做跨摄像头配对 —— 这样用户可单独把「走出报警」关掉，
     * 而人员流向照样工作（解耦，见需求）。只有「没有任何生效流向」时才跳过喂引擎，省开销。
     * 注意：这**不是一刀切** —— 报警开关与流向检测完全独立，用户想收走出报警随时可在
     * 「区域规则」里把「走出区域」打开，流向检测同样照常工作。 */
    const zoneEvents = []
    const flowsOn = getFlowEngine().hasActiveFlows()
    for (const evt of res.events) {
      const isLoiter = evt.kind === 'loiter'
      const isEnter = evt.kind === 'enter'
      const isExit = evt.kind === 'exit'
      if (!isLoiter && !isEnter && !isExit) continue
      // 报警开关：关了就不作为报警事件上抛（但仍可能要喂流向引擎，见下）
      const alarmOff = (isLoiter && zc.loiterAlarm === false) ||
                       (isEnter && zc.enterAlarm === false) ||
                       (isExit && zc.exitAlarm === false)
      const out = {
        type: isLoiter ? 'loiter' : isEnter ? 'enter' : 'exit',
        zoneName: evt.zoneName,
        zoneId: evt.zoneId,
        trackId: evt.trackId,
        at: evt.at,
        box: evt.box,
        dwellMs: evt.dwellMs || 0,
        text: zoneText(evt),
        source: 'zone'
      }
      // 报警事件：一定进 zoneEvents（原行为），并上抛报警
      // 报警关了的走入 / 走出：仅当「人员流向」开着时进 zoneEvents 供 2.5 配对，但**不报警**
      // 虚拟区域（画面全区域）事件：只喂流向引擎，绝不作为报警上抛（否则每人出现一次就刷一条）
      if (!alarmOff && !evt.virtual) {
        zoneEvents.push(out)
        emit(out)
      } else if (flowsOn && (isEnter || isExit)) {
        zoneEvents.push(out)
      }
    }

    if (!live.length) {
      // 画面里没人：人脸/姿态没有意义，顺手清掉上一帧的残留框。
      // 但区域事件（离场）可能仍在，仍要跑走向匹配（见下方 2.5），故不提前 return。
      faces.value = []
      poses.value = []
      status.value = { ...status.value, face: '', pose: '' }
    } else {
      /* ---------- 3. 人脸识别（全局开着 且 这一路参与 才跑） ---------- */
      const fc = faceConf()
      if (fc.enabled && camExtOn(cam, 'face')) {
        try {
          await loadModel('face', undefined, fc.detSize).catch(() => {})
          if (isSlotReady('face')) {
            const dets = await detectFaces(frame.canvas, fc.score, fc.detSize)
            faces.value = dets.map((d) => ({ ...d, name: '', known: false }))
            await runFaces(frame, dets, live, now, fc, cam, emit)
            status.value = { ...status.value, face: isSlotReady('faceemb') ? 'ready' : 'detect-only' }
          }
        } catch (e) {
          status.value = { ...status.value, face: 'error' }
        }
      } else {
        faces.value = []
      }

      /* ---------- 4. 姿态（同样受通道级开关约束） ---------- */
      const pc = poseConf()
      if (pc.enabled && camExtOn(cam, 'pose')) {
        try {
          await loadModel('pose', undefined, 640).catch(() => {})
          if (isSlotReady('pose')) {
            await runPoses(frame, live, now, pc, cam, emit)
            status.value = { ...status.value, pose: 'ready' }
          }
        } catch (e) {
          status.value = { ...status.value, pose: 'error' }
        }
      } else {
        poses.value = []
      }
    }

    /* ---------- 2.5 人员走向（跨摄像头） ----------
     * 把本路刚发生的「走出 / 走入」区域事件，按身份（gid = 人脸归组名）+ 时间窗，
     * 串成「从 A 走向 B」的走向事件。零额外推理：只消费已算好的人脸 identity。
     * 身份来源：res.tracks[].face（跨帧持久，离场的那一帧也能拿到上一帧认出的脸）。
     * 引擎是模块级单例，A 路退场记 departure、B 路入场记 arrival 共用同一份缓冲。 */
    if (zoneEvents.length) {
      const engine = getFlowEngine()
      for (const evt of zoneEvents) {
        if (evt.type !== 'exit' && evt.type !== 'enter') continue
        const tr = res.tracks.find((t) => t.id === evt.trackId)
        const gid = tr && tr.face && tr.face.id ? tr.face.name : null // 已知人=归组名；陌生人(face.id=0)=null
        const shot = safeThumb(frame.canvas, evt.box)
        /*
         * 整帧原图（与 shot 同帧一起抓）：详情页「流向轨迹」的每个节点都要能看原图
         * —— 只存人形小图的话，用户想看清「是谁在什么画面里走过的」还得回去翻主图。
         * 采集时机同样是唯一的：此刻 canvas 就是事发那一帧；走完全程再补拍早换了画面。
         * frameShotWithFace 会在框上画一圈边框，节点图因此自带「人在哪里」的标注。
         */
        const fullShot = frameShotWithFace(frame.canvas, evt.box)
        const at = evt.at || now
        if (evt.type === 'exit') {
          // 出场：记一条 departure（窗口内等待对应入场配对）
          engine.recordDeparture({ cam: cam.id, zone: evt.zoneId, gid, name: gid, at, shot, fullShot, box: evt.box })
        } else {
          // 入场：尝试推进 / 完成链路，成功走完一路则上抛 flow 事件
          const r = engine.recordArrival({ cam: cam.id, zone: evt.zoneId, gid, name: gid, at, shot, fullShot, box: evt.box })
          if (r.ok) {
            for (const m of r.matches) {
              if (m.flow.push === false) continue // 用户关了这条 flow 的推送 → 只记录不发送
              emitFlowEvent(engine, m, { at, shot, gid, person: gid }, emit)
            }
          }
        }
      }
      engine.tick(now)
    }

    /* ---------- 5. 计数推送 ---------- */
    maybeCountPush(now, emit, cam)
  }

  /* ==================== 人脸 ==================== */
  async function runFaces(frame, dets, live, now, fc, cam, emit) {
    if (!dets.length && !live.length) return
    await loadModel('faceemb', undefined, 112).catch(() => {})
    const canEmbed = isSlotReady('faceemb')
    const pairs = attachFacesToTracks(live, dets)

    /* ---------- 头部区域裁剪放大补检 ----------
     * 整帧检测在 640 输入里看远处的人，脸只剩十几个像素，SCRFD 直接漏检
     * （采集率只有约 1/10 的第二个原因，第一个是附着判定）。
     * 对「去重窗口已到期、整帧又没检出脸」的轨迹，把头部区域裁出来放大再检。
     * 只补到期的是为了省算力：窗口没到期的轨迹本来就要复用旧结果，
     * 检出来了也用不上。 */
    const covered = new Set(pairs.map((p) => p.track.id))
    const due = tracksDueForFace(live, covered, now, fc.dedupeSec * 1000)
    if (due.length && isSlotReady('face')) {
      for (const tr of due) {
        // 先记「本帧已发起补检」——否则漏检的人头每帧都重新到期，640 全推理每帧一发。
        // 节流窗口由 tracksDueForFace 读这个字段（不能借 faceAt，见那里的说明）。
        tr.faceSearchAt = now
        const extra = await detectFacesInHead(
          frame.canvas,
          tr.box,
          (cv) => detectFaces(cv, fc.score, fc.detSize),
          { headRatio: fc.headRatio, size: fc.detSize }
        )
        // 裁大之后邻框的脸也可能被检出来，只收确实属于这个人的
        const back = pickFaceFor(extra, tr.box)
        if (!back) continue
        faces.value.push({ ...back, name: '', known: false })
        pairs.push({ face: back, track: tr })
      }
    }

    /*
     * 每帧识别人数上限（maxFaces，默认 2）：画面里多个人时，按"框面积"降序取最显眼的前
     * N 张做提特征 + 比对，其余只画框、不识别（性能保护）。这是"每帧"上限不是"总人数"
     * 上限 —— 靠轨迹去重，同一个人整窗只提一次，多个人跨帧陆续被认出。
     */
    const faceCap = Math.max(1, fc.maxFaces || 2)
    const cappedIds = new Set(
      pairs
        .slice()
        .sort((a, b) => b.face.w * b.face.h - a.face.w * a.face.h)
        .slice(0, faceCap)
        .map((p) => p.track.id)
    )

    for (const { face, track } of pairs) {
      // 超过每帧识别上限：只显示框，不提特征 / 比对（性能保护，默认 2）
      if (!cappedIds.has(track.id)) continue
      // 同一个人近期「成功」提过特征 → 直接继承既有结果，别重提（复用只看成功的时刻）
      if (faceReuseFresh(track, now, fc.dedupeSec * 1000)) {
        const known = track.face
        const slot = faces.value.find(
          (f) => Math.abs((f.x + f.w / 2) - (face.x + face.w / 2)) < 0.02 &&
                 Math.abs((f.y + f.h / 2) - (face.y + face.h / 2)) < 0.02
        )
        if (known && slot) {
          slot.name = known.name || ''
          slot.known = !!known.id
        }
        continue
      }
      // 模型还没就绪：不预约下一次，下帧就接着试（避免被去重窗关在外面）
      if (!canEmbed) continue
      // 上一次「尝试」还在重试节流窗内（多半刚失败）→ 先歇一会儿
      if (faceRetryDue(track, now, fc.retryMs)) continue
      // 真正去尝试提特征了，先记一个「尝试时刻」（成败都记）
      track.faceAt = now

      const aligned = alignFace(frame.canvas, face.kps)
      if (!aligned) continue
      const vec = await faceEmbedding(aligned)
      if (!vec || !vec.length) continue

      // 特征到手 → 记「成功时刻」，之后整窗复用（这一刻才把人从「待重试」里放出来）
      track.faceOkAt = now
      const thumb = faceThumb(frame.canvas, face, FACE_SHOT_SIZE)
      // matchFaceGroup：把命中的样本映射到「归类名称」——库里归好类的人只报一个名字
      const hit = await matchFaceGroup(vec, { threshold: fc.threshold, bySimilarity: readGroupSim(), margin: fc.hitMargin })
      const slot = faces.value.find(
        (f) => Math.abs((f.x + f.w / 2) - (face.x + face.w / 2)) < 0.02 &&
               Math.abs((f.y + f.h / 2) - (face.y + face.h / 2)) < 0.02
      )

      /*
       * 命中质量门槛：检测置信度太低 / 脸太小 / 侧脸转太多，不许认成库内某人
       * （落入下面的未录入分支，而不是报一个不可信的"识别到 X"）。
       * 判定收口在 defaults.faceQualityPassed，与后端 analyzer 共用同一份口径。
       * 默认关（fc.quality.enabled=false）→ 直接放行，历史行为不变。
       */
      const okQuality = faceQualityPassed(face, frame.canvas.width, frame.canvas.height, fc.quality)
      if (hit && !hit.miss && okQuality) {
        const who = hit.groupName
        track.face = { id: hit.face.id, name: who, score: hit.score }
        if (slot) {
          slot.name = who
          slot.known = true
        }
        if (!fc.eventOnKnown) continue
        /*
         * 命中确认闸门（可配置，默认关 = 见到在库人脸就推）。
         * 判定收口在 defaults.hitConfirmStep，前后端共用同一份状态机。
         *
         * ⚠️ 必须放在冷却**之前**：放在后面的话重复出现会被 `faceEventAt` 冷却
         *    吞掉（同 key 直接 continue），计数永远涨不上去，功能静默失效。
         * ⚠️ 计数键用**归类名**而不是样本 id：同一个人有多条样本时，
         *    `hit.face.id` 随角度变来变去，按它计数会把一个人拆成好几个，
         *    永远数不满 `times`。冷却键保持样本 id 不变（改它会动到既有行为）。
         */
        const confirmKey = 'f' + (who || `#${hit.face.id}`)
        if (!hitConfirmStep(faceConfirmAt, confirmKey, now, fc.hitConfirm).fire) continue
        const key = `f${hit.face.id}`
        if (now - (faceEventAt.get(key) || 0) < fc.cooldownSec * 1000) continue
        faceEventAt.set(key, now)
        emit({
          type: 'face',
          known: true,
          faceName: who,
          faceScore: hit.score,
          box: face,
          thumb: thumb || '',
          trackId: track.id,
          at: now,
          text: `识别到「${who}」（相似度 ${(hit.score * 100).toFixed(0)}%）`,
          source: 'face'
        })
      } else {
        track.face = { id: 0, name: '', score: hit ? hit.score : 0 }
        if (slot) {
          slot.name = ''
          slot.known = false
        }
        if (fc.collectUnknown && thumb) {
          pushPendingFace({
            vector: vec,
            thumb,
            full: frameShotWithFace(frame.canvas, face),
            at: now,
            camId: cam.id,
            camName: cam.name,
            max: fc.fullAt,
            dedupeSec: fc.dedupeWin,
            metrics: sampleMetrics(frame.canvas, face, aligned)
          })
        }
        if (!fc.eventOnUnknown) continue
        // 按摄像头聚合：每个摄像头每 cooldownSec 秒最多产一条陌生人脸事件（降噪）。
        // 原来全局单键 'unknown' 会让"另一路摄像头刚报过"把本路也压住，
        // 多摄像头场景会出现"门口有人、电梯却不报"的错位压制。
        const key = 'unknown:' + cam.id
        if (now - (faceEventAt.get(key) || 0) < fc.cooldownSec * 1000) continue
        faceEventAt.set(key, now)
        emit({
          type: 'face',
          known: false,
          faceName: '',
          faceScore: hit ? hit.score : 0,
          box: face,
          thumb: thumb || '',
          trackId: track.id,
          at: now,
          text: '检测到未录入的人脸',
          source: 'face'
        })
      }
    }
  }

  /* ==================== 姿态 ==================== */
  async function runPoses(frame, live, now, pc, cam, emit) {
    // 面积大的优先（离镜头近的人姿态更清楚），每帧最多处理 maxPersons 个
    const cands = live
      .slice()
      .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)
      .slice(0, pc.maxPersons)

    const out = []
    for (const tr of cands) {
      const cropped = cropBox(frame.canvas, tr.box, 320, 0.12)
      if (!cropped) continue
      const res = await detectPose(cropped.canvas, pc.score)
      const best = res && res[0]
      if (!best) continue
      const mapped = mapCropBack(best, cropped)
      out.push({ ...mapped, trackId: tr.id })
      const act = classifyAction(mapped.kps)
      const prev = tr.poseKey
      tr.poseKey = act.key
      if (!act.key || !pc.actions[act.key]) continue
      // 动作没变就不重复报，避免同一个"蹲下"每 5 秒报一次
      if (prev === act.key) continue
      const key = `pose-${act.key}`
      if (now - (faceEventAt.get(key) || 0) < 15000) continue
      faceEventAt.set(key, now)
      emit({
        type: 'pose',
        action: act.key,
        actionText: ACTION_LABEL[act.key] || act.key,
        box: mapped,
        trackId: tr.id,
        at: now,
        text: `检测到人形动作：${ACTION_LABEL[act.key] || act.key}`,
        source: 'pose'
      })
    }
    poses.value = out
  }

  /* ==================== 计数 ==================== */
  function maybeCountPush(now, emit, cam) {
    const zc = zoneConf()
    if (!camExtOn(cam, 'zone')) return
    if (!zc.countEnabled || !zc.countPush) return
    // 第一次不推：否则刚打开页面就会收到一条「当前 0 人」，没有信息量
    if (!lastCountPushAt) {
      lastCountPushAt = now
      return
    }
    const interval = Math.max(10, Number(zc.countIntervalSec) || 60) * 1000
    if (now - lastCountPushAt < interval) return
    lastCountPushAt = now
    const c = counts.value
    const mode = zc.countMode || 'current'
    const text =
      mode === 'total'
        ? `累计经过 ${c.totalIn} 人次`
        : mode === 'both'
          ? `当前 ${c.current} 人 · 累计经过 ${c.totalIn} 人次`
          : `当前画面 ${c.current} 人`
    emit({
      type: 'count',
      counts: { ...c },
      at: now,
      text,
      source: 'count'
    })
  }

  /* ==================== 补拍窗口的"顺便看一眼" ==================== */
  /**
   * 报警后补拍完整人形的那几秒里，顺便回答两个问题：
   *   「这个人是谁」——人脸识别（已录入则给姓名 + 特写图）
   *   「他在做什么」——姿态分析（跌倒 / 举手 / 蹲下）
   *
   * 这里刻意做成"尽力而为"：任何一步失败都静默返回，
   * 因为补拍窗口的主任务是拿到完整人形图，不能被附加分析拖垮。
   *
   * @returns {Promise<{faceChecked:boolean,faceName:string,faceScore:number,faceThumb:string,actionText:string}>}
   */
  async function probe(canvas, box, now, ctx) {
    const cam = (ctx && ctx.cam) || {}
    const out = { faceChecked: false, faceName: '', faceScore: 0, faceThumb: '', actionText: '' }
    if (!canvas || !box) return out

    /* ---- 人脸 ---- */
    const fc = faceConf()
    if (fc.enabled && camExtOn(cam, 'face')) {
      try {
        await loadModel('face', undefined, fc.detSize).catch(() => {})
        if (isSlotReady('face')) {
          const dets = await detectFaces(canvas, fc.score, fc.detSize)
          const face = pickFaceFor(dets, box)
          if (face) {
            out.faceChecked = true
            await loadModel('faceemb', undefined, 112).catch(() => {})
            if (isSlotReady('faceemb')) {
              const aligned = alignFace(canvas, face.kps)
              const vec = aligned ? await faceEmbedding(aligned) : null
              if (vec) {
                const hit = await matchFaceGroup(vec, { threshold: fc.threshold, bySimilarity: readGroupSim(), margin: fc.hitMargin })
              out.faceThumb = faceThumb(canvas, face, FACE_SHOT_SIZE)
              if (hit && !hit.miss) {
                out.faceName = hit.groupName
                out.faceScore = hit.score
              } else {
                out.faceScore = hit ? hit.score : 0
                if (fc.collectUnknown && out.faceThumb) {
                  pushPendingFace({
                    vector: vec,
                    thumb: out.faceThumb,
                    full: frameShotWithFace(canvas, face),
                    at: now,
                    camId: cam.id,
                    camName: cam.name,
                    max: fc.fullAt,
                    dedupeSec: fc.dedupeWin,
                    metrics: sampleMetrics(canvas, face, aligned)
                  })
                }
              }
              }
            }
          }
        }
      } catch (e) {
        /* 人脸只是附加信息，失败不影响补图 */
      }
    }

    /* ---- 姿态 ---- */
    const pc = poseConf()
    if (pc.enabled && camExtOn(cam, 'pose')) {
      try {
        await loadModel('pose', undefined, 640).catch(() => {})
        if (isSlotReady('pose')) {
          const cropped = cropBox(canvas, box, 320, 0.12)
          if (cropped) {
            const res = await detectPose(cropped.canvas, pc.score)
            const best = res && res[0]
            if (best) {
              const act = classifyAction(mapCropBack(best, cropped).kps)
              if (act && act.key) out.actionText = ACTION_LABEL[act.key] || act.key
            }
          }
        }
      } catch (e) {
        /* 姿态同理 */
      }
    }

    return out
  }

  return { step, reset, probe, tracks, faces, poses, counts, status, tracker }
}

/** 区域事件文案 */
function zoneText(evt) {
  const sec = Math.round((evt.dwellMs || 0) / 1000)
  if (evt.kind === 'enter') return `有人走入「${evt.zoneName}」`
  if (evt.kind === 'exit') return `有人走出「${evt.zoneName}」（停留 ${sec} 秒）`
  return `有人在「${evt.zoneName}」徘徊（已停留 ${sec} 秒）`
}

/**
 * 基础动作判定。
 * 只做「单帧姿态能可靠判断」的动作，不做需要时序的动作（如奔跑）——
 * 后者需要更大的模型和更长的观察窗，收益不成正比。
 */
export function classifyAction(kps) {
  if (!kps || kps.length < 17) return { key: '', label: '' }
  const good = (i) => kps[i] && kps[i].s >= 0.35
  const Y = (i) => kps[i].y
  const X = (i) => kps[i].x

  /* 躯干倾角：肩中点到髋中点的连线与竖直方向的夹角 */
  let torsoLean = 0
  if (good(KP.lSh) && good(KP.rSh) && good(KP.lHip) && good(KP.rHip)) {
    const sx = (X(KP.lSh) + X(KP.rSh)) / 2
    const sy = (Y(KP.lSh) + Y(KP.rSh)) / 2
    const hx = (X(KP.lHip) + X(KP.rHip)) / 2
    const hy = (Y(KP.lHip) + Y(KP.rHip)) / 2
    torsoLean = Math.atan2(Math.abs(hx - sx), Math.abs(hy - sy))
  }
  // 大于约 51° 认为躯干已经躺倒
  if (torsoLean > 0.9) return { key: 'fall', label: ACTION_LABEL.fall }

  /* 举手：手腕明显高于同侧肩 */
  let hands = 0
  if (good(KP.lSh) && good(KP.lWr) && Y(KP.lWr) < Y(KP.lSh) - 0.01) hands += 1
  if (good(KP.rSh) && good(KP.rWr) && Y(KP.rWr) < Y(KP.rSh) - 0.01) hands += 1
  if (hands > 0) return { key: 'handUp', label: ACTION_LABEL.handUp }

  /* 蹲下：髋到膝的竖直距离相对肩到膝明显变短 */
  if (good(KP.lHip) && good(KP.rHip) && good(KP.lKn) && good(KP.rKn) && good(KP.lSh)) {
    const hipY = (Y(KP.lHip) + Y(KP.rHip)) / 2
    const kneeY = (Y(KP.lKn) + Y(KP.rKn)) / 2
    const shY = (Y(KP.lSh) + Y(KP.rSh)) / 2
    const span = Math.max(1e-6, kneeY - shY)
    if ((kneeY - hipY) / span < 0.28) return { key: 'crouch', label: ACTION_LABEL.crouch }
  }

  /* 其余算站立 */
  if (good(KP.lSh) && good(KP.lHip)) return { key: 'stand', label: ACTION_LABEL.stand }
  return { key: '', label: '' }
}
