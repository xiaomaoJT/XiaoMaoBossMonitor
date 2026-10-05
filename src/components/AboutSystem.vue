<template>
  <div class="about">
    <!-- ==================== 概览：最关心的四个数 ==================== -->
    <div class="hero">
      <div class="hero-main">
        <span class="hero-label">系统运行时长</span>
        <strong class="hero-clock">{{ uptimeText }}</strong>
        <span class="hero-sub">启动于 {{ bootText }}</span>
      </div>
      <div class="hero-cells">
        <div class="hero-cell">
          <span>累计推送</span>
          <strong>{{ pushStats.total }}</strong>
        </div>
        <div class="hero-cell">
          <span>成功</span>
          <strong class="ok">{{ pushStats.ok }}</strong>
        </div>
        <div class="hero-cell">
          <span>失败</span>
          <strong :class="pushStats.fail ? 'fail' : ''">{{ pushStats.fail }}</strong>
        </div>
        <div class="hero-cell">
          <span>在线通道</span>
          <strong>{{ props.cameras.length }}</strong>
        </div>
      </div>
    </div>

    <!-- ==================== 推送统计：三端分开 + 累计 ==================== -->
    <section class="card">
      <header class="card-head">
        <h4>推送统计</h4>
        <div class="head-ops">
          <span class="pct" v-if="pushStats.total">成功率 {{ successRate }}%</span>
          <button class="mini" @click="onResetStats">清零</button>
        </div>
      </header>

      <div class="ch-grid">
        <div class="ch" v-for="c in pushChannels" :key="c.id">
          <div class="ch-top">
            <span class="ch-name">{{ c.label }}</span>
            <strong class="ch-total">{{ chTotal(c.id) }}</strong>
          </div>
          <div class="ch-line">
            <span>成功 <i class="ok">{{ chOf(c.id).ok }}</i></span>
            <span>失败 <i :class="chOf(c.id).fail ? 'fail' : ''">{{ chOf(c.id).fail }}</i></span>
          </div>
          <div class="ch-time">{{ chOf(c.id).lastAt ? `最近 ${ago(chOf(c.id).lastAt)}` : '暂无记录' }}</div>
          <div class="ch-err" v-if="chOf(c.id).lastError" :title="chOf(c.id).lastError">
            {{ chOf(c.id).lastError }}
          </div>
        </div>
      </div>

      <p class="hint">
        首次推送 {{ pushStats.firstAt ? ago(pushStats.firstAt) : '暂无' }} ·
        最近推送 {{ pushStats.lastAt ? ago(pushStats.lastAt) : '暂无' }}
        <br />
        只统计真正发出去的（静默时段、未勾选、限流拦截的不计入）。
      </p>
    </section>

    <!-- ==================== 系统信息分区（含设备 / 能力 / 存储） ==================== -->
    <section class="card" v-for="sec in sections" :key="sec.title">
      <header class="card-head">
        <h4>{{ sec.title }}</h4>
      </header>
      <div class="kv-grid">
        <div class="kv" v-for="row in sec.rows" :key="row.k">
          <span class="k">{{ row.k }}</span>
          <span class="v" :class="row.tone || ''">{{ row.v }}</span>
        </div>
      </div>
    </section>

    <!-- ==================== 错误留档 ==================== -->
    <section class="card">
      <header class="card-head">
        <h4>错误留档</h4>
        <div class="head-ops">
          <span class="pct">{{ errorLog.length }} 条</span>
        </div>
      </header>
      <p class="hint" v-if="!errorLog.length">本次运行没有捕获到错误，状态良好。</p>
      <template v-else>
        <div class="err-item" v-for="(it, i) in errorLog.slice(0, 5)" :key="i">
          <div class="err-head">
            <span class="err-src">{{ it.source }}<template v-if="it.extra"> · {{ it.extra }}</template></span>
            <span class="err-time">{{ ago(it.time) }}</span>
          </div>
          <div class="err-msg">{{ it.message }}</div>
        </div>
        <p class="hint" v-if="errorLog.length > 5">仅显示最近 5 条，点下方「复制全部信息」可拿到完整留档。</p>
      </template>
    </section>

    <div class="foot">
      <button class="btn primary" @click="copyAll">{{ copied ? '已复制到剪贴板' : '复制全部信息' }}</button>
      <span class="foot-tip">{{ BRAND.fullName }} {{ BRAND.version }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BRAND } from '../config/defaults'
