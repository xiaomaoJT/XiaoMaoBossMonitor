/**
 * 待录入人脸的「样本质量」打分（纯函数，前后端共用）
 * ============================================================================
 * 场景：待录入队列里一堆抓到的脸，用户要挑「哪张值得录进人脸库」。
 * 挑错了的代价极不对称 —— 录一张侧脸/糊脸进去，匹配时**拉低**的不是这一张，
 * 而是整个名字（库内同人相似度被废样本摊薄，真人反而认不出来）。
 * 所以这里给三个**可解释**的分项，而不是一个黑箱分数：
 *
 *   ① 人脸尺寸  —— 原帧里人脸框的边长（像素）。脸太小，MobileFaceNet 的
 *                  112×112 对齐就是纯插值，特征不可靠（本项目实测：侧脸 +
 *                  小脸 = 同人相似度掉到 0.2 量级）。
 *   ② 清晰度    —— 对齐裁切上的拉普拉斯方差（高频能量）。糊脸/运动模糊的
 *                  特征是噪声，录进去只会制造误匹配。
 *   ③ 正脸程度  —— 复用 defaults.yawFromKps（SCRFD 5 点算鼻尖相对眼连线的
 *                  偏移）。**这是本项目的头号病因**：库里多数样本是大侧脸 /
 *                  俯视，导致同人/异人两个分布重叠、无可用工作点。
 *
 * ⚠️ 为什么不用「整张 thumb 的对称度/肤色」这类图像启发式：
 *    实测（26 条库样本 + 50 条待录入）那样算出来的排序与「是不是正脸」
 *    基本无关 —— thumb 是带 12%  padding 的宽松裁切（头发、背景都在里面），
 *    在它上面算对称度等于在噪声上排序。**必须回到检测器给的几何量**。
 *
 * 所有阈值都集中在下面的 SCALE 里，改口径只改这一处；展示层与后端算的是
 * 同一个函数，不会出现「设置页说优、后端当废帧丢」。
 */

/** 各分项的归一化区间（输入物理量 → 0..1 的线性映射端点） */
export const SAMPLE_SCORE_SCALE = {
  /** 人脸框短边（像素）：30px 以下判 0，110px 及以上判 1 */
  size: { min: 30, max: 110 },
  /** 拉普拉斯方差（对齐裁切灰度）：0 判 0，此值判 1 */
  sharp: { min: 0, max: 60 },
  /** |偏航|（归一化眼距倍数）：0 判 1，达到此值判 0 */
  yaw: { max: 0.35 },
  /** 检测置信度低于此值的样本，整项打折（SCRFD 自己都没把握的脸） */
  minDet: 0.5
}

/** 三个分项的权重：正脸程度权重最高（本项目根因就是侧脸样本） */
export const SAMPLE_SCORE_WEIGHTS = { size: 0.25, sharp: 0.3, front: 0.45 }

/** 线性归一化到 [0,1]；越界夹住 */
function unit(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  if (hi === lo) return n >= hi ? 1 : 0
  return Math.max(0, Math.min(1, (n - lo) / (hi - lo)))
}

/** 灰度拉普拉斯方差（4 邻域）。清晰度代理：糊图高频能量低。 */
export function laplacianVar(gray, w, h) {
  if (!gray || !w || !h || w < 3 || h < 3) return 0
  let s = 0
  let s2 = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      s += lap
      s2 += lap * lap
      n++
    }
  }
  if (!n) return 0
  const mean = s / n
  const varr = s2 / n - mean * mean
  return varr > 0 ? varr : 0
}

/** RGBA → 灰度（Rec.601），供 laplacianVar 用 */
export function toGray(rgba, w, h) {
  const g = new Float32Array(w * h)
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
  }
  return g
}

/**
 * 由一份「检测结果 + 原帧几何 + 对齐裁切灰度」算出三个分项与总分。
 *
 * @param {object} m
 * @param {{x:number,y:number,w:number,h:number}} m.box 归一化人脸框
 * @param {Array<{x:number,y:number}>} m.kps SCRFD 5 点（归一化）
 * @param {number} m.frameW 原帧宽（像素）
 * @param {number} m.frameH 原帧高（像素）
 * @param {Float32Array} [m.gray] 对齐裁切的灰度（缺省则清晰度记 0）
 * @param {number} [m.cropW] 裁切宽
 * @param {number} [m.cropH] 裁切高
 * @param {number} [m.det] 检测置信度
 * @returns {{boxW:number, boxH:number, yaw:number, sharp:number,
 *            sizeScore:number, sharpScore:number, frontScore:number, total:number}}
 */
