/**
 * 预加载脚本：往渲染进程注入两个**受控**的桥。
 *
 * 1. __MONITOR_SHELL__ —— 只读运行时标记，前端据此判断
 *    "当前跑在桌面客户端 / 浏览器 / 手机原生壳"里。
 *
 * 2. __MONITOR_NATIVE__ —— 白名单式的原生能力桥，目前只有「屏幕常亮」一个开关。
 *    ⚠️ 这里刻意只暴露**具名函数**，不暴露 ipcRenderer 本体：
 *    渲染进程能做的仅限于「让主进程开/关 prevent-display-sleep」，
 *    拿不到任意通道的发送能力，contextIsolation 的安全边界依然完整。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__MONITOR_SHELL__', {
  runtime: 'electron',
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }
})

contextBridge.exposeInMainWorld('__MONITOR_NATIVE__', {
  /**
   * 屏幕常亮开关。
   * @param {boolean} on
   * @returns {Promise<boolean>} 主进程里 powerSaveBlocker 是否处于运行状态
   */
  keepAwake: (on) => ipcRenderer.invoke('monitor:keep-awake', !!on),
  /** 查询当前状态（设置面板展示用） */
  keepAwakeStatus: () => ipcRenderer.invoke('monitor:keep-awake-status'),

  /**
   * 强制终结 App（设置 → 配置方案）。
   * 主进程先 quit 再兜底 exit(0)，保证不会留在后台。
   * @returns {Promise<boolean>}
   */
  quitApp: () => ipcRenderer.invoke('monitor:quit'),

  /**
   * 重启整个桌面端（设置 → 系统维护 → 立即重启）。
   * 主进程先 app.relaunch() 登记重启，再 quit（1.2s 兜底 exit(0)），
   * 保证一定重启。后端若是独立进程，则由后端自己的定时/手动重启负责。
   * @returns {Promise<boolean>}
   */
  restartApp: () => ipcRenderer.invoke('monitor:restart'),

  /**
   * 发一条系统通知（主进程 Notification 模块）。
   * @param {{title:string, body:string, tag?:string, silent?:boolean}} payload
   * @returns {Promise<{supported:boolean, error?:string}>}
   */
  notify: (payload) => ipcRenderer.invoke('monitor:notify', payload),
  /** 查询通知能力（桌面端无授权流程，视为已授权） */
  notifyPermission: () => ipcRenderer.invoke('monitor:notify-permission'),
  /**
   * 订阅「点击系统通知」事件（主进程把窗口聚焦后回传 tag）。
   * @param {(tag: string) => void} cb
   */
  onNotifyClick: (cb) => {
    if (typeof cb !== 'function') return
    ipcRenderer.on('monitor:notify-click', (_e, tag) => cb(tag))
  }
})
