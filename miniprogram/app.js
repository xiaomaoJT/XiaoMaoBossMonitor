// BossMonitor 监控大屏 —— 小程序容器壳
App({
  onLaunch() {
    // 保持屏幕常亮：监控大屏场景默认常亮（可在系统内关闭）
    try {
      wx.setKeepScreenOn({ keepScreenOn: true });
    } catch (e) { /* 旧基础库忽略 */ }
  },
  globalData: {
    // H5 通过 wx.miniProgram.postMessage 上报的消息会暂存在这里，
    // 小程序侧在 onUnload 时才能批量取到（微信机制）
    lastMessage: null
  }
});