import { aiBackend, aiModel, aiState } from '../composables/useAiDetector'
import { runtimeInfo } from '../composables/useDeviceInfo'
import { errorLog, errorLogText } from '../composables/useErrorLog'
import { estimateUsage, formatBytes } from '../composables/useEventStore'
import { isJessibucaReady } from '../composables/useJessibuca'
import { PUSH_CHANNELS, pushStats, resetPushStats } from '../composables/usePushStats'

const props = defineProps({
  cameras: { type: Array, default: () => [] },
  events: { type: Array, default: () => [] },
  options: { type: Object, default: () => ({}) },
  layoutKey: { type: String, default: '' },
  /** 当前隐藏（不参与解码）的通道 id，用于算「在显示 N 路」 */
  hiddenIds: { type: Array, default: () => [] }
})

/* ==================== 运行时长 ==================== */
/*
 * performance.timeOrigin 是「本次页面导航开始」的绝对时间戳 —— 也就是应用真正
 * 被拉起来的时刻，比自己记一个 Date.now() 更准（后者会把脚本解析时间漏掉）。
 */
const BOOT_AT =
  (typeof performance !== 'undefined' && performance.timeOrigin) || Date.now()

const nowTick = ref(Date.now())
let ticker = null

onMounted(() => {
  ticker = setInterval(() => (nowTick.value = Date.now()), 1000)
})

onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
  ticker = null
})

const pad = (n) => String(n).padStart(2, '0')

