/**
 * AI 推理 Worker：ONNX Runtime Web
 * ----------------------------------------------------------------------------
 * 一个 Worker 承载全部模型，按「槽位（slot）」区分用途：
 *
 *   detector  人形检测   yolo11n / yolo11s          COCO person
 *   face      人脸检测   scrfd-500m                 人脸框 + 5 点关键点
 *   faceemb   人脸特征   mobilefacenet              112×112 → 512 维向量
 *   pose      姿态估计   yolov8n-pose               17 关键点
 *
 * 为什么放 Worker：H.265 软解已经把主线程吃得很紧，推理（尤其 WASM 后端）
 * 如果跑在主线程会让按钮、画面全部卡住。放到独立线程后推理期间界面依旧流畅。
 *
 * 模型与运行时全部来自项目本地 /ai/ 目录，不依赖任何外网。
 *
 * ⚠️ 两个实测踩过的坑（不要"顺手优化"掉）：
 *   1. ORT Web 的 `session.inputMetadata` 是**数组**，且维度属性叫 **`shape`**
 *      （不是 `dims`）。写成 `inputMetadata[name].dims` 会被 try/catch 静默吞掉，
 *      把 112×112 的人脸模型喂成 640。
 *   2. MobileFaceNet 在 WebGPU 执行后端下建会话会直接失败，必须回退 WASM。
 *      这里统一用「先试 WebGPU、失败自动退 WASM」的建会话策略。
 */

const ORT_DIR = '/ai/ort/'
const MODEL_DIR = '/ai/models/'

/** COCO 数据集中 person 的类别下标 */
const PERSON_CLASS = 0
/** 人脸对齐后的标准输入边长 */
const FACE_SIZE = 112
/** 姿态模型的关键点数量 */
const KPT_COUNT = 17

/** 用 Function 包一层，避免打包器把运行时路径当成模块去静态解析 */
const dynImport = new Function('u', 'return import(u)')

/* ==================== 输入归一化 ==================== */
/**
 * 不同模型对输入的归一化要求不一样，混用会直接导致识别不出东西：
 *   unit    YOLO 系列：直接 /255
 *   scrfd   InsightFace 人脸检测：(x - 127.5) / 128
 *   arcface InsightFace 人脸特征：(x - 127.5) / 127.5
 */
const NORM_FN = {
  unit: (v) => v * 0.00392156862745098,
  scrfd: (v) => (v - 127.5) * 0.0078125,
  arcface: (v) => (v - 127.5) * 0.00784313725490196
}
const SLOT_NORM = { detector: 'unit', face: 'scrfd', faceemb: 'arcface', pose: 'unit' }

/* ==================== 运行时与会话 ==================== */
let ort = null
let backend = ''
/** 调用方是否允许用 WebGPU（用户在设置里关掉时为 false） */
let preferGpu = true
/** slot → { key, session, size, inputName, outputs } */
const slots = {}

async function loadOrt() {
  if (ort) return ort
  const m = await dynImport(`${ORT_DIR}ort.webgpu.min.mjs`)
  const mod = m && m.env && m.InferenceSession ? m : m.default
  if (!mod || !mod.InferenceSession) throw new Error('ONNX Runtime 运行时加载失败')
  mod.env.wasm.wasmPaths = ORT_DIR
  // 单线程：不想为了多线程引入 SharedArrayBuffer / COOP+COEP 头
  mod.env.wasm.numThreads = 1
  mod.env.logLevel = 'error'
  ort = mod
  return ort
}

/** 有 WebGPU 就优先用它（走 GPU，几乎不占 CPU）；也允许调用方强制只用 WASM */
async function detectBackend() {
  if (backend) return backend
  if (preferGpu === false) {
    backend = 'wasm'
    return backend
  }
  try {
    if (self.navigator && self.navigator.gpu) {
      const adapter = await self.navigator.gpu.requestAdapter()
      if (adapter) {
        backend = 'webgpu'
        return backend
      }
    }
  } catch (e) {
    /* 忽略，回退 wasm */
  }
  backend = 'wasm'
  return backend
}

