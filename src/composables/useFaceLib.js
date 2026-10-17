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
import { DB_NAME, DB_VERSION, FACE_STORE_NAME, FACE_SPLIT_STORE } from './useEventStore.js'
import { normalizeFaceSplits } from '../config/defaults.js'
import {
  cosine,
  loadModel,
  isSlotReady,
  detectFaces,
  alignFace,
  faceEmbedding,
  faceThumb
} from './useAiDetector.js'
import { netErrorText, timeoutReason } from './useNet.js'
import { cosineOrRaw, looksSame } from './vecMatch.js'

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

/**
 * 「待录入人脸」那一块展开着吗。默认**收起**，与 faceLibOpen 对称。
 *
 * 同样刻意放在模块级（理由见 faceLibOpen 上面那段）。
 * 默认收起是因为待录入常常十几二十张，一打开设置就把它全部铺开，
 * 会把整页配置项顶到下面去；想看的人自己点一下「管理」。
 * 收起时标题行仍然带着数量（待录入人脸（N）），不会让人误以为"没有"。
 */
export const pendingLibOpen = ref(false)

/** 简单互斥，避免并发写坏自增 id */
let writeChain = Promise.resolve()

/* ==================== 人脸库专用 IndexedDB 连接 ====================
 * 为什么不复用 useEventStore 那个共享连接：
 *   人脸写与「事件记录」写**共用同一个连接**时，同一连接上的事务是**串行**的。
 *   检测器实时跑、每有报警就往同一个库写截图，人脸写要排在事件写后面 → 拥堵；
 *   更糟的是**死事务级联**：某次人脸写卡死（请求永远不回）时，看门狗虽拒绝了这次
 *   操作，但那条卡死的事务仍挂在连接上，后续每次人脸写都排在它后面 → 一起卡 15s。
 *
 *   单独开一个**同库不同连接**（IndexedDB 的事务只在**连接内**串行，跨连接可并行）：
 *   · 人脸写不再被事件写堵住 —— 正好落实「优先录入、其余写入暂缓」；
 *   · 写超时时只重置这一个人脸连接，死事务随连接关闭而消亡，不影响事件写。
 */
let faceDbPromise = null

/** 关掉并丢弃人脸连接（写超时兜底 / 需要重开时用）。下一次调用会重新 open。 */
export function resetFaceDB() {
  const p = faceDbPromise
  faceDbPromise = null
  if (p) {
    Promise.resolve(p)
      .then((db) => {
        try {
          db.close()
        } catch (e) {}
      })
      .catch(() => {})
  }
}

/** 人脸库专用连接（与事件连接隔离）。语义与 useEventStore.openDB 一致：**绝不永久 pending**。 */
function openFaceDB() {
  if (faceDbPromise) return faceDbPromise
  faceDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    let settled = false
    let timer = null
    const fail = (msg) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      faceDbPromise = null
      reject(msg instanceof Error ? msg : new Error(msg))
    }
    timer = setTimeout(() => fail('打开本地人脸数据库超时（10s），请关闭本应用的其它标签页后重试'), 10000)

    const req = indexedDB.open(DB_NAME, DB_VERSION)
    /*
     * 建库：人脸连接与事件连接**同库同版本**，谁先 open 谁触发这一次的
     * onupgradeneeded，所以这里把**两张表都补齐**（幂等）——
     * 避免"人脸连接恰好先开 → events 表漏建"。
     */
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(FACE_STORE_NAME)) {
        const fs = db.createObjectStore(FACE_STORE_NAME, { keyPath: 'id', autoIncrement: true })
        fs.createIndex('createdAt', 'createdAt')
      }
      if (!db.objectStoreNames.contains('events')) {
        const os = db.createObjectStore('events', { keyPath: 'key' })
        os.createIndex('time', 'time')
      }
      /*
       * 手动拆分声明表（版本 3 新增）。这里也必须幂等补建：
       * 同一升级窗口里谁先 open 谁触发 onupgradeneeded，漏建这张表 →
       * 后面所有拆分读写都是 NotFoundError。
       */
      if (!db.objectStoreNames.contains(FACE_SPLIT_STORE)) {
        db.createObjectStore(FACE_SPLIT_STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onblocked = () => fail(new Error('本地人脸数据库正被本应用的其它标签页占用，请关掉其它标签页后重试'))
    req.onsuccess = () => {
      if (settled) {
        try {
          req.result.close()
        } catch (e) {}
        return
      }
      settled = true
      if (timer) clearTimeout(timer)
      resolve(req.result)
    }
    req.onerror = () => fail('打开本地人脸数据库失败：' + ((req.error && req.error.message) || req.error || '未知原因'))
  })
  return faceDbPromise
}

/**
 * 单次写操作的看门狗上限（毫秒）。
 *
 * ⚠️ 为什么需要它：这些操作是**串行排队**的（runExclusive），队头卡住 = 后面全卡住。
 *    真实的卡法有两种，一种在 openDB（数据库被别的标签页阻塞，见那边说明），
 *    另一种是**某一次 get/put 的请求永远不回**（浏览器实现异常 / 事务被挂起）——
 *    这时 fn 的 Promise 永远不落地，writeChain 就永久堵死：
 *    「点改名没反应、点删除没反应、录入也没反应」，且**一条错误都不报**。
 *    对一个本地 IndexedDB 写操作来说，15 秒还没回来只可能是卡死了。
 *
 * 超时后**拒绝**这次操作（而不是一直等）：队列是 `writeChain.then(run, run)`，
 * 拒绝也会让后面的操作照常跑 —— 于是一次卡死退化成"这一下失败并弹窗"，
 * 而不是"整个人脸库从此不动"。真出错时用户至少看得见、能重试。
 */
