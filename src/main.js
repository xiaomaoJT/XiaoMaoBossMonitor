import { createApp } from 'vue'
/*
 * 挂载的是 LoginGate 而不是 App。
 * 「先登录再进系统」的门禁就在这一层：未登录 / 会话校验中，
 * App（大屏本体）连实例化都不会发生 —— 详见 src/LoginGate.vue。
 */
import LoginGate from './LoginGate.vue'
import './style.css'
import { reportError } from './composables/useErrorLog'

const app = createApp(LoginGate)

/*
 * 全局错误兜底（三层）。
 * 任何一层命中都会在界面上弹出一条可见的错误条，而不是像以前那样
 * 「界面闪一下就没了、控制台里默默躺一条」—— 手机上根本没法开控制台。
 */
app.config.errorHandler = (err, instance, info) => {
  const type = instance && instance.type
  const name = type ? type.__name || type.name || '' : ''
  reportError(err, '界面组件', [info, name].filter(Boolean).join(' · '))
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    // 资源（img / script / link）加载失败只带 target、没有 error 对象，这类噪音跳过
    if (!e.error && e.target && e.target !== window) return
    reportError(e.error || e.message || '未知脚本错误', '脚本')
  })

  // 没有这一步就抓不到 Promise 里的错误 —— 上次那个组件递归异常正是从这冒出来的
  window.addEventListener('unhandledrejection', (e) => {
    reportError(e.reason || '未处理的 Promise 拒绝', '异步任务')
  })
}

/*
 * 直接挂载。
 * 解码器（./js/jessibuca.js，469KB）改成了 defer 引入，再也不用等它 ——
 * 以前这里要轮询到 window.Jessibuca 就绪才 mount，等于把整个 App 的首次渲染
 * 推迟到 469KB 脚本下载执行完，弱网下就是长时间白屏。
 * 真正需要解码器的地方（CameraTile 创建播放器）自己 await 就绪即可，
 * 见 composables/useJessibuca.js。
 */
app.mount('#app')
