const config = require('../../utils/config.js');

Page({
  data: {
    url: '',
    ready: false,
    failed: false,
    errorMsg: '',
    loaded: false
  },

  onLoad() {
    if (!config.CONFIGURED) {
      wx.redirectTo({ url: '/pages/guide/guide?reason=noconfig' });
      return;
    }
    this.setData({ url: config.H5_URL, ready: true, failed: false });
  },

  onWebviewLoad() {
    this.setData({ loaded: true, failed: false });
  },

  onWebviewError(e) {
    const detail = (e && e.detail) || {};
    this.setData({
      failed: true,
      errorMsg: detail.url ? ('加载失败：' + detail.url) : '网页加载失败，请检查域名是否已在小程序后台配置为业务域名'
    });
  },

  // H5 内通过 wx.miniProgram.postMessage 上报的数据（微信机制：页面卸载时才送达）
  onMessage(e) {
    const data = (e && e.detail && e.detail.data) || [];
    if (data.length) {
      getApp().globalData.lastMessage = data[data.length - 1];
    }
  },

  onRetry() {
    this.setData({ url: this.data.url + (this.data.url.indexOf('?') > -1 ? '&' : '?') + '_r=' + Date.now(), failed: false });
  },

  onGuide() {
    wx.navigateTo({ url: '/pages/guide/guide?reason=error' });
  },

  onShareAppMessage() {
    return {
      title: 'BossMonitor 监控大屏',
      path: '/pages/index/index'
    };
  },

  onShareTimeline() {
    return { title: 'BossMonitor 监控大屏' };
  }
});