const uptimeText = computed(() => {
  const total = Math.max(0, Math.floor((nowTick.value - BOOT_AT) / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`
  return d > 0 ? `${d} 天 ${clock}` : clock
})

const bootText = computed(() => new Date(BOOT_AT).toLocaleString('zh-CN'))

/** 相对时间，用在「最近推送」这类展示上 */
function ago(ts) {
  if (!ts) return '—'
  const diff = Date.now() - Number(ts)
  if (diff < 0) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/* ==================== 推送统计 ==================== */
const pushChannels = PUSH_CHANNELS
const chOf = (id) => pushStats.channels[id] || { ok: 0, fail: 0, lastAt: 0, lastError: '' }
const chTotal = (id) => {
  const c = chOf(id)
  return c.ok + c.fail
}
const successRate = computed(() =>
  pushStats.total ? Math.round((pushStats.ok / pushStats.total) * 100) : 0
)

function onResetStats() {
  if (typeof window !== 'undefined' && !window.confirm('清零累计推送统计？该操作不影响推送功能本身。')) return
  resetPushStats()
}

/* ==================== 异步采集：电池 / 存储配额 ==================== */
const batteryText = ref('读取中…')
const quotaText = ref('读取中…')
const lsBytes = ref(0)

/** 粗算 localStorage 占用（UTF-16，所以字符数 ×2 才是真实字节） */
function calcLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return 0
    let chars = 0
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k === null) continue
      chars += k.length + (localStorage.getItem(k) || '').length
    }
    return chars * 2
  } catch (e) {
    return 0
  }
}

onMounted(async () => {
  // 电池（Chrome 系支持，iOS Safari 不支持 → 保持「不支持」）
  try {
    if (navigator.getBattery) {
      const b = await navigator.getBattery()
      const pctOf = () => `${Math.round(b.level * 100)}%${b.charging ? '（充电中）' : ''}`
      batteryText.value = pctOf()
      b.addEventListener('levelchange', () => (batteryText.value = pctOf()))
      b.addEventListener('chargingchange', () => (batteryText.value = pctOf()))
    } else {
      batteryText.value = '该环境不支持读取'
    }
  } catch (e) {
    batteryText.value = '读取失败'
  }

  // 存储配额（IndexedDB 用量）
  try {
    const est = await estimateUsage()
    quotaText.value = est ? `${formatBytes(est.usage)} / ${formatBytes(est.quota)}` : '该环境不支持'
  } catch (e) {
    quotaText.value = '读取失败'
  }

  lsBytes.value = calcLocalStorage()
})

/* ==================== 能力探测 ==================== */
function webglRenderer() {
  try {
    const cv = document.createElement('canvas')
    const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl')
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : ''
  } catch (e) {
    return ''
  }
}

function nativePlatform() {
  try {
    const cap = typeof window !== 'undefined' ? window.Capacitor : null
    if (cap && typeof cap.getPlatform === 'function') {
      const p = cap.getPlatform()
      if (p === 'ios') return 'iOS App（Capacitor 原生壳）'
      if (p === 'android') return 'Android App（Capacitor 原生壳）'
    }
  } catch (e) {
    /* 忽略 */
  }
  return '否（浏览器 / 网页环境）'
}

const runtime = computed(() => runtimeInfo(BRAND))

/** 构建时间由 vite.config.js 的 define 注入；拿不到就显示「未注入」 */
const buildTime = (() => {
  try {
    return typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : ''
  } catch (e) {
    return ''
  }
})()

const netText = computed(() => {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection
  if (!c) return '该环境不支持读取'
  const parts = []
  if (c.effectiveType) {
    const map = { 'slow-2g': '极慢 2G', '2g': '2G', '3g': '3G', '4g': '4G', '5g': '5G' }
    parts.push(map[c.effectiveType] || c.effectiveType)
  }
  if (c.downlink) parts.push(`下行 ${c.downlink}Mb/s`)
  if (typeof c.rtt === 'number') parts.push(`RTT ${c.rtt}ms`)
  return parts.length ? parts.join(' · ') : '未知'
})

const onlineText = computed(() =>
  typeof navigator !== 'undefined' && navigator.onLine === false ? '离线' : '在线'
)

const tzText = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '未知'
  } catch (e) {
    return '未知'
  }
})()

const aiText = computed(() => {
  const stateMap = { idle: '未启用', loading: '加载中', ready: '就绪', error: '加载失败' }
  const s = stateMap[aiState.value] || aiState.value
  if (aiState.value === 'ready' && aiModel.value) {
    return `${s} · ${aiModel.value}${aiBackend.value ? ` · ${aiBackend.value.toUpperCase()}` : ''}`
  }
  return s
})

const unreadCount = computed(() => props.events.filter((e) => !e.read).length)

/** 采样一次可见性；它变化不频繁，模块级读一次够用 */
const visibilityText = computed(() => {
  const map = { visible: '前台可见', hidden: '后台 / 已隐藏', prerender: '预渲染' }
  const v = typeof document !== 'undefined' ? document.visibilityState : ''
  return map[v] || v || '未知'
})

/* ==================== 分区数据（模板与「复制全部」共用同一份源） ==================== */
const sections = computed(() => [
  {
    title: '系统运行',
    rows: [
      { k: '运行时长', v: uptimeText.value },
      { k: '启动时间', v: bootText.value },
      { k: '页面状态', v: visibilityText.value },
      { k: '应用版本', v: `${BRAND.fullName} ${BRAND.version}` },
      { k: '构建时间', v: buildTime ? new Date(buildTime).toLocaleString('zh-CN') : '未注入' },
      { k: '界面主题', v: themeLabel.value },
      { k: '画面布局', v: props.layoutKey || 'auto' },
      { k: '监控通道', v: `${props.cameras.length} 路（在显示 ${visibleCount.value} 路）` }
    ]
  },
  {
    title: '运行设备',
    rows: [
      { k: '设备类型', v: runtime.value.label },
      { k: '运行环境', v: runtime.value.detail || '—' },
      { k: '原生壳', v: nativePlatform() },
      { k: '系统语言', v: navigator.language || '未知' },
      { k: '时区', v: tzText },
      { k: '屏幕', v: screen && screen.width ? `${screen.width}×${screen.height}` : '未知' },
      { k: '窗口', v: typeof innerWidth === 'number' ? `${innerWidth}×${innerHeight}` : '未知' },
      { k: '像素比', v: String(devicePixelRatio || 1) },
      { k: '色彩深度', v: screen && screen.colorDepth ? `${screen.colorDepth} bit` : '未知' },
      { k: 'CPU 核心', v: navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} 核` : '未知' },
      {
        k: '设备内存',
        v: navigator.deviceMemory ? `约 ${navigator.deviceMemory} GB` : '该环境不支持读取'
      },
      { k: '网络状态', v: onlineText.value },
      { k: '网络类型', v: netText.value },
      { k: '电池', v: batteryText.value }
    ]
  },
  {
    title: '能力检测',
    rows: [
      {
        k: '视频解码器',
        v: isJessibucaReady() ? '已就绪（Jessibuca / wasm 软解）' : '正在加载…',
        tone: isJessibucaReady() ? 'ok' : ''
      },
      { k: 'AI 识别', v: aiText.value, tone: aiState.value === 'error' ? 'fail' : '' },
      {
        k: 'WebGPU',
        v: typeof navigator !== 'undefined' && navigator.gpu ? '支持（AI 走 GPU 加速）' : '不支持（回退 WASM）'
      },
      { k: 'WebGL 渲染器', v: webglRenderer() || '不可用' },
      {
        k: '屏幕常亮',
        v: typeof navigator !== 'undefined' && 'wakeLock' in navigator ? '支持' : '不支持'
      },
      {
        k: '剪贴板',
        v: typeof navigator !== 'undefined' && navigator.clipboard ? '支持' : '不支持'
      },
      { k: '本地数据库', v: typeof indexedDB !== 'undefined' ? 'IndexedDB 可用' : '不可用' }
    ]
  },
  {
    title: '数据与存储',
    rows: [
      { k: '报警事件', v: `${props.events.length} 条（未读 ${unreadCount.value} 条）` },
      { k: '事件库占用', v: quotaText.value },
      { k: '配置占用', v: lsBytes.value ? formatBytes(lsBytes.value) : '读取中…' },
      { k: '配置项', v: `${Object.keys(props.options || {}).length} 组` },
      { k: '错误留档', v: `${errorLog.value.length} 条` }
    ]
  }
])

