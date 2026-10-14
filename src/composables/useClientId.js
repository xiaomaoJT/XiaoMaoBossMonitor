/**
 * 设备标识（cid）
 * ----------------------------------------------------------------------------
 * 后端是**多端共享**的：值守机、办公室电脑、手机可能同时开着同一个局域网地址。
 * 后端要能回答「现在有几台设备连着、分别是谁」，就得先能把"同一个设备的多次
 * 请求"认成同一台 —— 这就是 cid 的用途。
 *
 * 它**不是凭据**，只是一枚随机串：
 *   · 落在本机 localStorage，清站点数据就换一个新的（换来的是"名单里多一条"，不是故障）；
 *   · 后端只拿它做分组计数，鉴权仍然走登录会话（useAuth），两回事。
 *
 * ⚠️ 用 `crypto.getRandomValues` 而**不是** `crypto.randomUUID()`：
 *    后者要求安全上下文（https / localhost），而本项目的部署形态是**局域网明文 http**，
 *    在那里 randomUUID 直接不存在。getRandomValues 在非安全上下文里是可用的。
 *    （与 sha256.js 里"别用 crypto.subtle"是同一类约束。）
 * ⚠️ 相对 import 必须带 `.js`：后端用 Node ESM 直接加载前端模块，不补扩展名。
 */
import { BRAND } from '../config/defaults.js'
import { runtimeInfo } from './useDeviceInfo.js'

const CID_KEY = 'monitor-wall-client-id-v1'

/** 32 位十六进制随机串（非安全上下文也能拿到） */
function randomId() {
  try {
    const a = new Uint8Array(16)
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(a)
    } else {
      for (let i = 0; i < a.length; i += 1) a[i] = Math.floor(Math.random() * 256)
    }
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch (e) {
    // 极端环境下随机源不可用：退化成时间 + 随机数，够区分同一局域网里的几台设备
    return `${Date.now().toString(16)}${Math.floor(Math.random() * 1e9).toString(16)}`
  }
}

let cached = ''

/**
 * 取本机 cid（首次调用时生成并落盘，之后一直复用）。
 * 存不下（隐私模式 / 存储被禁）时退回**本次会话内的**临时 id ——
 * 后果只是"刷新页面后后端看到一条新设备"，不影响任何功能。
 */
export function clientId() {
  if (cached) return cached
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage : null
    const saved = s ? s.getItem(CID_KEY) : ''
    if (saved && /^[0-9a-f]{8,64}$/i.test(saved)) {
      cached = saved
      return cached
    }
    cached = randomId()
    if (s) s.setItem(CID_KEY, cached)
  } catch (e) {
    if (!cached) cached = randomId()
  }
  return cached
}

/**
 * 设备友好名（自报）。
 *
 * 只在**UA 认不出来**的时候报：原生壳（`iOS App` / `Android App`）与 Electron 桌面端
 * （`macOS 桌面端`）—— 这两种后端从 UA 只能看出"苹果 / 安卓 + Safari/Chrome"，
 * 分不清"是 App 还是浏览器"。
 * 普通网页端一律返回空串：它的标签就是 `网页端`，和 UA 推出的「macOS · Chrome」
 * 放在一起是纯重复（界面上会变成两行同一件事）。
 */
export function clientName() {
  try {
    const r = runtimeInfo(BRAND)
    return r && r.kind && r.kind !== 'web' ? r.label || '' : ''
  } catch (e) {
    return ''
  }
}

/**
 * 拼到后端请求上的查询串（`&cid=...&dn=...`）。
 * 统一从这里出，避免"有的接口带了、有的没带"，导致设备在名单里忽在忽不在。
 * @param {boolean} [asFirst] true 时返回以 `?` 开头的形式（URL 上还没有查询串）
 */
export function clientQuery(asFirst = false) {
  const q = `cid=${encodeURIComponent(clientId())}&dn=${encodeURIComponent(clientName())}`
  return asFirst ? `?${q}` : `&${q}`
}
