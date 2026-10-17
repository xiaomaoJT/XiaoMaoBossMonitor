/**
 * 人脸向量的「是不是同一个人」判定（前后端共用单一来源）。
 * ----------------------------------------------------------------------------
 * ⚠️ 为什么单独成文件、零依赖：前端 useFaceLib 和后端 store.mjs 都要用同一套口径，
 * 放这儿两边都 import，避免「前端认为同一个人、后端又插一条」的漂移。
 *
 * 向量是 MobileFaceNet 的 512 维、**已 L2 归一化**的单位向量
 * （见 server/detector.mjs 的 faceEmbedding / normalizeVector），
 * 所以「点积」等价于「余弦相似度」。looksSame 用 >0.5 当作同一人，
 * 和 face-lib 的 matchThreshold（默认 0.38，比对已录入人脸）是两套不同用途的阈值：
 *   - matchThreshold：和「已录入人脸」比，要严格才认得；
 *   - looksSame：和「待录入队列里已有的」比，松一点，只为别把同一个人堆成 N 张。
 */

/** 原始点积（向量已归一化时即余弦相似度） */
export function cosineOrRaw(a, b) {
  if (!a || !b || a.length !== b.length) return -1
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 粗略判断是不是同一张脸（避免同一个人每隔几秒就塞一张进去） */
export function looksSame(a, b) {
  if (!a || !b) return false
  if (!a.thumb || !b.thumb) return false
  if (!a.vector || !b.vector) return false
  return cosineOrRaw(a.vector, b.vector) > 0.5
}

/* ----------------------------------------------------------------------------
 * 待录入队列的「重复捕获合并间隔」（前后端共用单一来源）
 *
 * 场景：同一个人在门口来回走动，每隔几秒就采到一张；队列里很快堆满同一个人的
 * N 张脸，把真正想录入的新面孔挤出去。looksSame 只回答"像不像"，不回答
 * "是不是刚采过"—— 时间窗让采集有"防抖"：窗内再遇到同一个人只刷新已有那条
 * （时间/ hit 数 / 更清晰的原图），窗外再来才新增一条（用最新鲜的样本）。
 *
 * 配置：options.face.pendingDedupeSec（秒）。
 *   - 没配 → 用默认值（升级前后行为兼容：多数人几分钟内被重复采到都能合并）；
 *   - 配 0  → 关闭去重，每张都单独保留（想要"多角度样本库"的人自己关）；
 *   - 上限 86400（一天）——再大没有意义，队列本身按容量滚动删最旧。
 */
export const PENDING_DEDUPE = {
  sec: { def: 300, max: 86400 }
}

/**
 * 解析合并间隔（秒）。「没配」与「配 0」严格分开（与 clampDigestMinutes 同一约定）：
 * 没配回落默认值，显式 0 就是 0（关闭）。
 */
export function pendingDedupeSec(c) {
  const raw = c && c.pendingDedupeSec
  if (raw === undefined || raw === null || raw === '') return PENDING_DEDUPE.sec.def
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return PENDING_DEDUPE.sec.def
  return Math.max(0, Math.min(PENDING_DEDUPE.sec.max, n))
}

/**
 * 在待录入队列里找「应该被合并掉」的那一条，没有则返回 null。
 *
 * @param {Array} list      队列（前端 pendingFaces / 后端 listPendingFaces 的形状都行）
 * @param {{vector:ArrayLike, thumb:string}} incoming 新采到的脸
 * @param {number} windowSec 合并间隔（秒）；<=0 表示关闭去重（直接返回 null）
 * @param {number} [now]     当前 ms 时间戳（可注入，便于测试）
 * @returns {object|null} 命中的队列项（调用方刷新它的 at / hits / full）
 */
export function pendingDedupeTarget(list, incoming, windowSec, now = Date.now()) {
  // 走同一个解析器：没传 → 默认 300；显式 0 → 关闭；越界钳住
  const win = pendingDedupeSec({ pendingDedupeSec: windowSec })
  if (win <= 0 || !Array.isArray(list) || !list.length) return null
  const t = Number(now) || Date.now()
  for (const it of list) {
    if (!looksSame(it, incoming)) continue
    // 窗外（间隔以前采到的）不合并：那人可能是"又来了"，该给一条新鲜样本
    if (!(Number(it.at) >= t - win * 1000)) continue
    return it
  }
  return null
}
