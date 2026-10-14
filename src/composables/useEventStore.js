/**
 * 事件存储：IndexedDB
 * ----------------------------------------------------------------------------
 * 为什么要换掉 localStorage：
 *   - localStorage 只有约 5MB，还要和配置共用，几百张原图截图根本放不下；
 *   - IndexedDB 一般有几百 MB ~ 数 GB 配额，够存 200+ 条带原图的事件。
 *
 * 内存策略（省内存，手机上尤其重要）：
 *   - IndexedDB 里存完整记录（含 `shot` 原图 dataURL，可能几百 KB）；
 *   - 页面内存里只保留 `thumb` 小缩略图（几十 KB）；
 *   - 详情弹窗打开时才按 key 把原图从库里捞出来。
 */
const DB_NAME = 'monitor-wall-db'
const DB_VERSION = 2
const STORE = 'events'
/** 人脸库（特征向量 + 缩略图） */
const FACE_STORE = 'faces'
/** 旧版本 localStorage 里的历史记录，迁移完就删掉 */
const LEGACY_KEY = 'monitor-alarm-history-v1'

let dbPromise = null

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function isAvailable() {
  return typeof indexedDB !== 'undefined'
}

/**
 * 打开数据库超时（毫秒）。
 * 见下面 openDB 的说明：这是"绝不永久 pending"的兜底，不是性能调优参数。
 */
const OPEN_TIMEOUT_MS = 10000

/**
 * 打开数据库。
 * v2 新增人脸库 store；升级时只补建缺的 store，不动已有事件数据。
 *
 * ⚠️ 这个 Promise 会被**缓存**在 dbPromise 里，所以它**绝不能永远不落地**。
 *
 * 起因是一个真实的"改了名但保存不了、刷新前怎么点都没反应"：只要这个 Promise
 * 卡在 pending，后面**每一次**人脸 / 事件读写都排在它后面（transaction 拿不到 db），
 * 界面上就是「点改名没反应 / 一直转 / 经常卡住」，而且不会有任何报错——
 * 因为没有任何东西被拒绝。
 *
 * 三条真实的"永不落地"路径，以前一条都没处理：
 *   1. 另一个标签页还持有**旧版本**连接 → 升级被阻塞：onupgradeneeded 不触发、
 *      onsuccess 也不来，连 onerror 都没有，**只有 onblocked 会响**（以前没监听）。
 *      这是同一个应用开两个标签页时最常见的卡死原因。
 *   2. 隐私模式 / 存储被禁用时某些实现既不 success 也不 error。
 *   3. 升级过程中被别的连接"堵着"，用户又不去关那个标签页 —— 无限期等。
 *
 * 所以：onblocked 立刻报错；再加一根超时兜底。两条路都要**清掉缓存**——
 * 不清的话，一次卡死就把这个页面永久钉死，只能刷新；清了以后下一次调用还能重试
 * （重新 open 一次是完全安全的，大不了多一个连接）。
 */
export function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    let settled = false
    let timer = null
    const fail = (msg) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // 关键：把缓存清掉，允许下一次重试（否则一次失败 = 本页永久失效）
      dbPromise = null
      reject(msg instanceof Error ? msg : new Error(msg))
    }
    timer = setTimeout(() => fail(`打开本地数据库超时（${OPEN_TIMEOUT_MS / 1000}s），请关闭本应用的其它标签页后重试`), OPEN_TIMEOUT_MS)

    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' })
        os.createIndex('time', 'time')
      }
      if (!db.objectStoreNames.contains(FACE_STORE)) {
        // 人脸库：以自增 id 为主键，按录入时间排序
        const fs = db.createObjectStore(FACE_STORE, { keyPath: 'id', autoIncrement: true })
        fs.createIndex('createdAt', 'createdAt')
      }
    }
    // 被别的标签页阻塞：立刻给出**能照做**的原因，而不是干等
    req.onblocked = () => fail(new Error('本地数据库正被本应用的其它标签页占用，请关掉其它标签页后重试'))
    req.onsuccess = () => {
      if (settled) {
        // 已经超时报错了，这个连接没人要 —— 关掉，别占着
        try {
          req.result.close()
        } catch (e) {}
        return
      }
      settled = true
      if (timer) clearTimeout(timer)
      resolve(req.result)
    }
    req.onerror = () => fail('打开本地数据库失败：' + ((req.error && req.error.message) || req.error || '未知原因'))
  })
  return dbPromise
}

export const FACE_STORE_NAME = FACE_STORE

/** 写入 / 覆盖一条完整记录（含截图） */
export async function putEvent(record) {
  const db = await openDB()
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
  return reqAsPromise(store.put(record))
}

/** 只改部分字段（不会把没传进来的截图冲掉） */
export async function patchEvent(key, patch) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    const getReq = store.get(key)
    getReq.onsuccess = () => {
      const cur = getReq.result
      if (cur) store.put({ ...cur, ...patch })
      else store.put({ key, time: Date.now(), ...patch })
    }
    t.oncomplete = () => resolve(true)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('transaction aborted'))
  })
}

