/**
 * 登录鉴权配置（前端与后端 headless 共用同一份）
 * ----------------------------------------------------------------------------
 * 「访问系统要先登录」这件事的口径：
 *
 *   - 前端只负责**界面与门禁**：没登录之前 App 根本不挂载（连流都不会拉）；
 *   - 真正的身份校验在**后端**：后端模式下登录走 POST /api/login，
 *     由 server/auth.mjs 用 config.json 里的 auth 凭据判定，前端拿到的是一枚
 *     随机 token（不是把密码存在浏览器里比对）。
 *   - 后台连不上时（局域网抖动 / 后端停了），退回**本地凭据**校验并给出提示 ——
 *     一块值守大屏不能因为后端不在就把主人锁在门外。这一点很重要，别为了"更安全"
 *     把回退路径删掉。
 *
 *   - 口令**不以明文存在任何一侧**、也**不以明文上线**（见下）。
 *
 * 口令是怎么走的（三层，逐层都不出现明文）：
 *
 *   ① 存：源码 / 配置里只有摘要 H1 = sha256(`账号:密码`)，没有明文密码。
 *   ② 传：登录前先向服务端要一枚一次性 nonce，提交的是
 *      proof = sha256(`H1:nonce`) —— 报文里既没有密码，也没有可重放的固定值，
 *      抓包重放会因 nonce 已作废而被拒（见 server/auth.mjs）。
 *   ③ 比：前端本地兜底也只比摘要（逐字符异或，不提前短路）。
 *
 * ----------------------------------------------------------------------------
 * 这个文件同时是**全部本地校验型口令**的摘要权威 —— 不只是登录口令。
 * 「本地校验型口令」= 校验只在本机/本进程做完、不需要拿去联网换凭据的口令。
 * 目前有三处，一律只存摘要、只比摘要，代码里不存在明文常量：
 *
 *   ① 登录口令        DEFAULT_AUTH.passwordHash   （sha256(`账号:密码`)）
 *   ② 遮罩解锁密码    options.mask.passwordHash   （sha256(`boss-monitor:mask-unlock:口令`)）
 *   ③ 隐藏配置访问口令 HIDDEN_PASSCODE_HASH        （sha256(`boss-monitor:hidden-config:口令`)）
 *
 * ②③ 走 secretDigest(scope, 口令)（见 composables/sha256.js），
 * 靠 scope 做**域分隔**：三处口令就算碰巧写成同一个字符串，摘要也互不相同，
 * 某一处泄漏的摘要不能拿去顶替另一处。
 *
 * ⚠️ 为什么钉钉加签密钥 / TG Bot Token / 企微 Webhook 不在这个名单里：
 *   它们**不是本地校验型口令** —— 要原样发给第三方服务器才能用，
 *   摘要化会让功能直接失效。那类凭据的保护手段是"别进版本库、别导出、走 HTTPS"，
 *   不是哈希。别把它们也顺手摘要了。
 *
 * 生成摘要（两处都用得上 —— 登录那条不带前缀，另两条带前缀，别抄错）：
 *
 *   # 登录口令：sha256('账号:密码')
 *   node -e "console.log(require('crypto').createHash('sha256').update('账号:密码').digest('hex'))"
 *
 *   # 遮罩 / 隐藏配置口令（scope 换成 mask-unlock 或 hidden-config）
 *   node -e "console.log(require('crypto').createHash('sha256').update('boss-monitor:mask-unlock:你的口令').digest('hex'))"
 *
 * ⚠️ 安全边界（说清楚，别自欺欺人）：
 *   这是**摘要**不是加密，也挡不住能开控制台的人改前端绕过门禁；
 *   弱口令的摘要可被离线穷举（***REMOVED-loginpw*** 这种 4 位密码，本地跑一遍就是秒级）。
 *   它的定位是「明文不外泄、报文可重放性为零、挡住随手打开链接的人」。
 *   真正要防的时候：换成强口令 + HTTPS + 让后端校验成为唯一入口
 *   （前端那份只当离线兜底），必要时再上真正的会话鉴权（HMAC/TLS）。
 */

/** localStorage 键名：勾选「保持登录」时会话存这里（关掉浏览器仍在） */
export const AUTH_KEY = 'monitor-wall-auth-v1'

