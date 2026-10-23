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
import { DB_NAME, DB_VERSION, FACE_STORE_NAME, FACE_SPLIT_STORE, FACE_BLOCK_STORE } from './useEventStore.js'
import { normalizeFaceSplits, normalizeFaceBlocks, foldFaceBlocks, BLOCK_KEEP, blockMaxAgeDays as parseBlockMaxAge } from '../config/defaults.js'
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
import { cosineOrRaw, looksSame, pendingDedupeTarget, blockMergeTarget, hitMarginPassed } from './vecMatch.js'

/** 默认比对阈值：余弦相似度高于它才认为是同一个人 */
export const DEFAULT_FACE_THRESHOLD = 0.38
/** 人脸库默认上限 */
export const DEFAULT_FACE_MAX = 50

/**
 * 把 IndexedDB 事务的失败原因转成一个**真 Error**。
 *
 * ⚠️ 绝不能直接 `reject(tx.error)`：Chrome 在「请求错误冒泡导致事务中止」时
 *    `transaction.error` 可能是 **null**，于是调用方收到的是一个 `null`，
 *    上层 `(e && e.message) || e` 只能打印出 `"null"` —— 既看不出错在哪一类，
 *    也没法靠它分流文案（历史症状：`⚠️ 陌生人反例拉取失败：null`，
 *    以及「替换人脸库失败但控制台什么都不说」）。
 *
 * 本文件所有事务的 `onerror` / `onabort` 都必须走这里。新增事务时照抄旁边
 * 那行的写法，不要手写 `reject(tx.error)`。
 *
 * @param {IDBTransaction} tx
 * @param {string} what 人话说明，如「录入事务出错」「录入事务被中止」
 * @returns {Error}
 */
function txFail(tx, what) {
  return tx.error || new Error(what)
}

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

/**
 * 「命中修正」那一块展开着吗。默认**收起**，与 pendingLibOpen 对称。
 *
 * 放模块级的理由同 faceLibOpen：抽屉关掉再打开时展开状态要保留。
 * 默认收起是因为命中样本一列就是十几二十张图，打开设置就全铺开会把
 * 配置项顶下去；默认收起时标题行仍带数量（命中修正（N））。
 */
export const hitReviewOpen = ref(false)

/**
 * 「手动拆分」声明列表展开着吗。默认**收起**：拆分声明通常只有一两条，
 * 但每行都带解除按钮和说明文案，常显会把整页配置顶下去 —— 用户嫌占位置。
 * 收起时标题行仍带数量（手动拆分（N）），不会误以为"没有"。
 * 同样放模块级，理由见 faceLibOpen。
 */
export const faceSplitsOpen = ref(false)

/**
 * 「陌生人标记」（反例）列表展开着吗。默认**收起**，与 faceSplitsOpen 对称。
 * 放模块级的理由同 faceLibOpen；默认收起是因为平时通常没几条，
 * 展开时标题行仍带数量（陌生人标记（N））。
 */
export const blockLibOpen = ref(false)

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

/* ==================== 人脸库写失败的类型码 ====================
 * 为什么用 error.code 而不是比对错误文本：文案随时会改，文本判定一改就错；
 * 而且 UI 需要**区分**「卡住了（可重试 / 可能已写入）」和「真的写失败」，
 * 这两种要给的下一步动作完全不同。判定只有一份 —— faceWriteErrKind()。
 */
const FACE_ERR_WRITE_TIMEOUT = 'FACE_WRITE_TIMEOUT'
const FACE_ERR_OPEN_TIMEOUT = 'FACE_OPEN_TIMEOUT'
const FACE_ERR_BLOCKED = 'FACE_DB_BLOCKED'
const FACE_ERR_OPEN_FAIL = 'FACE_OPEN_FAIL'
const FACE_ERR_NO_IDB = 'FACE_NO_IDB'

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
      const err = new Error('当前环境不支持 IndexedDB')
      err.code = FACE_ERR_NO_IDB
      reject(err)
      return
    }
    let settled = false
    let timer = null
    const fail = (msg, code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      faceDbPromise = null
      const err = msg instanceof Error ? msg : new Error(msg)
      // 带上类型码：UI 靠它挑文案（见 faceWriteErrKind），不要去 grep 错误文本
      if (code && !err.code) err.code = code
      reject(err)
    }
    timer = setTimeout(() => fail('打开本地人脸数据库超时（10s），请关闭本应用的其它标签页后重试', FACE_ERR_OPEN_TIMEOUT), 10000)

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
      /*
       * 陌生人反例表（版本 4 新增）。同上必须幂等补建，理由见拆分表。
       */
      if (!db.objectStoreNames.contains(FACE_BLOCK_STORE)) {
        db.createObjectStore(FACE_BLOCK_STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onblocked = () => fail(new Error('本地人脸数据库正被本应用的其它标签页占用，请关掉其它标签页后重试'), FACE_ERR_BLOCKED)
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
    req.onerror = () => fail('打开本地人脸数据库失败：' + ((req.error && req.error.message) || req.error || '未知原因'), FACE_ERR_OPEN_FAIL)
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

/*
 * 连续超时次数（写成功一次就归零）。
 * 用途只有一个：**同一句话不要重复说给用户听**。第一次超时按"偶发、重试一下"处理；
 * 连着两次以上就说明不是偶发，而是连接真被占住了 —— 这时提示必须升级成
 * "完全退出应用再打开"，因为只关设置面板并不会释放连接（用户试过才知道）。
 */
let writeTimeoutStreak = 0

/** 当前连续超时次数（UI 拼文案用；0 = 上次写是成功的） */
export function faceWriteTimeoutStreak() {
  return writeTimeoutStreak
}

/**
 * 人脸库写失败的**类型判定（唯一一份）**。
 *
 * @param {any} err 捕获到的错误
 * @returns {'timeout'|'blocked'|'unsupported'|'other'}
 *   timeout     —— 卡住了：写事务 15s 没回来 / 打开连接 10s 没回来。
 *                  ⚠️ 注意"超时"并不等于"没写进去"，事务可能已提交（见 withWatchdog）。
 *   blocked     —— 数据库被本应用的其它标签页占着（升级受阻，open 被 blocked）。
 *   unsupported —— 环境没有 IndexedDB（老 WebView / 隐私模式）。
 *   other       —— 其它真失败（配额、事务被中止、请求错误）。
 */
export function faceWriteErrKind(err) {
  const code = (err && err.code) || ''
  if (code === FACE_ERR_WRITE_TIMEOUT || code === FACE_ERR_OPEN_TIMEOUT) return 'timeout'
  if (code === FACE_ERR_BLOCKED) return 'blocked'
  if (code === FACE_ERR_NO_IDB) return 'unsupported'
  // 兜底：没有 code 的原生错误（别的浏览器/旧代码路径）才退回文本判定
  const msg = String((err && err.message) || err || '')
  if (/超时/.test(msg)) return 'timeout'
  if (/占用|blocked/i.test(msg)) return 'blocked'
  if (/不支持 IndexedDB/i.test(msg)) return 'unsupported'
  return 'other'
}

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
      writeTimeoutStreak += 1
      const err = new Error(`本地数据库写入超时（${WRITE_TIMEOUT_MS / 1000}s）：请关闭本应用的其它标签页后重试`)
      err.code = FACE_ERR_WRITE_TIMEOUT
      reject(err)
    }, WRITE_TIMEOUT_MS)
    // Node（探针）里别为它吊住事件循环；浏览器返回数字，没有 unref
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve().then(fn), guard])
    .then((res) => {
      // 写成功了 → 之前的超时是偶发的，连续计数归零（下次超时重新从"偶发"说起）
      writeTimeoutStreak = 0
      return res
    })
    .finally(() => {
      if (timer) clearTimeout(timer)
    })
}

