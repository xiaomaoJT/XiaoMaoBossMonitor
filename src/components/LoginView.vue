<template>
  <div class="login-root" :class="{ overlay }">
    <!-- ==================== 背景：极光 + 网格 + 光斑 ==================== -->
    <!-- 全部用主题变量上色，三套外观（液态 / 暗黑 / 亮色）都不用改这块 -->
    <div class="bg" aria-hidden="true">
      <span class="orb orb-a"></span>
      <span class="orb orb-b"></span>
      <span class="orb orb-c"></span>
      <span class="grid"></span>
      <span class="scan"></span>
    </div>

    <div class="shell">
      <!-- ==================== 左：品牌与能力 ==================== -->
      <section class="brand">
        <div class="brand-head">
          <div class="logo">
            <img :src="LOGO" alt="BossMonitor" draggable="false" />
          </div>
          <div class="brand-text">
            <h1>
              {{ BRAND.fullName }}
              <em class="ver">v{{ BRAND.version }}</em>
            </h1>
            <p class="slogan">{{ BRAND.slogan }}</p>
          </div>
        </div>

        <ul class="feats">
          <li v-for="(f, i) in FEATURES" :key="f.k" :style="{ animationDelay: 120 + i * 90 + 'ms' }">
            <span class="ic" v-html="f.icon"></span>
            <span class="tx">
              <b>{{ f.k }}</b>
              <i>{{ f.v }}</i>
            </span>
          </li>
        </ul>

        <div class="brand-foot">
          <span class="beat" :class="authState.backendReachable ? 'on' : ''"></span>
          <span>{{ backendText }}</span>
        </div>
      </section>

      <!-- ==================== 右：登录卡片 ==================== -->
      <section class="panel" :class="{ shake: shaking }">
        <!-- 取景框四角：监控画面的语言，纯装饰 -->
        <i class="cnr tl"></i>
        <i class="cnr tr"></i>
        <i class="cnr bl"></i>
        <i class="cnr br"></i>

        <header class="panel-head">
          <h2>身份校验</h2>
          <p>{{ overlay ? '登录后显示画面 · 后台监测照常进行' : '登录后可进入监控大屏' }}</p>
        </header>

        <form @submit.prevent="submit" novalidate>
          <label class="row">
            <span class="lb">账号</span>
            <div class="ipt">
              <svg class="ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2ZM4.8 20.2a7.2 7.2 0 0 1 14.4 0"
                />
              </svg>
              <input
                ref="userEl"
                v-model="username"
                type="text"
                name="username"
                autocomplete="username"
                spellcheck="false"
                maxlength="64"
                placeholder="请输入账号"
                @keydown="onKey"
                @keyup="onKey"
              />
            </div>
          </label>

          <label class="row">
            <span class="lb">密码</span>
            <div class="ipt">
              <svg class="ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M7 10.5V8a5 5 0 0 1 10 0v2.5M6 10.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19v-7A1.5 1.5 0 0 1 6 10.5Z"
                />
              </svg>
              <input
                ref="pwdEl"
                v-model="password"
                :type="show ? 'text' : 'password'"
                name="password"
                autocomplete="current-password"
                maxlength="64"
                placeholder="请输入密码"
                @keydown="onKey"
                @keyup="onKey"
              />
              <button
                type="button"
                class="eye"
                :class="{ on: show }"
                :aria-label="show ? '隐藏密码' : '显示密码'"
                @click="show = !show"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M2.8 12S6 6.2 12 6.2 21.2 12 21.2 12 18 17.8 12 17.8 2.8 12 2.8 12Z"
                  />
                  <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.6" />
                  <path v-if="!show" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4.5 19.5 19.5 4.5" />
                </svg>
              </button>
            </div>
          </label>

          <div class="opts">
            <button
              type="button"
              class="check"
              :class="{ on: remember }"
              :aria-pressed="String(remember)"
              @click="remember = !remember"
            >
              <i class="box">
                <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M4.5 12.5 9.5 17.5 19.5 6.5"
                  />
                </svg>
              </i>
              保持登录 {{ AUTH_REMEMBER_DAYS }} 天
            </button>
            <span class="caps" v-if="capsOn">大写锁定已开启</span>
          </div>

          <transition name="fade">
            <p class="msg err" v-if="authState.error" role="alert">{{ authState.error }}</p>
          </transition>
          <transition name="fade">
            <p class="msg note" v-if="!authState.error && authState.notice">{{ authState.notice }}</p>
          </transition>

          <button class="submit" type="submit" :disabled="authState.busy || lockLeft > 0">
            <span class="spin" v-if="authState.busy"></span>
            <span>{{ submitText }}</span>
          </button>
        </form>

        <p class="tip">
          账号由部署方在 <code>server/config.json</code> 的 <code>auth</code> 段配置（只存口令摘要）；
          口令经摘要 + 一次性随机数校验，<b>不以明文上线</b>。
          {{ authState.backendReachable ? `当前校验：${authState.backendUrl || '本机后端'}` : '当前校验：本地兜底（未连接后端）' }}
        </p>
      </section>
    </div>

    <footer class="foot">
      <span class="clock">{{ clockText }}</span>
      <span class="sep">·</span>
      <span>{{ BRAND.name }} 监控值守系统</span>
      <template v-if="buildTime">
        <span class="sep">·</span>
        <span>构建 {{ buildShort }}</span>
      </template>
    </footer>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BRAND } from '../config/defaults'
