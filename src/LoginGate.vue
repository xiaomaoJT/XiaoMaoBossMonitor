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
import { authState, restoreSession, sameOriginBackend } from './composables/useAuth'

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

/**
 * 首次打开：本机还没有任何配置，而本页正是**由一个监测后端服务出来的**
 * → 直接接管（打开后端模式 + 把地址记成同源）。
 *
 * 不这么做的后果（真实场景）：
 *   局域网里另一台机器（B）访问 `http://值守机:8787`。B 的 localStorage 是空的
 *   → 它跑的是空白初始化配置 → 于是它认为「本页就是监测本身」（前端模式）：
 *   未登录时连 App 都不实例化，登录进去也只有一块空大屏。
 *   而真相是：后端就在同一个地址上，7 路通道、凭据、人脸库全都在它手里。
 *
 * 为什么必须在这一层（而不是 App.vue 里）：
 *   前端模式下 App **根本不挂载**，写在 App 里的任何自动发现都永远跑不到 ——
 *   这正是"第一次访问永远发现不了后端"的成因。
 *
 * 为什么只在本机还没配过东西时探：
 *   ① 已经配好的机器（含值守机自己）不需要被改写地址，也不该多等这一次探测；
 *   ② 用户主动关掉后端模式时（存档里已有通道）不会被这里又打开 ——
 *      「我关了它自己又开了」比"少一个自动发现"糟糕得多。
 *
 * 探到之后只做一件事：把结论写进存档（`options.backend`），
 * 后面的 restoreSession() 会据此把门禁分流到后端模式；
 * 真正"把配置拉回来"是 App.vue 挂载后自己的事（那边才拿得到 cameras / 人脸库）。
 */
async function adoptSameOriginBackend() {
  let saved = null
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    saved = raw ? JSON.parse(raw) : null
  } catch (e) {
    saved = null
  }
  const cams = saved && Array.isArray(saved.cameras) ? saved.cameras : []
  const be = saved && saved.options && saved.options.backend
  if (cams.length || (be && be.enabled)) return false
  if (typeof location === 'undefined' || !/^https?:$/i.test(location.protocol)) return false
  if (!(await sameOriginBackend())) return false

  const next = saved && typeof saved === 'object' ? saved : {}
  next.cameras = cams
  next.options = { ...(next.options || {}) }
  next.options.backend = { ...(next.options.backend || {}), url: location.origin, enabled: true }
  try {
    // 只写这几项，其余字段由 App.vue 载入时用默认值补齐（fillMissingOptions）
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch (e) {
    /* 存不下就维持前端模式（更保守的那一侧） */
  }
  return true
}

function onLoggedIn() {
  // 主题再对齐一次（登录期间用户可能在另一台设备改过配置，且上面那次可能读不到存档）
  applySavedTheme()
}

onMounted(async () => {
  /*
   * 顺序要紧：**先接管、再恢复会话**。
   * restoreSession() 里第一件事就是 refreshBackendMode()，而门禁要用它的结果
   * 决定「未登录时挂不挂载 App」—— 晚一步的话这一帧会按前端模式渲染，
   * 登录页会先闪一下"没有底层大屏"的状态。
   */
  const adopted = await adoptSameOriginBackend()
  if (adopted) console.log('🌐 本页由监测后端提供，已接管（后端模式 + 同源地址）')
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