function runExclusive(fn) {
  const run = () => withWatchdog(fn)
  const next = writeChain.then(run, run)
  writeChain = next.catch(() => {})
  return next
}

/**
 * 写事务提交后，在**看门狗之外**统一刷新缓存。
 *
 * ⚠️ 为什么必须挪出去（这是「写入超时但其实已入库 → 重复入库」的根因）：
 *   refreshFaces 只是「读库 + 更新缓存」，此时写事务**已经提交**。
 *   以前 refresh 写在 runExclusive 内部 `await`，于是把「读全库 + 拆分清理 +
 *   反例清理 + 连接重建」的时间一起算进 15s 看门狗。而 withWatchdog 是
 *   `Promise.race([fn, guard])`：超时只会让 race 先 reject，**fn 不会被取消**，
 *   写事务照样跑完并提交。结果就是——
 *     用户看到「写入超时」→ 以为没录上 → 再点一次 → 库里出现两条。
 *   把 refresh 放到写结果 resolve 之后调用（fire-and-forget），它再慢再卡，
 *   都不会把「已经落盘的成功」误报成「超时」。
 *
 * @param {Promise} promise runExclusive(...) 的写结果
 * @param {...Function} refreshers 提交成功后要跑的刷新函数（失败一律吞掉）
 */
function withRefresh(promise, ...refreshers) {
  return promise.then((res) => {
    // 只有真正成功（没有 ok:false）才刷新；校验类失败不碰缓存
    const ok = !res || res.ok !== false
    if (ok) {
      for (const fn of refreshers) {
        try {
          const p = fn()
          if (p && typeof p.catch === 'function') p.catch(() => {})
        } catch (e) {
          /* 刷新失败不该影响写入结果；下次刷新会补上 */
        }
      }
    }
    return res
  })
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
    samples: f.samples || 1,
    primary: f.primary ? 1 : 0
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
  try {
    await refreshFaceBlocks()
  } catch (e) {
    /* 反例缓存刷不出来只是"误命中拦截暂不生效"，人脸库照常可用 */
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
          tx.onerror = () => reject(txFail(tx, '拆分声明清理事务出错'))
          tx.onabort = () => reject(txFail(tx, '拆分声明清理事务被中止'))
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
  return withRefresh(
    runExclusive(async () => {
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
        tx.onerror = () => reject(txFail(tx, '拆分声明写入事务出错'))
        tx.onabort = () => reject(txFail(tx, '拆分声明写入事务被中止'))
      })
      return { ok: true, added: fresh.length }
    }),
    refreshFaceSplits
  )
}

/** 解除一条拆分声明（之后恢复自动归类：相似度仍会把他们并回去） */
export function removeFaceSplit(id) {
  return withRefresh(
    runExclusive(async () => {
      const db = await openFaceDB()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_SPLIT_STORE, 'readwrite')
        tx.objectStore(FACE_SPLIT_STORE).delete(id)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(txFail(tx, '拆分声明删除事务出错'))
        tx.onabort = () => reject(txFail(tx, '拆分声明删除事务被中止'))
      })
      return { ok: true }
    }),
    refreshFaceSplits
  )
}

/**
 * 用一份声明**整体替换**本机的（从后端拉取配置时用，以后端为准）。
 * 与 replaceFaces 同理：明确送来数组才替换；送空数组 = 用户/后端确实没有拆分。
 */
export function replaceFaceSplits(list) {
  return withRefresh(
    runExclusive(async () => {
      const want = normalizeFaceSplits(list)
      const db = await openFaceDB()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_SPLIT_STORE, 'readwrite')
        const os = tx.objectStore(FACE_SPLIT_STORE)
        os.clear()
        const now = Date.now()
        for (const w of want) os.add({ ...w, createdAt: now })
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(txFail(tx, '拆分声明替换事务出错'))
        tx.onabort = () => reject(txFail(tx, '拆分声明替换事务被中止'))
      })
      return { ok: true, count: want.length }
    }),
    refreshFaceSplits
  )
}

/* ==================== 陌生人反例（「不是本人」标记） ====================
 *
 * 为什么需要它：陌生人被误认成库里某人时，「忽略」只删样本不治本——
 * 库内样本与这张陌生脸的余弦依然过高，下次照认。反例把这张陌生脸的向量
 * 存下来，匹配时同时算「库内最像分」与「反例最像分」，仅当
 *     反例分 ≥ 阈值 且 反例分 ≥ 库内最像分
 * 才判未录入（blocked）。库里真人本人不受影响：真人对己样本 ~0.9，
 * 远高于对陌生反例 ~0.4，库内分天然压过反例分。
 *
 * 与拆分声明同模式：IndexedDB face-blocks 表是唯一 source of truth，
 * 随配置同步给后端（faceBlocks 字段），后端只在内存里缓存 + 落盘 cfg。
 */

/** 反例缓存（非响应式，与 splitCache 同模式）：匹配路径同步读 */
let blockCache = []

/**
 * 反例保留期限（天）的当前生效值（模块级，随配置同步更新）。
 * normalizeFaceBlocks / refreshFaceBlocks / pruneFaceBlocks 都以它为默认口径，
 * 避免"前端留着过期反例、还在拦截"的漂移。setBlockMaxAgeDays 由 App.vue 在配置
 * 应用时写入（解析收口在 defaults.blockMaxAgeDays）。
 */
let blockMaxAge = 0
export function setBlockMaxAgeDays(face) {
  blockMaxAge = parseBlockMaxAge(face || {})
}

/** 每次 refreshFaceBlocks 自增 —— 让设置页「陌生人标记」列表 computed 知道该重算了 */
export const faceBlocksVersion = ref(0)