const WRITE_TIMEOUT_MS = 15000

function withWatchdog(fn) {
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      /*
       * 超时 = 这次写真的卡死了。**先把人脸连接重置掉**再报错：
       * 卡死的那条事务还挂在连接上，不重置的话后续每次人脸写都排在它后面 →
       * 从"一下失败"退化成"整个脸库从此不动"（用户侧表现为"经常报 15s 超时"）。
       * 重置只关人脸连接，不影响事件写（那是另一个连接）。
       */
      resetFaceDB()
      reject(new Error(`本地数据库写入超时（${WRITE_TIMEOUT_MS / 1000}s）：请关闭本应用的其它标签页后重试`))
    }, WRITE_TIMEOUT_MS)
    // Node（探针）里别为它吊住事件循环；浏览器返回数字，没有 unref
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve().then(fn), guard]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function runExclusive(fn) {
  const run = () => withWatchdog(fn)
  const next = writeChain.then(run, run)
  writeChain = next.catch(() => {})
  return next
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function store(mode, name = FACE_STORE_NAME) {
  const db = await openFaceDB()
  return db.transaction(name, mode).objectStore(name)
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
  rawRows = all
  faces.value = all.map((f) => ({
    id: f.id,
    name: f.name,
    thumb: f.thumb || '',
    createdAt: f.createdAt || 0,
    updatedAt: f.updatedAt || 0,
    samples: f.samples || 1
  }))
  faceRowsVersion.value += 1
  facesReady.value = true
  /*
   * 拆分声明跟着人脸库一起刷：两边同温，设置页的归类 computed 与识别路径
   * （matchFaceGroup 同步读缓存）拿到的才是同一份。失败不波及人脸列表本身。
   */
  try {
    await refreshFaceSplits()
  } catch (e) {
    /* 拆分缓存刷不出来只是"拆分暂不生效"，人脸库照常可用 */
  }
  return faces.value
}

/**
 * 完整记录（**含向量**）的非响应式暂存，只给「同一个人归类」用。
 *
 * ⚠️ 刻意**不进响应式**：向量是 512 个浮点 × 人数，塞进 ref 会被 Vue 逐层包代理，
 *    白花性能（归类只需要读，不需要它响应式）。要响应式的只有"库变了"这个信号，
 *    那就是下面的 faceRowsVersion。
 */
let rawRows = []

/** 每次 refreshFaces 自增 —— 让外部（设置页）的归类 computed 知道该重算了 */
export const faceRowsVersion = ref(0)

/** 取上面那份完整记录的快照（含向量），调用方只读、别改 */
export function rawFaceRows() {
  return rawRows
}

/* ==================== 手动拆分声明（「这两个不是同一人」） ====================
 *
 * 为什么需要它：归类判据是「同名 ∨ 相似度 ≥ 阈值」—— 两个长得像的不同人会被并成
 * 一张卡，推送也各按各的名字。用户需要一条**显式声明**把两者永久分开：
 * 相似度是概率，用户的"这是两个人"是确定事实，确定事实必须能压过概率判据。
 *
 * 存哪：IndexedDB 的 face-splits 表（与人脸库同生共死；放 localStorage 会被
 * 单独清掉，届时拆分静默失效、两人又合回去，且没有任何提示）。
 * 一条声明 = 两个「侧」，每侧记 id + 名字（理由见 defaults.normalizeFaceSplits）：
 *   · id 对   挡住「改过名」的样本对（黎→老黎后依然分开）；
 *   · 名字对  挡住「之后新录入」的同名样本（id 对覆盖不到新样本）。
 */

/** 拆分声明缓存（非响应式，与 rawRows 同模式）：同步读取用 */
let splitCache = []

/** 每次 refreshFaceSplits 自增 —— 让设置页的归类 / 拆分列表 computed 知道该重算了 */
export const faceSplitsVersion = ref(0)

/** 取当前拆分声明快照（同步；调用方只读） */
export function currentSplits() {
  return splitCache
}

/** 读全量拆分声明（含历史记录字段），按写入顺序 */
export async function getAllFaceSplits() {
  try {
    const os = await store('readonly', FACE_SPLIT_STORE)
    const all = await reqAsPromise(os.getAll())
    return (all || []).sort((a, b) => (a.id || 0) - (b.id || 0))
  } catch (e) {
    // 老库还没升级（表不存在）等情形：当没有拆分，绝不能让调用方炸掉
    return []
  }
}

/**
 * 刷新拆分缓存（人脸库每次 refresh 都跟着刷一次，保证两边同温）。
 * 顺带做**惰性清理**：两侧样本都已不在、两个名字也都不在库里的声明已经不可能
 * 命中任何比对，删掉以免无限堆积。
 * ⚠️ 只有在 rawRows 非空时才清理：底库还没加载完时 rawRows 是空的，
 *     那时清理会把所有声明误杀。
 */
export async function refreshFaceSplits() {
  let list = await getAllFaceSplits()
  try {
    if (rawRows.length && list.length) {
      const ids = new Set(rawRows.map((r) => r.id))
      const names = new Set(rawRows.map((r) => String(r.name || '').trim()).filter(Boolean))
      const alive = list.filter(
        (s) => ids.has(s.aId) || ids.has(s.bId) || (s.aName && names.has(s.aName)) || (s.bName && names.has(s.bName))
      )
      if (alive.length !== list.length) {
        const db = await openFaceDB()
        await new Promise((resolve, reject) => {
          const tx = db.transaction(FACE_SPLIT_STORE, 'readwrite')
          const os = tx.objectStore(FACE_SPLIT_STORE)
          for (const s of list) {
            if (!alive.includes(s)) os.delete(s.id)
          }
          tx.oncomplete = () => resolve(true)
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error || new Error('拆分声明清理事务被中止'))
        })
        list = alive
      }
    }
  } catch (e) {
    /* 清理失败不碍事：下次刷新还会试 */
  }
  splitCache = list
  faceSplitsVersion.value += 1
  return list
}

