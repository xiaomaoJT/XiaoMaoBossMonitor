/**
 * 同步进度（「第一次打开页面时，后端到底在干什么」）
 * ----------------------------------------------------------------------------
 * 起因：局域网里另一台机器第一次打开这个地址时，页面要**先接管后端配置再能看**：
 * 探后端 → 拉配置（通道 / 凭据 / 隐藏名单）→ 重建人脸库 → 回填历史事件 → 拉统计。
 * 这一串动作全在后台异步跑，界面上什么都不显示：
 *   · 用户看到的只是一块空大屏，不知道"在同步"还是"这后端就是空的"；
 *   · 慢的时候（人脸库几十人、事件几千条）会误以为卡死，然后不停刷新 ——
 *     而每刷一次都会重跑一遍这一串。
 *
 * 所以这里给它一层**可见的分步进度**。
 *
 * ---------- 设计上刻意守的两条线 ----------
 * ① **进度必须是真的**：每个步骤由 App.vue 里那次真实 await 的起止驱动，
 *    不做"假进度条自己往前爬"。假装在加载比不显示更糟 —— 用户会等一个
 *    永远不会来的结果。
 * ② **不阻塞操作**：这只是一层提示卡片（顶部居中），可点「关闭」收起；
 *    即便它某一步失败了，页面本身该怎么用还怎么用。
 *
 * 状态机：idle → active（逐步 doing/done）→ 全部 done / 某步 fail → 自动收起。
 */
import { computed, reactive } from 'vue'

/** 完成后停留多久再自动收起（让用户看得见"完成"那一帧） */
const DONE_LINGER_MS = 1800

/**
 * @typedef {object} SyncStep
 * @property {string} key   步骤标识（驱动方按它更新状态）
 * @property {string} label 展示文案
 */

/** 首次打开（接管后端）的固定五步 —— 与实际发生的事一一对应 */
export const FIRST_OPEN_STEPS = [
  { key: 'probe', label: '连接后端服务' },
  { key: 'config', label: '拉取配置（通道 / 推送 / 隐藏名单）' },
  { key: 'faces', label: '同步人脸库' },
  { key: 'history', label: '载入历史事件' },
  { key: 'stats', label: '同步统计' }
]

export const syncFlow = reactive({
  /** 面板是否可见 */
  active: false,
  /** 标题（区分"首次打开"和"手动拉取"） */
  title: '',
  /** 副标题：当前正在做什么 */
  hint: '',
  /** [{ key, label, state, note }]，state: pending | doing | done | fail | skip */
  steps: [],
  /** 失败说明（非空即失败，面板会一直留着直到用户关掉） */
  error: '',
  /** 整串是否已跑完（成功） */
  done: false,
  /** 是否可手动关闭（失败时常驻，成功时自动消失） */
  startedAt: 0,
  finishedAt: 0
})

/** 0~100：已完成步数占比（失败按"已停下"算，不再涨） */
export const syncFlowPct = computed(() => {
  const n = syncFlow.steps.length
  if (!n) return 0
  const done = syncFlow.steps.filter((s) => s.state === 'done' || s.state === 'skip').length
  return Math.round((done / n) * 100)
})

/** 当前正在进行的步骤文案（没有就返回空串） */
export const syncFlowNow = computed(() => {
  const s = syncFlow.steps.find((x) => x.state === 'doing')
  return s ? s.label : ''
})

let hideTimer = null

/**
 * 开始一串同步。`steps` 决定面板上有几项 —— 不传就用首次打开那五步。
 * 重复调用（例如用户连点「从后端拉取」）会**重置**成新一轮，不会叠起来。
 */
export function beginSyncFlow(title = '正在与后端同步…', steps = FIRST_OPEN_STEPS) {
  clearTimeout(hideTimer)
  syncFlow.active = true
  syncFlow.title = title
  syncFlow.hint = ''
  syncFlow.steps = (steps || []).map((s) => ({
    key: s.key,
    label: s.label,
    state: 'pending',
    note: ''
  }))
  syncFlow.error = ''
  syncFlow.done = false
  syncFlow.startedAt = Date.now()
  syncFlow.finishedAt = 0
}

/**
 * 更新某一步。
 * @param {string} key
 * @param {'pending'|'doing'|'done'|'fail'|'skip'} state
 * @param {string} [note] 追加说明（如「12 路通道」）
 */
export function stepSyncFlow(key, state, note = '') {
  const s = syncFlow.steps.find((x) => x.key === key)
  if (!s) return
  s.state = state
  if (note) s.note = String(note)
}

/** 标记某步"跳过"并附原因（例如后端人脸库为空、本次没动本机底库） */
export function skipSyncFlow(key, note = '') {
  stepSyncFlow(key, 'skip', note)
}

/**
 * 收尾。
 * @param {string} [error] 传了就是失败 —— 当前"进行中"的那一步会被标成失败，
 *                         面板常驻等用户关掉（失败不能自动消失，否则用户看不到发生过什么）
 */
export function finishSyncFlow(error = '') {
  syncFlow.finishedAt = Date.now()
  if (error) {
    // 谁在跑谁就是失败的那一步（调用方不用自己去猜是哪步崩的）
    syncFlow.steps.forEach((s) => {
      if (s.state === 'doing') s.state = 'fail'
    })
    syncFlow.error = String(error)
    syncFlow.done = false
    // 失败时别自动消失 —— 否则用户根本看不到发生了什么
    return
  }
  // 没跑完的（理论上不该有）统一按跳过收尾，避免面板永远挂着半截进度
  syncFlow.steps.forEach((s) => {
    if (s.state === 'pending' || s.state === 'doing') s.state = 'skip'
  })
  syncFlow.error = ''
  syncFlow.done = true
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (syncFlow.done) syncFlow.active = false
  }, DONE_LINGER_MS)
}

/** 手动收起（右上角 ×，或失败后点「知道了」） */
export function dismissSyncFlow() {
  clearTimeout(hideTimer)
  syncFlow.active = false
}
