/**
 * 登录会话（前端门禁）
 * ----------------------------------------------------------------------------
 * 目标：**没登录就不让看画面**。登录页本身是 src/components/LoginView.vue，
 * 挂载开关在 src/LoginGate.vue —— 但"门禁该拦在哪一层"取决于**监测在不在这台机器上**，
 * 也就是 authState.backendMode（判据与顶栏那颗「后端模式 / 前端模式」徽标同源）：
 *
 *   · 前端模式（本页就是监测本身）：未登录时 App.vue **根本不挂载**。
 *     这不是盖一层遮罩，是连组件都不实例化 —— 没登录就不会有流被拉起来、
 *     也不会有任何本地检测在跑。退出登录时 App 卸载，走正常的 onBeforeUnmount。
 *
 *   · 后端模式（监测在常驻设备上跑，本页只是"看画面"）：登录页**就是一层遮罩**，
 *     大屏照常挂载在它下面。这里不能再拦挂载 —— 采集与检测根本不在这台机器上，
 *     拦住 App 既省不下算力、又只会让人白屏；反过来，登录、退出、
 *     甚至干脆不开这个页面，都不影响常驻设备（那边照旧检测、照旧推送）。
 *
 * 校验分两条路（谁在就先问谁）：
 *
 *   1. 后端在（后端模式 / 页面就是后端吐出来的）
 *      → GET /api/auth/challenge 领一次性 nonce
 *      → POST /api/login { username, nonce, proof=sha256(`H1:nonce`) }
 *      由 server/auth.mjs 判定，返回一枚随机会话 token。
 *   2. 后端不在 → 退回本地凭据（src/config/auth.js 的 DEFAULT_AUTH）校验。
 *      值守大屏不能被"后端正好没起来"锁在门外，这是刻意的兜底，
 *      代价是本地校验可被绕过（安全边界写在 config/auth.js 顶部）。
 *
 * ⚠️ 口令在**任何一步都不以明文出现**：
 *   输入框里的明文只活到"算出 H1 = sha256(账号:密码)"为止（src/composables/sha256.js），
 *   之后上传的只有 sha256(`H1:nonce`)；本地兜底比的也是摘要。
 *   所以抓包、控制台、localStorage 里都翻不到密码本身。
 *
 * 会话持久化：**只存 sessionStorage**（12 小时，关掉标签页即失效）。
 *   —— 原来还有一条「保持登录 30 天」的长效分支（localStorage），已按需求**取消**：
 *      公用值守机上"关掉浏览器 30 天还免密"风险太大。
 *   后端签发的会话在恢复时会再向服务端 /api/auth/verify 核对一次；
 *   服务端明确说失效就清掉，只是**连不上**则沿用本地会话（离线容忍）。
 *   ⚠️ 升级后要**主动清掉**历史遗留的 localStorage 会话（旧的长效 token），
 *      否则老机器上那枚 30 天 token 会一直躺着（见 purgeLegacyLocalSession）。
 */
import { reactive } from 'vue'
import { DEFAULT_BACKEND_URL, STORAGE_KEY } from '../config/defaults.js'
import {
  AUTH_FETCH_TIMEOUT_MS,
  AUTH_KEY,
  AUTH_PROBE_TIMEOUT_MS,
  AUTH_PROOF_ALGO,
  AUTH_SESSION_HOURS,
  AUTH_SESSION_KEY,
  DEFAULT_AUTH,
  LOGIN_LOCK_MS,
  LOGIN_MAX_ATTEMPTS
} from '../config/auth.js'
import { credentialDigest, digestEquals, loginProof } from './sha256.js'
import { backendOn } from './useBackendEvents.js'
import { timeoutReason } from './useNet.js'