/** ORT Web 的 inputMetadata 是数组；兼容个别版本按名字建索引的对象形式 */
function inputMetaAt(session, index, name) {
  const im = session.inputMetadata
  if (Array.isArray(im)) return im[index] || {}
  if (im && im[name]) return im[name]
  return {}
}

/** 从元数据里取静态输入边长（NCHW 的 H）。动态导出取不到，返回 0 */
function staticSideOf(meta) {
  const shape = meta && (meta.shape || meta.dims)
  if (Array.isArray(shape) && shape.length === 4) {
    const h = shape[2]
    if (typeof h === 'number' && h > 0) return h
  }
  return 0
}

/**
 * 建立 / 复用会话。
 * 先按当前后端建；如果插不上（例如 MobileFaceNet 在 WebGPU 下必失败），
 * 自动退回 WASM 重建——比让整个功能直接不可用要好得多。
 */
async function ensureSession(slot, file, size) {
  const key = `${file}@${size}`
  const cur = slots[slot]
  if (cur && cur.key === key && cur.session) return cur

  if (cur && cur.session) {
    try {
      await cur.session.release()
    } catch (e) {
      /* 忽略 */
    }
    slots[slot] = null
  }

  const mod = await loadOrt()
  const ep = await detectBackend()
  const path = `${MODEL_DIR}${file}.onnx`
  const base = { graphOptimizationLevel: 'all' }

  let session = null
  let used = 'wasm'
  if (ep === 'webgpu') {
    try {
      session = await mod.InferenceSession.create(path, {
        ...base,
        executionProviders: ['webgpu', 'wasm']
      })
      used = 'webgpu'
    } catch (e) {
      session = null
    }
  }
  if (!session) {
    session = await mod.InferenceSession.create(path, { ...base, executionProviders: ['wasm'] })
    used = 'wasm'
  }

  const inputName = session.inputNames[0]
  const meta = inputMetaAt(session, 0, inputName)
  // 模型自带的静态尺寸优先；动态导出（人脸检测就是动态的）沿用调用方给的 size
  const declared = staticSideOf(meta)
  const entry = {
    key,
    session,
    size: declared || size,
    inputName,
    outputs: session.outputNames.slice(),
    backend: used
  }
  slots[slot] = entry
  return entry
}

/* ==================== 张量构造 ==================== */
function asU8(raw) {
  if (raw instanceof Uint8ClampedArray) return raw
  if (raw instanceof Uint8Array) return new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength)
  return new Uint8ClampedArray(raw)
}

/** RGBA → 归一化 NCHW 张量 */
function toTensor(rgba, size, normName) {
  const area = size * size
  if (rgba.length < area * 4) throw new Error(`输入帧尺寸不符：期望 ${area * 4}，实得 ${rgba.length}`)
  const norm = NORM_FN[normName] || NORM_FN.unit
  const f32 = new Float32Array(area * 3)
  for (let i = 0, j = 0; i < area; i++, j += 4) {
    f32[i] = norm(rgba[j])
    f32[area + i] = norm(rgba[j + 1])
    f32[area * 2 + i] = norm(rgba[j + 2])
  }
  return f32
}

/**
 * 是不是「wasm 陷阱」类错误。
 *
 * `Uncaught RuntimeError: memory access out of bounds` 是 WebAssembly 的 trap，
 * 在 Windows 上跑 WebGPU 后端（jsep）时比较常见：GPU 驱动 / 浏览器版本组合一旦
 * 不被支持，症状不是普通 JS 异常，而是整个推理线程抛 RuntimeError。
 * 这类错误可以自动降级处理；别的错误照常上抛，避免掩盖真问题。
 */