import { AUTH_REMEMBER_DAYS, AUTH_REMEMBER_KEY } from '../config/auth'
import { DEFAULT_USERNAME, authState, detectBackend, lockSecondsLeft, login } from '../composables/useAuth'

const emit = defineEmits(['success'])

/**
 * 由门禁（src/LoginGate.vue）传进来：本页处于**后端模式**时，登录页是
 * 盖在「正在运行的大屏」之上的一层遮罩，而不是独占整屏的门。
 * 只影响层级与一句文案 —— 语义差异全在门禁那边（要不要挂载 App）。
 */
defineProps({
  overlay: { type: Boolean, default: false }
})

/** 动图 logo 在登录页太闹，用静态图（两张都在 public/logo/ 下） */
const LOGO = './logo/logo.png'

/**
 * 三个卖点。用内联 SVG 而不是 emoji：emoji 在不同系统上字体差异巨大，
 * 而这套界面的气质是"克制的工业感"，插画风 emoji 会破坏它。
 */
const FEATURES = [
  {
    k: '实时预览',
    v: '多路同看 · H.265 软解',
    icon: '<svg viewBox="0 0 24 24" width="17" height="17"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M3.5 7.5h11a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 2 18v-9a1.5 1.5 0 0 1 1.5-1.5Z"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="m16 13 5.5-3.2v8.4L16 15"/></svg>'
  },
  {
    k: '智能识别',
    v: '人形 · 人脸 · 区域进出',
    icon: '<svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M12 1.6v3.2M12 19.2v3.2M1.6 12h3.2M19.2 12h3.2"/></svg>'
  },
  {
    k: '多端推送',
    v: '钉钉 · 企微 · Telegram',
    icon: '<svg viewBox="0 0 24 24" width="17" height="17"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M12 3.4c-4.7 0-8.5 2.7-8.5 6 0 1.9 1.2 3.6 3.1 4.7l-.8 4.1 4.2-2.2c.6.1 1.3.2 2 .2 4.7 0 8.5-2.7 8.5-6s-3.8-6.8-8.5-6.8Z"/></svg>'
  }
]

/** 构建时间由 vite.config.js 的 define 注入（与「关于系统」页同一套写法） */
const buildTime = (() => {
  try {
    return typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : ''
  } catch (e) {
    return ''
  }
})()
const buildShort = computed(() => (buildTime ? new Date(buildTime).toLocaleString('zh-CN') : ''))

const userEl = ref(null)
const pwdEl = ref(null)
const username = ref(DEFAULT_USERNAME)
const password = ref('')
const show = ref(false)
const shaking = ref(false)
const capsOn = ref(false)
const now = ref(Date.now())

/** 「保持登录」记在上次的选择上（共用机器上取消过就别自动勾回来） */
const remember = ref(readRememberPref())
let rememberTimer = null
watch(remember, (v) => {
  clearTimeout(rememberTimer)
  rememberTimer = setTimeout(() => writeRememberPref(v), 100)
})

function readRememberPref() {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_REMEMBER_KEY) : null
    return v === null ? true : v !== '0'
  } catch (e) {
    return true
  }
}