/** 登录会话状态（全局单例，登录页 / 关于系统页 / 门禁都读这一份） */
export const authState = reactive({
  /** 是否已经完成"首次会话检查"（false 时门禁显示启动态，别闪一下登录页） */
  ready: false,
  /** 是否已登录 */
  authed: false,
  /** 当前登录账号 */
  user: '',
  /** 会话来源：backend 服务端签发 / local 本地校验 / local-fallback 后端没响应时的本地放行 / offline 后端不可达沿用 */
  mode: 'local',
  /**
   * 本页是不是「后端模式」：监测由常驻设备负责，这个页面只是画面。
   * 判据与 useBackendEvents.backendOn、以及顶栏那颗模式徽标**完全同源**
   * （开关开着 + 填了地址）—— 否则会出现"徽标说后端模式、门禁却按前端模式拦挂载"
   * 这种自相矛盾的现场。
   *
   * 门禁据此分流（见 src/LoginGate.vue）：
   *   true  → 登录页只当遮罩，App 照常挂载；登不登录都不影响常驻设备
   *   false → 未登录不挂载 App（这台页面就是监测本身）
   */
  backendMode: false,
  /** 后端地址（'' = 同源，也就是页面本身就是后端出的） */
  backendUrl: '',
  /** 探测到的后端是否可达 */
  backendReachable: false,
  /** 会话到期时刻（毫秒，0 = 未知） */
  expiresAt: 0,
  /** 错误提示（红） */
  error: '',
  /** 中性提示（灰 / 蓝） */
  notice: '',
  /** 提交中（按钮转圈、禁止重复提交） */
  busy: false,
  /** 本地失败节流的锁定截止时刻（毫秒） */
  lockedUntil: 0,
  /** 服务端返回的剩余重试秒数（0 = 没锁） */
  retryAfterSec: 0,
  /** 本地还能试几次 */
  attemptsLeft: LOGIN_MAX_ATTEMPTS
})

/** 默认账号（登录页预填用） */
export const DEFAULT_USERNAME = DEFAULT_AUTH.username

/* ==================== 存储 ==================== */