/** 取当前反例快照（同步；调用方只读） */
export function currentFaceBlocks() {
  return blockCache
}

/**
 * 读全量反例（含向量），按 id 升序。
 * ⚠️ 别再把它当成「按标记时间先后」：合并会刷新 at，id 与时间已经脱钩。
 */
export async function getAllFaceBlocks() {
  try {
    const os = await store('readonly', FACE_BLOCK_STORE)
    const all = await reqAsPromise(os.getAll())
    return (all || []).sort((a, b) => (a.id || 0) - (b.id || 0))
  } catch (e) {
    // 老库还没升级（表不存在）等情形：当没有反例，绝不能让调用方炸掉
    return []
  }
}

/** 刷新反例缓存（人脸库每次 refresh 都跟着刷一次，保证匹配拿到的是最新的） */
export async function refreshFaceBlocks() {
  const list = normalizeFaceBlocks(await getAllFaceBlocks(), blockMaxAge)
  blockCache = list
  faceBlocksVersion.value += 1
  return list
}

/**
 * 新增一条陌生人反例（同一个人已有时合并，不再插新条）。
 * ----------------------------------------------------------------------------
 * 为什么合并：酒店这类高流动场景里同一个路人被误认 N 次，老逻辑就是 N 条独立
 * 反例 —— 库按「点击次数」而不是「不同陌生人」增长，很快占满 200 条容量。
 * 判据收口在 vecMatch.blockMergeTarget（默认 0.6，可配；配 0 = 关闭合并）。
 *
 * @param {{vector:number[], thumb?:string, name?:string, mergeThreshold?:number}} rec
 *        vector：这张陌生脸的 512 维特征（判据本体）；
 *        thumb：缩略图（设置页要能看见"是谁被认错了"）；
 *        name：当初被误认成的库内人名（展示用，可空）；
 *        mergeThreshold：合并阈值（`options.face.blockMergeThreshold` 的解析值，
 *                        没传走默认 0.6）。
 * @returns {Promise<{ok:boolean, id?:number, merged?:boolean, count?:number, reason?:string}>}
 */
export function addFaceBlock({ vector, thumb, name, mergeThreshold } = {}) {
  return withRefresh(
    runExclusive(async () => {
      const vec = Array.isArray(vector) ? vector.slice() : null
      if (!vec || !vec.length || !vec.every((n) => Number.isFinite(n))) {
        return { ok: false, reason: '这条样本没有可用的特征向量' }
      }
      const db = await openFaceDB()
      const now = Date.now()
      const incomingName = String(name || '').trim()
      const incomingThumb = String(thumb || '')

      // 合并判定：库里已有一条足够像的 → 只给它 count+1、刷新 at/thumb/name
      const hit = blockMergeTarget(blockCache, { vector: vec }, mergeThreshold)
      if (hit) {
        const next = {
          ...hit,
          count: (Number(hit.count) || 1) + 1,
          at: now,
          thumb: incomingThumb || hit.thumb || '',
          name: incomingName || hit.name || ''
        }
        await putFaceBlock(db, next)
        return { ok: true, id: next.id, merged: true, count: next.count }
      }

      const rec = {
        vector: vec,
        thumb: incomingThumb,
        name: incomingName,
        at: now,
        count: 1
      }
      const id = await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_BLOCK_STORE, 'readwrite')
        const rq = tx.objectStore(FACE_BLOCK_STORE).add(rec)
        tx.oncomplete = () => resolve(rq.result)
        tx.onerror = () => reject(txFail(tx, '反例写入事务出错'))
        tx.onabort = () => reject(txFail(tx, '反例写入事务被中止'))
      })
      return { ok: true, id, merged: false, count: 1 }
    }),
    // 滚动清理（写）→ 刷缓存（读），按序在后台跑；清理失败不影响"反例已写入"
    () =>
      (async () => {
        try {
          await pruneFaceBlocks()
        } catch (e) {
          /* 清理失败下次还会试 */
        }
        await refreshFaceBlocks()
      })()
  )
}

/** 覆盖写一条反例（合并计数、刷新 at/thumb 时用；id 已在库里，按 keyPath 覆盖） */
function putFaceBlock(db, rec) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FACE_BLOCK_STORE, 'readwrite')
    tx.objectStore(FACE_BLOCK_STORE).put(rec)
    tx.oncomplete = () => resolve(true)
    // tx.error 在 Chrome 下可能为 null，必须兜真 Error（见 replaceFaceBlocks 的说明）
    tx.onerror = () => reject(txFail(tx, '反例更新事务出错'))
    tx.onabort = () => reject(txFail(tx, '反例更新事务被中止'))
  })
}

/** 解除一条反例（之后这张脸重新参与正常匹配） */
export function removeFaceBlock(id) {
  return withRefresh(
    runExclusive(async () => {
      const db = await openFaceDB()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_BLOCK_STORE, 'readwrite')
        tx.objectStore(FACE_BLOCK_STORE).delete(id)
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(txFail(tx, '反例删除事务出错'))
        tx.onabort = () => reject(txFail(tx, '反例删除事务被中止'))
      })
      return { ok: true }
    }),
    refreshFaceBlocks
  )
}

/**
 * 用一份反例**整体替换**本机的（从后端拉取配置时用，以后端为准）。
 * 与 replaceFaceSplits 同理：明确送来数组才替换；送空数组 = 后端确实没有反例。
 *
 * ⚠️ 修过的坑：后端远程 `/hitblock` 标的反例 id 一律是 0（「纯配置来源」），
 *    而 face-blocks 表是 `keyPath:'id' + autoIncrement` —— 直接 `os.add({id:0})`
 *    会抛 ConstraintError 让**整笔事务中止**（`os.clear()` 一起回滚），
 *    症状是「从后端拉取配置」静默失败、本机数据看着没丢。所以 id<=0 的记录
 *    必须重新分配自增位，绝不能原样写 0。
 *
 * @param {Array} list 后端下发的反例
 * @param {number} [mergeThreshold] 合并阈值（`options.face.blockMergeThreshold`
 *        的解析值）。同一个人在本机标过又被远程标过时，拉取会拿到两份，
 *        这里按阈值折叠成一条（判据见 defaults.foldFaceBlocks）。
 */
