/**
 * AI 能力总入口（ONNX Runtime Web）
 * ----------------------------------------------------------------------------
 * 全部资源走项目本地 /ai/，不依赖任何外网：
 *   /ai/models/yolo11n|s.onnx     人形检测（COCO 80 类，这里只取 person）
 *   /ai/models/scrfd-500m.onnx    人脸检测（人脸框 + 5 点关键点）
 *   /ai/models/mobilefacenet.onnx 人脸特征（112×112 → 512 维）
 *   /ai/models/yolov8n-pose.onnx  姿态估计（17 关键点）
 *   /ai/ort/*                     ONNX Runtime Web 运行时（优先 WebGPU，回退 WASM）
 *
 * 真正的推理在 ../workers/aiWorker.js 里跑，避免阻塞界面。
 * 四个模型共用**同一个 Worker 线程**：同执行后端下共用一份 ORT 运行时，
 * 边际内存成本只有几 MB（实测四模型全驻留约 110MB）。
 */
import { ref } from 'vue'

/* ==================== 对外状态（detector 槽位，向后兼容） ==================== */
/** idle | loading | ready | error */
export const aiState = ref('idle')
export const aiError = ref('')
/** 实际生效的后端：webgpu | wasm */
export const aiBackend = ref('')
/** 当前已加载的人形模型名 */
export const aiModel = ref('')
/** 最近一次人形推理耗时（毫秒） */
export const aiCost = ref(0)
/** 最近一次识别到的人形数量 */
export const aiPersons = ref(0)

/** 各扩展槽位的后端（人脸特征在 WebGPU 下建不了会话，必然显示 wasm） */
export const aiSlotBackend = ref({})
/** 各扩展槽位的加载状态 */
export const aiSlotState = ref({})

/** 可选人形模型：键为文件名，值为展示信息 */
export const AI_MODELS = [
  { key: 'yolo11n', label: 'YOLO11n（最快·10.4MB）', size: 10.4, desc: 'nano，精度 39.5 mAP，最省 CPU' },
  { key: 'yolo11s', label: 'YOLO11s（均衡·36.3MB）', size: 36.3, desc: 'small，精度 47.0 mAP，推荐' }
]

const DEFAULT_MODEL = 'yolo11s'
const DEFAULT_SIZE = 640
/** 目标检测交并比阈值（NMS） */
const IOU = 0.45
/** 人脸对齐目标尺寸 */
const FACE_SIZE = 112

/** 固定文件的模型槽位（模型名写死，配置里只需要开关） */
const SLOT_FILE = {
  face: 'scrfd-500m',
  faceemb: 'mobilefacenet',
  pose: 'yolov8n-pose'
}
/** 各槽位的推荐输入边长 */
const SLOT_SIZE = { detector: 640, face: 640, pose: 640, faceemb: FACE_SIZE }

/* ==================== Worker 管理 ==================== */
let worker = null
let seq = 0
const pending = new Map()
/** slot → { key, promise, resolve, reject }：正在加载中的请求 */
const initMap = {}
/** slot → 已经加载完成的模型 key（命中的调用不再打扰 Worker） */
const readyKey = {}
/** slot → 失败冷却截止时间（避免每个分析周期都重试加载一个永远失败的模型） */
const failedUntil = {}

/**
 * 是否允许用 WebGPU 加速（设置里可关）。
 *
 * Windows 上部分显卡 / 驱动组合会让 WebGPU 后端抛
 * `Uncaught RuntimeError: memory access out of bounds` —— 那是 WebAssembly 的 trap，
 * 一旦发生整个推理线程就死了，界面从此再没有人形框。
 * Worker 内已有「trap → 自动降级 WASM 并重建会话」的兜底，
 * 但如果连 WASM 也扛不住（内存实在不够），关掉这个开关能彻底绕开 GPU 路径。
 */
let gpuPref = true

/** 设置页开关：切换后重置「已就绪」缓存，下次加载按新偏好建会话 */
export function setGpuPref(v) {
  const next = v !== false
  if (next === gpuPref) return
  gpuPref = next
  for (const k of Object.keys(readyKey)) delete readyKey[k]
}