/** sessionStorage 键名：不勾选「保持登录」时存这里（关掉标签页即失效） */
export const AUTH_SESSION_KEY = 'monitor-wall-auth-session-v1'

/**
 * 「保持登录」这个勾选框本身的记忆（1 / 0）。
 * 共用机器上有人特意取消勾选，下次打开不该又给他勾回来。
 */
export const AUTH_REMEMBER_KEY = 'monitor-wall-auth-remember-v1'

/**
 * 默认账号 + **口令摘要**（不是密码本身）。
 *
 * `passwordHash = sha256('xiaomao:***REMOVED-loginpw***')` —— 也就是"默认密码是 ***REMOVED-loginpw***"，
 * 但源码里查不到这四个字符，前端也永远不会拿它去比明文。
 * 后端启动时若 config.json 里没有 auth 段，同样用这一份 —— 两边永远一致，
 * 不会出现「界面上能登、接口说密码错」这种两头打架的情况。
 *
 * 换成自己的口令：跑上面的 node 命令生成 64 位十六进制摘要，替换 passwordHash。
 */
export const DEFAULT_AUTH = {
  username: 'xiaomao',
  passwordHash: '16cf0cb21f9f2ac4a8a029a18b987593194494f8217477b6a08efa0cb99903fe'
}

/** 勾选「保持登录」时的会话有效期（天） */
export const AUTH_REMEMBER_DAYS = 30

/** 不勾选「保持登录」时的会话有效期（小时） */
export const AUTH_SESSION_HOURS = 12

/**
 * 密码输错多少次后临时锁住（前端本地节流，与后端各算各的）。
 * 前后端都有一份是为了「离线兜底」时也有最基本的暴力破解阻力。
 */
export const LOGIN_MAX_ATTEMPTS = 5

/** 触发锁定后的冷却时长（毫秒） */
export const LOGIN_LOCK_MS = 60 * 1000

/**
 * 登录应答协议版本。
 * 前后端必须一致：服务端在 challenge 里回这个值，客户端对不上就**明确报错**
 * 而不是让它表现成"密码错误" —— 协议不匹配被误判成密码错，是最难查的一类问题。
 */
export const AUTH_PROOF_ALGO = 'sha256-h1-nonce-v1'

/** 登录相关接口的请求超时（毫秒）。局域网内够用，超时就当后端不在 */
export const AUTH_FETCH_TIMEOUT_MS = 6000

/** 探测「这台机器上有没有后端」的超时（毫秒）。短一点，避免拖慢登录页首屏 */
export const AUTH_PROBE_TIMEOUT_MS = 1500

/* ============================================================================
 * 本地校验型口令的用途域（scope）
 * ----------------------------------------------------------------------------
 * 传给 composables/sha256.js 的 secretDigest(scope, 口令)。
 * 每个用途一个固定字符串，**一旦上线就不要改** —— 改了等于把所有人的口令重置，
 * 因为旧摘要再也算不出来了（这也是为什么它不是可配置项，只是代码常量）。
 * ==========================================================================*/
export const SECRET_SCOPE = {
  /** 隐私遮罩的解锁密码（options.mask.passwordHash） */
  MASK: 'mask-unlock',
  /** 「加载内置配置」的访问口令（HIDDEN_PASSCODE_HASH） */
  HIDDEN: 'hidden-config'
}

/**
 * 「加载内置配置」的访问口令**摘要** —— 原文是 13 个字符那串，这里只是它的摘要。
 *
 * 改这个口令：跑文件顶部注释里的第二条 node 命令（scope 用 `hidden-config`），
 * 把算出来的 64 位十六进制粘回来即可。
 *
 * 为什么不留明文：这个常量会被**原样打进前端构建产物**（JS 包），
 * 而 dist 是要分发出去的东西。留明文等于把口令连同系统一起发出去；
 * 留摘要的话，拿到产物的人至少还得先跑一遍穷举。
 * 注意这只抬高门槛、不是"安全"—— 它本质仍是前端门槛（见文件顶部安全边界）。
 */
export const HIDDEN_PASSCODE_HASH =
  'f60f69196084fc5d3557f33301af52501735bdb55ec6eeceacc154d5470e7241'
