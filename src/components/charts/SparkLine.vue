<template>
  <svg
    class="sp"
    :viewBox="`0 0 ${W} ${height}`"
    :style="{ maxWidth: W + 'px' }"
    role="img"
    :aria-label="ariaLabel"
  >
    <title>{{ ariaLabel }}</title>
    <path v-if="fillOn && n > 1" class="sp-area" :d="areaPath" :fill="`url(#${gid})`" />
    <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" :style="{ stopColor: color, stopOpacity: 0.34 }" />
      <stop offset="1" :style="{ stopColor: color, stopOpacity: 0 }" />
    </linearGradient>
    <polyline
      v-if="n > 1"
      class="sp-line"
      :points="linePoints"
      fill="none"
      :style="{ stroke: color }"
      stroke-width="1.6"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <!-- 单点 / 末点：给一个"现在在哪"的锚 -->
    <circle
      class="sp-dot"
      :cx="n ? x(n - 1) : 0"
      :cy="n ? y(vals[n - 1]) : 0"
      :r="n === 1 ? 2.6 : 2"
      :style="{ fill: color }"
    />
  </svg>
</template>

<script setup>
/**
 * KPI 卡里嵌的迷你折线（sparkline）。
 * 刻意**不带坐标轴、不带交互**：它的职责是"一眼看出这几天的形状"，
 * 精确读数由上面的大图和数值本身承担。做成交互图反而会让 KPI 卡变重。
 */
import { computed } from 'vue'

const props = defineProps({
  /** 数值序列（早 → 晚） */
  values: { type: Array, default: () => [] },
  color: { type: String, default: 'var(--accent)' },
  height: { type: Number, default: 30 },
  width: { type: Number, default: 150 },
  /** 是否画渐变面积 */
  fillOn: { type: Boolean, default: true },
  label: { type: String, default: '' }
})

/** 每个实例一个渐变 id（同页多个 sparkline 不能撞 id） */
const gid = `sp-grad-${Math.random().toString(36).slice(2, 9)}`

const vals = computed(() => props.values.map((v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0)))
const n = computed(() => vals.value.length)
const W = computed(() => props.width)

const pad = 3
const max = computed(() => Math.max(1, ...vals.value))
const x = (i) => (n.value <= 1 ? W.value / 2 : pad + (i / (n.value - 1)) * (W.value - pad * 2))
const y = (v) => props.height - pad - (Number(v) / max.value) * (props.height - pad * 2)

const linePoints = computed(() => vals.value.map((v, i) => `${r(x(i))},${r(y(v))}`).join(' '))

const areaPath = computed(() => {
  if (n.value < 2) return ''
  const base = props.height - pad
  return `M${r(x(0))},${r(base)}${vals.value.map((v, i) => `L${r(x(i))},${r(y(v))}`).join('')}L${r(x(n.value - 1))},${r(base)}Z`
})

const ariaLabel = computed(() => `${props.label || '趋势'}：${vals.value.join('、')}`)

const r = (v) => Math.round(v * 100) / 100
</script>

<style scoped>
.sp {
  width: 100%;
  height: auto;
  display: block;
}

.sp-line {
  stroke-dasharray: 700;
  animation: spDraw 0.6s ease both;
}

.sp-area {
  animation: spFade 0.5s ease both;
}

@keyframes spDraw {
  from {
    stroke-dashoffset: 700;
  }
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes spFade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sp-line,
  .sp-area {
    animation: none;
  }
  .sp-line {
    stroke-dasharray: none;
  }
}
</style>
