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
  const boxW = Math.round((Number(box.w) || 0) * frameW)
  const boxH = Math.round((Number(box.h) || 0) * frameH)
  const short = Math.min(boxW, boxH)
  const sizeScore = unit(short, SAMPLE_SCORE_SCALE.size.min, SAMPLE_SCORE_SCALE.size.max)
  const sharp = m && m.gray ? laplacianVar(m.gray, Number(m.cropW) || 0, Number(m.cropH) || 0) : 0
  const sharpScore = unit(sharp, SAMPLE_SCORE_SCALE.sharp.min, SAMPLE_SCORE_SCALE.sharp.max)
  const yaw = Math.abs(Number(m && m.yaw)) || 0
  const frontScore = Math.max(0, Math.min(1, 1 - yaw / SAMPLE_SCORE_SCALE.yaw.max))
  let total =
    sizeScore * SAMPLE_SCORE_WEIGHTS.size +
    sharpScore * SAMPLE_SCORE_WEIGHTS.sharp +
    frontScore * SAMPLE_SCORE_WEIGHTS.front
  // 检测器自己都没把握的脸，整体打折（但不归零：可能是姿态极端导致漏分）
  const det = Number(m && m.det)
  if (Number.isFinite(det) && det > 0 && det < SAMPLE_SCORE_SCALE.minDet) total *= det / SAMPLE_SCORE_SCALE.minDet
  return {
    boxW,
    boxH,
    yaw: Number(m && m.yaw) || 0,
    sharp,
    sizeScore: round2(sizeScore),
    sharpScore: round2(sharpScore),
    frontScore: round2(frontScore),
    total: round2(total)
  }
}

function round2(v) {
  return Math.round(v * 100) / 100
}

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