function isTrap(e) {
  const msg = String((e && e.message) || e || '')
  return /memory access out of bounds|RuntimeError|unreachable|out of bounds|abort/i.test(msg)
}

/** 释放所有会话（降级后必须重建，否则拿到的还是 WebGPU 会话） */
async function releaseAll() {
  for (const k of Object.keys(slots)) {
    const s = slots[k]
    if (s && s.session) {
      try {
        await s.session.release()
      } catch (e) {
        /* 忽略 */
      }
    }
    slots[k] = null
  }
}

async function runSlotOnce(slot, rgba, size) {
  const st = slots[slot]
  if (!st || !st.session) throw new Error(`槽位 ${slot} 未就绪`)
  const f32 = toTensor(rgba, size, SLOT_NORM[slot])
  const tensor = new ort.Tensor('float32', f32, [1, 3, size, size])
  const out = await st.session.run({ [st.inputName]: tensor })
  return st.outputs.map((n) => out[n])
}

/**
 * 跑一次推理。
 * 命中 wasm trap（多半来自 WebGPU）时：全局降级成 WASM、丢掉所有会话重建，
 * 然后**重试一次**。这样「Windows + 特定驱动」这类环境下只是慢一点，
 * 不会整个 AI 线程崩掉、界面从此再没有人形框。
 */
async function runSlot(slot, rgba, size) {
  try {
    return await runSlotOnce(slot, rgba, size)
  } catch (e) {
    if (!isTrap(e) || backend !== 'webgpu') throw e
    backend = 'wasm'
    await releaseAll()
    self.postMessage({ type: 'downgrade', reason: 'WebGPU 推理异常，已自动切到 WASM' })
    return await runSlotOnce(slot, rgba, size)
  }
}

/* ==================== 通用后处理 ==================== */
function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  const w = x2 - x1
  const h = y2 - y1
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

function nms(boxes, iouThreshold, limit = 30) {
  boxes.sort((a, b) => b.score - a.score)
  const keep = []
  for (const box of boxes) {
    let ok = true
    for (const k of keep) {
      if (iou(box, k) > iouThreshold) {
        ok = false
        break
      }
    }
    if (ok) keep.push(box)
    if (keep.length >= limit) break
  }
  return keep
}

/**
 * 把检测框从「填边后的正方形输入」映射回原始画面并归一化。
 * 关键点（人脸 5 点 / 姿态 17 点）用同一套变换跟着走。
 */
function toNormalized(list, geom) {
  const { scale, dx, dy, srcW, srcH } = geom
  const nx = (v) => Math.min(Math.max((v - dx) / scale / srcW, 0), 1)
  const ny = (v) => Math.min(Math.max((v - dy) / scale / srcH, 0), 1)
  const out = []
  for (const b of list) {
    const x1 = nx(b.x1)
    const y1 = ny(b.y1)
    const x2 = nx(b.x2)
    const y2 = ny(b.y2)
    if (x2 - x1 < 1 / srcW || y2 - y1 < 1 / srcH) continue
    const item = { x: x1, y: y1, w: x2 - x1, h: y2 - y1, score: b.score }
    if (b.kps) {
      item.kps = b.kps.map((k) => ({ x: nx(k.x), y: ny(k.y), s: k.s }))
    }
    out.push(item)
  }
  return out
}

/* ==================== 各模型解码 ==================== */

/**
 * YOLOv8 / v11 检测头。
 * 形状 [1, 84, N]（84 = 4 框 + 80 类），个别导出方向相反为 [1, N, 84]，做自适应。
 * 兼容 v5 风格（多一个 objectness 通道：85 = 4 框 + 1 置信度 + 80 类）。
 */