/**
 * 归一化「卡住的推送状态」。
 * ----------------------------------------------------------------------------
 * `sending` / `queued` 只在一次推送的生命周期内有意义。如果应用在推送途中
 * 被关闭、刷新或崩溃（进程直接消失，没有机会回写结果），这两个状态会被
 * 永久留在库里 —— 事件列表就会一直显示「正在推送…」，让人误以为推送没成功。
 *
 * 应用启动时调用一次：把残留的 sending / queued 标记为失败并说明原因。
 * 启动瞬间必然没有任何推送正在进行，所以这里不会误伤。
 * @returns {Promise<number>} 被修正的记录条数
 */
export async function normalizeStuckPushes() {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    let fixed = 0
    const req = store.openCursor()
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return
      const v = cur.value
      if (v && (v.push === 'sending' || v.push === 'queued')) {
        const wasQueued = v.push === 'queued'
        v.push = 'fail'
        v.pushChannels = ''
        v.pushError = wasQueued
          ? '排队中的合并推送未发出（应用已重启）'
          : '推送未完成（应用在推送途中被关闭或刷新）'
        cur.update(v)
        fixed += 1
      }
      cur.continue()
    }
    t.oncomplete = () => resolve(fixed)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('transaction aborted'))
  })
}

/**
 * 批量标记已读 / 未读（只动 read 字段，不碰截图）。
 * 已读状态跟记录一起持久化，刷新页面后不会丢。
 */
export async function markRead(keys, read = true) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean)
  if (!list.length) return true
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    list.forEach((k) => {
      const getReq = store.get(k)
      getReq.onsuccess = () => {
        const cur = getReq.result
        if (!cur) return
        cur.read = read
        store.put(cur)
      }
    })
    t.oncomplete = () => resolve(true)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('transaction aborted'))
  })
}

export async function deleteEvents(keys) {
  if (!keys || !keys.length) return
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    keys.forEach((k) => store.delete(k))
    t.oncomplete = () => resolve(true)
    t.onerror = () => reject(t.error)
  })
}

/**
 * 按「保留最近 keep 条」滚动清理。
 * ----------------------------------------------------------------------------
 * 页面里那套「内存截断 + 删掉被挤出去的」只管本次会话挤掉的记录：
 * 用户把「最多保留条数」从 2000 调到 200 之后，库里那 1800 条老记录
 * 既不在列表里、也不会被删 —— 就这么一直占着空间（每条还带一张原图）。
 *
 * 这里按 time 索引从新到旧走一遍游标，跳过前 keep 条，剩下的直接删。
 * 用游标而不是 getAll：原图是 dataURL，全量读出来会有上百 MB 的内存峰值，
 * 而清理只需要 key。
 *
 * @param {number} keep 保留条数
 * @returns {Promise<number>} 实际删除条数
 */
export async function pruneEvents(keep) {
  const limit = Math.max(1, Number(keep) || 200)
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const idx = t.objectStore(STORE).index('time')
    let seen = 0
    let deleted = 0
    const req = idx.openCursor(null, 'prev') // 新 → 旧
    req.onsuccess = () => {
      const cur = req.result
      if (!cur) return
      seen += 1
      if (seen > limit) {
        cur.delete()
        deleted += 1
      }
      cur.continue()
    }
    t.oncomplete = () => resolve(deleted)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('transaction aborted'))
  })
}

export async function clearEvents() {
  const db = await openDB()
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE)
  return reqAsPromise(store.clear())
}

/** 全量读取（按时间倒序），用于导出 */
export async function getAllEvents() {
  const db = await openDB()
  const all = await reqAsPromise(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())
  return (all || []).sort((a, b) => (b.time || 0) - (a.time || 0))
}

/** 按需取一条（详情弹窗拿原图用） */
export async function getEvent(key) {
  const db = await openDB()
  const store = db.transaction(STORE, 'readonly').objectStore(STORE)
  return reqAsPromise(store.get(key))
}

/** 去掉截图字段，得到可以放进页面内存的轻量版本 */
export function toLightRecord(record) {
  if (!record) return record
  const { shot, ...rest } = record
  return shot ? { ...rest, shotInStore: true } : { ...rest }
}

/**
 * 把旧版本 localStorage 里的历史记录搬进 IndexedDB（只跑一次）。
 * 迁移完成后会删掉旧的 localStorage key。
 */
export async function migrateLegacyHistory() {
  if (!isAvailable()) return []
  let legacy = null
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw) legacy = JSON.parse(raw)
  } catch (e) {
    legacy = null
  }
  if (!Array.isArray(legacy) || !legacy.length) return []

  try {
    await putEvents(legacy)
    localStorage.removeItem(LEGACY_KEY)
  } catch (e) {
    /* 迁移失败不影响主流程 */
  }
  return legacy
}

export async function putEvents(list) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite')
    const store = t.objectStore(STORE)
    list.forEach((r) => r && r.key && store.put(r))
    t.oncomplete = () => resolve(true)
    t.onerror = () => reject(t.error)
  })
}

/** 粗略估算占用（给设置页展示） */
export async function estimateUsage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate()
      return { usage: e.usage || 0, quota: e.quota || 0 }
    }
  } catch (e) {
    /* 忽略 */
  }
  return null
}

export function formatBytes(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