/**
 * 新增拆分声明（已存在的同 id 对 + 同名字对跳过，不会重复堆）。
 * @param {Array<{aId?,aName?,bId?,bName?}>} pairs 每个元素是一「对」两侧
 * @returns {Promise<{ok:boolean, added:number, reason?:string}>}
 */
export function addFaceSplits(pairs) {
  return runExclusive(async () => {
    const want = normalizeFaceSplits(pairs)
    if (!want.length) return { ok: false, reason: '没有要拆分的对象' }
    const exist = await getAllFaceSplits()
    const seen = new Set(exist.map((s) => `${s.aId}|${s.bId}|${s.aName}|${s.bName}`))
    const fresh = want.filter((w) => !seen.has(`${w.aId}|${w.bId}|${w.aName}|${w.bName}`))
    if (!fresh.length) return { ok: true, added: 0 }
    const db = await openFaceDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FACE_SPLIT_STORE, 'readwrite')
      const os = tx.objectStore(FACE_SPLIT_STORE)
      const now = Date.now()
      for (const w of fresh) os.add({ ...w, createdAt: now })
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('拆分声明写入事务被中止'))
    })
    await refreshFaceSplits()
    return { ok: true, added: fresh.length }
  })
}

/** 解除一条拆分声明（之后恢复自动归类：相似度仍会把他们并回去） */
export function removeFaceSplit(id) {
  return runExclusive(async () => {
    const db = await openFaceDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FACE_SPLIT_STORE, 'readwrite')
      tx.objectStore(FACE_SPLIT_STORE).delete(id)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('拆分声明删除事务被中止'))
    })
    await refreshFaceSplits()
    return { ok: true }
  })
}

/**
 * 用一份声明**整体替换**本机的（从后端拉取配置时用，以后端为准）。
 * 与 replaceFaces 同理：明确送来数组才替换；送空数组 = 用户/后端确实没有拆分。
 */
export function replaceFaceSplits(list) {
  return runExclusive(async () => {
    const want = normalizeFaceSplits(list)
    const db = await openFaceDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FACE_SPLIT_STORE, 'readwrite')
      const os = tx.objectStore(FACE_SPLIT_STORE)
      os.clear()
      const now = Date.now()
      for (const w of want) os.add({ ...w, createdAt: now })
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('拆分声明替换事务被中止'))
    })
    await refreshFaceSplits()
    return { ok: true, count: want.length }
  })
}

/**
 * 改名之后维护拆分声明（renameFaces 内部调用，别处不需要）。
 *
 * 规则只有一条，但必须严：**两侧名字被改成一样了 = 用户已经把这两人统一了，
 * 声明自动退休**（否则「归入到…」「改名统一」会被旧的拆分挡着，表现为
 * "点了归入没反应"）。名字仍不同 → 只更新记录里的名字，id 对继续兜底。
 *
 * @param {number[]} ids 被改过名的样本 id
 */
async function maintainSplitsAfterRename(ids) {
  const touched = new Set((Array.isArray(ids) ? ids : []).map((x) => Number(x)).filter((x) => x > 0))
  if (!touched.size) return
  const list = await getAllFaceSplits()
  const involved = list.filter((s) => touched.has(Number(s.aId)) || touched.has(Number(s.bId)))
  if (!involved.length) return
  // 改名后的当前名字（直接从库里读，别信调用方传的旧值）
  const db = await openFaceDB()
  const nameOf = async (id) => {
    if (!id) return ''
    const rec = await reqAsPromise(db.transaction(FACE_STORE_NAME, 'readonly').objectStore(FACE_STORE_NAME).get(id))
    return rec ? String(rec.name || '').trim() : ''
  }
  const names = new Map()
  for (const s of involved) {
    for (const id of [s.aId, s.bId]) {
      if (id && !names.has(id)) names.set(id, await nameOf(id))
    }
  }
  const retire = [] // 两侧同名 → 退休
  const update = [] // 名字变了 → 同步记录
  for (const s of involved) {
    const a = names.get(s.aId)
    const b = names.get(s.bId)
    const na = a === undefined ? s.aName : a
    const nb = b === undefined ? s.bName : b
    if (na && nb && na === nb) {
      retire.push(s.id)
    } else if (na !== s.aName || nb !== s.bName) {
      update.push({ ...s, aName: na, bName: nb })
    }
  }
  if (!retire.length && !update.length) return
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FACE_SPLIT_STORE, 'readwrite')
    const os = tx.objectStore(FACE_SPLIT_STORE)
    for (const id of retire) os.delete(id)
    for (const s of update) os.put(s)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('拆分声明维护事务被中止'))
  })
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

/**
 * 改名（**一批**记录改成同一个名字）。
 *
 * 为什么要批量：人脸库现在按「人」显示 —— 同一人的多角度样本归到一张卡片上，
 * 卡片上的「改名」当然是改**这个人**的名字，而不是改其中某一条。留一张对不上名字的
 * 在库里，卡片分组会立刻散开（同名归类的判据就是名字），用户会觉得"改了没用"。
 *
 * 一条记录也走这里（renameFace 已并入），避免单条 / 批量两套实现漂移。
 *
 * @param {number[]} ids
 * @param {string} name 空白视为放弃（不写库，返回 ok:false 让界面提示）
 * @returns {Promise<{ok:boolean, name?:string, count?:number, reason?:string}>}
 */