function decodeDetector(out, geom, scoreThreshold, iouThreshold) {
  const dims = out.dims
  const data = out.data
  let anchors = 0
  let chan = 0
  let at = null

  if (dims.length === 3) {
    const d1 = dims[1]
    const d2 = dims[2]
    if (d1 <= 256 && d2 > 256) {
      chan = d1
      anchors = d2
      at = (c, i) => c * anchors + i
    } else {
      anchors = d1
      chan = d2
      at = (c, i) => i * chan + c
    }
  } else if (dims.length === 2) {
    chan = dims[0]
    anchors = dims[1]
    at = (c, i) => c * anchors + i
  } else {
    return []
  }

  const withObj = chan === 5 + 80
  const boxes = []
  for (let i = 0; i < anchors; i++) {
    let score
    if (withObj) score = data[at(4, i)] * data[at(5 + PERSON_CLASS, i)]
    else score = data[at(4 + PERSON_CLASS, i)]
    if (!(score >= scoreThreshold)) continue
    const cx = data[at(0, i)]
    const cy = data[at(1, i)]
    const w = data[at(2, i)]
    const h = data[at(3, i)]
    boxes.push({
      x1: cx - w / 2,
      y1: cy - h / 2,
      x2: cx + w / 2,
      y2: cy + h / 2,
      score
    })
  }
  return toNormalized(nms(boxes, iouThreshold), geom)
}

/**
 * SCRFD-500M 人脸检测。
 * 输出共 9 个张量，按 stride 8/16/32 分成三组：每组「分数 / 框 / 关键点」。
 * 不依赖输出顺序，改用「第二维长度 + 行数」自动归类，换导出也不容易崩。
 *   分数 [N,1]  框 [N,4]（ltrb，相对 anchor 中心，单位是 stride 倍数）  关键点 [N,10]
 * N = (size/stride)² × 每个位置 2 个 anchor
 */
function decodeFace(outputs, geom, scoreThreshold, iouThreshold) {
  const groups = []
  const collect = (kind) => {
    const list = []
    for (const o of outputs) {
      if (!o || !o.dims || o.dims.length !== 2) continue
      const rows = o.dims[0]
      const cols = o.dims[1]
      if (kind === 'score' && cols === 1) list.push({ rows, o })
      if (kind === 'bbox' && cols === 4) list.push({ rows, o })
      if (kind === 'kps' && cols === 10) list.push({ rows, o })
    }
    // 行数多的是小 stride（特征图更大），必须按 stride 从细到粗配对
    return list.sort((a, b) => b.rows - a.rows)
  }
  const scores = collect('score')
  const bboxes = collect('bbox')
  const kpss = collect('kps')
  const n = Math.min(scores.length, bboxes.length, kpss.length)
  for (let i = 0; i < n; i++) groups.push({ scores: scores[i], bboxes: bboxes[i], kpss: kpss[i] })

  const boxes = []
  for (let g = 0; g < groups.length; g++) {
    const { scores: so, bboxes: bo, kpss: ko } = groups[g]
    const stride = 8 * Math.pow(2, g)
    const side = Math.max(1, Math.round(Math.sqrt(so.rows / 2)))
    const anchors = 2
    const sd = so.o.data
    const bd = bo.o.data
    const kd = ko.o.data

    for (let i = 0; i < side; i++) {
      for (let j = 0; j < side; j++) {
        for (let a = 0; a < anchors; a++) {
          const idx = (i * side + j) * anchors + a
          const score = sd[idx]
          if (!(score >= scoreThreshold)) continue
          const cx = j * stride
          const cy = i * stride
          const b = idx * 4
          const k = idx * 10
          const x1 = cx - bd[b] * stride
          const y1 = cy - bd[b + 1] * stride
          const x2 = cx + bd[b + 2] * stride
          const y2 = cy + bd[b + 3] * stride
          const kps = []
          for (let p = 0; p < 5; p++) {
            kps.push({
              x: cx + kd[k + p * 2] * stride,
              y: cy + kd[k + p * 2 + 1] * stride,
              s: score
            })
          }
          boxes.push({ x1, y1, x2, y2, score, kps })
        }
      }
    }
  }
  const kept = nms(boxes, iouThreshold, 20)
  return toNormalized(kept, geom)
}

