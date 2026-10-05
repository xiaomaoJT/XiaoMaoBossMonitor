/**
 * BossMonitor 小程序容器 —— H5 地址配置
 *
 * 小程序本身只是壳，真正的监控大屏是本仓库 npm run build 产出的 H5，
 * 部署到任意 HTTPS 静态托管后，把地址填到下面的 H5_URL 即可。
 *
 * 配置要求（上传/上线前必读）：
 *  1. 必须是 https:// 开头（小程序 web-view 不允许 http）；
 *  2. 域名需在小程序后台「开发管理 → 开发设置 → 业务域名」中配置，
 *     并把后台下载的校验文件放到该域名的站点根目录；
 *  3. 视频流走的是 WebSocket（ws-flv / H.265），该 ws:// 或 wss:// 域名
 *     需要在后台「socket 合法域名」中单独配置；
 *  4. 若 H5 使用了自带的 AI 模型（public/ai，约 107MB），请部署在 CDN，
 *     它不进小程序包（小程序总包上限 20MB，装不下也绝不打包）。
 *
 * 未配置时小程序会进入 pages/guide 配置引导页，不影响编译和上传。
 */
const H5_URL = '';

module.exports = {
  H5_URL: (H5_URL || '').trim(),
  CONFIGURED: !!(H5_URL && H5_URL.indexOf('https://') === 0)
};