function writeRememberPref(v) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(AUTH_REMEMBER_KEY, v ? '1' : '0')
  } catch (e) {
    /* 存不下就用默认值，不影响登录 */
  }
}

/* ---------- 时钟 / 锁定倒计时 ---------- */
let ticker = null
onMounted(() => {
  ticker = setInterval(() => {
    now.value = Date.now()
  }, 1000)
  /*
   * 进页面就探一次后端：探测要在局域网里跑最多 1.5 秒，
   * 等用户敲完密码再探就成了"点登录后要愣一下"。结果有 15 秒缓存（见 useAuth）。
   */
  void detectBackend()
  /*
   * 账号已经预填，光标直接落在密码框里 —— 少一次点击。
   * 触屏设备不自动聚焦：会直接弹起软键盘，把整个登录卡片顶走。
   */
  if (!isCoarsePointer()) nextTick(() => focusPassword())
})

onBeforeUnmount(() => {
  clearInterval(ticker)
  clearTimeout(rememberTimer)
  ticker = null
})

function isCoarsePointer() {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  } catch (e) {
    return false
  }
}

function focusPassword() {
  const el = pwdEl.value
  if (!el) return
  el.focus()
  // 光标落到末尾，方便直接接上输入
  const n = el.value ? el.value.length : 0
  try {
    el.setSelectionRange(n, n)
  } catch (e) {
    /* 某些浏览器对 password 类型不支持，忽略 */
  }
}

const lockLeft = computed(() => lockSecondsLeft(now.value))

const submitText = computed(() => {
  if (authState.busy) return '正在校验…'
  if (lockLeft.value > 0) return `请稍候 ${lockLeft.value}s`
  return '登 录'
})

const backendText = computed(() =>
  authState.backendReachable
    ? '检测服务已连接 · 由服务端校验身份'
    : '未连接检测服务 · 按本地凭据校验'
)

