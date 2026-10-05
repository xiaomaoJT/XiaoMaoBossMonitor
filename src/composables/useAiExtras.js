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
import { Tracker, attachFacesToTracks } from './useTracker.js'
import {
  alignFace,
  cropBox,
  detectFaces,
  detectPose,
  faceEmbedding,
  faceThumb,
  loadModel,
  isSlotReady
} from './useAiDetector.js'
import {
  DEFAULT_FACE_MAX,
  DEFAULT_FACE_THRESHOLD,
  matchFace,
  pushPendingFace
} from './useFaceLib.js'

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

/**
 * 四项附加分析能力的权威定义放在 src/config/features.js —— 那里零依赖，
 * 后端 server/ 也直接复用它算推送消息里的「功能状态」，前后端不会各说各话。
 * 这里只做转发，保持原有导出路径不变。
 */
export { camExtOn, EXT_FEATURES, activeFeatures, featureState } from '../config/features.js'
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
      dedupeSec: Math.max(2, Number(c.dedupeSec) || 6),
      eventOnKnown: c.eventOnKnown !== false,
      eventOnUnknown: !!c.eventOnUnknown,
      collectUnknown: c.collectUnknown !== false
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
     */
    const list = camExtOn(cam, 'zone') ? (cam && cam.zones) || [] : []
    const key = JSON.stringify(list.map((z) => [z.id, z.rect, z.enterExit, z.loiter, z.loiterSec, z.loiterRadius]))
    if (key === zonesKey) return
    zonesKey = key
    tracker.setZones(list)
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

    /* ---------- 2. 区域事件 ---------- */
    for (const evt of res.events) {
      if (evt.kind === 'loiter' && zc.loiterAlarm === false) continue
      if (evt.kind === 'enter' && zc.enterAlarm === false) continue
      if (evt.kind === 'exit' && zc.exitAlarm === false) continue
      emit({
        type: evt.kind === 'loiter' ? 'loiter' : evt.kind === 'enter' ? 'enter' : 'exit',
        zoneName: evt.zoneName,
        zoneId: evt.zoneId,
        trackId: evt.trackId,
        at: evt.at,
        box: evt.box,
        dwellMs: evt.dwellMs || 0,
        text: zoneText(evt),
        source: 'zone'
      })
    }

    if (!live.length) {
      // 画面里没人：人脸/姿态没有意义，顺手清掉上一帧的残留框
      faces.value = []
      poses.value = []
      status.value = { ...status.value, face: '', pose: '' }
      maybeCountPush(now, emit, cam)
      return
    }

    /* ---------- 3. 人脸识别（全局开着 且 这一路参与 才跑） ---------- */
    const fc = faceConf()
    if (fc.enabled && camExtOn(cam, 'face')) {
      try {
        await loadModel('face', undefined, 640).catch(() => {})
        if (isSlotReady('face')) {
          const dets = await detectFaces(frame.canvas, fc.score)
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

    /* ---------- 5. 计数推送 ---------- */
    maybeCountPush(now, emit, cam)
  }

  /* ==================== 人脸 ==================== */
  async function runFaces(frame, dets, live, now, fc, cam, emit) {
    if (!dets.length) return
    await loadModel('faceemb', undefined, 112).catch(() => {})
    const canEmbed = isSlotReady('faceemb')
    const pairs = attachFacesToTracks(live, dets)

    for (const { face, track } of pairs) {
      // 同一个人的脸不需要每个周期都重算一遍特征
      if (track.faceAt && now - track.faceAt < fc.dedupeSec * 1000) {
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
      track.faceAt = now
      if (!canEmbed) continue

      const aligned = alignFace(frame.canvas, face.kps)
      if (!aligned) continue
      const vec = await faceEmbedding(aligned)
      if (!vec || !vec.length) continue

      const thumb = faceThumb(frame.canvas, face, FACE_SHOT_SIZE)
      const hit = await matchFace(vec, fc.threshold)
      const slot = faces.value.find(
        (f) => Math.abs((f.x + f.w / 2) - (face.x + face.w / 2)) < 0.02 &&
               Math.abs((f.y + f.h / 2) - (face.y + face.h / 2)) < 0.02
      )

      if (hit && !hit.miss) {
        track.face = { id: hit.face.id, name: hit.face.name, score: hit.score }
        if (slot) {
          slot.name = hit.face.name
          slot.known = true
        }
        if (!fc.eventOnKnown) continue
        const key = `f${hit.face.id}`
        if (now - (faceEventAt.get(key) || 0) < fc.cooldownSec * 1000) continue
        faceEventAt.set(key, now)
        emit({
          type: 'face',
          known: true,
          faceName: hit.face.name,
          faceScore: hit.score,
          box: face,
          thumb: thumb || '',
          trackId: track.id,
          at: now,
          text: `识别到「${hit.face.name}」（相似度 ${(hit.score * 100).toFixed(0)}%）`,
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
            at: now,
            camId: cam.id,
            camName: cam.name
          })
        }
        if (!fc.eventOnUnknown) continue
        const key = 'unknown'
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

  /** 把裁剪图里的姿态结果映射回原帧归一化坐标 */
  function mapCropBack(item, cropped) {
    const { box, inner, outSize, srcW, srcH } = cropped
    const toFrame = (u, v) => {
      // 裁剪图归一化 → 裁剪图像素 → 去掉填边 → 原帧像素
      const px = u * outSize
      const py = v * outSize
      const fx = (box.x * srcW * 1) + ((px - inner.dx) * box.w * srcW) / inner.nw
      const fy = (box.y * srcH * 1) + ((py - inner.dy) * box.h * srcH) / inner.nh
      return { x: fx / srcW, y: fy / srcH }
    }
    const x1 = toFrame(item.x, item.y)
    const x2 = toFrame(item.x + item.w, item.y + item.h)
    const kps = (item.kps || []).map((k) => {
      const p = toFrame(k.x, k.y)
      return { x: p.x, y: p.y, s: k.s }
    })
    return {
      x: x1.x,
      y: x1.y,
      w: x2.x - x1.x,
      h: x2.y - x1.y,
      score: item.score,
      kps
    }
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
        await loadModel('face', undefined, 640).catch(() => {})
        if (isSlotReady('face')) {
          const dets = await detectFaces(canvas, fc.score)
          const face = pickFaceFor(dets, box)
          if (face) {
            out.faceChecked = true
            await loadModel('faceemb', undefined, 112).catch(() => {})
            if (isSlotReady('faceemb')) {
              const aligned = alignFace(canvas, face.kps)
              const vec = aligned ? await faceEmbedding(aligned) : null
              if (vec) {
                const hit = await matchFace(vec, fc.threshold)
                out.faceThumb = faceThumb(canvas, face, FACE_SHOT_SIZE)
                if (hit && !hit.miss) {
                  out.faceName = hit.face.name
                  out.faceScore = hit.score
                } else {
                  out.faceScore = hit ? hit.score : 0
                  if (fc.collectUnknown && out.faceThumb) {
                    pushPendingFace({
                      vector: vec,
                      thumb: out.faceThumb,
                      at: now,
                      camId: cam.id,
                      camName: cam.name
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

/** 在若干张人脸里，挑出最可能属于这个人形框的那一张 */
function pickFaceFor(faces, box) {
  if (!faces || !faces.length || !box) return null
  let best = null
  for (const f of faces) {
    const cx = f.x + f.w / 2
    const cy = f.y + f.h / 2
    const inside = cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h
    const area = (f.w * f.h) / Math.max(1e-6, box.w * box.h)
    if (!inside && area < 0.02) continue
    const score = (inside ? 1 : 0) + Math.min(0.5, area) + (Number(f.score) || 0) * 0.2
    if (!best || score > best.score) best = { score, face: f }
  }
  return best ? best.face : null
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