export function getGpuPref() {
  return gpuPref
}

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('../workers/aiWorker.js', import.meta.url), { type: 'module' })

  worker.onmessage = (ev) => {
    const m = ev.data || {}

    if (m.type === 'ready') {
      const slot = m.slot || 'detector'
      aiSlotBackend.value = { ...aiSlotBackend.value, [slot]: m.backend }
      aiSlotState.value = { ...aiSlotState.value, [slot]: 'ready' }
      if (slot === 'detector') {
        aiState.value = 'ready'
        aiBackend.value = m.backend
        aiModel.value = m.model
      }
      const it = initMap[slot]
      if (it) {
        // 记住「已就绪」的 key，后续同模型的调用直接命中，不再重复往返 Worker
        readyKey[slot] = it.key
        delete initMap[slot]
        it.resolve(m)
      }
      return
    }

    if (m.type === 'downgrade') {
      // WebGPU 跑挂了（Windows 上偶发 wasm trap），Worker 已自动切到 WASM 并重建会话。
      // 这里必须清掉「已就绪」缓存，否则主线程以为模型还在线、永远不再发 init。
      for (const k of Object.keys(readyKey)) delete readyKey[k]
      for (const k of Object.keys(initMap)) {
        const it = initMap[k]
        delete initMap[k]
        // 重新加载：让它按新后端建会话
        loadModel(k, it.file, it.size).catch(() => {})
      }
      aiBackend.value = 'wasm'
      aiSlotBackend.value = {}
      return
    }

    if (m.type === 'error') {
      const slot = m.slot || 'detector'
      aiSlotState.value = { ...aiSlotState.value, [slot]: 'error' }
      failedUntil[slot] = Date.now() + 60000
      const it = initMap[slot]
      if (it) {
        it.reject(new Error(m.message || '模型加载失败'))
        delete initMap[slot]
      }
      if (slot === 'detector') {
        aiState.value = 'error'
        aiError.value = m.message || '模型加载失败'
      }
      return
    }

    if (m.type === 'result') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (p.slot === 'detector') {
        if (typeof m.cost === 'number') aiCost.value = m.cost
        aiPersons.value = (m.items || []).length
      }
      if (m.error) p.resolve([])
      else p.resolve(m.items || [])
    }
  }

  worker.onerror = (e) => {
    aiState.value = 'error'
    const raw = (e && e.message) || '推理线程异常'
    // wasm trap 在这里只会显示成一句 RuntimeError，对用户毫无指导意义
    aiError.value = /memory access out of bounds|RuntimeError|out of bounds/i.test(raw)
      ? '推理线程崩溃（GPU 加速在该设备上不兼容）。可在「设置 → 检测识别」里关掉 WebGPU 加速，已自动改用 CPU。'
      : raw
    // 线程已死：下一次调用会重建 worker，但要清掉「已就绪」缓存才会真的重新 init
    for (const k of Object.keys(readyKey)) delete readyKey[k]
    for (const k of Object.keys(failedUntil)) delete failedUntil[k]
  }

  return worker
}

/**
 * 加载（或切换）某个槽位的模型；同一个槽位多次调用共享同一个 Promise。
 * 加载失败会进入 60 秒冷却，期间直接返回失败的 Promise，不再反复踢 Worker。
 */
export function loadModel(slot, file, size) {
  const name = file || (slot === 'detector' ? DEFAULT_MODEL : SLOT_FILE[slot])
  const side = size || SLOT_SIZE[slot] || DEFAULT_SIZE
  if (!name) return Promise.reject(new Error(`未知槽位：${slot}`))
  const key = `${name}@${side}`

  if (readyKey[slot] === key) return Promise.resolve()
  const it = initMap[slot]
  if (it && it.key === key) return it.promise
  if (failedUntil[slot] && Date.now() < failedUntil[slot]) {
    return Promise.reject(new Error(`${slot} 模型加载失败冷却中`))
  }

  aiSlotState.value = { ...aiSlotState.value, [slot]: 'loading' }
  if (slot === 'detector') {
    aiState.value = 'loading'
    aiError.value = ''
  }

  let resolve = null
  let reject = null
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  // 包一层：把 reject 也变成「不抛出」的 resolve，调用方统一用 .catch 兜底
  initMap[slot] = { key, promise, resolve, reject, file: name, size: side }
  ensureWorker().postMessage({ type: 'init', slot, model: name, size: side, preferGpu: gpuPref })
  return promise
}

/** 人形模型加载的兼容入口 */
export function loadPersonModel(model) {
  return loadModel('detector', model || DEFAULT_MODEL, DEFAULT_SIZE)
}

export function isAiReady() {
  return aiState.value === 'ready'
}

