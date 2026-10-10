/**
 * 人脸库
 * ----------------------------------------------------------------------------
 * 存什么：每个人的 512 维人脸特征向量（MobileFaceNet）+ 一张 96×96 的缩略图。
 * 存哪：和报警记录同一个 IndexedDB（monitor-wall-db），单独一个 faces 表。
 * 上限：默认 50 人（可配置）。到上限后必须先删人才能继续录入，避免无限增长。
 *
 * 为什么要存缩略图：设置页要能一眼看到"这条记录是谁"，只有一串向量没法认。
 * 缩略图统一压到 96×96 JPEG，每张约 4~6KB，50 个人总共不到 300KB。
 */
import { ref } from 'vue'
import { openDB, FACE_STORE_NAME } from './useEventStore.js'
import { cosine } from './useAiDetector.js'

/** 默认比对阈值：余弦相似度高于它才认为是同一个人 */
export const DEFAULT_FACE_THRESHOLD = 0.38
/** 人脸库默认上限 */
export const DEFAULT_FACE_MAX = 50

/** 人脸库列表（轻量：不含向量，向量只在比对时按需读） */
export const faces = ref([])
/** 加载状态 */
export const facesReady = ref(false)
/**
 * 「人脸库」那一块展开着吗。
 *
 * ⚠️ 刻意放在**模块级**而不是设置抽屉的组件里：抽屉是 `v-if` 挂载的，
 *    组件内部的 ref 每次关掉设置都会跟着销毁 —— 于是「点开管理 → 看到人 →
 *    关了设置再打开 → 又是个折叠的 + 要重新点」，
 *    用起来就像"人脸库一会有一会又不见了"。展开状态属于"用户看这一块的偏好"，
 *    不该被一次抽屉的开关重置掉。
 */
export const faceLibOpen = ref(false)

/** 简单互斥，避免并发写坏自增 id */
let writeChain = Promise.resolve()