const clockText = computed(() => {
  const d = new Date(now.value)
  const p = (n) => String(n).padStart(2, '0')
  const week = '日一二三四五六'[d.getDay()]
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} 周${week}`
})

/* ---------- 交互 ---------- */

/** 大写锁定：密码框上一按就提示，省得"密码明明是对的"却进不去 */
function onKey(e) {
  if (!e || typeof e.getModifierState !== 'function') return
  try {
    capsOn.value = !!e.getModifierState('CapsLock')
  } catch (err) {
    capsOn.value = false
  }
}

async function shakeOnce() {
  shaking.value = false
  await nextTick()
  shaking.value = true
  setTimeout(() => (shaking.value = false), 460)
}

/**
 * 「清空密码框」是代码干的，不是用户敲的。
 * 下面的 watch 会把"用户重新输入"当成"把错误提示收起来"的信号，
 * 于是这个程序性清空会反过来把刚设好的错误提示抹掉 ——
 * 表现就是「卡片抖了一下，但一个字都没说为什么」。
 * 用这个标志把两者分开（置位 → 等 watch 跑完 → 复位）。
 */
let programmaticClear = false

async function submit() {
  if (authState.busy || lockLeft.value > 0) return
  // 先取口令再登录：明文只在这里出现一次，交给 login() 变成摘要
  const ok = await login(username.value, password.value, remember.value)
  if (ok) {
    emit('success', authState.user)
    return
  }
  // 失败：清空密码 + 抖一下 + 光标回密码框，一次到位
  programmaticClear = true
  password.value = ''
  await nextTick()
  programmaticClear = false
  await shakeOnce()
  nextTick(() => focusPassword())
}

/**
 * 用户重新开始输入时把错误 / 提示收起来。
 * 不这么做的话，错误提示会一直挂着，直到下一次提交才更新 —— 体验上像卡住了。
 */
watch([username, password], () => {
  if (programmaticClear) return
  if (authState.error) authState.error = ''
  if (authState.notice && authState.notice !== '已退出登录') authState.notice = ''
})
</script>

<style scoped>
.login-root {
  position: fixed;
  inset: 0;
  z-index: 500;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  padding: calc(var(--safe-top) + 20px) calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 14px)
    calc(var(--safe-left) + 16px);
}

/*
 * 后端模式：这一层是盖在**正在运行的大屏**之上的遮罩，不是独占整屏的门。
 *
 * 层级必须压过大屏里的所有浮层：顶栏 / 放大画面(90)、设置抽屉(120)、
 * 事件面板(300)、画面上那层遮罩(400)，以及可能被 teleport 到 body 的
 * 下拉面板(600) 与画面右键菜单(640)。这不是"够用就行"的地方 ——
 * 只要有一层露在登录页之上，未登录的人就能透过它看见底下的监控画面。
 *
 * 仍然保持不透明：露出底下的画面就等于遮罩失效，所以不追求"能看出下面在跑"
 * 的透视效果 —— 这件事交给文案交代（"后台监测照常进行"）。
 */
.login-root.overlay {
  z-index: 700;
}

/* ==================== 背景 ==================== */
.bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}

/* 极光：三团色晕，跟大屏首页同一套配色语言（accent / cyan / purple） */
.orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(60px);
  opacity: 0.5;
  will-change: transform;
}

.orb-a {
  width: 46vw;
  height: 46vw;
  min-width: 320px;
  min-height: 320px;
  top: -14vw;
  right: -8vw;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 55%, transparent), transparent 70%);
  animation: drift1 22s ease-in-out infinite alternate;
}

.orb-b {
  width: 38vw;
  height: 38vw;
  min-width: 260px;
  min-height: 260px;
  bottom: -14vw;
  left: -8vw;
  background: radial-gradient(circle, color-mix(in srgb, var(--cyan) 42%, transparent), transparent 70%);
  animation: drift2 26s ease-in-out infinite alternate;
}

.orb-c {
  width: 30vw;
  height: 30vw;
  min-width: 200px;
  min-height: 200px;
  top: 42%;
  left: 46%;
  background: radial-gradient(circle, color-mix(in srgb, var(--purple) 40%, transparent), transparent 70%);
  animation: drift3 30s ease-in-out infinite alternate;
}

@keyframes drift1 {
  from {
    transform: translate3d(0, 0, 0) scale(1);
  }
  to {
    transform: translate3d(-6%, 8%, 0) scale(1.12);
  }
}

@keyframes drift2 {
  from {
    transform: translate3d(0, 0, 0) scale(1.06);
  }
  to {
    transform: translate3d(9%, -7%, 0) scale(1);
  }
}

@keyframes drift3 {
  from {
    transform: translate3d(-4%, 4%, 0) scale(1);
  }
  to {
    transform: translate3d(5%, -5%, 0) scale(1.15);
  }
}

/* 网格：向中心收拢淡出，给画面一点"技术底纹"但不抢戏 */
.grid {
  position: absolute;
  inset: -1px;
  background-image:
    linear-gradient(var(--line-soft) 1px, transparent 1px),
    linear-gradient(90deg, var(--line-soft) 1px, transparent 1px);
  background-size: 48px 48px;
  -webkit-mask-image: radial-gradient(circle at 50% 44%, #000 0%, transparent 74%);
  mask-image: radial-gradient(circle at 50% 44%, #000 0%, transparent 74%);
  opacity: 0.9;
}

/* 扫描线：监控产品的老梗，很淡地扫一遍 */
.scan {
  position: absolute;
  left: 0;
  right: 0;
  height: 180px;
  background: linear-gradient(
    180deg,
    transparent,
    color-mix(in srgb, var(--accent) 12%, transparent) 45%,
    color-mix(in srgb, var(--accent) 18%, transparent) 50%,
    transparent
  );
  animation: scan 9s linear infinite;
}

@keyframes scan {
  from {
    top: -180px;
  }
  to {
    top: 100%;
  }
}

/* ==================== 主体两栏 ==================== */
.shell {
  position: relative;
  z-index: 1;
  width: min(940px, 100%);
  display: grid;
  grid-template-columns: 1.05fr 0.95fr;
  gap: 38px;
  align-items: center;
  animation: rise 0.52s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
}

/* ---------- 左：品牌 ---------- */
.brand {
  display: flex;
  flex-direction: column;
  gap: 22px;
  min-width: 0;
}

.brand-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo {
  width: 54px;
  height: 54px;
  border-radius: 15px;
  overflow: hidden;
  flex: 0 0 auto;
  background: var(--panel-2);
  border: 1px solid var(--line);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--tint) 14%, transparent),
    0 10px 26px rgba(0, 0, 0, 0.3);
}

.logo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.brand-text h1 {
  margin: 0;
  font-size: 25px;
  letter-spacing: 0.4px;
  color: var(--text-bright);
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.brand-text .ver {
  font-size: 11px;
  font-style: normal;
  font-weight: 500;
  color: var(--text-dim-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 7px;
}

.slogan {
  margin: 5px 0 0;
  font-size: 13px;
  color: var(--text-dim);
  letter-spacing: 0.3px;
}

.feats {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.feats li {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 13px;
  border-radius: 12px;
  border: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--panel-2) 55%, transparent);
  animation: rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.feats .ic {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  color: var(--accent-text);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.feats .tx {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.feats .tx b {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-soft);
}

.feats .tx i {
  font-style: normal;
  font-size: 11.5px;
  color: var(--text-dim-2);
}

.brand-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
}

.beat {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-dim-2);
  box-shadow: 0 0 0 0 transparent;
}

.beat.on {
  background: var(--ok);
  animation: pulse 2s ease-out infinite;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent);
  }
  70% {
    box-shadow: 0 0 0 8px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

/* ---------- 右：登录卡片 ---------- */
.panel {
  position: relative;
  padding: 28px 26px 20px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--panel-2) 82%, transparent),
    var(--panel-deep)
  );
  -webkit-backdrop-filter: blur(26px) saturate(1.7);
  backdrop-filter: blur(26px) saturate(1.7);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--tint) 14%, transparent),
    0 26px 70px rgba(0, 0, 0, 0.42);
}

/* 取景框四角 */
.cnr {
  position: absolute;
  width: 14px;
  height: 14px;
  border: 1.5px solid color-mix(in srgb, var(--accent) 62%, transparent);
  opacity: 0.75;
}

.cnr.tl {
  top: -1px;
  left: -1px;
  border-right: none;
  border-bottom: none;
  border-top-left-radius: 18px;
}

.cnr.tr {
  top: -1px;
  right: -1px;
  border-left: none;
  border-bottom: none;
  border-top-right-radius: 18px;
}

.cnr.bl {
  bottom: -1px;
  left: -1px;
  border-right: none;
  border-top: none;
  border-bottom-left-radius: 18px;
}

.cnr.br {
  bottom: -1px;
  right: -1px;
  border-left: none;
  border-top: none;
  border-bottom-right-radius: 18px;
}

.panel-head h2 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.5px;
  color: var(--text-bright);
}

.panel-head p {
  margin: 5px 0 20px;
  font-size: 12.5px;
  color: var(--text-dim);
}

.row {
  display: block;
  margin-bottom: 14px;
}

.lb {
  display: block;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
  letter-spacing: 0.3px;
}

.ipt {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 44px;
  padding: 0 12px;
  border-radius: 11px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--field-bg) 92%, transparent);
  transition:
    border-color 0.16s ease,
    box-shadow 0.18s ease,
    background 0.16s ease;
}

.ipt:focus-within {
  border-color: color-mix(in srgb, var(--accent) 68%, transparent);
  background: color-mix(in srgb, var(--field-bg) 100%, transparent);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent),
    inset 0 1px 0 color-mix(in srgb, var(--tint) 8%, transparent);
}

.ipt .ico {
  color: var(--text-dim-2);
  flex: 0 0 auto;
}

.ipt:focus-within .ico {
  color: var(--accent-text);
}

.ipt input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  letter-spacing: 0.2px;
  color: var(--text);
}

.ipt input::placeholder {
  color: var(--text-dim-2);
}

/* 浏览器自动填充：默认会糊一层白底/黄底，这里统一压回玻璃质感 */
.ipt input:-webkit-autofill,
.ipt input:-webkit-autofill:hover,
.ipt input:-webkit-autofill:focus {
  -webkit-text-fill-color: var(--text);
  -webkit-box-shadow: 0 0 0 1000px transparent inset;
  transition: background-color 9999s ease-out 0s;
}

.eye {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-dim-2);
  transition: color 0.15s ease, background 0.15s ease;
}

.eye:hover,
.eye.on {
  color: var(--accent-text);
  background: var(--accent-soft);
}

.opts {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 4px 0 2px;
  min-height: 20px;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text-dim);
  padding: 2px 0;
  transition: color 0.15s ease;
}

.check:hover {
  color: var(--text-soft);
}

.check .box {
  width: 15px;
  height: 15px;
  border-radius: 5px;
  border: 1px solid var(--line-strong);
  display: grid;
  place-items: center;
  color: transparent;
  transition: all 0.16s ease;
}

.check.on .box {
  color: #fff;
  border-color: color-mix(in srgb, var(--accent) 75%, transparent);
  background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 78%, #000));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 32%, transparent);
}

.caps {
  font-size: 11.5px;
  color: var(--warn-text);
  white-space: nowrap;
}

.msg {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  border-radius: 9px;
  padding: 8px 11px;
  border: 1px solid transparent;
}

.msg.err {
  color: var(--err-text);
  background: color-mix(in srgb, var(--err) 12%, transparent);
  border-color: color-mix(in srgb, var(--err) 34%, transparent);
}

.msg.note {
  color: var(--warn-text);
  background: color-mix(in srgb, var(--warn) 11%, transparent);
  border-color: color-mix(in srgb, var(--warn) 28%, transparent);
}

.submit {
  width: 100%;
  height: 46px;
  margin-top: 16px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: 2px;
  color: #fff;
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 96%, #fff), var(--accent));
  border: 1px solid color-mix(in srgb, var(--accent) 70%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.28),
    0 10px 26px color-mix(in srgb, var(--accent) 30%, transparent);
  transition:
    transform 0.12s ease,
    box-shadow 0.18s ease,
    filter 0.16s ease;
}

.submit:hover:not(:disabled) {
  filter: brightness(1.06);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.3),
    0 14px 32px color-mix(in srgb, var(--accent) 38%, transparent);
}

.submit:active:not(:disabled) {
  transform: translateY(1px);
}

.submit:disabled {
  cursor: not-allowed;
  filter: saturate(0.6) brightness(0.86);
  box-shadow: none;
}

.spin {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.tip {
  margin: 14px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-dim-2);
}

.tip code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--tint) 7%, transparent);
}

/* 登录失败：卡片抖一下（很克制，0.46 秒） */
.panel.shake {
  animation: shake 0.44s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

@keyframes shake {
  10%,
  90% {
    transform: translateX(-3px);
  }
  20%,
  80% {
    transform: translateX(5px);
  }
  30%,
  50%,
  70% {
    transform: translateX(-7px);
  }
  40%,
  60% {
    transform: translateX(7px);
  }
}

/* ==================== 底部 ==================== */
.foot {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  justify-content: center;
  font-size: 11.5px;
  color: var(--text-dim-2);
  animation: rise 0.6s 0.16s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.foot .clock {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.foot .sep {
  opacity: 0.5;
}

/* 淡入淡出（错误 / 提示） */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ==================== 自适应 ==================== */

/* 平板 / 竖屏手机：改单列，品牌区压缩成一行 */
@media (max-width: 880px) {
  .shell {
    grid-template-columns: 1fr;
    gap: 18px;
    width: min(440px, 100%);
  }

  .feats {
    display: none;
  }

  .brand {
    gap: 0;
    align-items: flex-start;
  }

  .brand-foot {
    display: none;
  }
}

/* 小屏：卡片占满、留白收紧 */
@media (max-width: 480px) {
  .login-root {
    justify-content: flex-start;
    padding-top: calc(var(--safe-top) + 34px);
    overflow-y: auto;
  }

  .brand-text h1 {
    font-size: 21px;
  }

  .slogan {
    font-size: 12px;
  }

  .panel {
    padding: 22px 18px 16px;
    border-radius: 16px;
  }

  .foot {
    margin-top: 4px;
  }
}

/* 触屏：输入框字号 ≥16px（否则 iOS 聚焦时整页被放大），控件加高到手指可点 */
@media (pointer: coarse) {
  .ipt {
    height: 48px;
  }

  .ipt input {
    font-size: 16px;
  }

  .submit {
    height: 50px;
  }

  .check {
    padding: 6px 0;
  }
}

/* 系统开了「减少动态效果」：光斑 / 扫描线 / 入场动画全部停掉 */
@media (prefers-reduced-motion: reduce) {
  .orb,
  .scan,
  .shell,
  .feats li,
  .foot,
  .beat.on,
  .spin {
    animation: none !important;
  }
}
</style>