export function isSlotReady(slot) {
  return (aiSlotState.value || {})[slot] === 'ready'
}

export function slotBackend(slot) {
  return (aiSlotBackend.value || {})[slot] || ''
}

/* ==================== 图像 → 张量 ==================== */
/** 复用的填边画布，避免每帧新建 */
let padCanvas = null
let padCtx = null

function ensurePad(size) {
  if (!padCanvas) {
    padCanvas = document.createElement('canvas')
    padCtx = padCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (padCanvas.width !== size || padCanvas.height !== size) {
    padCanvas.width = size
    padCanvas.height = size
  }
  return padCtx
}

/**
 * 把任意可绘制来源等比缩放并灰边填充成 size×size，返回 RGBA 与几何信息。
 * 几何信息交给 Worker 用来把检测框映射回原画面坐标。
 */
function prepare(source, size) {
  const srcW = source.width
  const srcH = source.height
  const scale = Math.min(size / srcW, size / srcH)
  const nw = Math.max(1, Math.round(srcW * scale))
  const nh = Math.max(1, Math.round(srcH * scale))
  const dx = Math.floor((size - nw) / 2)
  const dy = Math.floor((size - nh) / 2)

  const ctx = ensurePad(size)
  ctx.fillStyle = 'rgb(114,114,114)'
  ctx.fillRect(0, 0, size, size)
  ctx.drawImage(source, dx, dy, nw, nh)
  const imageData = ctx.getImageData(0, 0, size, size)
  return { imageData, rgba: imageData.data.buffer, geom: { scale, dx, dy, srcW, srcH } }
}

/** 发一次推理请求并等结果（带超时兜底，避免某个请求永远挂着） */
function request(slot, size, rgba, extra, timeoutMs = 20000) {
  const id = ++seq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve([])
      }
    }, timeoutMs)
    pending.set(id, {
      slot,
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      }
    })
    ensureWorker().postMessage(
      { type: 'infer', slot, id, size, rgba, ...extra },
      rgba instanceof ArrayBuffer ? [rgba] : []
    )
  })
}

/* ==================== 对外推理接口 ==================== */

/**
 * 人形检测
 * @returns {Promise<Array<{x:number,y:number,w:number,h:number,score:number}>>} 归一化坐标
 */
export async function detectPersons(canvas, minScore = 0.5, opts = {}) {
  const name = opts.model || DEFAULT_MODEL
  await loadPersonModel(name).catch(() => {})
  if (aiState.value !== 'ready') return []
  if (!canvas || !canvas.width || !canvas.height) return []

  const size = DEFAULT_SIZE
  const { rgba, geom } = prepare(canvas, size)
  return request('detector', size, rgba, {
    score: Math.min(0.95, Math.max(0.1, Number(minScore) || 0.5)),
    iou: IOU,
    geom
  })
}

/**
 * 人脸检测（SCRFD-500M）
 * @param {number} [size] 检测输入边长（缺省 640；SCRFD 是动态导出，可改 —— 见 FACE_TUNING.detSize）
 * @returns {Promise<Array<{x,y,w,h,score,kps:{x,y,s}[]}>>} 归一化坐标，kps 为 5 点
 */
export async function detectFaces(canvas, minScore = 0.5, size = SLOT_SIZE.face) {
  const side = Math.max(32, Math.round(Number(size) || SLOT_SIZE.face))
  await loadModel('face', SLOT_FILE.face, side).catch(() => {})
  if (!isSlotReady('face')) return []
  if (!canvas || !canvas.width || !canvas.height) return []

  const { rgba, geom } = prepare(canvas, side)
  return request('face', side, rgba, {
    score: Math.min(0.95, Math.max(0.1, Number(minScore) || 0.5)),
    iou: IOU,
    geom
  })
}

/**
 * 姿态估计（YOLOv8n-pose）
 * @param {HTMLCanvasElement} canvas 通常是人形框裁剪后放大到 640 的小图
 * @returns {Promise<Array<{x,y,w,h,score,kps:{x,y,s}[]}>>} 归一化坐标，kps 为 17 点
 */
export async function detectPose(canvas, minScore = 0.4) {
  await loadModel('pose', SLOT_FILE.pose).catch(() => {})
  if (!isSlotReady('pose')) return []
  if (!canvas || !canvas.width || !canvas.height) return []

  const size = SLOT_SIZE.pose
  const { rgba, geom } = prepare(canvas, size)
  return request('pose', size, rgba, {
    score: Math.min(0.9, Math.max(0.1, Number(minScore) || 0.4)),
    iou: IOU,
    geom
  })
}