/**
 * YOLOv8-pose：输出 [1, 56, N] = 4 框 + 1 置信度 + 17×(x, y, 置信度)。
 * 关键点坐标是**输入张量像素坐标**，跟着框一起做几何反变换。
 */
function decodePose(out, geom, scoreThreshold, iouThreshold) {
  if (!out || !out.dims || out.dims.length !== 3) return []
  const dims = out.dims
  const chan = dims[1]
  const anchors = dims[2]
  if (chan < 5 + KPT_COUNT * 3) return []
  const data = out.data
  const at = (c, i) => c * anchors + i

  const boxes = []
  for (let i = 0; i < anchors; i++) {
    const score = data[at(4, i)]
    if (!(score >= scoreThreshold)) continue
    const cx = data[at(0, i)]
    const cy = data[at(1, i)]
    const w = data[at(2, i)]
    const h = data[at(3, i)]
    const kps = []
    for (let p = 0; p < KPT_COUNT; p++) {
      kps.push({
        x: data[at(5 + p * 3, i)],
        y: data[at(5 + p * 3 + 1, i)],
        s: data[at(5 + p * 3 + 2, i)]
      })
    }
    boxes.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score, kps })
  }
  return toNormalized(nms(boxes, iouThreshold, 6), geom)
}

/* ==================== 消息处理 ==================== */
self.onmessage = async (ev) => {
  const msg = ev.data || {}

  if (msg.type === 'init') {
    // 调用方可以在设置里强制「只用 WASM」（默认允许 WebGPU）
    if (typeof msg.preferGpu === 'boolean' && msg.preferGpu !== preferGpu) {
      preferGpu = msg.preferGpu
      backend = '' // 让下次 detectBackend 重新判定
    }
    const t0 = Date.now()
    try {
      const st = await ensureSession(msg.slot, msg.model, msg.size || 640)
      self.postMessage({
        type: 'ready',
        slot: msg.slot,
        model: msg.model,
        backend: st.backend,
        size: st.size,
        cost: Date.now() - t0
      })
    } catch (e) {
      self.postMessage({
        type: 'error',
        slot: msg.slot,
        model: msg.model,
        message: (e && e.message) || String(e)
      })
    }
    return
  }

  if (msg.type === 'infer') {
    const t0 = Date.now()
    try {
      const st = slots[msg.slot]
      if (!st || !st.session) throw new Error(`槽位 ${msg.slot} 未加载`)
      const size = msg.size || st.size || 640
      const outputs = await runSlot(msg.slot, asU8(msg.rgba), size)
      const score = msg.score || 0.5
      const iouTh = msg.iou || 0.45
      let items = null

      if (msg.slot === 'detector') items = decodeDetector(outputs[0], msg.geom, score, iouTh)
      else if (msg.slot === 'face') items = decodeFace(outputs, msg.geom, score, iouTh)
      else if (msg.slot === 'pose') items = decodePose(outputs[0], msg.geom, score, iouTh)
      else if (msg.slot === 'faceemb') {
        // 人脸特征：只有一条 512 维向量，直接原样带回（余弦相似度在主线程算）
        const o = outputs[0]
        items = [{ vector: Array.from(o.data) }]
      }

      self.postMessage({
        type: 'result',
        slot: msg.slot,
        id: msg.id,
        items: items || [],
        backend: st.backend,
        cost: Date.now() - t0
      })
    } catch (e) {
      self.postMessage({
        type: 'result',
        slot: msg.slot,
        id: msg.id,
        items: [],
        error: (e && e.message) || String(e)
      })
    }
    return
  }

  if (msg.type === 'release') {
    const st = slots[msg.slot]
    if (st && st.session) {
      try {
        await st.session.release()
      } catch (e) {
        /* 忽略 */
      }
    }
    slots[msg.slot] = null
    self.postMessage({ type: 'released', slot: msg.slot })
  }
}