function runExclusive(fn) {
  const next = writeChain.then(fn, fn)
  writeChain = next.catch(() => {})
  return next
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function store(mode) {
  const db = await openDB()
  return db.transaction(FACE_STORE_NAME, mode).objectStore(FACE_STORE_NAME)
}

/** 读取全量（含向量），仅内部比对与导出用 */
export async function getAllFaces() {
  const os = await store('readonly')
  const all = await reqAsPromise(os.getAll())
  return (all || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
}

/** 刷新对外列表（去掉向量，避免 Vue 深度响应式把大数组变慢） */
export async function refreshFaces() {
  const all = await getAllFaces()
  faces.value = all.map((f) => ({
    id: f.id,
    name: f.name,
    thumb: f.thumb || '',
    createdAt: f.createdAt || 0,
    updatedAt: f.updatedAt || 0,
    samples: f.samples || 1
  }))
  facesReady.value = true
  return faces.value
}

/** 自动编号：人脸 1 / 人脸 2 ……（跳过已占用的序号） */
export function nextFaceName(existing) {
  const used = new Set((existing || []).map((f) => String(f.name || '')))
  let i = 1
  while (used.has(`人脸 ${i}`)) i += 1
  return `人脸 ${i}`
}

/**
 * 录入一张人脸。
 * @param {Float32Array|number[]} vector 已归一化的特征向量
 * @param {string} thumb 缩略图 dataURL
 * @param {string} [name] 留空则自动编号
 * @param {number} [max] 上限
 * @returns {Promise<{ok:boolean, id?:number, name?:string, reason?:string}>}
 */
export function addFace(vector, thumb, name, max = DEFAULT_FACE_MAX) {
  return runExclusive(async () => {
    if (!vector || !vector.length) return { ok: false, reason: '人脸特征为空' }
    const list = await getAllFaces()
    const cap = Math.max(1, Number(max) || DEFAULT_FACE_MAX)
    if (list.length >= cap) {
      return { ok: false, reason: `人脸库已满（上限 ${cap} 人），请先删除不再需要的人脸` }
    }
    const finalName = (name && String(name).trim()) || nextFaceName(list)
    const now = Date.now()
    const os = await store('readwrite')
    const record = {
      name: finalName,
      // 统一转成普通数组存：TypedArray 在部分老 WebView 的 IndexedDB 里克隆不可靠
      vector: Array.from(vector),
      thumb: thumb || '',
      createdAt: now,
      updatedAt: now,
      samples: 1
    }
    const id = await reqAsPromise(os.add(record))
    await refreshFaces()
    return { ok: true, id, name: finalName }
  })
}

/** 改名 */
export function renameFace(id, name) {
  return runExclusive(async () => {
    const os = await store('readwrite')
    const cur = await reqAsPromise(os.get(id))
    if (!cur) return { ok: false, reason: '该人脸不存在' }
    cur.name = String(name || '').trim() || cur.name
    cur.updatedAt = Date.now()
    await reqAsPromise(os.put(cur))
    await refreshFaces()
    return { ok: true, name: cur.name }
  })
}

export function deleteFace(id) {
  return runExclusive(async () => {
    const os = await store('readwrite')
    await reqAsPromise(os.delete(id))
    await refreshFaces()
    return { ok: true }
  })
}

export function clearFaces() {
  return runExclusive(async () => {
    const os = await store('readwrite')
    await reqAsPromise(os.clear())
    await refreshFaces()
    return { ok: true }
  })
}

/**
 * 用一整份人脸库**整体替换**本地库 —— 给「从后端拉取配置」用。
 *
 * 与后端 face-lib.mjs 的 replaceAll 对称：**整体替换**（不是合并）、
 * 没有向量的记录直接跳过（正是为了不让"半条记录"混进底库）。
 * 两端的语义必须一致，否则"拉回来的人数"和"后端认识的人数"会对不上。
 *
 * ----------------------------------------------------------------------------
 * ⚠️ **空数组不许清掉非空底库**（除非显式 force）。
 *
 * 起因是一次真事故：后端那份底库是空的（比如它被人推空过 / 从来没人推上去过），
 * 本机 IndexedDB 里明明有 3 个人，用户在设置页点了一下「从后端拉取」——
 * 一份 `faces: []` 就把本机底库整体清掉，而且**不报任何错**：
 * 界面上只会看到"人脸库（0 / 50）"，推送里从此全是"未录入"。
 * 「拉取」这个动作的语义是"以后端为准"，但"以后端为准"不该把**空的**一份
 * 当成有效的覆盖源 —— 那更可能是后端那边出了问题，而不是用户真想清空。
 *
 * 守卫只放在这**一个收口处**（而不是每个调用点各判一次）：调用点有三处
 * （自动接管 / 手动拉取 / 设置页按钮），各判一次迟早漏一处，而且三处判据会漂。
 * 真要从后端清空本机底库，走设置页那个「清空人脸库」按钮（clearFaces），
 * 或显式传 { force: true }。
 *
 * @param {Array<{name:string, vector:number[], thumb?:string, createdAt?:number}>} list
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{ok:true, count:number, skipped?:boolean}>} count = 替换后的人数
 */
export function replaceFaces(list, { force = false } = {}) {
  return runExclusive(async () => {
    const items = (Array.isArray(list) ? list : []).filter(
      (f) => f && f.name && Array.isArray(f.vector) && f.vector.length
    )
    const db = await openDB()
    if (!force && items.length === 0) {
      // 先看一眼本机还有没有人：有就**什么都不做**（连 clear 都不发）
      const cur = await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_STORE_NAME, 'readonly')
        const req = tx.objectStore(FACE_STORE_NAME).count()
        req.onsuccess = () => resolve(Number(req.result) || 0)
        req.onerror = () => reject(req.error)
      })
      if (cur > 0) {
        console.warn(`👤 收到一份空的人脸库，本机已有 ${cur} 人 —— 已忽略（不清空底库）`)
        await refreshFaces()
        return { ok: true, count: cur, skipped: true }
      }
    }
    await new Promise((resolve, reject) => {
      // 清空 + 批量写入放在**同一个事务**里：中途失败要么全成要么全不成，
      // 不会出现"旧的清掉了、新的没写进去"（那等于把底库弄丢了）
      const tx = db.transaction(FACE_STORE_NAME, 'readwrite')
      const os = tx.objectStore(FACE_STORE_NAME)
      os.clear()
      const now = Date.now()
      items.forEach((f) => {
        os.add({
          name: String(f.name),
          // 统一转普通数组：TypedArray 在部分老 WebView 的 IndexedDB 里克隆不可靠
          vector: Array.from(f.vector),
          thumb: f.thumb || '',
          createdAt: Number(f.createdAt) || now,
          updatedAt: Number(f.updatedAt) || now,
          samples: Number(f.samples) || 1
        })
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    await refreshFaces()
    return { ok: true, count: items.length }
  })
}

/**
 * 用新样本增强某个人的特征。
 * 做法：向量按样本数做增量平均再重新归一化——比只留第一张稳，
 * 又不需要长期保存全部历史样本。
 */
export function mergeFace(id, vector, thumb) {
  return runExclusive(async () => {
    if (!vector || !vector.length) return { ok: false, reason: '人脸特征为空' }
    const os = await store('readwrite')
    const cur = await reqAsPromise(os.get(id))
    if (!cur) return { ok: false, reason: '该人脸不存在' }
    const old = Array.isArray(cur.vector) ? cur.vector : []
    const n = Math.max(1, Number(cur.samples) || 1)
    const merged = new Array(vector.length)
    for (let i = 0; i < vector.length; i++) {
      merged[i] = ((old[i] || 0) * n + vector[i]) / (n + 1)
    }
    // 重新归一化，保持「余弦相似度 = 点积」的前提
    let s = 0
    for (let i = 0; i < merged.length; i++) s += merged[i] * merged[i]
    s = Math.sqrt(s) || 1
    for (let i = 0; i < merged.length; i++) merged[i] /= s

    cur.vector = merged
    cur.samples = n + 1
    cur.updatedAt = Date.now()
    if (thumb) cur.thumb = thumb
    await reqAsPromise(os.put(cur))
    await refreshFaces()
    return { ok: true }
  })
}

/**
 * 在人脸库里找最像的人。
 * @param {Float32Array|number[]} vector 已归一化
 * @param {number} [threshold] 相似度阈值
 * @returns {Promise<{face:object, score:number}|null>}
 */
export async function matchFace(vector, threshold = DEFAULT_FACE_THRESHOLD) {
  if (!vector || !vector.length) return null
  const list = await getAllFaces()
  if (!list.length) return null
  const q = vector instanceof Float32Array ? vector : Float32Array.from(vector)
  let best = null
  for (const f of list) {
    if (!f.vector || f.vector.length !== q.length) continue
    const s = cosine(q, f.vector)
    if (!best || s > best.score) best = { face: f, score: s }
  }
  if (!best) return null
  return best.score >= threshold ? best : { face: best.face, score: best.score, miss: true }
}

/* ==================== 待录入人脸（采集暂存） ==================== */
/**
 * 检测到、但还没入库的人脸，先暂存在内存里供用户在设置页一键录入。
 * 只留最近若干张，且**不持久化**——人脸是实时场景，重启后旧面孔意义不大，
 * 存进库反而占空间。
 */
export const pendingFaces = ref([])
const PENDING_MAX = 24

/** 粗略判断是不是同一张脸（避免同一个人每隔 5 秒就塞一张进来） */
function looksSame(a, b) {
  if (!a.thumb || !b.thumb) return false
  if (!a.vector || !b.vector) return false
  return cosineOrRaw(a.vector, b.vector) > 0.5
}

function cosineOrRaw(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * 暂存一张未录入的人脸。
 * @returns {{added:boolean, id?:number}}
 */
export function pushPendingFace({ vector, thumb, at, camId, camName }) {
  if (!vector || !vector.length || !thumb) return { added: false }
  const list = pendingFaces.value
  // 和已有暂存项太像就只刷新时间，不再重复堆一张
  for (const it of list) {
    if (looksSame(it, { vector, thumb })) {
      it.at = at || Date.now()
      it.camName = camName || it.camName
      it.hits = (it.hits || 1) + 1
      return { added: false, id: it.id }
    }
  }
  const id = (list[0] ? list[0].id : 0) + 1
  list.unshift({
    id,
    vector: Float32Array.from(vector),
    thumb,
    at: at || Date.now(),
    camId: camId || '',
    camName: camName || '',
    hits: 1
  })
  if (list.length > PENDING_MAX) list.splice(PENDING_MAX)
  return { added: true, id }
}

export function removePendingFace(id) {
  pendingFaces.value = pendingFaces.value.filter((f) => f.id !== id)
}

export function clearPendingFaces() {
  pendingFaces.value = []
}

/* ==================== 后端待录入队列（headless 模式） ====================
 *
 * ⚠️ 为什么需要这一份：开了「后端检测服务」后，**跑检测的是后端**，
 * 它抓到未录入的人脸写进**自己的 SQLite**（GET /api/pending-faces）；
 * 而上面那个 pendingFaces 只是前端自己检测时的内存暂存，后端模式下永远是空的。
 * 结果就是「抓到的人脸进不了人脸库」—— 设置页里「待录入」列表一直空白，
 * 压根没东西可点「录入」。
 *
 * 这里把后端队列取回来单独存一份（带 fromBackend 标记），
 * 由设置页在录入 / 忽略后回后端删掉对应那条。
 */
export const backendPendingFaces = ref([])

function normBackendPending(base, list) {
  return (Array.isArray(list) ? list : [])
    .filter((f) => f && f.id)
    .map((f) => ({
      id: `b${f.id}`, // 加前缀，避免与前端内存队列的数字 id 撞号
      backendId: Number(f.id),
      vector: f.vector, // 后端返回的就是普通数组，addFace 直接收
      thumb: f.thumb || '',
      at: Number(f.at) || Date.now(),
      camId: f.camId || '',
      camName: f.camName || '',
      hits: 1,
      fromBackend: true
    }))
}

/** 拉一次后端待录入队列 */
export async function loadBackendPendingFaces(url) {
  const base = String(url || '').replace(/\/+$/, '')
  if (!base) {
    backendPendingFaces.value = []
    return []
  }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    let res
    try {
      res = await fetch(`${base}/api/pending-faces?limit=50`, { signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    backendPendingFaces.value = normBackendPending(base, data && data.faces)
    return backendPendingFaces.value
  } catch (e) {
    backendPendingFaces.value = []
    return []
  }
}

/** 从后端队列里删掉一条（录入或忽略之后调用，否则刷新又冒出来） */
export async function dropBackendPendingFace(url, backendId) {
  const base = String(url || '').replace(/\/+$/, '')
  backendPendingFaces.value = backendPendingFaces.value.filter((f) => f.backendId !== Number(backendId))
  if (!base) return
  try {
    await fetch(`${base}/api/pending-face?id=${encodeURIComponent(backendId)}`)
  } catch (e) {
    /* 删不掉也只是下次又出现，不影响已录入的人脸 */
  }
}
