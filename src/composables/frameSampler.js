/**
 * 帧采样器：从播放器画面里取出可用于分析的缩略帧。
 *
 * 优先直接读取 Jessibuca 渲染用的 <canvas>（快、同步）；
 * 如果读到的画面全黑（说明渲染不在 canvas 上，或 WebGL 缓冲已释放），
 * 自动降级为调用播放器的 screenshot(base64) 兜底。
 */
export class FrameSampler {
  /**
   * @param {object} cfg
   * @param {() => HTMLElement} cfg.getContainer 播放器容器
   * @param {() => any} cfg.getPlayer 播放器实例
   * @param {number} [cfg.width] 缩略帧目标宽度
   */
  constructor({ getContainer, getPlayer, width = 256 }) {
    this.getContainer = getContainer
    this.getPlayer = getPlayer
    this.width = width

    this.canvas = document.createElement('canvas')
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    this.mode = 'canvas' // canvas | screenshot
    this.blankStrikes = 0
  }

  get ready() {
    return this.canvas.width > 0 && this.canvas.height > 0
  }

  _fit(srcW, srcH) {
    const w = this.width
    const h = Math.max(8, Math.round((w * srcH) / srcW))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  /**
   * 取一帧，返回 { canvas, ctx, imageData }；失败返回 null
   */
  async grab() {
    const box = this.getContainer()
    if (!box) return null

    if (this.mode === 'canvas') {
      const src = box.querySelector('canvas')
      if (src && src.width > 1 && src.height > 1) {
        try {
          this._fit(src.width, src.height)
          this.ctx.drawImage(src, 0, 0, this.canvas.width, this.canvas.height)
          const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
          if (!isBlank(imageData.data)) {
            this.blankStrikes = 0
            return { canvas: this.canvas, ctx: this.ctx, imageData }
          }
          // 连续 3 次全黑 → 判定该渲染方式不支持直接读画布
          this.blankStrikes += 1
          if (this.blankStrikes >= 3) this.mode = 'screenshot'
        } catch (e) {
          this.mode = 'screenshot'
        }
      } else {
        this.blankStrikes += 1
        if (this.blankStrikes >= 3) this.mode = 'screenshot'
      }
    }

    // ---- 截图兜底 ----
    const player = this.getPlayer()
    if (!player || typeof player.screenshot !== 'function') return null
    let b64 = null
    try {
      b64 = player.screenshot('', 'png', 1, 'base64')
    } catch (e) {
      return null
    }
    if (!b64 || typeof b64 !== 'string') return null
    if (!b64.startsWith('data:')) b64 = `data:image/png;base64,${b64}`
    const img = await loadImage(b64)
    if (!img) return null
    this._fit(img.naturalWidth || 320, img.naturalHeight || 180)
    this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height)
    const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
    if (isBlank(imageData.data)) return null
    return { canvas: this.canvas, ctx: this.ctx, imageData }
  }
}

function isBlank(data) {
  // 抽样检查亮度，避免逐像素遍历
  let max = 0
  for (let i = 0; i < data.length; i += 4 * 37) {
    const v = Math.max(data[i], data[i + 1], data[i + 2])
    if (v > max) max = v
    if (max > 12) return false
  }
  return true
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}