export function renameFaces(ids, name) {
  return runExclusive(async () => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null)
    const finalName = String(name == null ? '' : name).trim()
    if (!list.length) return { ok: false, reason: '没有要改名的记录' }
    if (!finalName) return { ok: false, reason: '名字不能为空' }
    const db = await openFaceDB()
    await new Promise((resolve, reject) => {
      // 同一事务里改完：要么全改要么全不改（否则会出现"同一个人一半新名字一半旧名字"）
      const tx = db.transaction(FACE_STORE_NAME, 'readwrite')
      const os = tx.objectStore(FACE_STORE_NAME)
      const now = Date.now()
      let hit = 0
      list.forEach((id) => {
        const g = os.get(id)
        g.onsuccess = () => {
          const cur = g.result
          if (!cur) return
          hit += 1
          cur.name = finalName
          cur.updatedAt = now
          os.put(cur)
        }
      })
      tx.oncomplete = () => resolve(hit)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('改名事务被中止'))
    })
    /*
     * 先维护拆分声明再刷缓存：两侧被改名成同一个名字 = 用户已把两人统一，
     * 声明必须在这里退休（否则归入/改名统一会被旧拆分挡着，见该函数说明）。
     */
    await maintainSplitsAfterRename(list)
    await refreshFaces()
    return { ok: true, name: finalName, count: list.length }
  })
}

/** 改名（单条）—— 与 renameFaces 同一实现，只是包一层，别再写第二套 */
export function renameFace(id, name) {
  return renameFaces([id], name)
}

/**
 * 删除（**一批**记录）。
 * 一张卡片 = 一个人（可能含多个角度样本），卡片上的「删除」就是删这个人，
 * 所以必须支持批量；单条删除（样本人脸墙里删一张）也走这里。
 */
export function deleteFaces(ids) {
  return runExclusive(async () => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null)
    if (!list.length) return { ok: false, reason: '没有要删除的记录' }
    const db = await openFaceDB()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FACE_STORE_NAME, 'readwrite')
      const os = tx.objectStore(FACE_STORE_NAME)
      list.forEach((id) => os.delete(id))
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('删除事务被中止'))
    })
    await refreshFaces()
    return { ok: true, count: list.length }
  })
}

export function deleteFace(id) {
  return deleteFaces([id])
}

/**
 * 把多条记录的特征按**样本数加权**平均，再重新归一化。
 *
 * 纯函数（不碰 IndexedDB），所以"合并出来的特征对不对"能被穷举测试 ——
 * 合并是这个功能里唯一会**改变识别结果**的动作，算错了表现为"合并之后谁都认不出来"，
 * 而且不报错，只能靠测试守住。
 *
 * 为什么按样本数加权而不是简单平均：`samples` 记录这条特征是由几次抓取平均出来的，
 * 样本多的那条本来就更稳，不该和刚录的一条等权。
 * 为什么必须重新归一化：归一化向量加权平均后长度 < 1，而"余弦相似度 = 点积"
 * 这个前提依赖单位长度（见 vecMatch.js），不归一化会让相似度整体偏小、识别变差。
 *
 * @param {Array<{vector:number[], samples?:number}>} recs
 * @returns {{vector:number[], weight:number}|null} 没有可用向量时返回 null
 */
export function averageVectors(recs) {
  const list = (Array.isArray(recs) ? recs : []).filter((r) => r && Array.isArray(r.vector) && r.vector.length)
  if (!list.length) return null
  // 维度以第一条为准：混进维度不同的老数据时跳过它，而不是产出 NaN 向量
  const dim = list[0].vector.length
  const sum = new Float64Array(dim)
  let weight = 0
  for (const r of list) {
    if (r.vector.length !== dim) continue
    const w = Math.max(1, Number(r.samples) || 1)
    for (let i = 0; i < dim; i++) sum[i] += (Number(r.vector[i]) || 0) * w
    weight += w
  }
  if (!weight) return null
  let norm = 0
  for (let i = 0; i < dim; i++) norm += sum[i] * sum[i]
  norm = Math.sqrt(norm) || 1
  const vector = new Array(dim)
  for (let i = 0; i < dim; i++) vector[i] = sum[i] / norm
  return { vector, weight }
}

/**
 * 把同一个人的多条记录**合并成一条**（收纳）。
 *
 * 做法：把参与合并的各条向量按样本数加权平均（averageVectors），
 * 写回 `keepId` 那条，其余删掉 —— 与 mergeFace（增量平均）语义一致，
 * 只是这里一次算完，不会出现"合并到一半"的中间态。
 *
 * 为什么值得做：同一人拆成多条时，每条只覆盖一个角度，识别时容易漏
 * （某个角度谁都对不上）；合并后特征覆盖更全、也更省人脸库名额。
 *
 * @param {number[]} ids 参与合并的全部记录 id（含 keepId）
 * @param {number} [keepId] 保留哪一条（不传就用第一条）
 * @returns {Promise<{ok:boolean, id?:number, samples?:number, count?:number, reason?:string}>}
 */