/**
 * 人脸特征提取。
 * @param {HTMLCanvasElement} aligned 已按 5 点对齐好的 112×112 画布
 * @returns {Promise<Float32Array|null>} 512 维单位向量（失败返回 null）
 */
export async function faceEmbedding(aligned) {
  await loadModel('faceemb', SLOT_FILE.faceemb).catch(() => {})
  if (!isSlotReady('faceemb')) return null
  if (!aligned || !aligned.width || !aligned.height) return null

  const ctx = aligned.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  let img = null
  try {
    img = ctx.getImageData(0, 0, aligned.width, aligned.height)
  } catch (e) {
    return null
  }
  // 对齐画布本身就是 112×112，直接送进去，没有填边几何
  const bytes = new Uint8ClampedArray(img.data.length)
  bytes.set(img.data)
  const res = await request('faceemb', FACE_SIZE, bytes.buffer, {}, 15000)
  const first = res && res[0]
  if (!first || !first.vector) return null
  return normalizeVector(Float32Array.from(first.vector))
}

/* ==================== 人脸对齐 ==================== */
/**
 * ArcFace 标准的 5 点目标位置（112×112）。
 * 顺序：左眼、右眼、鼻尖、左嘴角、右嘴角 —— 和 SCRFD 的输出顺序一致。
 */
const ARC_DST = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041]
]

/**
 * 用 5 个关键点求「相似变换」（旋转 + 均匀缩放 + 平移）的最小二乘解。
 * 只解 4 个自由度而不是完整仿射，是为了不让检测抖动把脸拉变形。
 */
function estimateSimilarity(src, dst) {
  const n = Math.min(src.length, dst.length)
  if (n < 2) return null
  let sx = 0
  let sy = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    sx += src[i][0]
    sy += src[i][1]
    dx += dst[i][0]
    dy += dst[i][1]
  }
  sx /= n
  sy /= n
  dx /= n
  dy /= n

  let a = 0
  let b = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx
    const py = src[i][1] - sy
    const qx = dst[i][0] - dx
    const qy = dst[i][1] - dy
    a += px * qx + py * qy
    b += px * qy - py * qx
    den += px * px + py * py
  }
  if (den < 1e-6) return null
  const A = a / den
  const B = b / den
  return { A, B, tx: dx - A * sx + B * sy, ty: dy - B * sx - A * sy }
}

let alignCanvas = null
let alignCtx = null

/**
 * 把一张画面里的人脸，按 5 点关键点摆正、缩放到 112×112。
 * @param {HTMLCanvasElement} source 原始帧画布
 * @param {Array<{x:number,y:number}>} kps 归一化坐标的 5 点关键点
 * @returns {HTMLCanvasElement|null}
 */
export function alignFace(source, kps) {
  if (!source || !kps || kps.length < 5) return null
  const sw = source.width
  const sh = source.height
  const src = kps.slice(0, 5).map((k) => [k.x * sw, k.y * sh])
  // 关键点里有 (0,0) 之类的坏值时直接放弃，免得拉出一张废图
  for (const p of src) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
  }
  const dst = ARC_DST.map((p) => [
    (p[0] * FACE_SIZE) / 112,
    (p[1] * FACE_SIZE) / 112
  ])
  const m = estimateSimilarity(src, dst)
  if (!m) return null

  if (!alignCanvas) {
    alignCanvas = document.createElement('canvas')
    alignCtx = alignCanvas.getContext('2d', { willReadFrequently: true })
  }
  alignCanvas.width = FACE_SIZE
  alignCanvas.height = FACE_SIZE
  if (!alignCtx) return null
  alignCtx.setTransform(1, 0, 0, 1, 0, 0)
  alignCtx.clearRect(0, 0, FACE_SIZE, FACE_SIZE)
  // canvas 的 setTransform(m11, m12, m21, m22, dx, dy) 对应
  //   x' = m11·x + m21·y + dx
  //   y' = m12·x + m22·y + dy
  alignCtx.setTransform(m.A, m.B, -m.B, m.A, m.tx, m.ty)
  try {
    alignCtx.drawImage(source, 0, 0)
  } catch (e) {
    alignCtx.setTransform(1, 0, 0, 1, 0, 0)
    return null
  }
  alignCtx.setTransform(1, 0, 0, 1, 0, 0)
  return alignCanvas
}