export function replaceFaceBlocks(list, mergeThreshold, maxAgeDays = blockMaxAge) {
  return withRefresh(
    runExclusive(async () => {
      const want = foldFaceBlocks(normalizeFaceBlocks(list, maxAgeDays), mergeThreshold)
      const db = await openFaceDB()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_BLOCK_STORE, 'readwrite')
        const os = tx.objectStore(FACE_BLOCK_STORE)
        os.clear()
        // 自增位从「本批最大 id + 1」起：既不会和显式 id 撞，
        // 也会把 IndexedDB 的键生成器顶上去，后续本机新增不会回落到已占用的 id
        let nextId = want.reduce((m, w) => Math.max(m, Number(w.id) || 0), 0) + 1
        for (const w of want) {
          if (w.id > 0) {
            os.add({ ...w })
            continue
          }
          os.add({ ...w, id: nextId++ })
        }
        tx.oncomplete = () => resolve(true)
        /*
         * ⚠️ 不能直接 reject(tx.error)：Chrome 在「请求错误冒泡导致事务中止」时
         *    transaction.error 可能是 null，于是调用方收到的是一个 null，
         *    App.vue 的 `(e && e.message) || e` 只能打印出 "null" —— 既看不出
         *    错在哪类，也没法靠它分流文案。所以这里必须兜一个真 Error。
         */
        tx.onerror = () => reject(txFail(tx, '反例替换事务出错'))
        tx.onabort = () => reject(txFail(tx, '反例替换事务被中止'))
      })
      return { ok: true, count: want.length }
    }),
    refreshFaceBlocks
  )
}

/** 清空全部反例 */
export function clearFaceBlocks() {
  return withRefresh(
    runExclusive(async () => {
      const db = await openFaceDB()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_BLOCK_STORE, 'readwrite')
        tx.objectStore(FACE_BLOCK_STORE).clear()
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(txFail(tx, '反例清空事务出错'))
        tx.onabort = () => reject(txFail(tx, '反例清空事务被中止'))
      })
      return { ok: true }
    }),
    refreshFaceBlocks
  )
}

/**
 * 滚动清理：超过 BLOCK_KEEP 条时删最旧的；另外超过保留期限（blockMaxAge 天）的也删。
 * ⚠️ 两套口径独立：保留期限（时间上限）优先于 BLOCK_KEEP（容量上限）—— 过期的
 *    无论是否超容量都丢，没过期的才参与容量滚动。
 * ⚠️ 排序口径与 defaults.normalizeFaceBlocks 逐字一致（**按 at 新者优先**，
 *    同 at 保持原相对顺序）。以前按 id 删是错的：合并会刷新 at 但不换 id，
 *    「最近还在被认错」的老记录反而先被淘汰；更要命的是远程 `/hitblock`
 *    来源的反例 id 全是 0，会永远排在头部被优先删掉 —— 与价值完全不相关。
 */
async function pruneFaceBlocks() {
  const all = await getAllFaceBlocks()
  const maxAgeMs = blockMaxAge > 0 ? blockMaxAge * 86400000 : 0
  const now = Date.now()
  const alive = []
  const drop = []
  for (const r of all) {
    const at = Number(r && r.at) || 0
    // 保留期限：过期的直接丢（与 BLOCK_KEEP 独立口径）
    if (maxAgeMs > 0 && at > 0 && now - at > maxAgeMs) {
      drop.push(r)
      continue
    }
    alive.push(r)
  }
  if (alive.length > BLOCK_KEEP) {
    const order = alive.map((_, i) => i)
    order.sort((a, b) => (alive[b].at - alive[a].at) || (a - b))
    const keep = new Set(order.slice(0, BLOCK_KEEP))
    for (const i of order.slice(BLOCK_KEEP)) drop.push(alive[i])
  }
  const db = await openFaceDB()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(FACE_BLOCK_STORE, 'readwrite')
    const os = tx.objectStore(FACE_BLOCK_STORE)
    for (const r of drop) os.delete(r.id)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(txFail(tx, '反例清理事务出错'))
    tx.onabort = () => reject(txFail(tx, '反例清理事务被中止'))
  })
  return drop.length
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
    tx.onerror = () => reject(txFail(tx, '拆分声明维护事务出错'))
    tx.onabort = () => reject(txFail(tx, '拆分声明维护事务被中止'))
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
 * 两条特征向量是否「同一张脸」（逐元素近似相等）。
 *
 * 用途：录入**幂等**。同一张「待录入」卡被重复点击 / 超时后用户重试时，
 * 传进来的是**同一份向量**，命中即视为"已经入过"，直接返回已有那条，不再新建
 * —— 这是「超时但其实已写入 → 重复入库」的最后一道保险。
 * 不同照片拍同一个人 → 向量不同 → 不会被挡（那本来就该作为新样本）。
 */
function sameVector(a, b, eps = 1e-6) {
  if (!a || !b || a.length !== b.length || !a.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs((Number(a[i]) || 0) - (Number(b[i]) || 0)) > eps) return false
  }
  return true
}

/**
 * 录入一张人脸。
 * @param {Float32Array|number[]} vector 已归一化的特征向量
 * @param {string} thumb 缩略图 dataURL
 * @param {string} [name] 留空则自动编号
 * @param {number} [max] 上限
 * @returns {Promise<{ok:boolean, id?:number, name?:string, duplicate?:boolean, reason?:string}>}
 */
export function addFace(vector, thumb, name, max = DEFAULT_FACE_MAX) {
  return withRefresh(
    runExclusive(async () => {
      if (!vector || !vector.length) return { ok: false, reason: '人脸特征为空' }
      const list = await getAllFaces()
      /*
       * 幂等去重（必须在容量判断**之前**）：库里已有完全相同的向量 =
       * 这次是重复点击 / 超时重试，直接返回已有那条，绝不再建第二条。
       * 否则会出现「点三次 → 三个人脸 1/2/3」。
       */
      const dup = list.find((r) => sameVector(r.vector, vector))
      if (dup) return { ok: true, id: dup.id, name: dup.name, duplicate: true }
      const cap = Math.max(1, Number(max) || DEFAULT_FACE_MAX)
      if (list.length >= cap) {
        return { ok: false, reason: `人脸库已满（上限 ${cap} 人），请先删除不再需要的人脸` }
      }
      const finalName = (name && String(name).trim()) || nextFaceName(list)
      const now = Date.now()
      const db = await openFaceDB()
      const record = {
        name: finalName,
        // 统一转成普通数组存：TypedArray 在部分老 WebView 的 IndexedDB 里克隆不可靠
        vector: Array.from(vector),
        thumb: thumb || '',
        createdAt: now,
        updatedAt: now,
        samples: 1,
        // 主样本标记（每个名字最多一条）。新录入默认不是主样本 ——
        // 让它抢主样本位会覆盖用户已经挑好的那张。
        primary: 0
      }
      /*
       * 以**事务提交**（oncomplete）为准，而不是请求成功（req.onsuccess）：
       * onsuccess 只代表请求被接受，那时事务可能还没真正落盘；oncomplete 才是已提交。
       * 这样"返回成功"就等价于"数据确实在库里"，不会出现"报成功却没写进去"。
       */
      const id = await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_STORE_NAME, 'readwrite')
        const rq = tx.objectStore(FACE_STORE_NAME).add(record)
        tx.oncomplete = () => resolve(rq.result)
        tx.onerror = () => reject(txFail(tx, '录入事务出错'))
        tx.onabort = () => reject(txFail(tx, '录入事务被中止'))
      })
      return { ok: true, id, name: finalName }
    }),
    refreshFaces
  )
}