const themeLabel = computed(() => {
  const map = { liquid: '液态风格', dark: '暗黑风格', light: '亮色风格', auto: '自动（跟随系统）' }
  return map[props.options && props.options.theme] || props.options?.theme || '默认'
})

/** 可见通道数：总数里去掉被隐藏的那些 */
const visibleCount = computed(() => {
  const hidden = props.hiddenIds || []
  return props.cameras.filter((c) => !hidden.includes(c.id)).length
})

/* ==================== 复制全部 ==================== */
const copied = ref(false)

function allText() {
  const lines = [`【${BRAND.fullName}】运行信息`, `导出时间：${new Date().toLocaleString('zh-CN')}`, '']

  lines.push('— 推送统计 —')
  lines.push(`累计 ${pushStats.total} 次 · 成功 ${pushStats.ok} · 失败 ${pushStats.fail} · 成功率 ${successRate.value}%`)
  pushChannels.forEach((c) => {
    const s = chOf(c.id)
    lines.push(
      `${c.label}：成功 ${s.ok} / 失败 ${s.fail}` +
        (s.lastAt ? ` · 最近 ${new Date(s.lastAt).toLocaleString('zh-CN')}` : '') +
        (s.lastError ? ` · 最近错误 ${s.lastError}` : '')
    )
  })
  lines.push('')

  sections.value.forEach((sec) => {
    lines.push(`— ${sec.title} —`)
    sec.rows.forEach((r) => lines.push(`${r.k}：${r.v}`))
    lines.push('')
  })

  const errs = errorLogText()
  if (errs) {
    lines.push('— 错误留档 —')
    lines.push(errs)
  }
  return lines.join('\n')
}