export function faceSampleScore(m) {
  const box = (m && m.box) || {}
  const frameW = Number(m && m.frameW) || 0
  const frameH = Number(m && m.frameH) || 0
  const gray = m && m.gray
  const p = scoreParts(
    (Number(box.w) || 0) * frameW,
    (Number(box.h) || 0) * frameH,
    gray ? laplacianVar(gray, Number(m.cropW) || 0, Number(m.cropH) || 0) : 0,
    m && m.yaw,
    m && m.det
  )
  return {
    boxW: p.boxW,
    boxH: p.boxH,
    yaw: p.yaw,
    sharp: p.sharp,
    sizeScore: p.sizeScore,
    sharpScore: p.sharpScore,
    frontScore: p.frontScore,
    total: p.total
  }
}

/**
 * 三个分项的原始物理量 → 归一化分项 + 总分。
 *
 * **唯一口径**：正算（faceSampleScore，手里有整帧）与回算（sampleScoreFromMetrics，
 * 只有库里存的几何量）都走这一份，否则同一个样本会算出两个分数。
 *
 * @param {number} boxW 人脸框宽（原帧像素）
 * @param {number} boxH 人脸框高（原帧像素）
 * @param {number} sharp 拉普拉斯方差（对齐裁切灰度）
 * @param {number} yaw 偏航（归一化眼距倍数，可正可负）
 * @param {number} [det] 检测置信度（<=0 表示未知，不打折）
 */
function scoreParts(boxW, boxH, sharp, yawIn, det) {
  const w = Math.round(Number(boxW) || 0)
  const h = Math.round(Number(boxH) || 0)
  const short = Math.min(w, h)
  const sh = Math.max(0, Number(sharp) || 0)
  const yaw = Number(yawIn) || 0
  const sizeScore = unit(short, SAMPLE_SCORE_SCALE.size.min, SAMPLE_SCORE_SCALE.size.max)
  const sharpScore = unit(sh, SAMPLE_SCORE_SCALE.sharp.min, SAMPLE_SCORE_SCALE.sharp.max)
  const frontScore = Math.max(0, Math.min(1, 1 - Math.abs(yaw) / SAMPLE_SCORE_SCALE.yaw.max))
  let total =
    sizeScore * SAMPLE_SCORE_WEIGHTS.size +
    sharpScore * SAMPLE_SCORE_WEIGHTS.sharp +
    frontScore * SAMPLE_SCORE_WEIGHTS.front
  // 检测器自己都没把握的脸，整体打折（但不归零：可能是姿态极端导致漏分）
  const d = Number(det)
  if (Number.isFinite(d) && d > 0 && d < SAMPLE_SCORE_SCALE.minDet) total *= d / SAMPLE_SCORE_SCALE.minDet
  return {
    boxW: w,
    boxH: h,
    yaw,
    sharp: sh,
    sizeScore: round2(sizeScore),
    sharpScore: round2(sharpScore),
    frontScore: round2(frontScore),
    total: round2(total)
  }
}

/**
 * 采集时算出的一批「待录入入库字段」。
 *
 * **为什么需要这一层封装**：faceSampleScore() 回答的是「三个分项各多少、为什么」，
 * 里面叫 `total`；而写入方（store.addPendingFace / useFaceLib.pushPendingFace）
 * 期望的是**落库字段**：多了 frameW/frameH/det，且总分列名叫 `score`。
 * 以前两边各读各的 —— 写入方读 `m.score`，而这个字段根本不存在，
 * 于是 score 恒落 -1、scored_at 恒为 0，待录入列表**一律显示「未评分」**。
 * 现在把「分项解释」到「入库形状」的映射收在这一个函数里，前后端共用，
 * 再加字段只改这里，不会再出现「一边算一边读不到」。
 *
 * @param {object} input 与 faceSampleScore 同一份入参
 *        （box / frameW / frameH / gray / cropW / cropH / det / yaw）
 * @returns {{score:number, boxW:number, boxH:number, yaw:number, sharp:number,
 *            det:number, frameW:number, frameH:number}}
 */
export function pendingSampleMetrics(input) {
  const m = input || {}
  const aligned = {
    boxW: (Number(m.box && m.box.w) || 0) * (Number(m.frameW) || 0),
    boxH: (Number(m.box && m.box.h) || 0) * (Number(m.frameH) || 0),
    sharp: m.gray ? laplacianVar(m.gray, Number(m.cropW) || 0, Number(m.cropH) || 0) : 0,
    yaw: m.yaw,
    det: m.det
  }
  const p = scoreParts(aligned.boxW, aligned.boxH, aligned.sharp, aligned.yaw, aligned.det)
  return {
    score: p.total,
    boxW: p.boxW,
    boxH: p.boxH,
    yaw: p.yaw,
    sharp: p.sharp,
    det: Number(m.det) || 0,
    frameW: Math.round(Number(m.frameW) || 0),
    frameH: Math.round(Number(m.frameH) || 0)
  }
}

