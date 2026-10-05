/**
 * 全局错误留档 + 可视错误条
 * ----------------------------------------------------------------------------
 * 以前这个项目没有任何全局错误兜底：组件里抛异常只会在控制台留一条，
 * 界面上表现为「闪一下就没了」（比如设置抽屉那次 computed 循环更新的 bug），
 * 手机上连控制台都开不了，只能靠猜。
 *
 * 现在三层入口（见 main.js）统一收到这里：
 *   - app.config.errorHandler  Vue 组件内错误
 *   - window.onerror           其它同步脚本错误
 *   - unhandledrejection       Promise 未捕获拒绝
 * 命中后写进 errorLog 留档，并把最新一条挂到 fatalError 上，由 App.vue 渲染成错误条。
 *
 * 注意：这里刻意「不抛、不阻塞、不递归」—— 错误处理自己出错是最糟的情况，
 * 所以所有逻辑都包在 try/catch 里，且同一条错误 1.5 秒内只记一次（防止渲染循环刷屏）。
 */
import { ref } from 'vue'

/** 当前要在界面上展示的错误（null = 不展示） */
export const fatalError = ref(null)

/** 最近若干条错误留档，供错误条里展开查看 / 复制发人 */
export const errorLog = ref([])

const MAX_LOG = 30
/** 同一条错误的去重窗口（毫秒） */
const DEDUPE_MS = 1500

let lastKey = ''
let lastAt = 0

/**
 * 把任意错误对象整理成一句人话。
 * 对几个「看着吓人其实有明确成因」的报错给了专门文案。
 */
function normalizeMessage(err) {
  if (err === null || err === undefined) return '未知错误'
  if (typeof err === 'string') return err
  const msg = err.message || String(err)

  if (/Maximum recursive updates/i.test(msg)) {
    return '界面组件出现了循环更新，已自动中断（通常是某处 computed 反复改写自己的依赖）'
  }
  if (/ResizeObserver loop/i.test(msg)) {
    return '尺寸变化回调触发过于频繁（通常无害）'
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return '网络请求失败，请检查与设备的网络连接'
  }
  return msg
}

function safeStack(err) {
  if (!err || !err.stack) return ''
  try {
    return String(err.stack).slice(0, 1500)
  } catch (e) {
    return ''
  }
}

/**
 * 记录一条错误。
 * @param {*} err 错误对象或字符串
 * @param {string} source 来源（界面组件 / 脚本 / 异步任务）
 * @param {string} [extra] 补充信息（组件名、钩子名等）
 */
export function reportError(err, source = '未知来源', extra = '') {
  try {
    const message = normalizeMessage(err)
    const key = `${source}|${message}`
    const now = Date.now()
    if (key === lastKey && now - lastAt < DEDUPE_MS) return
    lastKey = key
    lastAt = now

    const item = {
      time: now,
      source,
      message,
      extra: extra || '',
      stack: safeStack(err)
    }

    // 留档（最新的在最前）
    errorLog.value = [item, ...errorLog.value].slice(0, MAX_LOG)
    fatalError.value = item

    // 控制台仍然保留原始错误，方便桌面端排查
    console.error(`[${source}]${extra ? ` ${extra}` : ''}`, err)
  } catch (e) {
    /* 错误处理自身绝不向上抛 */
  }
}

/** 关掉错误条（留档不动） */
export function dismissError() {
  fatalError.value = null
}

/** 清空留档 */
export function clearErrorLog() {
  errorLog.value = []
}

/** 把留档拼成可直接粘贴的文本 */
export function errorLogText() {
  return errorLog.value
    .map((it) => {
      const t = new Date(it.time).toLocaleString('zh-CN')
      return [
        `【${t}】${it.source}${it.extra ? ` · ${it.extra}` : ''}`,
        it.message,
        it.stack || ''
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}
