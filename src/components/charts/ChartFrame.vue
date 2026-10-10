<template>
  <svg
    class="cf"
    :viewBox="`0 0 ${W} ${H}`"
    :role="title ? 'img' : 'presentation'"
    :aria-label="title || undefined"
    preserveAspectRatio="xMidYMid meet"
  >
    <title v-if="title">{{ title }}</title>

    <!-- 横向网格 + y 刻度 -->
    <g class="cf-grid">
      <template v-for="t in ticks" :key="t.v">
        <line
          :x1="plot.x"
          :x2="plot.x + plot.w"
          :y1="y(t.v)"
          :y2="y(t.v)"
          :class="{ base: t.v === 0 }"
        />
        <text class="cf-ax-y" :x="plot.x - 5" :y="y(t.v) + 3.2">{{ t.label }}</text>
      </template>
    </g>

    <!-- 数据几何交给调用方：这里只给坐标系与比例函数 -->
    <slot :plot="plot" :x="cx" :x0="bx" :y="y" :step="pxStep" :top="top" :ticks="ticks" />

    <!-- x 轴标签（空串不画：热力图每 3 小时才标一个） -->
    <g class="cf-ax-x" v-if="xLabels.length">
      <!-- v-if 与 v-for 不能写在同一个元素上：v-if 先求值，取不到 v-for 的变量 -->
      <template v-for="(l, i) in xLabels" :key="i">
        <text v-if="l" :x="cx(i)" :y="H - 4.5">{{ l }}</text>
      </template>
    </g>
  </svg>
</template>

<script setup>
/**
 * 图表的「坐标系骨架」：网格、y 刻度、x 标签、以及 slot 用的比例函数。
 * ----------------------------------------------------------------------------
 * 三个刻意的决定：
 *
 * 1. **固定 viewBox + width:100%，不用 ResizeObserver。**
 *    统计页在 `v-show` 的页签里，抽屉又是 `v-if` —— 挂载那一刻容器很可能
 *    `display:none`、宽度是 0，观察器会先收到一个 0 再收到真实值，
 *    处理不当就是"图挤成一条线"。等比缩放（`preserveAspectRatio` 保持默认的
 *    meet）不需要知道真实像素：几何全在 viewBox 坐标系里算，浏览器负责放大。
 *    代价只有一个 —— 字号会随宽度整体缩放（480 的 viewBox 在 320~520px 宽的
 *    抽屉里渲染，缩放系数 0.67~1.08，9px 的字落到 6~9.7px）。抽屉宽度不会更窄，
 *    这个区间可接受；换来的是四端（Web / WKWebView / 小程序 web-view / Electron）
 *    完全一致，且 4K / 高 DPR 下永远锐利（矢量）。
 *
 * 2. **缩放上限取刻度的最大档，不是数据最大值。**
 *    否则最大值那一点永远贴在顶边上，而且顶部没有一条能读数的网格线。
 *
 * 3. **颜色一律 `var(--…)`**（样式块里或行内 style 里），绝不写 hex ——
 *    这是"三套主题切换零成本"的全部来源。注意：SVG 里 `fill="var(--x)"` 这种
 *    **属性**写法是无效的（属性不接受 var()），必须放 `style` 或 CSS 规则里。
 */
import { computed } from 'vue'
import { niceTicks } from './scale.js'

const props = defineProps({
  /** 数据最大值（内部会向上取到"好看的"刻度） */
  max: { type: Number, default: 0 },
  /** 期望刻度档数 */
  tickCount: { type: Number, default: 4 },
  /** viewBox 宽度（固定，靠 CSS 等比缩放） */
  width: { type: Number, default: 480 },
  /** viewBox 高度 */
  height: { type: Number, default: 150 },
  /** 内边距 {t,r,b,l}，只给需要的字段，其余走默认 */
  pad: { type: Object, default: () => ({}) },
  /** x 轴标签（长度 = 槽位数；空串表示这个槽不标） */
  xLabels: { type: Array, default: () => [] },
  /** 无障碍：一句说明这个图在讲什么 */
  title: { type: String, default: '' }
})

const W = computed(() => props.width)
const H = computed(() => props.height)

const ticks = computed(() => niceTicks(props.max, props.tickCount))
/** 缩放上限 = 刻度最大档 */
const top = computed(() => {
  const t = ticks.value
  const last = t.length ? t[t.length - 1].v : 0
  return last > 0 ? last : 1
})

const plot = computed(() => {
  const d = { t: 10, r: 6, b: props.xLabels.length ? 17 : 8, l: 26 }
  const p = Object.assign({}, d, props.pad || {})
  return {
    x: p.l,
    y: p.t,
    w: Math.max(1, W.value - p.l - p.r),
    h: Math.max(1, H.value - p.t - p.b)
  }
})

/** 槽宽（一个 x 单位占多少 viewBox 像素） */
const pxStep = computed(() => plot.value.w / Math.max(1, props.xLabels.length || 1))

/** 第 i 槽的**中心** x（折线、点、x 标签都用它） */
function cx(i) {
  return plot.value.x + (i + 0.5) * pxStep.value
}

/** 第 i 槽的**左边界** x（热力格、柱条用） */
function bx(i) {
  return plot.value.x + i * pxStep.value
}

/** 数值 → y（0 在底边，top 在顶边） */
function y(v) {
  const n = Number(v)
  const val = Number.isFinite(n) && n > 0 ? n : 0
  return plot.value.y + plot.value.h - (val / top.value) * plot.value.h
}

defineExpose({ top })
</script>

<style scoped>
/*
 * 宽度 100% + 高度 auto：viewBox 的宽高比决定渲染高度（等比，绝不变形）。
 * 之所以不用 preserveAspectRatio="none"：那会把圆压成椭圆、把描边拉粗。
 */
.cf {
  width: 100%;
  height: auto;
  display: block;
  overflow: visible;
}

.cf-grid line {
  stroke: var(--line-soft);
  stroke-width: 1;
}

.cf-grid line.base {
  stroke: var(--line);
}

.cf-ax-y,
.cf-ax-x {
  fill: var(--text-dim-2);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.cf-ax-y {
  text-anchor: end;
}

.cf-ax-x {
  text-anchor: middle;
}
</style>