/** 把人脸缩略图编码成 dataURL（存人脸库用） */
export function faceThumb(source, box, size = 96) {
  if (!source || !box) return ''
  const sw = source.width
  const sh = source.height
  const x = Math.max(0, box.x * sw)
  const y = Math.max(0, box.y * sh)
  const w = Math.max(1, Math.min(sw - x, box.w * sw))
  const h = Math.max(1, Math.min(sh - y, box.h * sh))
  if (w < 2 || h < 2) return ''
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  // 正方形内缩一点，让脸不至于贴边
  const pad = 0.12
  const s = Math.min(w, h) * (1 + pad * 2)
  const cx = x + w / 2
  const cy = y + h / 2
  try {
    ctx.drawImage(source, cx - s / 2, cy - s / 2, s, s, 0, 0, size, size)
    return c.toDataURL('image/jpeg', 0.72)
  } catch (e) {
    return ''
  }
}

/** 把一张画面按归一化框裁剪并放大到指定边长（姿态分析用） */
let cropCanvas = null
let cropCtx = null

/**
 * 裁剪并放大一个人形区域。
 * 返回的 `box` / `inner` / `outSize` 是用来把结果**映射回原帧**的完整几何信息
 * （裁剪图归一化坐标 → 原帧归一化坐标），少了它姿态关键点就对不上位置。
 * @returns {{canvas:HTMLCanvasElement, box:object, inner:object, outSize:number, srcW:number, srcH:number}|null}
 */
export function cropBox(source, box, outSize = 320, padRatio = 0.12) {
  if (!source || !box) return null
  const sw = source.width
  const sh = source.height
  const px = box.w * sw * padRatio
  const py = box.h * sh * padRatio
  const x = Math.max(0, box.x * sw - px)
  const y = Math.max(0, box.y * sh - py)
  const w = Math.min(sw - x, box.w * sw + px * 2)
  const h = Math.min(sh - y, box.h * sh + py * 2)
  if (w < 4 || h < 4) return null

  if (!cropCanvas) {
    cropCanvas = document.createElement('canvas')
    cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true })
  }
  cropCanvas.width = outSize
  cropCanvas.height = outSize
  if (!cropCtx) return null
  cropCtx.fillStyle = 'rgb(114,114,114)'
  cropCtx.fillRect(0, 0, outSize, outSize)
  const scale = Math.min(outSize / w, outSize / h)
  const nw = Math.max(1, Math.round(w * scale))
  const nh = Math.max(1, Math.round(h * scale))
  const dx = Math.floor((outSize - nw) / 2)
  const dy = Math.floor((outSize - nh) / 2)
  try {
    cropCtx.drawImage(source, x, y, w, h, dx, dy, nw, nh)
  } catch (e) {
    return null
  }
  return {
    canvas: cropCanvas,
    /** 裁剪区在原画面里的归一化位置 */
    box: { x: x / sw, y: y / sh, w: w / sw, h: h / sh },
    /** 缩放 + 填边信息 */
    inner: { dx, dy, nw, nh },
    outSize,
    srcW: sw,
    srcH: sh
  }
}

/* ==================== 人脸：头部区域裁剪放大再检测 ==================== */

/**
 * 人形框的「头部区域」（归一化，已 clamp 到画面内）。
 *
 * 为什么要单独裁一遍：SCRFD 的输入边长固定 640。一个 4 米外的人，
 * 脸在整帧 640 输入里只剩十几个像素，低于检测器的有效分辨率 →
 * 整帧检测直接漏检，采集率就是这样掉到十分之一的。
 * 把头部区域裁出来放大到 640 再检一次，同一张脸在模型眼里从 ~12px 变成 ~100px。
 *
 * 取框高 45% 是三种构图的兼容上界：
 *   全身框（头在顶部 12~18%）/ 半身框（25~30%）/ 胸以上近拍（45~55%）
 * 上限 0.9 防呆：配置写飞了也不至于把整框当头部。
 *
 * @param {object} box 人形框（归一化）
 * @param {number} [headRatio=0.45] 头部区域占框高的比例
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function headZoneOf(box, headRatio = 0.45) {
  if (!box || !box.w || !box.h) return null
  const ratio = Math.min(0.9, Math.max(0.1, Number(headRatio) || 0.45))
  const y = Math.max(0, Math.min(1, box.y))
  const h = Math.min(1 - y, box.h * ratio)
  const x = Math.max(0, Math.min(1, box.x))
  const w = Math.min(1 - x, box.w)
  if (h <= 0.002 || w <= 0.002) return null
  return { x, y, w, h }
}

/**
 * 把裁剪图里的检测结果映射回原帧归一化坐标（cropBox 的逆运算）。
 * 两端共用同一份：后端漏掉这一步，脸就会画到错误的位置上。
 */
