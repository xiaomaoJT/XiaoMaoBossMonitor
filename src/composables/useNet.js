/**
 * 网络小工具：给 fetch 加超时 + 把「被掐断」翻译成人话。
 *
 * 为什么必须加超时：
 *   有些接口（境外图床、被墙域名、网络黑洞，以及**正在自愈重启、连接半开的后端**）
 *   不会快速失败，而是把连接一直挂着，请求既不成功也不报错。
 *   上层 `await` 卡住 → 事件状态永远停在「正在推送」。
 *   加上超时后，最坏情况也只是「推送失败：请求超时」，状态一定能落定。
 *
 * AbortSignal.timeout 在较老的 WebView（部分 iOS / 小程序内核）里没有，
 * 这里做一次手工降级，保证任何环境都能用。
 */

/**
 * 超时那一刻给 abort 带的理由。
 *
 * 为什么要专门造一个：`ctrl.abort()` 不传参数时，signal.reason 是**引擎自带**的
 * 一个 DOMException，文案长这样 ——
 *   Chromium: "signal is aborted without reason"
 *   Node:     "This operation was aborted"
 *   Firefox:  "The operation was aborted."
 * 而 fetch 的 rejection 就是这个 reason，于是上游只要写一句
 * `errText = e.message`，这句英文就会**原样出现在界面上**
 * （「后端检测服务：连接失败 signal is aborted without reason」）。
 * 用户看不懂，也完全无法据此判断"是超时还是对方挂了"。
 *
 * 带上理由之后，`e.message` 直接就是能读的中文，而且 `e.name === 'TimeoutError'`
 * 还能和「用户主动取消」（AbortError）区分开 —— 这两件事的处理完全相反。
 *
 * @param {string} what 干什么（用在地道的中文句子里，如「后端状态」）
 * @param {number} ms   超时毫秒数
 */
export function timeoutReason(what = '请求', ms = 0) {
  const sec = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms)} 毫秒`
  const e = new Error(`${what}请求超时（${sec}未响应）`)
  e.name = 'TimeoutError'
  return e
}

/**
 * 是不是「我们自己掐断的」。
 *
 * 判据同时看 name 与文案：第三方库（jessibuca / 浏览器自身）掐断时往往
 * 只留下引擎文案、name 未必是我们认得的那个，两种都要认。
 */
export function isAbortError(e) {
  if (!e) return false
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true
  const msg = String((e && e.message) || e)
  return /signal is aborted|timed out|operation was aborted|请求超时/i.test(msg)
}

/**
 * 把网络异常翻成一句人话。
 *
 * 关键点：**超时不是对方的错，也不是程序的故障** —— 它是我们自己设的闸门到点了。
 * 所以这里不能把引擎文案透出去，必须换成能读的说明。
 *
 * 同一类问题还有一种：**连接直接失败**。引擎给的也是英文
 * （Chrome `Failed to fetch` / Firefox `NetworkError when attempting to fetch resource.` /
 *  Safari `Load failed`），同样看不懂，同样要翻。
 * 判据与 useErrorLog.normalizeMessage 里那一条保持一致 —— 都是"连不上对方"这件事。
 *
 * ⚠️ 只翻这两类**引擎文案**；HTTP 状态码之类的业务错误必须原样透出
 *    （「HTTP 500」是有信息量的，覆盖成"连不上"反而把人引到错误方向上）。
 *
 * @param {*} e      捕获到的异常
 * @param {string} what 干什么（如「后端状态」「配置拉取」）
 */
export function netErrorText(e, what = '请求') {
  if (isAbortError(e)) return `${what}超时：对方在限定时间内没有响应`
  const msg = (e && (e.message || String(e))) || ''
  if (!msg) return `${what}失败`
  if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
    return `${what}失败：连不上对方（网络不通 / 服务没起来 / 地址不对）`
  }
  return msg
}

export function timeoutSignal(ms = 20000) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    try {
      return AbortSignal.timeout(ms)
    } catch (e) {
      /* 落到下面的降级实现 */
    }
  }
  if (typeof AbortController === 'undefined') return undefined
  const ac = new AbortController()
  setTimeout(() => {
    try {
      ac.abort(timeoutReason('请求', ms))
    } catch (e) {
      ac.abort()
    }
  }, ms)
  return ac.signal
}
