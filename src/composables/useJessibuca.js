/**
 * Jessibuca 解码器的按需等待
 * ----------------------------------------------------------------------------
 * jessibuca.js（469KB）在 index.html 里是 `defer` 引入的：它不再阻塞 HTML 解析，
 * 也不再拖住 App 的挂载 —— 顶栏、设置抽屉、事件列表都能立刻显示出来。
 *
 * 代价是「要播画面的时候解码器可能还没就绪」，所以原来放在 main.js 里的那段
 * 轮询等待搬到了这里，由 CameraTile 在真正创建播放器前调用：
 *   - 未就绪 → 显示「解码器加载中…」，而不是直接报「播放器未加载」；
 *   - 等待超时 → 返回 false，调用方给出可重试的错误态。
 */

/** 是否已就绪（同步判断，用于快速路径） */
export function isJessibucaReady() {
  return typeof window !== 'undefined' && typeof window.Jessibuca === 'function'
}

/** 正在等待中的 Promise，多个画面同时初始化时只轮询一份 */
let pending = null

/**
 * 等待解码器就绪。
 * @param {number} [timeout] 超时毫秒数，默认 15 秒
 * @returns {Promise<boolean>} 就绪返回 true，超时返回 false
 */
export function ensureJessibuca(timeout = 15000) {
  if (isJessibucaReady()) return Promise.resolve(true)
  if (pending) return pending

  pending = new Promise((resolve) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (isJessibucaReady()) {
        clearInterval(timer)
        resolve(true)
        return
      }
      if (Date.now() - startedAt > timeout) {
        clearInterval(timer)
        // 置空以便下次调用能重新发起等待（比如用户点重连）
        pending = null
        resolve(false)
      }
    }, 60)
  })

  return pending
}
