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
 * 打开数据库。
 * v2 新增人脸库 store；升级时只补建缺的 store，不动已有事件数据。
 */
export function openDB() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
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
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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
