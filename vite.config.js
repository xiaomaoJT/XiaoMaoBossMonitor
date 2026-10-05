import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  /*
   * 构建时间戳：设置里「关于系统」页会展示它。
   * 排障时第一个要问的就是「你跑的是哪个包」，有个时间戳比版本号更实在
   * （版本号常年 1.0.0，构建时间每次都不同）。
   */
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
    // 钉钉 / 企业微信的开放接口都没有 CORS 响应头，浏览器直连会被拦；
    // 这里做一层本地代理，前端请求 /dingtalk-robot/** 与 /wecom-bot/** 即可。
    // ⚠️ 两个前缀必须与 electron/main.cjs 里的代理前缀保持一致。
    proxy: {
      '/dingtalk-robot': {
        target: 'https://oapi.dingtalk.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/dingtalk-robot/, '')
      },
      '/wecom-bot': {
        target: 'https://qyapi.weixin.qq.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/wecom-bot/, '')
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
