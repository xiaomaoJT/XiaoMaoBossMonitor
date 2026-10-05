/**
 * 网络小工具：给 fetch 加超时。
 *
 * 为什么必须加：
 *   有些接口（境外图床、被墙域名、网络黑洞）不会快速失败，而是把连接一直挂着，
 *   请求既不成功也不报错。上层 `await` 卡住 → 事件状态永远停在「正在推送」。
 *   加上超时后，最坏情况也只是「推送失败：请求超时」，状态一定能落定。
 *
 * AbortSignal.timeout 在较老的 WebView（部分 iOS / 小程序内核）里没有，
 * 这里做一次手工降级，保证任何环境都能用。
 */
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
      ac.abort(new Error(`请求超时（${ms}ms 无响应）`))
    } catch (e) {
      ac.abort()
    }
  }, ms)
  return ac.signal
}
