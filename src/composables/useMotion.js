/**
 * 运动检测（帧差法）：纯前端、零模型、几乎不吃 CPU 的「有人/物体移动」判断。
 *
 * 思路：把画面缩到 ~256px 宽转灰度，与上一帧做逐像素差分，
 * 统计变化像素占比，超过灵敏度阈值即认为该区域有移动。
 */

/** 灵敏度 1(最不敏感) ~ 10(最敏感) → 变化像素占比阈值 */
export function sensitivityToThreshold(sensitivity) {
  const s = Math.min(10, Math.max(1, Number(sensitivity) || 5))
  // 1 → 3.2%   10 → 0.32%
  return 0.032 - (s - 1) * 0.0032
}

/** 把归一化 ROI（0~1）换算成像素范围 */
export function roiToRect(roi, width, height) {
  if (!roi || typeof roi !== 'object') return { x0: 0, y0: 0, x1: width, y1: height }
  const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0))
  const x0 = Math.floor(clamp(roi.x) * width)
  const y0 = Math.floor(clamp(roi.y) * height)
  const x1 = Math.ceil(clamp(roi.x + roi.w) * width)
  const y1 = Math.ceil(clamp(roi.y + roi.h) * height)
  return {
    x0: Math.max(0, Math.min(x0, width - 1)),
    y0: Math.max(0, Math.min(y0, height - 1)),
    x1: Math.max(x0 + 1, Math.min(x1, width)),
    y1: Math.max(y0 + 1, Math.min(y1, height))
  }
}

/** 生成灰度数组 */
function toGray(imageData) {
  const { data } = imageData
  const len = data.length / 4
  const gray = new Uint8ClampedArray(len)
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    gray[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
  }
  return gray
}

/**
 * 比较当前帧与上一帧
 * @returns {{ gray: Uint8ClampedArray, ratio: number, changed: number, total: number, box: object|null }}
 */
export function compareFrames(prevGray, imageData, roi, pixelThreshold = 22) {
  const w = imageData.width
  const h = imageData.height
  const gray = toGray(imageData)
  const rect = roiToRect(roi, w, h)

  let changed = 0
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1

  if (prevGray && prevGray.length === gray.length) {
    for (let y = rect.y0; y < rect.y1; y += 1) {
      const row = y * w
      for (let x = rect.x0; x < rect.x1; x += 1) {
        const idx = row + x
        if (Math.abs(gray[idx] - prevGray[idx]) > pixelThreshold) {
          changed += 1
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
  }

  const total = Math.max(1, (rect.x1 - rect.x0) * (rect.y1 - rect.y0))
  const box =
    maxX >= minX
      ? { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h }
      : null

  return { gray, ratio: changed / total, changed, total, box }
}
