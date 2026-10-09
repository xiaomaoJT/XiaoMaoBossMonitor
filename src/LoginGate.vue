<template>
  <!--
    会话检查期间（读取本地会话 / 向后端核对）显示启动态。
    这一步不能省：有会话时先闪一下登录页再跳进大屏，观感上像"被退出来了"。
  -->
  <div class="splash" v-if="!authState.ready">
    <div class="splash-inner">
      <div class="ring"></div>
      <p class="title">{{ BRAND.fullName }}</p>
      <p class="sub">正在校验登录状态…</p>
    </div>
  </div>

  <!--
    后端模式：监测在常驻设备（headless）上跑，这个页面只是"看画面"的窗口。
    所以大屏 **照常挂载**，登录页只是盖在它上面的一层遮罩 ——
    性质和「遮罩」按钮一样，区别只是这层遮罩要用账号密码才揭得开。
    登不登录、开不开这个页面，都不影响常驻设备那边照旧检测、照旧推送。

    反过来也不能在这里拦挂载：采集与检测根本不在这台机器上，
    拦住 App 既省不下算力，又只会让人对着登录页白等。
  -->
  <template v-else-if="authState.backendMode">
    <!-- 遮罩挡得住鼠标，挡不住键盘 —— 快捷键得由这里让给登录页（M/F/R/E…） -->
    <App :interactive="authState.authed" />
    <LoginView v-if="!authState.authed" overlay @success="onLoggedIn" />
  </template>

  <!--
    前端模式：**这个页面就是"监测"本身**。未登录时 App 根本不挂载 ——
    不是盖一层遮罩，而是连组件都不实例化，未授权时不会有一路流被拉起来
    （也就没有"底层其实在跑"的走光问题），退出登录时 App 卸载走的
    也是正常的 onBeforeUnmount（停轮询、释放解码器）。
  -->
  <LoginView v-else-if="!authState.authed" @success="onLoggedIn" />
  <App v-else />
</template>

<script setup>
import { onMounted } from 'vue'
import App from './App.vue'
import LoginView from './components/LoginView.vue'
import { BRAND, STORAGE_KEY } from './config/defaults'
import { authState, restoreSession } from './composables/useAuth'

/**
 * 登录页也要跟用户选过的外观走（液态 / 暗黑 / 亮色）。
 * App.vue 里那份 applyTheme 要等组件挂载才生效，而登录发生在它之前 ——
 * 不在这里补一次，选了亮色的人会先看到一屏深色登录页再跳成亮色。
 * 逻辑与 App.vue 的 applyTheme 保持一致（auto 按系统深色解析）。
 */
function applySavedTheme() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    const saved = raw ? JSON.parse(raw) : null
    let t = (saved && saved.options && saved.options.theme) || 'liquid'
    if (t === 'default') t = 'liquid'
    if (!['liquid', 'dark', 'light', 'auto'].includes(t)) t = 'liquid'
    if (t === 'auto') {
      t =
        typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
    }
    document.documentElement.dataset.theme = t
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', t === 'light' ? '#eef1f6' : t === 'dark' ? '#000000' : '#0b1119')
  } catch (e) {
    /* 存档损坏时保持 index.html 里的默认外观，不影响登录 */
  }
}

applySavedTheme()

function onLoggedIn() {
  // 主题再对齐一次（登录期间用户可能在另一台设备改过配置，且上面那次可能读不到存档）
  applySavedTheme()
}

onMounted(() => {
  void restoreSession()
})
</script>

<style scoped>
.splash {
  position: fixed;
  inset: 0;
  z-index: 600;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--text);
}

.splash-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  animation: fade 0.3s ease both;
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

.ring {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2.5px solid color-mix(in srgb, var(--accent) 22%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.title {
  margin: 2px 0 0;
  font-size: 15px;
  letter-spacing: 0.6px;
  color: var(--text-bright);
}

.sub {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
}
</style>
