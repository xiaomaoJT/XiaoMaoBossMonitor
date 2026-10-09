/**
 * SHA-256（纯 JS，无依赖）
 * ----------------------------------------------------------------------------
 * 为什么不用 crypto.subtle：
 *   WebCrypto 只在**安全上下文**里存在 —— https、localhost 才有；
 *   而这块大屏最常见的访问方式恰恰是 http://192.168.x.x:8787（局域网明文 HTTP），
 *   那里 `crypto.subtle` 是 undefined。用它就得写两套实现 + 两条分支，
 *   而两条分支行为一旦有细微差异，登录就会"有时能进有时进不去"，极难排查。
 *   所以统一用这份同步实现：**任何宿主下结果都一样**（dev / http / https /
 *   Electron / iOS 壳 / 小程序），调用方也不用 await。
 *
 * 正确性怎么保证：它不是"看起来像 SHA-256"，而是标准算法逐轮实现，
 * 并由探针拿 node:crypto 的 createHash('sha256') 对拍（含非 ASCII、emoji、
 * 落单代理字符这些 UTF-8 边界）。
 *
 * 用途（都只是摘要，不涉及密钥）：登录口令摘要、challenge 应答。
 */

/** 前 64 个素数立方根小数部分的前 32 位（SHA-256 标准常量） */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

const HEX = '0123456789abcdef'

/**
 * 字符串 → UTF-8 字节数组。
 * 手写而不是用 TextEncoder：一是老 WebView 不一定有，二是要跟 node 的
 * 'utf8' 完全对齐（落单代理字符按 WHATWG 规范编成 U+FFFD，即 EF BF BD）。
 */
export function utf8Bytes(str) {
  const s = String(str)
  const out = []
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        // 合法的代理对（emoji 等）→ 4 字节
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63))
        i += 1
      } else {
        // 落单的高代理：Node 的 Buffer.from(str,'utf8') 会换成 U+FFFD
        out.push(0xef, 0xbf, 0xbd)
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out.push(0xef, 0xbf, 0xbd)
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    }
  }
  return out
}

/**
 * SHA-256。
 * @param {string|number[]} input 字符串（按 UTF-8）或字节数组
 * @returns {string} 64 位小写十六进制摘要
 */
export function sha256Hex(input) {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : Array.from(input || [])
  const len = bytes.length

  // 填充：0x80 + 若干 0x00，使总长 ≡ 56 (mod 64)，末尾 8 字节是比特长度（大端）
  const withPad = len + 1
  const padded = withPad + ((56 - (withPad % 64)) + 64) % 64
  const total = padded + 8
  const msg = new Uint8Array(total)
  msg.set(bytes, 0)
  msg[len] = 0x80
  const bitLen = len * 8
  const hi = Math.floor(bitLen / 4294967296)
  const lo = bitLen >>> 0
  msg[total - 8] = (hi >>> 24) & 0xff
  msg[total - 7] = (hi >>> 16) & 0xff
  msg[total - 6] = (hi >>> 8) & 0xff
  msg[total - 5] = hi & 0xff
  msg[total - 4] = (lo >>> 24) & 0xff
  msg[total - 3] = (lo >>> 16) & 0xff
  msg[total - 2] = (lo >>> 8) & 0xff
  msg[total - 1] = lo & 0xff

  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const w = new Uint32Array(64)

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = off + i * 4
      w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  const out = new Array(64)
  const words = [h0, h1, h2, h3, h4, h5, h6, h7]
  for (let i = 0; i < 8; i += 1) {
    const v = words[i]
    const base = i * 8
    out[base] = HEX[(v >>> 28) & 0xf]
    out[base + 1] = HEX[(v >>> 24) & 0xf]
    out[base + 2] = HEX[(v >>> 20) & 0xf]
    out[base + 3] = HEX[(v >>> 16) & 0xf]
    out[base + 4] = HEX[(v >>> 12) & 0xf]
    out[base + 5] = HEX[(v >>> 8) & 0xf]
    out[base + 6] = HEX[(v >>> 4) & 0xf]
    out[base + 7] = HEX[v & 0xf]
  }
  return out.join('')
}

const sum = (s) => sha256Hex(String(s))

/** 定长摘要比较（逐字符异或，不做提前短路） */
export function digestEquals(a, b) {
  const x = String(a || '')
  const y = String(b || '')
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

/**
 * 口令摘要 H1 = sha256(`账号:密码`)。
 * 把账号当盐：同一个弱密码在不同账号下摘要不同，也顺手躲开通用彩虹表。
 */
export function credentialDigest(username, password) {
  return sum(`${String(username || '')}:${String(password || '')}`)
}

/**
 * 登录应答 proof = sha256(`H1:nonce`)。
 * 服务端下发一次性 random nonce，只有同时知道 H1 和本次 nonce 才算得出 ——
 * 报文里因此**没有密码，也没有可以重放的固定值**（nonce 用完即废）。
 */
export function loginProof(digest, nonce) {
  return sum(`${String(digest || '')}:${String(nonce || '')}`)
}

/**
 * 本地校验型口令的摘要 —— 遮罩解锁密码、隐藏配置访问口令都走这里。
 * ============================================================================
 * 和登录口令（credentialDigest）分开的两点理由：
 *
 * ① **域分隔**：加一段固定前缀 + 调用方给的 scope。
 *    不这么做的话，"遮罩密码"和"登录密码"如果碰巧一样，摘要也会一模一样 ——
 *    在某一处泄漏的摘要等于把另一处的口令也交出去了。
 *    带上 scope 之后，`mask-unlock` 的摘要拿去当 `hidden-config` 的摘要必被拒。
 * ② **不复用 credentialDigest**：那个把「账号」当盐。本地校验型口令没有账号
 *    这个概念，硬塞一个假账号进来只会让人误以为它和登录是同一套东西。
 *
 * ⚠️ 这仍然是**摘要不是加密**：口令本身没有密钥可还原，弱口令照样能被离线穷举。
 *    它的作用是「明文不落盘、不进产物、不在代码里躺着」，不是"防住爆破"。
 *
 * @param {string} scope 用途域，见 config/auth.js 的 SECRET_SCOPE
 * @param {string} plain 明文口令（只在内存里活到这一行为止）
 * @returns {string} 64 位十六进制摘要
 */
export function secretDigest(scope, plain) {
  return sum(`boss-monitor:${String(scope || '')}:${String(plain || '')}`)
}

/**
 * 比对「明文口令」与「已存摘要」。
 * 口径与登录一致：**只比摘要**，全程没有任何"明文 vs 明文"的比较路径。
 * 走 digestEquals 的定长异或，不提前短路。
 *
 * @param {string} scope    用途域
 * @param {string} plain    用户这次输入的明文
 * @param {string} expected 已存的 64 位摘要；为空表示"没设口令"
 */
export function secretMatches(scope, plain, expected) {
  const want = String(expected || '')
  // 没设口令时，唯一正确的"输入"就是空 —— 但这属于调用方的策略
  // （遮罩是「点击即恢复」，隐藏配置是「必须先输口令」），所以这里不做特殊处理，
  // 交由调用方判断，本函数只负责"摘要对不对"。
  if (!want) return false
  return digestEquals(secretDigest(scope, plain), want)
}