export function mapCropBack(item, cropped) {
  const { box, inner, outSize, srcW, srcH } = cropped
  const toFrame = (u, v) => {
    // 裁剪图归一化 → 裁剪图像素 → 去掉填边 → 原帧像素
    const px = u * outSize
    const py = v * outSize
    const fx = box.x * srcW + ((px - inner.dx) * box.w * srcW) / inner.nw
    const fy = box.y * srcH + ((py - inner.dy) * box.h * srcH) / inner.nh
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

/**
 * 按人形头部区域裁剪放大，再跑一次人脸检测，结果映射回原帧坐标。
 *
 * 性能约定（调用方遵守）：只对「去重窗口已到期」的轨迹调用 ——
 * 窗口没到期的轨迹本来就要复用旧结果，检出来了也用不上，白跑一次推理。
 * 后端没有叠加层要画，2fps × 10s 去重窗下每轨迹最多 0.1 次/秒，
 * 相对整帧检测（2 次/秒）开销可忽略；窗口内反而比整帧检测更省。
 *
 * @param {object} source 画面（前端 canvas / 后端 canvas shim）
 * @param {object} box 人形框（归一化）
 * @param {(canvas:object) => Promise<Array>} detect 人脸检测函数（端各自注入）
 * @param {object} [opts] { headRatio, padRatio, size }
 *        size = 裁剪放大到的边长，**必须与 detect 端真正吃的输入边长一致**
 *        （前端 SLOT_SIZE.face / 后端会话的 st.size），否则映射回原帧会错位。
 * @returns {Promise<Array<{x,y,w,h,score,kps}>>} 映射回原帧的人脸框（可能为空）
 */
export async function detectFacesInHead(source, box, detect, opts = {}) {
  const zone = headZoneOf(box, opts.headRatio)
  if (!zone) return []
  const target = Math.max(32, Math.round(Number(opts.size) || SLOT_SIZE.face))
  const crop = cropBox(source, zone, target, opts.padRatio || 0.18)
  if (!crop) return []
  let dets = []
  try {
    dets = (await detect(crop.canvas)) || []
  } catch (e) {
    return []
  }
  return dets.map((d) => mapCropBack(d, crop))
}

/* ==================== 向量工具 ==================== */
/** L2 归一化（人脸比对用余弦相似度，先归一化就只剩点积） */
export function normalizeVector(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  s = Math.sqrt(s)
  if (!(s > 1e-8)) return v
  for (let i = 0; i < v.length; i++) v[i] /= s
  return v
}

/** 两个已归一化向量的余弦相似度 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/* ==================== 释放 ==================== */
/** 释放全部模型（关闭 AI 功能时调用） */
export function releaseModel() {
  if (worker) {
    worker.terminate()
    worker = null
  }
  pending.forEach((p) => p.resolve([]))
  pending.clear()
  Object.keys(initMap).forEach((k) => delete initMap[k])
  Object.keys(readyKey).forEach((k) => delete readyKey[k])
  Object.keys(failedUntil).forEach((k) => delete failedUntil[k])
  aiState.value = 'idle'
  aiBackend.value = ''
  aiModel.value = ''
  aiSlotBackend.value = {}
  aiSlotState.value = {}
}

/** 只释放某个扩展槽位（专项功能关掉时调用，省内存） */
export function releaseSlot(slot) {
  if (!worker) return
  worker.postMessage({ type: 'release', slot })
  aiSlotState.value = { ...aiSlotState.value, [slot]: 'idle' }
  delete initMap[slot]
  delete readyKey[slot]
}

/** 调试用：控制台执行 __aiDebug 可查看各模型加载状态与耗时 */
if (typeof window !== 'undefined') {
  window.__aiDebug = {
    state: aiState,
    backend: aiBackend,
    model: aiModel,
    cost: aiCost,
    persons: aiPersons,
    slotState: aiSlotState,
    slotBackend: aiSlotBackend,
    error: aiError
  }
}
