Page({
  data: {
    reason: 'noconfig',
    isNoConfig: true
  },

  onLoad(query) {
    const reason = (query && query.reason) || 'noconfig';
    this.setData({ reason, isNoConfig: reason === 'noconfig' });
  },

  onCopySnippet() {
    const snippet = [
      '// miniprogram/utils/config.js',
      "const H5_URL = 'https://你的域名/';",
      '',
      '后台需配置：',
      '1) 业务域名：https://你的域名（下载校验文件放到站点根目录）',
      '2) socket 合法域名：视频流的 wss:// 地址',
      '3) request 合法域名：H5 里若有接口请求也要加'
    ].join('\n');
    wx.setClipboardData({
      data: snippet,
      success() {
        wx.showToast({ title: '已复制配置说明', icon: 'success' });
      }
    });
  },

  onReload() {
    wx.reLaunch({ url: '/pages/index/index' });
  }
});