export function mergeFaces(ids, keepId) {
  return runExclusive(async () => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null)
    if (list.length < 2) return { ok: false, reason: '至少需要两条记录才能合并' }
    const db = await openFaceDB()
    const recs = await new Promise((resolve, reject) => {
      const tx = db.transaction(FACE_STORE_NAME, 'readonly')
      const os = tx.objectStore(FACE_STORE_NAME)
      const out = []
      list.forEach((id) => {
        const g = os.get(id)
        g.onsuccess = () => {
          if (g.result) out.push(g.result)
        }
      })
      tx.oncomplete = () => resolve(out)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('读取人脸记录被中止'))
    })
    if (recs.length < 2) return { ok: false, reason: '至少需要两条记录才能合并' }
    const keep = recs.find((r) => r.id === keepId) || recs[0]
    const avg = averageVectors(recs)
    if (!avg) return { ok: false, reason: '这些记录都没有可用的特征向量' }

    const now = Date.now()
    keep.vector = avg.vector
    keep.samples = avg.weight
    keep.updatedAt = now
    // 创建时间取最早那条：卡片排序沿用"这个人第一次出现的时间"，合并后不会乱跳
    keep.createdAt = Math.min(...recs.map((r) => Number(r.createdAt) || now))
    // 缩略图沿用保留那条（不另造）：它是这人最早录入的那张，风格与其它卡片一致
    await new Promise((resolve, reject) => {
      const tx = db.transaction(FACE_STORE_NAME, 'readwrite')
      const os = tx.objectStore(FACE_STORE_NAME)
      os.put(keep)
      recs.forEach((r) => {
        if (r.id !== keep.id) os.delete(r.id)
      })
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || new Error('合并事务被中止'))
    })
    await refreshFaces()
    return { ok: true, id: keep.id, samples: avg.weight, count: recs.length }
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
    const db = await openFaceDB()
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

/* ==================== 同一个人：把多角度样本归类成一「人」 ====================
 *
 * 用户在设置页看到的问题是：同一个人被拍了好几次（正面 / 侧面 / 低头），
 * 每一次都占一张卡片、还各自顶着「人脸 7」「人脸 12」这种自动编号 ——
 * 库里看着像十几个人，而**推送里也会按命中的那一条各叫各的名字**。
 *
 * 归类的意义不只是"看起来整齐"，而是让同一个人**只有一个名字**：
 * 只要归到一张卡片上，卡片上的改名就会应用到该人的全部样本，
 * 于是无论哪个角度被拍到、命中哪一条记录，推送里都是同一个名字。
 *
 * 判据两条，都不另立一套：
 *   ① 名字相同 → 同一个人。名字是用户自己起的，这是**确定**的判据。
 *   ② 相似度 ≥ 识别阈值 → 同一个人。用的就是设置页那个「识别阈值」旋钮
 *      （`options.face.matchThreshold`，默认 0.38）——「系统认为这是同一个人」
 *      在识别与归类两处必须是同一份判定，否则会出现"推送说认出来了、
 *      库里却分成两个人"这种自相矛盾。
 *
 * 刻意**不改数据**：归类只影响显示。要不要把它们真的合成一条（合并特征）
 * 由用户在卡片上点「合并为一条」决定 —— 相似度是概率，不该由界面替用户落锤。
 */

/** 归类默认阈值 = 识别默认阈值（同一份常量；实际使用时会传设置页那个值进来） */
export const FACE_GROUP_THRESHOLD = DEFAULT_FACE_THRESHOLD

/** localStorage 键：是否按相似度把「同一个人」的多角度样本归到一张卡片。
 *  放在这里作为单一来源 —— 识别路径（useAiExtras）也要用它，
 *  才能和用户在人脸库看到的「归类」保持一致。 */
export const GROUP_SIM_KEY = 'monitor-wall-face-group-sim-v1'
/**
 * 读「是否按相似度归类」偏好。默认开 —— 同一个人只占一张卡片、只有一个名字。
 * 偏好存 localStorage：它属于"我想怎么看这份名单"，不该每次打开设置都被重置。
 * @returns {boolean}
 */
export function readGroupSim() {
  try {
    return localStorage.getItem(GROUP_SIM_KEY) !== '0'
  } catch (e) {
    return true
  }
}

/**
 * 在人脸库里找最像的人，并把命中的那条样本映射到它的「归类名称」。
 *
 * 为什么需要它：`matchFace` 返回的只是库里**某一条样本**（比如「人脸 12」），
 * 但用户已经在设置页把同一人的多角度样本并到一张卡片（归类）了，
 * 库里显示的是组代表样本的名字。识别路径若直接报 `hit.face.name`，
 * 就会出现"库里叫张三、推送/画面里叫人脸 12"这种自相矛盾。
 *
 * 本函数沿用与界面**完全相同**的归类判据（groupFaces：同名 → 同一人；
 * 相似度 ≥ 阈值 → 同一人），找到命中样本所在的组，回它的代表名，
 * 于是"归了类，归类下的就判断为同一人"——无论被拍到哪个角度、命中哪条样本，
 * 报出来的都是同一个归类名。
 *
 * @param {Float32Array|number[]} vector 已归一化
 * @param {{threshold?:number, bySimilarity?:boolean, splits?:Array}} [opts]
 *        threshold：识别/归类阈值（默认识别默认阈值）；
 *        bySimilarity：是否按相似度归类（与设置页「按相似度归类」开关一致）；
 *        splits：手动拆分声明；**不传则自动从库里读**（识别路径懒得每次显式传，
 *                但库里的声明必须生效，否则"库里分开了、推送还并着"）。
 * @returns {Promise<{face:object, score:number, groupName:string}|null>}
 *          miss 情形仍回 `{face,score,miss:true,groupName}`（groupName 回样本本名）。
 */