function area(kind) {
  try {
    if (kind === 'session') return typeof sessionStorage !== 'undefined' ? sessionStorage : null
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch (e) {
    // 隐私模式 / 禁用存储时 getItem 都可能抛，一律当"没有存储"
    return null
  }
}

function readKey(store, key) {
  if (!store) return null
  try {
    const raw = store.getItem(key)
    if (!raw) return null
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : null
  } catch (e) {
    return null
  }
}

function writeKey(store, key, val) {
  if (!store) return
  try {
    store.setItem(key, JSON.stringify(val))
  } catch (e) {
    /* 存不下不影响本次会话（内存里照样是已登录） */
  }
}

function removeKey(store, key) {
  if (!store) return
  try {
    store.removeItem(key)
  } catch (e) {
    /* noop */
  }
}

/** 读回当前会话（只认标签页级那份 —— 长效登录已取消） */
export function readSession() {
  const s = readKey(area('session'), AUTH_SESSION_KEY)
  if (!s) return null
  return {
    token: String(s.token || ''),
    user: String(s.user || ''),
    expiresAt: Number(s.expiresAt) || 0,
    via: String(s.via || 'local'),
    backendUrl: String(s.backendUrl || '')
  }
}

function commitSession(session) {
  const payload = {
    token: session.token || '',
    user: session.user || '',
    expiresAt: session.expiresAt || 0,
    via: session.via || 'local',
    backendUrl: session.backendUrl || '',
    at: Date.now()
  }
  // 只写标签页级；顺手清掉历史遗留的长效会话
  writeKey(area('session'), AUTH_SESSION_KEY, payload)
  removeKey(area('local'), AUTH_KEY)
}

function clearSession() {
  removeKey(area('local'), AUTH_KEY)
  removeKey(area('session'), AUTH_SESSION_KEY)
}

/**
 * 清掉「保持登录」时代遗留在 localStorage 里的长效会话。
 * 恢复会话时调一次：不主动清的话，老机器上那枚 30 天 token 虽然已不再被读取，
 * 但会一直躺在 localStorage 里（换回旧版本又会被认），属于该清的残留。
 */
function purgeLegacyLocalSession() {
  removeKey(area('local'), AUTH_KEY)
}

/** 会话有效期：固定 N 小时（只存标签页级，关掉标签页即失效） */
function ttlOf() {
  return Date.now() + AUTH_SESSION_HOURS * 3600 * 1000
}

/* ==================== 后端探测 ==================== */

/**
 * 读「保存过的配置」里的后端设置。
 * 注意是直接读 localStorage 里的原始存档，不走 App.vue 的 options ——
 * 登录发生在 App 挂载之前，那时候配置对象还不存在。
 */
function savedBackend() {
  const raw = readKey(area('local'), STORAGE_KEY)
  const be = raw && raw.options && raw.options.backend ? raw.options.backend : null
  return {
    enabled: !!(be && be.enabled),
    url: be && typeof be.url === 'string' ? be.url.trim() : ''
  }
}

/**
 * 直接读存档里的 options 对象（门禁要在 App 挂载之前就能判断模式）。
 * 读不出来就返回 null —— backendOn(null) 为 false，也就是按前端模式处理，
 * 这是更保守的那一侧（宁可要求先登录）。
 */
function savedOptions() {
  const raw = readKey(area('local'), STORAGE_KEY)
  return (raw && raw.options) || null
}

/**
 * 按存档判断本页是不是「后端模式」。
 *
 * 判据刻意复用 useBackendEvents.backendOn（开关开着 + 有地址），
 * 跟顶栏那颗模式徽标、跟「运行时长取后端还是取本页」用的是同一份规则。
 * 自己再写一份判断是这次最容易埋的坑：三处一旦漂移，
 * 就会出现"顶栏写着后端模式、登录页却把大屏拦在门外"这种说不清的现象。
 */
export function readBackendMode() {
  return backendOn(savedOptions())
}

/** 刷新 authState.backendMode（进登录页时、每次登录态变化时各调一次） */
export function refreshBackendMode() {
  authState.backendMode = readBackendMode()
  return authState.backendMode
}

function normalizeBase(url) {
  const s = String(url || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  // 少了协议头就当 http://（局域网里手敲地址最常见的就是漏 http://）
  return /^https?:\/\//i.test(s) ? s : `http://${s}`
}

/** 候选后端地址：同源优先（页面由后端 8787 吐出时就是它自己），再是配置里的地址 */
function backendCandidates() {
  const list = []
  try {
    if (typeof location !== 'undefined' && /^https?:$/i.test(location.protocol)) list.push('')
  } catch (e) {
    /* 没有 location（原生壳里 file://）就跳过同源 */
  }
  const saved = savedBackend()
  if (saved.enabled) {
    if (saved.url) list.push(normalizeBase(saved.url))
    if (DEFAULT_BACKEND_URL) list.push(normalizeBase(DEFAULT_BACKEND_URL))
  }
  const seen = new Set()
  return list.filter((b) => {
    const k = b || 'same-origin'
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * 带超时的 JSON 请求。
 * 返回值约定：`{ ok, status, body }`；**网络失败 / 超时 / 非 JSON 一律返回 null**
 * （调用方靠 null 区分"服务端说不行"和"根本没人应答"，两者处理完全相反）。
 */
async function fetchJson(url, { method = 'GET', body = null, timeout = AUTH_FETCH_TIMEOUT_MS } = {}) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => {
    if (ctl) ctl.abort(timeoutReason('认证接口', Math.max(300, timeout)))
  }, Math.max(300, timeout))
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl ? ctl.signal : undefined,
      cache: 'no-store',
      credentials: 'omit'
    })
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch (e) {
      parsed = null
    }
    return { ok: res.ok, status: res.status, body: parsed }
  } catch (e) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

let probeCache = { at: 0, base: null, info: null, tried: 0 }
const PROBE_TTL_MS = 15000

/**
 * 探测本机 / 局域网上有没有可用的后端。
 * 认领判据是 /api/auth/info 里的 service 字段 —— 随便一个同名端点不算数。
 * 结果缓存 15 秒：登录页一进来就先探一次，点「登录」时就不用再等。
 */
export async function detectBackend({ force = false } = {}) {
  const now = Date.now()
  if (!force && probeCache.at && now - probeCache.at < PROBE_TTL_MS) {
    // 缓存命中：''（同源）也是有效值，所以判据是 base !== null
    authState.backendReachable = probeCache.base !== null
    authState.backendUrl = probeCache.base || ''
    return toResult(probeCache)
  }
  probeCache = { at: now, base: null, info: null, tried: 0 }
  for (const base of backendCandidates()) {
    probeCache.tried += 1
    const r = await fetchJson(`${base}/api/auth/info`, { timeout: AUTH_PROBE_TIMEOUT_MS })
    if (r && r.ok && r.body && r.body.ok && r.body.service === 'BossMonitor') {
      probeCache = { at: now, base, info: r.body, tried: probeCache.tried }
      authState.backendReachable = true
      authState.backendUrl = base
      return { base, info: r.body }
    }
  }
  probeCache = { at: now, base: null, info: null, tried: probeCache.tried }
  authState.backendReachable = false
  authState.backendUrl = ''
  return null
}

function toResult(cache) {
  return cache.base === null ? null : { base: cache.base, info: cache.info }
}

/**
 * 本页是不是**由一个监测后端服务出来的**（同源）。
 *
 * 判据就是 detectBackend() 的同一份（`/api/auth/info` 的 service 字段），
 * 只是把「同源」这一个结论单独提出来 —— backendCandidates() 里同源排在第一位，
 * 命中的 base 是空串 `''`。（别为这件事另写一个探测：同源的判据一旦有两份，
 * 「门禁按前端模式拦挂载、顶栏却说后端模式」这种事迟早出现。）
 *
 * 用途见 src/LoginGate.vue：一台没有任何本地配置的新机器打开
 * `http://<值守机>:8787` 时，它必须先知道自己**不是**监测本体，
 * 否则会一直按前端模式把自己挡在门外，而且永远发现不了
 * 「后端就在同一个地址上、配置都在它手里」。
 */
export async function sameOriginBackend() {
  const r = await detectBackend()
  return !!(r && r.base === '')
}

/* ==================== 凭据校验 ==================== */

/**
 * 本地凭据比对（后端不可达时的兜底）——**比的是摘要，不是明文**。
 *
 * 输入口令现算 H1 = sha256(`账号:密码`)，跟内置的 DEFAULT_AUTH.passwordHash 比。
 * 意味着：源码里没有明文密码、运行期也没有"把明文跟明文对一下"的代码路径，
 * 控制台上翻不出密码（只有它的摘要）。
 * 比较用定长异或，不提前短路。
 */
export function verifyLocal(username, password) {
  const u = String(username || '').trim()
  const p = String(password || '')
  if (!u || !p) return false
  return digestEquals(credentialDigest(u, p), DEFAULT_AUTH.passwordHash)
}

function lockText() {
  const left = Math.max(0, Math.ceil((authState.lockedUntil - Date.now()) / 1000))
  return `尝试次数过多，请在 ${left} 秒后重试`
}

function bumpFail() {
  authState.attemptsLeft = Math.max(0, authState.attemptsLeft - 1)
  if (authState.attemptsLeft === 0) {
    authState.lockedUntil = Date.now() + LOGIN_LOCK_MS
    authState.attemptsLeft = LOGIN_MAX_ATTEMPTS
  }
}

function resetFail() {
  authState.attemptsLeft = LOGIN_MAX_ATTEMPTS
  authState.lockedUntil = 0
  authState.retryAfterSec = 0
}

/** 锁定剩余秒数（登录页倒计时用；0 = 没锁） */
export function lockSecondsLeft(now = Date.now()) {
  return Math.max(0, Math.ceil((authState.lockedUntil - now) / 1000))
}

/* ==================== 登录 / 登出 ==================== */

/**
 * 服务端给的是「结论性」拒绝的场景 —— 只有这些才不回退本地校验。
 * bad-credential 口令不对 / locked 失败次数过多被锁。
 * （stale-nonce、malformed、plaintext-rejected 都是握手协议问题，属于可降级。）
 */
const DEFINITIVE_REASONS = ['bad-credential', 'locked']

function adopt(session, notice = '') {
  authState.authed = true
  authState.user = session.user || ''
  authState.mode = session.via || 'local'
  authState.expiresAt = Number(session.expiresAt) || 0
  authState.backendUrl = session.backendUrl || authState.backendUrl || ''
  authState.notice = notice
  authState.error = ''
  return true
}

/**
 * 登录。
 * @param {string} username
 * @param {string} password
 * @returns {Promise<boolean>} 是否通过
 */
export async function login(username, password) {
  if (authState.busy) return false
  const now = Date.now()
  if (authState.lockedUntil > now) {
    authState.error = lockText()
    return false
  }
  authState.busy = true
  authState.error = ''
  authState.notice = ''
  authState.retryAfterSec = 0
  try {
    const u = String(username || '').trim()
    const p = String(password || '')
    if (!u || !p) {
      authState.error = '请输入账号和密码'
      return false
    }

    /*
     * 口令摘要：整条链路里唯一"知道密码"的地方就是这一行的入参，
     * 出这行之后只有 H1（64 位十六进制），明文不再往下传、也不进任何存储。
     */
    const h1 = credentialDigest(u, p)

    let session = null
    let backendDown = false
    const be = await detectBackend()

    /** 领一枚新 nonce 并提交应答（失败时返回 null 表示"连不上"，交由上层降级） */
    const tryBackend = async (base) => {
      const ch = await fetchJson(`${base}/api/auth/challenge`, { timeout: AUTH_FETCH_TIMEOUT_MS })
      if (!ch || !ch.ok || !ch.body || !ch.body.ok || !ch.body.nonce) return { r: null, ch: null }
      if (ch.body.algo && ch.body.algo !== AUTH_PROOF_ALGO) return { r: null, ch }
      const r = await fetchJson(`${base}/api/login`, {
        method: 'POST',
        body: {
          username: u,
          nonce: String(ch.body.nonce),
          // proof = sha256(`H1:nonce`)：报文里没有密码，也没有可重放的固定值
          proof: loginProof(h1, ch.body.nonce)
        },
        timeout: AUTH_FETCH_TIMEOUT_MS
      })
      return { r, ch }
    }

    if (be) {
      let { r, ch } = await tryBackend(be.base)
      /*
       * nonce 只用一次，而它可能已经作废（页面停在这儿很久 / 有人刷过 challenge / 上一次
       * 提交的回包丢了）。这种失败跟口令对错无关，重领一枚再试一次即可 ——
       * 不重试的话，用户会看到"登录请求已过期，请重试"这种不明所以的提示。
       */
      if (r && r.status === 401 && r.body && r.body.reason === 'stale-nonce') {
        ;({ r } = await tryBackend(be.base))
      }
      const reason = (r && r.body && r.body.reason) || ''
      if (r && r.ok && r.body && r.body.ok && r.body.token) {
        session = {
          token: String(r.body.token),
          user: String(r.body.user || u),
          expiresAt: Number(r.body.expiresAt) || ttlOf(),
          via: 'backend',
          backendUrl: be.base
        }
      } else if (r && (r.status === 423 || DEFINITIVE_REASONS.includes(reason))) {
        /*
         * 服务端对凭据给了**结论**（口令不对 / 被锁定）—— 这里绝不再走本地兜底：
         *   ① 服务端的失败锁定（423）会被本地校验绕过去，等于没有锁定；
         *   ② 部署方可能只在 config.json 里改了口令，本地那份摘要已经过时，
         *      回退等于用旧口令放行。
         * 注意判据是"结论性原因"，不是"状态码 401" —— nonce 过期之类也是 401，
         * 那属于握手问题，不该按口令错处理（见下面的降级分支）。
         */
        bumpFail()
        const sec = Number(r.body && r.body.retryAfterSec) || 0
        authState.retryAfterSec = sec
        if (sec > 0) authState.lockedUntil = Date.now() + sec * 1000
        authState.error = (r.body && r.body.error) || '账号或密码不正确'
        return false
      } else {
        // 连不上 / 领不到 nonce / nonce 反复失效 / 协议不一致 / 答非所问 → 降级到本地校验
        backendDown = true
        if (ch && ch.body && ch.body.algo && ch.body.algo !== AUTH_PROOF_ALGO) {
          authState.notice = `登录协议不一致（服务端 ${ch.body.algo}），已按本地凭据校验`
        }
      }
    } else {
      backendDown = true
    }

    if (!session) {
      if (!verifyLocal(u, p)) {
        bumpFail()
        authState.error =
          authState.lockedUntil > Date.now()
            ? lockText()
            : authState.attemptsLeft <= 2
              ? `账号或密码不正确（还可重试 ${authState.attemptsLeft} 次）`
              : '账号或密码不正确'
        return false
      }
      session = {
        token: '',
        user: u,
        expiresAt: ttlOf(),
        via: backendDown && be ? 'local-fallback' : 'local',
        backendUrl: be ? be.base : ''
      }
      if (be && !authState.notice) authState.notice = '后端未响应，已按本地凭据放行（配置与推送可能不可用）'
    }

    resetFail()
    commitSession(session)
    return adopt(session, authState.notice)
  } finally {
    authState.busy = false
  }
}

/**
 * 恢复会话（门禁在挂载时调一次）。
 * 后端签发的会话会再向服务端核对一次：明确失效 → 清掉并提示；
 * 只是连不上 → 沿用（离线容忍，但会打上 offline 标记，界面上能看出来）。
 */
export async function restoreSession() {
  authState.error = ''
  /*
   * 先把「本页是不是后端模式」定下来 —— 门禁要用它决定
   * 「未登录时是否挂载 App」，而这个判断必须在 ready 置位之前就绪，
   * 否则登录页会先按前端模式渲染一帧再跳成遮罩。
   */
  refreshBackendMode()
  // 取消长效登录：顺手清掉历史遗留的 localStorage 会话（不再读它，但要清干净）
  purgeLegacyLocalSession()
  const s = readSession()

  if (!s) {
    authState.ready = true
    authState.authed = false
    return false
  }
  if (s.expiresAt && s.expiresAt <= Date.now()) {
    clearSession()
    authState.ready = true
    authState.authed = false
    authState.notice = '上次的登录已过期，请重新登录'
    return false
  }

  if (s.via === 'backend' && s.token) {
    const be = await detectBackend()
    const sameBackend = be && (!s.backendUrl || be.base === s.backendUrl)
    if (sameBackend) {
      const r = await fetchJson(`${be.base}/api/auth/verify?token=${encodeURIComponent(s.token)}`, {
        timeout: AUTH_FETCH_TIMEOUT_MS
      })
      if (r && r.ok && r.body && r.body.ok) {
        authState.ready = true
        return adopt(s)
      }
      if (r && (r.status === 401 || r.status === 403)) {
        clearSession()
        authState.ready = true
        authState.authed = false
        authState.notice = '登录状态已失效，请重新登录'
        return false
      }
      authState.ready = true
      return adopt({ ...s, via: 'offline' }, '后端校验未响应，已沿用本地会话')
    }
    if (!be) {
      authState.ready = true
      return adopt({ ...s, via: 'offline' }, '后端不可达，已沿用本地会话')
    }
    // 探测到的是**另一台**后端：这枚 token 它不认，按失效处理
    clearSession()
    authState.ready = true
    authState.authed = false
    authState.notice = '后端地址已变更，请重新登录'
    return false
  }

  authState.ready = true
  return adopt(s)
}

/**
 * 退出登录。
 * 本地先清干净（哪怕后端通知失败也一定退得掉），后端那枚 token 顺手作废。
 */
export async function logout(reason = '') {
  /*
   * 退出是**门禁重新分流**的时刻（登录页要回来了），所以在这里重读一次模式：
   * 用户完全可能刚在设置里把「后端检测服务」开关动了，那时存的档才是准的。
   * 不重读的后果是"后端模式退出后仍盖遮罩"或"前端模式退出后大屏没卸载"。
   */
  refreshBackendMode()
  const s = readSession()
  clearSession()
  authState.authed = false
  authState.user = ''
  authState.mode = 'local'
  authState.expiresAt = 0
  authState.error = ''
  authState.notice = reason || '已退出登录'
  resetFail()
  if (s && s.via === 'backend' && s.token) {
    const base = s.backendUrl || ''
    // 不 await：退出体验不该被网络拖住（fetchJson 自身吞错，不会抛）
    void fetchJson(`${base}/api/logout`, {
      method: 'POST',
      body: { token: s.token },
      timeout: 3000
    })
  }
  return true
}

/* ==================== 展示用 ==================== */

/** 会话来源文案（关于系统页 / 登录页角标） */
export function authModeText(state = authState) {
  switch (state.mode) {
    case 'backend':
      return '服务端校验'
    case 'local-fallback':
      return '本地兜底校验'
    case 'offline':
      return '离线沿用会话'
    default:
      return '本地校验'
  }
}

/** 会话到期文案：`2026/10/09 15:30 到期（还有 29 天）` */
export function expiryText(ts = authState.expiresAt) {
  const t = Number(ts) || 0
  if (!t) return '—'
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  const left = t - Date.now()
  if (left <= 0) return `${stamp} 到期（已过期）`
  const days = Math.floor(left / 86400000)
  const hours = Math.floor((left % 86400000) / 3600000)
  const mins = Math.floor((left % 3600000) / 60000)
  const remain = days > 0 ? `${days} 天` : hours > 0 ? `${hours} 小时` : `${mins} 分`
  return `${stamp} 到期（还有 ${remain}）`
}

/** 重置探测缓存（测试 / 手动刷新后端连接状态时用） */
export function resetBackendProbe() {
  probeCache = { at: 0, base: null, info: null, tried: 0 }
}