/**
 * 把某一条设为主样本（同名的其它条自动取消）。
 * ----------------------------------------------------------------------------
 * 「主样本」是什么：这个人的**代表样本**。用途有三 ——
 *   ① 人脸库卡片的封面；
 *   ② 待录入打分时「最像谁」的对比基准（拿最稳的那张去比，而不是被废样本摊薄）；
 *   ③ 清理废样本时「保留哪一张」的默认选项。
 *
 * ⚠️ 刻意**不**让它参与匹配数学：匹配始终对该名字下所有样本取最高相似度。
 *    一旦让主样本加权，就等于动摇了 0.38 阈值 / 分差门槛那套已经调过的体系，
 *    而它带来的收益（多几个同人样本的分数变化）远小于风险。
 *
 * 唯一性（一个名字最多一条）在这里由事务保证：先同名全体清零，再点亮目标。
 * 放在应用层判断再写的话，两次快速点击就能钻空子留下两条主样本，
 *    于是"封面取哪张"取决于遍历顺序 —— 那是漂移的来源。
 *
 * @param {number} id
 * @returns {Promise<{ok:boolean, id?:number, name?:string, reason?:string}>}
 */
export async function setPrimaryFace(id) {
  const target = Number(id)
  if (!Number.isFinite(target)) return { ok: false, reason: '记录不存在' }
  return withRefresh(
    runExclusive(async () => {
      const list = await getAllFaces()
      const rec = list.find((r) => r.id === target)
      if (!rec) return { ok: false, reason: '记录不存在' }
      // 已经是主样本：幂等返回，不写库（避免无谓的 updatedAt 变动）
      if (rec.primary) return { ok: true, id: target, name: rec.name }
      const now = Date.now()
      const db = await openFaceDB()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_STORE_NAME, 'readwrite')
        const os = tx.objectStore(FACE_STORE_NAME)
        for (const r of list) {
          if (r.id !== target && r.name === rec.name && r.primary) {
            os.put({ ...r, primary: 0, updatedAt: now })
          }
        }
        os.put({ ...rec, primary: 1, updatedAt: now })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(txFail(tx, '设主样本事务出错'))
        tx.onabort = () => reject(txFail(tx, '设主样本事务被中止'))
      })
      return { ok: true, id: target, name: rec.name }
    }),
    refreshFaces
  )
}

/**
 * 取消某一条的主样本标记（同名的其它条不动 —— 本来也只有一条能是）。
 * 用途：用户选了一圈想回到「没有主样本」的默认态（封面回退到最早录入那张）。
 * @param {number} id
 * @returns {Promise<{ok:boolean, id?:number, reason?:string}>}
 */
export async function clearPrimaryFace(id) {
  const target = Number(id)
  if (!Number.isFinite(target)) return { ok: false, reason: '记录不存在' }
  return withRefresh(
    runExclusive(async () => {
      const list = await getAllFaces()
      const rec = list.find((r) => r.id === target)
      if (!rec) return { ok: false, reason: '记录不存在' }
      if (!rec.primary) return { ok: true, id: target, name: rec.name }
      const now = Date.now()
      const db = await openFaceDB()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_STORE_NAME, 'readwrite')
        const os = tx.objectStore(FACE_STORE_NAME)
        os.put({ ...rec, primary: 0, updatedAt: now })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(txFail(tx, '取消主样本事务出错'))
        tx.onabort = () => reject(txFail(tx, '取消主样本事务被中止'))
      })
      return { ok: true, id: target, name: rec.name }
    }),
    refreshFaces
  )
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
  const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null)
  const finalName = String(name == null ? '' : name).trim()
  return withRefresh(
    runExclusive(async () => {
      if (!list.length) return { ok: false, reason: '没有要改名的记录' }
      if (!finalName) return { ok: false, reason: '名字不能为空' }
      const db = await openFaceDB()
      /*
       * 主样本唯一性（一个名字最多一条 ★）。
       *
       * 改名是**唯一**能在应用层制造"同名两条主样本"的入口：把 A 的样本改名成
       * B，而 B 名下已经有一条 ★。不拦的话两张卡都挂 ★，「封面取哪张」取决于
       * 遍历顺序 —— 那是漂移的来源。
       *
       * 规矩：目标名字已有的主样本（不在本次改名集合里）**优先保留** ——
       * 用户并没有动那张卡，没道理让它失去代表样本；本次带过来的 ★ 让位。
       * 集合内部多条 ★ 时只留 id 最小的那条（= 最早录入的，与"封面默认取最早"
       * 的既有口径一致）。
       */
      const all = await getAllFaces()
      const idSet = new Set(list.map(Number))
      const existingPrimary = all.find((r) => r.primary && r.name === finalName && !idSet.has(r.id))
      let keepRenamed = null
      if (!existingPrimary) {
        keepRenamed = all
          .filter((r) => r.primary && idSet.has(r.id))
          .sort((a, b) => a.id - b.id)[0]
      }
      const primaryFix = new Map()
      for (const r of all) {
        if (!r.primary || !idSet.has(r.id)) continue
        if (existingPrimary || (keepRenamed && keepRenamed.id !== r.id)) primaryFix.set(r.id, 0)
      }
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
            if (primaryFix.has(Number(id))) cur.primary = primaryFix.get(Number(id))
            os.put(cur)
          }
        })
        tx.oncomplete = () => resolve(hit)
        tx.onerror = () => reject(txFail(tx, '改名事务出错'))
        tx.onabort = () => reject(txFail(tx, '改名事务被中止'))
      })
      return { ok: true, name: finalName, count: list.length }
    }),
    /*
     * 改名后维护拆分声明、再刷缓存，两者**按序**在后台跑（写在前面 await 已完成）：
     * 两侧被改成同一个名字 = 用户把两人统一了，声明必须退休；顺序反了会让
     * refreshFaces 先读到旧声明、界面短暂显示"还分着"。整段失败不影响改名结果。
     */
    () =>
      (async () => {
        try {
          await maintainSplitsAfterRename(list)
        } catch (e) {
          /* 声明维护失败只是"拆分暂未同步"，下次刷新会纠正 */
        }
        await refreshFaces()
      })()
  )
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
  return withRefresh(
    runExclusive(async () => {
      const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null)
      if (!list.length) return { ok: false, reason: '没有要删除的记录' }
      const db = await openFaceDB()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(FACE_STORE_NAME, 'readwrite')
        const os = tx.objectStore(FACE_STORE_NAME)
        list.forEach((id) => os.delete(id))
        tx.oncomplete = () => resolve(true)
        tx.onerror = () => reject(txFail(tx, '删除事务出错'))
        tx.onabort = () => reject(txFail(tx, '删除事务被中止'))
      })
      return { ok: true, count: list.length }
    }),
    refreshFaces
  )
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
  return withRefresh(
    runExclusive(async () => {
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
        tx.onerror = () => reject(txFail(tx, '读取人脸记录出错'))
        tx.onabort = () => reject(txFail(tx, '读取人脸记录被中止'))
      })
      if (recs.length < 2) return { ok: false, reason: '至少需要两条记录才能合并' }
      const keep = recs.find((r) => r.id === keepId) || recs[0]
      const avg = averageVectors(recs)
      if (!avg) return { ok: false, reason: '这些记录都没有可用的特征向量' }

      const now = Date.now()
      keep.vector = avg.vector
      keep.samples = avg.weight
      keep.updatedAt = now
      /*
       * 主样本跟着合并走：只要参与合并的里有主样本，保留那条就接过这个标记
       * （哪怕用户当时选的主样本不是 keep）。否则合并完主样本凭空消失，
       * 封面与「挑样本基准」静默回退到默认排序 —— 用户看不出发生了什么。
       */
      if (recs.some((r) => r.primary) && !keep.primary) keep.primary = 1
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
        tx.onerror = () => reject(txFail(tx, '合并事务出错'))
        tx.onabort = () => reject(txFail(tx, '合并事务被中止'))
      })
      return { ok: true, id: keep.id, samples: avg.weight, count: recs.length }
    }),
    refreshFaces
  )
}