export async function matchFaceGroup(vector, { threshold = DEFAULT_FACE_THRESHOLD, bySimilarity = true, splits } = {}) {
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
  const hit = best.score >= threshold ? best : { face: best.face, score: best.score, miss: true }
  // 把命中的这条样本映射到它的「归类」（组代表样本的名字），
  // 让识别报告的名字与用户在人脸库看到的归类名一致。
  const splitList = Array.isArray(splits) ? splits : await getAllFaceSplits()
  const groups = groupFaces(list, { threshold, bySimilarity, splits: splitList })
  const g = groups.find((x) => x.items.some((it) => it.id === hit.face.id))
  const groupName = g ? g.name : hit.face.name
  return { ...hit, groupName }
}

/**
 * 把一份人脸记录归成「人」。
 *
 * 纯函数（不碰 IndexedDB / Vue），所以能被穷举测试。并查集合并，
 * 记录数上限本来就是 50，两两比一遍（≤1225 次 512 维点积）可忽略。
 *
 * @param {Array<{id:number,name:string,thumb?:string,createdAt?:number,updatedAt?:number,samples?:number,vector:number[]}>} rows
 * @param {{threshold?:number, bySimilarity?:boolean, splits?:Array}} [opts]
 *        threshold：相似度判据；bySimilarity=false 时只按同名的**确定**判据归类
 *        splits：手动拆分声明（「这两个不是同一人」，见 defaults.normalizeFaceSplits）。
 *                声明优先于一切自动判据 —— 任何会把声明两侧并进同一簇的合并都被拦下。
 * @returns {Array<{
 *   key:string, id:number, name:string, thumb:string, createdAt:number,
 *   count:number, sameName:boolean, names:string[], score:number,
 *   items:Array<{id:number,name:string,thumb:string,createdAt:number,samples:number,sim:number}>
 * }>}
 *   score：组内**最弱一环**的两两相似度（同名组恒为 1）。
 *          为什么要最弱一环而不是平均：并查集是链式合并的（A~B、B~C 都过阈值，
 *          但 A~C 可能没过），报平均值会把最松的那一环藏起来 —— 用户看着
 *          "平均 0.45 挺像"却不知道里面有一条只有 0.31。
 */
export function groupFaces(rows, { threshold = FACE_GROUP_THRESHOLD, bySimilarity = true, splits = [] } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id != null)
  const n = list.length
  const nameOf = (r) => String((r && r.name) || '').trim()
  const parent = new Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (x) => {
    let r = x
    while (parent[r] !== r) {
      parent[r] = parent[parent[r]]
      r = parent[r]
    }
    return r
  }
  /*
   * 每个簇当前拥有的「样本 id 集合 + 名字集合」—— 拆分闸门必须做**簇级**检查：
   * 只拦「这一对样本」不够，A~B 被拦下后，A~C~B 的链式合并会把拆开的两人又合回去，
   * 所以每次合并前看的是"并起来之后，簇里会不会同时出现某条声明的两侧"。
   */
  const clusterIds = new Array(n)
  const clusterNames = new Array(n)
  for (let i = 0; i < n; i++) {
    clusterIds[i] = new Set([list[i].id])
    const nm = nameOf(list[i])
    clusterNames[i] = new Set(nm ? [nm] : [])
  }
  /*
   * 声明拆成两张表：id 对 + 名字对，任一中招就拦。
   *   id 对   —— 改过名（黎→老黎）也拆着；
   *   名字对  —— 之后新录入的同名样本也自动受保护（id 对覆盖不到新样本）。
   * 两侧名字相同的声明无意义（同名本来就会并，且 renameFaces 会让它退休）。
   */
  const forbidIds = []
  const forbidNames = []
  for (const raw of Array.isArray(splits) ? splits : []) {
    if (!raw || typeof raw !== 'object') continue
    const aId = Number(raw.aId) || 0
    const bId = Number(raw.bId) || 0
    const aName = String(raw.aName || '').trim()
    const bName = String(raw.bName || '').trim()
    if (aId && bId && aId !== bId) forbidIds.push([aId, bId])
    if (aName && bName && aName !== bName) forbidNames.push([aName, bName])
  }
  const wouldSplit = (ra, rb) => {
    if (!forbidIds.length && !forbidNames.length) return false
    const ids = new Set([...clusterIds[ra], ...clusterIds[rb]])
    const names = new Set([...clusterNames[ra], ...clusterNames[rb]])
    for (const [a, b] of forbidIds) {
      if (ids.has(a) && ids.has(b)) return true
    }
    for (const [a, b] of forbidNames) {
      if (names.has(a) && names.has(b)) return true
    }
    return false
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    // 手动拆分优先：这一并不能把用户声明「不是同一人」的两侧并进同一簇
    if (wouldSplit(ra, rb)) return
    parent[Math.max(ra, rb)] = Math.min(ra, rb)
    const root = Math.min(ra, rb)
    clusterIds[root] = new Set([...clusterIds[ra], ...clusterIds[rb]])
    clusterNames[root] = new Set([...clusterNames[ra], ...clusterNames[rb]])
  }

  for (let i = 0; i < n; i++) {
    const ni = nameOf(list[i])
    for (let j = i + 1; j < n; j++) {
      if (ni && ni === nameOf(list[j])) {
        union(i, j)
        continue
      }
      if (!bySimilarity) continue
      if (cosineOrRaw(list[i].vector, list[j].vector) >= threshold) union(i, j)
    }
  }

  const buckets = new Map()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(i)
  }

  const groups = []
  for (const idxs of buckets.values()) {
    const recs = idxs.map((i) => list[i])
    // 代表样本 = 最早录入的那条（getAllFaces 本来就按 createdAt 升序）
    const rep = recs[0]
    const names = [...new Set(recs.map(nameOf))]
    const sameName = names.length === 1
    let score = 1
    if (!sameName) {
      // 最弱一环：组内任意两条之间的最小相似度
      for (let a = 0; a < recs.length; a++) {
        for (let b = a + 1; b < recs.length; b++) {
          const s = cosineOrRaw(recs[a].vector, recs[b].vector)
          if (s < score) score = s
        }
      }
    }
    groups.push({
      key: `g${rep.id}`,
      id: rep.id,
      name: rep.name,
      thumb: rep.thumb || '',
      createdAt: rep.createdAt || 0,
      count: recs.length,
      sameName,
      names,
      score,
      items: recs.map((it) => ({
        id: it.id,
        name: it.name,
        thumb: it.thumb || '',
        createdAt: it.createdAt || 0,
        samples: it.samples || 1,
        sim: it === rep ? 1 : cosineOrRaw(it.vector, rep.vector)
      }))
    })
  }
  // 按"这个人第一次出现的时间"排，顺序稳定（与录入顺序一致）
  groups.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
  return groups
}