/**
 * 只用「库里存下来的几何量」回算总分（用于给历史行补分）。
 *
 * 与 pendingSampleMetrics 的差别只有一处：**没有 gray，清晰度用库里那份 sharp**。
 * 那份 sharp 是采集时在同一张对齐裁切上算的拉普拉斯方差，和现在的算法同源，
 * 所以回算结果与当时应得的分数一致（只差检测置信度打折，老行 det 丢了）。
 *
 * 判据：`boxW > 0 && boxH > 0` 才算「量过几何量」。补列之前的老行这两列是
 * DEFAULT 0 —— 对着 0 算会把 `yaw=0` 当成完美正脸，得到一份假高分，
 * 比「未评分」更坏（用户会照着假分去挑样本）。那种行**继续返回 -1**，
 * 界面如实显示「未评分」。
 *
 * @param {{boxW:number,boxH:number,yaw:number,sharp:number,det?:number}} m
 * @returns {number} 0..1 的总分；-1 = 没有几何量、算不出来
 */
export function sampleScoreFromMetrics(m) {
  const w = Math.round(Number(m && m.boxW) || 0)
  const h = Math.round(Number(m && m.boxH) || 0)
  if (w <= 0 || h <= 0) return -1
  return scoreParts(w, h, m && m.sharp, m && m.yaw, m && m.det).total
}

function round2(v) {
  return Math.round(v * 100) / 100
}

/**
 * 只用「库里存下来的几何量」回算**分项**（尺寸 / 清晰度 / 正脸 各自的 0..1，
 * 以及总分）。给「命中修正」卡片做明细展示用（命中样本也按待录入同口径打分）。
 *
 * 与 sampleScoreFromMetrics 的关系：它只回算总分，这个函数回算**分项**。
 * 两者共用同一份 scoreParts，不会算出两个分数。
 *
 * 判据同 sampleScoreFromMetrics：`boxW > 0 && boxH > 0` 才算量过几何量；
 * 否则返回 null（界面按「未评分」处理，不显示假分项）。
 *
 * @param {{boxW:number,boxH:number,yaw:number,sharp:number,det?:number}} m
 * @returns {{boxW:number,boxH:number,yaw:number,sharp:number,
 *            sizeScore:number,sharpScore:number,frontScore:number,total:number}|null}
 */
export function sampleScoreBreakdown(m) {
  const w = Math.round(Number(m && m.boxW) || 0)
  const h = Math.round(Number(m && m.boxH) || 0)
  if (w <= 0 || h <= 0) return null
  return scoreParts(w, h, m && m.sharp, m && m.yaw, m && m.det)
}

/**
 * 命中样本「推荐录入人脸库」的判定。
 *
 * 用户诉求：相似度高 + 角度好（质量好）的命中样本，推荐一键补录进人脸库，
 * 强化该人在库底（addFace 按名字归组，向已存在的人名下补样本即强化底库）。
 *
 * 两个门槛：
 *   ① 余弦相似度要高（HIT_RECOMMEND_SIMILARITY）—— 模型对「就是这个人」很确信；
 *   ② 样本质量要好（>= SAMPLE_SCORE_RECOMMEND，即「良」）—— 脸够大、清晰、正脸。
 * 任一不满足都不推荐：相似度低说明可能是临界误命中，质量差说明录进去会拉低底库。
 * 质量分 < 0（未评分 / 没量过几何量）一律不推荐 —— 没把握的样本不该被鼓励录入。
 *
 * @param {number} similarity 命中时的余弦相似度（0..1，即 hit.score）
 * @param {number} faceScore 命中样本的质量总分（0..1；<0 表示未评分）
 * @returns {boolean}
 */
export function hitRecommend(similarity, faceScore) {
  const s = Number(similarity)
  const q = Number(faceScore)
  if (!Number.isFinite(s) || !Number.isFinite(q)) return false
  if (q < 0) return false
  return s >= HIT_RECOMMEND_SIMILARITY && q >= SAMPLE_SCORE_RECOMMEND
}

/** 「推荐录入」的余弦相似度门槛：高于它才说明模型对「就是这个人」足够确信 */
export const HIT_RECOMMEND_SIMILARITY = 0.6

/**
 * 总分 → 一句话结论（给界面直接显示）。
 * 阈值与分项解耦：这里只解释「这张样本值不值得录」，不重复算分。
 */
export function sampleQualityLabel(total) {
  const t = Number(total)
  if (!Number.isFinite(t)) return { key: 'unknown', text: '未评分', tone: 'muted' }
  if (t >= 0.75) return { key: 'great', text: '优', tone: 'ok' }
  if (t >= 0.55) return { key: 'good', text: '良', tone: 'ok' }
  if (t >= 0.35) return { key: 'fair', text: '一般', tone: 'warn' }
  return { key: 'poor', text: '差', tone: 'bad' }
}

/** 「建议先录这些」的阈值：低于它的样本大概率是侧脸/糊脸/太小 */
export const SAMPLE_SCORE_RECOMMEND = 0.55