export function clearFaces() {
  return withRefresh(
    runExclusive(async () => {
      const os = await store('readwrite')
      await reqAsPromise(os.clear())
      return { ok: true }
    }),
    refreshFaces
  )
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
  return withRefresh(
    runExclusive(async () => {
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
      /*
       * 同名人下只认第一条主样本：后端 setPrimaryFace 已经保证唯一，但拉回来的
       * 那份可能来自更老的版本 / 别的写入路径，防御一下。否则两张卡都挂 ★，
       * 「封面取哪张」就取决于遍历顺序 —— 那是漂移的来源。
       */
      const seenPrimary = new Set()
      items.forEach((f) => {
        let primary = f.primary ? 1 : 0
        if (primary) {
          if (seenPrimary.has(f.name)) primary = 0
          else seenPrimary.add(f.name)
        }
        os.add({
          name: String(f.name),
          // 统一转普通数组：TypedArray 在部分老 WebView 的 IndexedDB 里克隆不可靠
          vector: Array.from(f.vector),
          thumb: f.thumb || '',
          createdAt: Number(f.createdAt) || now,
          updatedAt: Number(f.updatedAt) || now,
          samples: Number(f.samples) || 1,
          primary
        })
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(txFail(tx, '人脸库替换事务出错'))
      tx.onabort = () => reject(txFail(tx, '人脸库替换事务被中止'))
    })
      return { ok: true, count: items.length }
    }),
    refreshFaces
  )
}

/**
 * 用新样本增强某个人的特征。
 * 做法：向量按样本数做增量平均再重新归一化——比只留第一张稳，
 * 又不需要长期保存全部历史样本。
 */
export function mergeFace(id, vector, thumb) {
  return withRefresh(
    runExclusive(async () => {
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
    return { ok: true }
    }),
    refreshFaces
  )
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
 *                但库里的声明必须生效，否则"库里分开了、推送还并着"）；
 *        margin：命中分差门槛（余弦差）；>0 时要求"最像的人"比"第二像的人"高出
 *                这么多才敢确认命中，否则当未录入（ambiguous:true）。0=关闭。
 * @returns {Promise<{face:object, score:number, groupName:string}|null>}
 *          miss 情形仍回 `{face,score,miss:true,groupName}`（groupName 回样本本名）。
 *          被反例拦下的误命中回 `{face,score,miss:true,blocked:true,groupName:''}`。
 *          top1 过了阈值但差 top2 不够远回 `{face,score,miss:true,ambiguous:true}`。
 */
export async function matchFaceGroup(vector, { threshold = DEFAULT_FACE_THRESHOLD, bySimilarity = true, splits, margin = 0 } = {}) {
  if (!vector || !vector.length) return null
  const list = await getAllFaces()
  if (!list.length) return null
  const q = vector instanceof Float32Array ? vector : Float32Array.from(vector)
  let best = null
  let bestScore = -1
  let secondScore = -1
  for (const f of list) {
    if (!f.vector || f.vector.length !== q.length) continue
    const s = cosine(q, f.vector)
    if (s > bestScore) {
      secondScore = bestScore
      bestScore = s
      best = { face: f, score: s }
    } else if (s > secondScore) {
      secondScore = s
    }
  }
  if (!best) return null
  /*
   * 命中分差门槛（酒店等长相相似度高的场景防误认）：最像的人必须比第二像的人高出
   * margin 才敢确认命中；差得不够远就当没认出（落入未录入流程）。判定收口在
   * vecMatch.hitMarginPassed（前后端共用），margin<=0 关闭。
   */
  const marginOk = hitMarginPassed(bestScore, secondScore, margin)
  const confident = bestScore >= threshold && marginOk
  const hit = confident
    ? best
    : { face: best.face, score: bestScore, miss: true, ambiguous: bestScore >= threshold }
  /*
   * 陌生人反例拦截（「不是本人」标记）：
   * 本来要认成库里某人（过了阈值）时，再看反例里有没有更像的 —— 反例分 ≥ 阈值
   * 且 ≥ 库内最像分，才判未录入。真人本人不受影响：对自己样本 ~0.9 远高于
   * 对陌生反例 ~0.4，库内分天然压过反例分，拦截永远不会误伤本人。
   * 反例缓存读不到了（refresh 失败等）只是"暂不拦截"，绝不影响正常识别。
   */
  if (!hit.miss && blockCache.length) {
    let blockBest = -1
    for (const b of blockCache) {
      if (!b.vector || b.vector.length !== q.length) continue
      const s = cosine(q, b.vector)
      if (s > blockBest) blockBest = s
    }
    if (blockBest >= threshold && blockBest >= best.score) {
      return { face: best.face, score: best.score, miss: true, blocked: true, groupName: '' }
    }
  }
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
    // 代表样本 = 最早录入的那条（getAllFaces 本来就按 createdAt 升序）。
    // key / id / createdAt 都**锚在它身上**：改主样本不该让分组 key 变
    // （否则设置页展开的面板会被 watch 收起，用户刚设完 ★ 面板就关了）。
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
    /*
     * 主样本（★）：这个人的「代表样本」，由用户指定。
     * 用途：① 卡片封面；② 待录入打分时「最像谁」的对比基准；
     *      ③ 清理废样本时「保留哪一张」的默认选项。
     * 刻意**不**参与匹配数学（匹配对该名字下所有样本取最高相似度）——
     * 让它加权会动摇 0.38 阈值 / 分差门槛那套已验证的体系。
     * 没有主样本时封面回退到最早录入的那张（rep），行为与加这个字段前一致。
     */
    const primaryRec = recs.find((r) => r.primary) || null
    groups.push({
      key: `g${rep.id}`,
      id: rep.id,
      name: rep.name,
      thumb: (primaryRec && primaryRec.thumb) || rep.thumb || '',
      createdAt: rep.createdAt || 0,
      count: recs.length,
      sameName,
      names,
      score,
      primaryId: primaryRec ? primaryRec.id : 0,
      items: recs.map((it) => ({
        id: it.id,
        name: it.name,
        thumb: it.thumb || '',
        createdAt: it.createdAt || 0,
        samples: it.samples || 1,
        primary: it.primary ? 1 : 0,
        sim: it === rep ? 1 : cosineOrRaw(it.vector, rep.vector)
      }))
    })
  }
  // 按"这个人第一次出现的时间"排，顺序稳定（与录入顺序一致）
  groups.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
  return groups
}