async function copyAll() {
  const text = allText()
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    setTimeout(() => (copied.value = false), 1800)
  } catch (e) {
    // 剪贴板不可用（非 https / 内嵌 WebView）时退化成控制台输出
    console.log(text)
  }
}
</script>

<style scoped>
.about {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---------- 概览 ---------- */
.hero {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border-radius: 12px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, transparent), transparent 62%),
    color-mix(in srgb, var(--panel-2) 70%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
}

.hero-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 168px;
}

.hero-label {
  font-size: 11px;
  color: var(--text-dim);
}

.hero-clock {
  font-size: 26px;
  font-weight: 500;
  letter-spacing: 0.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-bright);
}

.hero-sub {
  font-size: 11px;
  color: var(--text-dim-2);
}

.hero-cells {
  display: flex;
  gap: 10px;
  flex: 1 1 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.hero-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 62px;
  padding: 7px 10px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--tint) 6%, transparent);
  border: 1px solid var(--line-soft);
}

.hero-cell span {
  font-size: 11px;
  color: var(--text-dim);
}

.hero-cell strong {
  font-size: 16px;
  font-weight: 500;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

/* ---------- 卡片 ---------- */
.card {
  padding: 12px 14px 13px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel-2) 52%, transparent);
  border: 1px solid var(--line-soft);
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 9px;
}

.card-head h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.head-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pct {
  font-size: 11px;
  color: var(--text-dim);
}

.mini {
  height: 22px;
  padding: 0 9px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--tint) 6%, transparent);
  border: 1px solid var(--line);
}

.mini:hover {
  color: var(--err-text);
  border-color: color-mix(in srgb, var(--err) 40%, transparent);
}

/* ---------- 渠道卡片 ---------- */
.ch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}

.ch {
  padding: 9px 10px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--tint) 5%, transparent);
  border: 1px solid var(--line-soft);
}

.ch-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.ch-name {
  font-size: 12px;
  color: var(--text-soft);
}

.ch-total {
  font-size: 17px;
  font-weight: 500;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
}

.ch-line {
  display: flex;
  gap: 10px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-dim);
}

.ch-time {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-dim-2);
}

.ch-err {
  margin-top: 4px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--err-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 键值网格 ---------- */
.kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 3px 16px;
}

.kv {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  border-bottom: 1px dashed color-mix(in srgb, var(--line) 55%, transparent);
}

.kv .k {
  flex: 0 0 auto;
  min-width: 68px;
  color: var(--text-dim);
}

.kv .v {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-soft);
  word-break: break-all;
}

.ok {
  color: var(--ok-text);
  font-style: normal;
}

.fail {
  color: var(--err-text);
  font-style: normal;
}

/* ---------- 错误留档 ---------- */
.err-item {
  padding: 7px 9px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--err) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--err) 20%, transparent);
  margin-bottom: 6px;
}

.err-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--err-text);
}

.err-time {
  color: var(--text-dim-2);
}

.err-msg {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-soft);
  word-break: break-word;
}

/* ---------- 提示与底部 ---------- */
.hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim-2);
}

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 2px;
}

.foot-tip {
  font-size: 11px;
  color: var(--text-dim-2);
}

@media (max-width: 640px) {
  .hero {
    padding: 12px;
  }

  .hero-clock {
    font-size: 22px;
  }

  .hero-cells {
    justify-content: flex-start;
  }

  .kv-grid {
    grid-template-columns: 1fr;
  }
}
</style>
