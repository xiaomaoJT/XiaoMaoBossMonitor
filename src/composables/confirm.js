import { reactive } from 'vue'

/**
 * 通用确认 / 提示框（替代浏览器原生 confirm / alert）。
 *
 * 设计取舍：
 *  - 用「模块级单例 + 响应式 state」而不是把组件实例到处传：任何组件都能直接
 *    `import { confirmDialog }` 调用，拿到的是 Promise<boolean>，与原生 confirm 的
 *    同步语义对齐成「异步版本」，迁移成本最低（把 `if (!window.confirm(x)) return`
 *    换成 `if (!(await confirmDialog(x))) return` 即可）。
 *  - 带一个轻量队列：理论上同一时刻只会弹一个（confirm 都是阻塞式 await 的），
 *    但万一两个触发点撞上，排队比互相覆盖安全。
 *  - 区分 confirm（有取消按钮，Esc=取消）与 alert（只有确定，Esc/回车=关闭）：
 *    失败 / 校验 / 报错走 alert，危险 / 不可撤销操作走 confirm + danger 变体。
 */

let currentResolve = null
const pending = []

const state = reactive({
  visible: false,
  title: '',
  message: '',
  okText: '',
  cancelText: '',
  variant: 'default', // 'default' | 'danger'
  type: 'confirm' // 'confirm' | 'alert'
})

function open(opts) {
  return new Promise((resolve) => {
    pending.push({ ...opts, resolve })
    pump()
  })
}

function pump() {
  if (state.visible) return
  const item = pending.shift()
  if (!item) return
  state.visible = true
  state.type = item.type || 'confirm'
  state.title = item.title || (state.type === 'alert' ? '提示' : '确认操作')
  state.message = item.message || ''
  state.variant = item.variant || 'default'
  state.okText = item.okText || (state.type === 'alert' ? '知道了' : '确定')
  state.cancelText = state.type === 'confirm' ? item.cancelText || '取消' : ''
  currentResolve = item.resolve
}

function settle(val) {
  if (currentResolve) currentResolve(val)
  currentResolve = null
  state.visible = false
  // 等当前这帧的过渡结束再弹下一个，避免两个框叠在一起闪
  Promise.resolve().then(pump)
}

/** 二次确认框：返回 Promise<boolean>（true=确定 / false=取消或 Esc） */
export function confirmDialog(opts = {}) {
  return open({ ...opts, type: 'confirm' })
}

/** 提示框（仅确定）：返回 Promise<void>，点确定 / Esc / 回车即 resolve */
export function alertDialog(opts = {}) {
  return open({ ...opts, type: 'alert' })
}

/** 供 ConfirmDialog.vue 读取当前要渲染的内容 */
export function useConfirmState() {
  return state
}

/** 供 ConfirmDialog.vue 在用户操作后调用，关闭并兑现当前 Promise */
export function settleConfirm(val) {
  settle(val)
}