/**
 * 「人脸库容量（libMax）调小到当前库存之下」时，算出该淘汰谁 —— **纯函数**，
 * 不碰 IndexedDB，所以"砍谁、砍几条、剩几条"能被穷举测试守住。
 *
 * 背景：libMax 以前只在 addFace 那一刻当门槛（满了就不许录），把上限从 100 改到 50
 * 时，已录入的 80 条原样留着、界面显示超额状态，用户完全看不出会发生什么。
 * 现在改成：保存前给出**明确警告**，确认后按本函数的计划自动淘汰。
 *
 * 淘汰粒度是「人」（groupFaces 的一张卡片 = 一个人），不是单条样本：
 * 同一个人被砍一半样本比整个人消失更怪（卡片还在、样本少了几张，用户会以为bug）。
 * 组按**组内最早样本**的 createdAt 升序淘汰（"最旧的人"= 建档最早的人），
 * 同刻按代表样本 id 兜底，顺序稳定。砍整组可能让结果略低于新上限（要的是"淘汰最旧的人"，
 * 不是"凑够条数"），对话框里写的保留数是按这个计划实算的。
 *
 * 组没覆盖到的记录（调用方传了过期 groups 才会发生）按单条一组参与同一套排序，
 * 不会出现"先砍组里较新的、留下没编组的更旧记录"。
 *
 * @param {Array<{id:number,name:string,createdAt?:number}>} rows 人脸库全部记录（faces）
 * @param {Array<{id:number,createdAt?:number,count:number,items:Array<{id:number,createdAt?:number}>}>} groups
 *        groupFaces(rows) 的分组结果
 * @param {number} cap 新上限（按**记录条数**计，与 addFace 的门槛同一口径）
 * @returns {{
 *   need:number, totalRecords:number, totalPeople:number, cap:number,
 *   victimIds:number[], removedRecords:number, removedPeople:number,
 *   keepRecords:number, keepPeople:number
 * }} need<=0 表示不需要淘汰（victimIds 为空）
 */
export function planEvictOldest(rows, groups, cap) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id != null)
  const gs = (Array.isArray(groups) ? groups : []).filter((g) => g && Array.isArray(g.items) && g.items.length)
  const c = Math.max(1, Math.round(Number(cap) || DEFAULT_FACE_MAX))
  const need = Math.max(0, list.length - c)
  const out = {
    need,
    totalRecords: list.length,
    totalPeople: gs.length,
    cap: c,
    victimIds: [],
    removedRecords: 0,
    removedPeople: 0,
    keepRecords: list.length,
    keepPeople: gs.length
  }
  if (need <= 0) return out

  const victimSet = new Set()
  const rowIds = new Set(list.map((r) => r.id))
  /*
   * 组没覆盖到的记录（调用方传了过期 groups 才会发生）按**单条一组**补进去，
   * 再和真组一起按"组内最早样本"排 —— 单一排序点，且不会出现
   * "先砍了组里较新的、留下没编组的更旧记录"这种自相矛盾。
   */
  const covered = new Set()
  for (const g of gs) for (const it of g.items) covered.add(it.id)
  const orphans = list
    .filter((r) => !covered.has(r.id))
    .map((r) => ({ id: r.id, items: [{ id: r.id, createdAt: r.createdAt }] }))
  // groups 自身已按代表样本排过，这里不依赖那个顺序，只认组内最早样本
  const ordered = [...gs, ...orphans]
    .map((g) => ({
      g,
      oldest: g.items.reduce((m, it) => Math.min(m, Number(it.createdAt) || 0), Infinity)
    }))
    .sort((a, b) => a.oldest - b.oldest || (a.g.id || 0) - (b.g.id || 0))

  let rest = need
  for (const { g } of ordered) {
    if (rest <= 0) break
    for (const it of g.items) {
      // 只对**真实存在**的记录计数：过期 groups 里的幽灵 id 不该把缺口抵掉
      if (rowIds.has(it.id) && !victimSet.has(it.id)) {
        victimSet.add(it.id)
        rest -= 1
      }
    }
  }
  // 兜底：还有缺口（理论上走到这说明 rows/groups 有重复 id 之类）→ 按记录级补砍最旧的
  if (rest > 0) {
    const leftovers = list
      .filter((r) => !victimSet.has(r.id))
      .slice()
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || (a.id || 0) - (b.id || 0))
    for (const r of leftovers) {
      if (rest <= 0) break
      if (!victimSet.has(r.id)) {
        victimSet.add(r.id)
        rest -= 1
      }
    }
  }

  out.victimIds = list.filter((r) => victimSet.has(r.id)).map((r) => r.id)
  out.removedRecords = out.victimIds.length
  // 「涉及几人」= 有样本被砍的组；「留下几人」= 还有样本存活的组（兜底补砍可能是半个组）
  out.removedPeople = gs.filter((g) => g.items.some((it) => victimSet.has(it.id))).length
  out.keepPeople = gs.filter((g) => g.items.some((it) => !victimSet.has(it.id))).length
  out.keepRecords = list.length - out.removedRecords
  return out
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
 * @param {number} [o.dedupeSec] 重复捕获合并间隔（秒，`options.face.pendingDedupeSec` 的解析值）；
 *                          <=0 = 关闭去重。缺省回落 vecMatch.PENDING_DEDUPE.sec.def
 * @returns {{added:boolean, id?:number}}
 */
