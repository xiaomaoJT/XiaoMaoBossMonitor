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