/* ==================== 待录入人脸（采集暂存） ==================== */
/**
 * 检测到、但还没入库的人脸，先暂存在内存里供用户在设置页一键录入。
 * 只留最近若干张，且**不持久化**——人脸是实时场景，重启后旧面孔意义不大，
 * 存进库反而占空间。
 */
export const pendingFaces = ref([])
/**
 * 前端自己的待录入暂存上限。
 * ⚠️ 只在**纯前端模式**（没接后端）下有意义：后端模式下队列在后端 SQLite
 * （上限 `PENDING_KEEP`，见 server/analyzer.mjs），这里是空的。
 * 满库提醒的阈值要与它对齐 —— 见 App.vue 的 pendingFullWatcher。
 */
export const PENDING_MAX = 24

/** looksSame / cosineOrRaw 已抽到 vecMatch.js（前后端共用单一来源），这里不再重复定义 */

/**
 * 暂存一张未录入的人脸。
 * @param {object} o
 * @param {number} [o.max] 队列容量（来自 `options.face.pendingFullAt` 的解析值；
 *                         缺省回落到 PENDING_MAX，与升级前一致）
 * @returns {{added:boolean, id?:number}}
 */
export function pushPendingFace({ vector, thumb, full, at, camId, camName, max }) {
  if (!vector || !vector.length || !thumb) return { added: false }
  const list = pendingFaces.value
  // 和已有暂存项太像就只刷新时间，不再重复堆一张
  for (const it of list) {
    if (looksSame(it, { vector, thumb })) {
      it.at = at || Date.now()
      it.camName = camName || it.camName
      it.hits = (it.hits || 1) + 1
      // 同一张脸刷新时间，但「后来抓到的这帧」往往更清晰/更完整，顺手更新原图
      if (full) it.full = full
      return { added: false, id: it.id }
    }
  }
  const id = (list[0] ? list[0].id : 0) + 1
  list.unshift({
    id,
    vector: Float32Array.from(vector),
    thumb,
    full: full || '',
    at: at || Date.now(),
    camId: camId || '',
    camName: camName || '',
    hits: 1
  })
  const cap = Math.max(1, Math.round(Number(max) || PENDING_MAX))
  if (list.length > cap) list.splice(cap)
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
/**
 * 最近一次拉取后端队列的结论。
 *
 * ⚠️ 为什么必须把「拉取失败」单独立一个状态，而不是让它和「暂无待录入」共用空数组：
 *    设置页要能区分这两件事，否则拉挂掉时界面显示「暂无待录入人脸」，
 *    用户会以为"没人来过"（实际上是没连上）；反过来，后端真的没人时
 *    又会被当成"加载不出来"，于是反复点刷新。
 *
 * loadedAt 用来看"这份数据是什么时候的"：失败时列表**保留上一次**的内容，
 * 界面上得说清它有多旧。
 */
export const backendPendingError = ref('')
export const backendPendingLoadedAt = ref(0)

function normBackendPending(base, list) {
  return (Array.isArray(list) ? list : [])
    .filter((f) => f && f.id)
    .map((f) => ({
      id: `b${f.id}`, // 加前缀，避免与前端内存队列的数字 id 撞号
      backendId: Number(f.id),
      vector: f.vector, // 后端返回的就是普通数组，addFace 直接收
      thumb: f.thumb || '',
      full: f.full || '', // 后端抓到人脸时一并存的整帧原图（点缩略图看大图用）
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
    backendPendingError.value = ''
    backendPendingLoadedAt.value = 0
    return []
  }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('待录入队列', 8000)), 8000)
    let res
    try {
      res = await fetch(`${base}/api/pending-faces?limit=100`, { signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    backendPendingFaces.value = normBackendPending(base, data && data.faces)
    backendPendingError.value = ''
    backendPendingLoadedAt.value = Date.now()
    return backendPendingFaces.value
  } catch (e) {
    /*
     * ⚠️ 失败时**绝不清空**已拿到的那份列表（「空白」不许覆盖「非空」）。
     *   清掉的话，一次网络抖动就会让界面上「本来抓到的人脸」凭空消失，
     *   用户只会以为人脸白抓了 —— 而真正该告诉他的是"这次没拉上"。
     *   只有第一次（手上本来就没有数据）才落到空列表。
     */
    backendPendingError.value = netErrorText(e, '待录入队列')
    return backendPendingFaces.value
  }
}

/**
 * 从后端队列里删掉一条（录入或忽略之后调用，否则刷新又冒出来）。
 *
 * ⚠️ 必须带超时：调用方（设置页 doAddPending）是 `await` 它的，
 *    而后端地址可能是**打不通又不回 RST** 的那种（拔网线 / IP 变了 / 防火墙丢包），
 *    这时 `fetch` 会一直挂着（TCP 连接超时前不会有任何返回）——
 *    界面上就是那张卡片永远停在「录入中」，点别的也没反应。删不掉本来只影响
 *    "下次刷新它又出现"，不值得拿界面的响应性去换，所以到点就放行。
 */
export async function dropBackendPendingFace(url, backendId) {
  const base = String(url || '').replace(/\/+$/, '')
  backendPendingFaces.value = backendPendingFaces.value.filter((f) => f.backendId !== Number(backendId))
  if (!base) return
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('删除待录入', 6000)), 6000)
    try {
      await fetch(`${base}/api/pending-face?id=${encodeURIComponent(backendId)}`, { signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    /* 删不掉也只是下次又出现，不影响已录入的人脸；更不该拖住界面 */
  }
}

/* ==================== 手动上传照片录入 ====================
 *
 * 用户诉求：能不能支持「上传一张照片、手动录入一个人脸」，而不是等摄像头慢慢拍到。
 * 「提特征」的全套零件本来就是现成的（detectFaces / alignFace / faceEmbedding /
 * faceThumb / addFace），这里只做**编排**，不新写任何识别算法。
 *
 * 设计取舍（README §5.31）：
 *   1. **一张一录**：一次上传只录一个人。照片里有 N 张脸时，自动挑「分数最高、其次面积最大」
 *      的一张录入，并在结果里带回 detected 张数，UI 提示「其余请分别上传」。
 *   2. **后端模式前端平时不加载人脸模型** —— 这里**按需 loadModel('face'/'faceemb')**，
 *      首次约 1~3 秒，调用方（设置页）必须给出 loading 态，否则用户以为卡死了。
 *   3. **失败全有文案**：不是图片 / 找不到正脸 / 对齐失败 / 提特征失败 / 模型加载失败 /
 *      人脸库已满，各说各的，不抛裸异常（「待录入空态」那条教训：用户至少要听懂"为什么没录上"）。
 *   4. 入库后**不需要手动推后端** —— addFace → refreshFaces → App.vue 盯着 faceList 变化
 *      会自动补发一份配置（含人脸库），后端底库随之更新。
 *
 * @param {File} file 用户选的图片
 * @param {{score?:number, max?:number, longSide?:number}} [opts]
 * @returns {Promise<{ok:boolean, id?:number, name?:string, detected?:number, reason?:string}>}
 */
export async function enrollFromImage(file, { score = 0.4, max = DEFAULT_FACE_MAX, longSide = 1280 } = {}) {
  if (!file) return { ok: false, reason: '没有选择图片' }
  if (!/^image\//.test(file.type || '')) return { ok: false, reason: '请选择图片文件（jpg / png 等）' }

  // 1. 解码：优先按 EXIF 朝向摆正（手机竖拍照片很常见，否则脸会横过来）
  let bmp
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch (e) {
    try {
      bmp = await createImageBitmap(file)
    } catch (e2) {
      return { ok: false, reason: '图片打不开，换一张试试' }
    }
  }
  // 2. 画到画布，超长边等比缩到 longSide（检测只在 640 内做，原图再大也没用，还费内存）
  const scale = Math.min(1, longSide / Math.max(bmp.width || 1, bmp.height || 1))
  const cw = Math.max(1, Math.round((bmp.width || 1) * scale))
  const ch = Math.max(1, Math.round((bmp.height || 1) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    if (bmp.close) bmp.close()
    return { ok: false, reason: '浏览器画布不可用' }
  }
  ctx.drawImage(bmp, 0, 0, cw, ch)
  if (bmp.close) bmp.close()

  try {
    // 3. 按需加载人脸模型（后端模式前端平时不加载，这里现拉）
    await loadModel('face').catch(() => {})
    await loadModel('faceemb').catch(() => {})
    if (!isSlotReady('face') || !isSlotReady('faceemb')) {
      return { ok: false, reason: '人脸识别模型加载失败，请稍后重试（确认 /ai/models 可访问）' }
    }

    // 4. 检测
    const dets = await detectFaces(canvas, score)
    if (!dets || !dets.length) {
      return { ok: false, reason: '没检测到清晰的正脸，请上传一张光线充足、正对镜头的单人照片' }
    }
    // 5. 多脸：挑「分数最高、其次面积最大」的一张
    const best = dets
      .slice()
      .sort((a, b) => b.score - a.score || b.w * b.h - a.w * a.h)[0]

    // 6. 对齐 + 提特征
    const aligned = alignFace(canvas, best.kps)
    if (!aligned) return { ok: false, reason: '人脸对齐失败，换一张更清晰的照片' }
    const vector = await faceEmbedding(aligned)
    if (!vector || !vector.length) return { ok: false, reason: '特征提取失败，换一张更清晰的照片' }

    // 7. 缩略图：优先用原框裁切（和待录入 / 其他人脸库缩略图风格一致），对齐图兜底
    const thumb = faceThumb(canvas, best) || aligned.toDataURL('image/jpeg', 0.72) || ''

    // 8. 入库（自动编号 + 自动回推后端，见 App.vue 的 faceList 监听）
    const r = await addFace(vector, thumb, '', max)
    if (!r.ok) return { ok: false, reason: r.reason || '录入失败' }
    return { ok: true, id: r.id, name: r.name, detected: dets.length }
  } catch (e) {
    return { ok: false, reason: '录入过程出错：' + ((e && e.message) || e) }
  }
}