export function pushPendingFace({ vector, thumb, full, at, camId, camName, max, dedupeSec, metrics, gender, age, attr }) {
  if (!vector || !vector.length || !thumb) return { added: false }
  const list = pendingFaces.value
  const now = at || Date.now()
  // 合并间隔内遇到过同一个人 → 只刷新已有那条（时间 / hits / 更清晰的原图），不重复堆一张。
  // 判定收口在 vecMatch.pendingDedupeTarget（与后端 store.addPendingFace 同一份口径）。
  const hit = pendingDedupeTarget(list, { vector, thumb }, dedupeSec, now)
  if (hit) {
    hit.at = now
    hit.camName = camName || hit.camName
    hit.hits = (hit.hits || 1) + 1
    // 同一张脸刷新时间，但「后来抓到的这帧」往往更清晰/更完整，顺手更新原图
    if (full) hit.full = full
    // 属性「空则填」：首帧模型可能还没加载完（本地模式懒加载），
    // 不补的话这条记录会一直显示不出徽标。已有值不覆盖（与后端 addPendingFace 同口径）。
    if (hit.gender == null && gender) hit.gender = gender
    if (hit.age == null && age != null) hit.age = Number(age)
    if (!hit.attr && attr) hit.attr = attr
    return { added: false, id: hit.id }
  }
  const id = (list[0] ? list[0].id : 0) + 1
  const m = metrics || {}
  list.unshift({
    id,
    vector: Float32Array.from(vector),
    thumb,
    full: full || '',
    at: now,
    camId: camId || '',
    camName: camName || '',
    hits: 1,
    /*
     * 样本质量（采集时算的，判定在 faceSampleScore.js，与后端共用）。
     * score = -1 = 没算过分；界面据此显示「未评分」而不是"0 分"。
     */
    score: m.score == null ? -1 : Number(m.score),
    boxW: Number(m.boxW) || 0,
    boxH: Number(m.boxH) || 0,
    yaw: Number(m.yaw) || 0,
    sharp: Number(m.sharp) || 0,
    frameW: Number(m.frameW) || 0,
    frameH: Number(m.frameH) || 0,
    // 属性（性别/年龄/口罩眼镜）：本地识别模式与后端 store.addPendingFace 同字段，
    // 让待录入卡片的徽标在「纯前端模式」下也能显示（后端模式本就走 SQLite，不走这里）
    gender: gender || null,
    age: age == null ? null : Number(age),
    attr: attr || null
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
      fromBackend: true,
      /*
       * 样本质量（采集时在后端算的）。score = -1 = 没算过分 ——
       * 老行 / 采集那一刻没拿到几何量。界面据此显示「未评分」而不是 0 分，
       * 因为「0 分」会被读成"这张极差"，而真相是"不知道"。
       */
      score: f.score == null ? -1 : Number(f.score),
      boxW: Number(f.boxW) || 0,
      boxH: Number(f.boxH) || 0,
      yaw: Number(f.yaw) || 0,
      sharp: Number(f.sharp) || 0,
      frameW: Number(f.frameW) || 0,
      frameH: Number(f.frameH) || 0
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

/* ==================== 后端命中样本（命中修正 + 精准度优化） ====================
 *
 * 已入库人脸的命中以前只发事件、不存向量 —— 想修正「认成小刘、实际是大刘」
 * 这种错判时，手里只剩一张图，没有 512 维向量可重新录入，精准度无从提升。
 * 后端现在每次命中都存一条样本（store.addHitFace：向量 + 名字 + 相似度 + 图），
 * 这里负责把它取回来给设置页的「命中修正」区。
 *
 * ⚠️ 修正为什么必须走前端 addFace：前端人脸库是 source of truth，
 *    会通过配置推送自动同步覆盖后端（App.vue watch faces → 推 config）。
 *    后端自己 addFace 会被下一次同步整体替换掉，白录。
 */
export const backendFaceHits = ref([])
export const backendFaceHitsError = ref('')
export const backendFaceHitsLoadedAt = ref(0)

function normBackendFaceHits(base, list) {
  return (Array.isArray(list) ? list : [])
    .filter((h) => h && h.id)
    .map((h) => ({
      id: `h${h.id}`, // 加前缀，避免与待录入条目的 id 撞号
      backendId: Number(h.id),
      vector: h.vector, // 后端返回普通数组，addFace 直接收
      thumb: h.thumb || '',
      full: h.full || '', // 命中时的整帧原图（点缩略图看大图用）
      name: h.name || '', // 当时认定的名字（可能就是认错了的那个）
      score: Number(h.score) || 0,
      at: Number(h.at) || Date.now(),
      camId: h.camId || '',
      camName: h.camName || '',
      fromBackend: true
    }))
}

/** 拉一次后端命中样本（默认 20 条：设置页「命中修正」就展示最近 20 条） */
export async function loadBackendFaceHits(url) {
  const base = String(url || '').replace(/\/+$/, '')
  if (!base) {
    backendFaceHits.value = []
    backendFaceHitsError.value = ''
    backendFaceHitsLoadedAt.value = 0
    return []
  }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('命中样本', 8000)), 8000)
    let res
    try {
      res = await fetch(`${base}/api/face-hits?limit=20`, { signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    backendFaceHits.value = normBackendFaceHits(base, data && data.hits)
    backendFaceHitsError.value = ''
    backendFaceHitsLoadedAt.value = Date.now()
    return backendFaceHits.value
  } catch (e) {
    // 与待录入同口径：失败不清空已有列表（「空白」不许覆盖「非空」），只报错
    backendFaceHitsError.value = netErrorText(e, '命中样本')
    return backendFaceHits.value
  }
}

/**
 * 从后端命中样本里删掉一条（修正录入后、或忽略后调用）。
 *
 * 「修正」的语义：把这条向量按**正确名字**重新录进人脸库（addFace），
 * 之后同一张脸的余弦相似度就落到对的人名下 —— 这条样本的使命完成了，删掉。
 */
export async function dropBackendFaceHit(url, backendId) {
  const base = String(url || '').replace(/\/+$/, '')
  backendFaceHits.value = backendFaceHits.value.filter((h) => h.backendId !== Number(backendId))
  if (!base) return
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(timeoutReason('删除命中样本', 6000)), 6000)
    try {
      await fetch(`${base}/api/face-hit?id=${encodeURIComponent(backendId)}`, { signal: ctrl.signal })
    } finally {
      clearTimeout(t)
    }
  } catch (e) {
    /* 删不掉也只是下次又出现，不影响已录入的人脸 */
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
