<template>
  <ChartFrame
    :max="localMax"
    :height="height"
    :x-labels="labels"
    :title="title || `${unit}趋势：${points.map((p) => `${p.label} ${p.value}`).join('，')}`"
  >
    <template #default="{ plot, x, x0, y, step, top }">
      <defs>
        <!-- 渐变靠 inline style 上色：stop-color 是**属性**，属性里写 var() 无效 -->
        <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" :style="{ stopColor: color, stopOpacity: 0.32 }" />
          <stop offset="1" :style="{ stopColor: color, stopOpacity: 0 }" />
        </linearGradient>
      </defs>

      <!-- 面积 -->
      <path v-if="!single" class="ta-area" :d="areaPath(plot, x, y)" :fill="`url(#${gid})`" />

      <!-- 折线 -->
      <path
        v-if="!single"
        class="ta-line"
        :d="linePath(x, y)"
        :style="{ stroke: color }"
        fill="none"
        stroke-width="1.8"
        stroke-linejoin="round"
        stroke-linecap="round"
      />

      <!-- 数据点：单点时退化成一个大点（折线画不出线） -->
      <g v-if="!active">
        <circle
          v-for="(p, i) in points"
          :key="p.key || i"
          :cx="x(i)"
          :cy="y(p.value)"
          :r="single ? 3.8 : 2.5"
          class="ta-dot"
          :style="{ fill: color }"
        />
      </g>

      <!-- 命中层：hover 预览 / tap 钉住（触屏没有 hover，必须支持 tap） -->
      <rect
        v-for="(p, i) in points"
        :key="`h${p.key || i}`"
        :x="x0(i)"
        :y="plot.y"
        :width="step"
        :height="plot.h"
        class="ta-hit"
        @pointermove="onMove($event, i)"
        @pointerleave="onLeave($event)"
        @click="onTap(i)"
      />

      <!-- 高亮：竖线 + 光环 + 实心点 + 数值（不新造浮层，避免与抽屉 z-index 打架） -->
      <g v-if="active" class="ta-on">
        <line
          :x1="x(active.i)"
          :x2="x(active.i)"
          :y1="plot.y"
          :y2="plot.y + plot.h"
          :style="{ stroke: color }"
          stroke-width="1"
          stroke-dasharray="3 3"
          opacity="0.7"
        />
        <circle
          :cx="x(active.i)"
          :cy="y(active.p.value)"
          r="7.5"
          :style="{ fill: color }"
          opacity="0.22"
        />
        <circle
          :cx="x(active.i)"
          :cy="y(active.p.value)"
          r="3.6"
          class="ta-pt-on"
          :style="{ fill: color }"
        />
        <text
          class="ta-val"
          :x="clampX(x(active.i), plot)"
          :y="Math.max(plot.y + 8, y(active.p.value) - 9)"
        >
          {{ active.p.value }}{{ unit }}
        </text>
        <text class="ta-cap" :x="clampX(x(active.i), plot)" :y="H - 4.5">
          {{ active.p.label }}
        </text>
      </g>
      <text v-else class="ta-hint" :x="plot.x + plot.w" :y="plot.y + 8" text-anchor="end">
        峰值 {{ top }}
      </text>
    </template>
  </ChartFrame>
</template>

<script setup>
/**
 * 报警趋势：面积 + 折线 + 数据点（替代原来的 CSS 柱条）。
 *
 * 为什么把原来的柱条换成折线：趋势要看的是"走势"而不是"每一天有多高"，
 * 折线 + 面积在同样的版面里能多表达一层（斜率 = 变化快慢），
 * 而且 7 个点用柱条时柱子之间大量留白，看起来比数据本身稀。
 *
 * 交互两个刻意的选择：
 *   - **hover 只是预览，click 才是"钉住"**（`pinned` 优先于 `hover`）。
 *     触屏没有 hover，只靠 hover 的 tooltip 在手机上永远不会出现。
 *   - **再点一下会把手悬停状态也清掉**（`hover = -1`）：否则鼠标用户
 *     "点开 → 再点收起"会因为指针还停在柱子上而看起来没收起。
 */
import { computed, ref } from 'vue'
import ChartFrame from './ChartFrame.vue'

const props = defineProps({
  /** [{ key, label, value }] */
  points: { type: Array, default: () => [] },
  /** 颜色 token（如 'var(--accent)'）或任意合法颜色 */
  color: { type: String, default: 'var(--accent)' },
  height: { type: Number, default: 156 },
  unit: { type: String, default: '次' },
  title: { type: String, default: '' }
})

/** 每个实例一个渐变 id：同一页出现两个同样的图时 id 不能撞（撞了后一个会引用前一个的渐变） */
const gid = `ta-grad-${Math.random().toString(36).slice(2, 9)}`

const H = computed(() => props.height)
const labels = computed(() => props.points.map((p) => p.label))
const single = computed(() => props.points.length === 1)
const localMax = computed(() => Math.max(0, ...props.points.map((p) => Number(p.value) || 0)))

const hover = ref(-1)
const pinned = ref(null)

const active = computed(() => {
  const i = pinned.value != null ? pinned.value : hover.value
  if (i < 0 || i >= props.points.length) return null
  return { i, p: props.points[i] }
})

function onMove(e, i) {
  // 触屏拖动也会发 pointermove：只有鼠标才当 hover，否则手指划过就乱闪
  if (e && e.pointerType && e.pointerType !== 'mouse') return
  hover.value = i
}

function onLeave(e) {
  if (e && e.pointerType && e.pointerType !== 'mouse') return
  if (pinned.value == null) hover.value = -1
}

function onTap(i) {
  if (pinned.value === i) {
    pinned.value = null
    hover.value = -1 // 见文件头：否则"再点收起"看着像没收
  } else {
    pinned.value = i
  }
}

function linePath(x, y) {
  return props.points.map((p, i) => `${i ? 'L' : 'M'}${r(x(i))},${r(y(p.value))}`).join('')
}

function areaPath(plot, x, y) {
  if (!props.points.length) return ''
  const base = plot.y + plot.h
  const head = props.points.map((p, i) => `${i ? 'L' : 'M'}${r(x(i))},${r(y(p.value))}`).join('')
  return `${head}L${r(x(props.points.length - 1))},${r(base)}L${r(x(0))},${r(base)}Z`
}

/** 数值标签贴边时会被裁掉，往内收一点（纯显示问题，不影响几何） */
function clampX(px, plot) {
  return Math.min(plot.x + plot.w - 16, Math.max(plot.x + 16, px))
}

const r = (v) => Math.round(v * 100) / 100
</script>

<style scoped>
.ta-area {
  animation: taFade 0.5s ease both;
}

/*
 * 描线动画：dasharray 固定 1400（大于任何一条 480 宽的路径长度），
 * 靠 dashoffset 从"整段藏在间隙里"滑到 0 —— 看起来就是线在生长。
 */
.ta-line {
  stroke-dasharray: 1400;
  animation: taDraw 0.75s ease both;
}

.ta-dot {
  transition: r 0.15s ease;
}

.ta-hit {
  fill: transparent;
  cursor: crosshair;
}

.ta-val {
  fill: var(--text-bright);
  font-size: 10px;
  font-weight: 600;
  text-anchor: middle;
  font-variant-numeric: tabular-nums;
}

.ta-cap {
  fill: var(--text-soft);
  font-size: 9px;
  text-anchor: middle;
}

.ta-hint {
  fill: var(--text-dim-2);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

@keyframes taDraw {
  from {
    stroke-dashoffset: 1400;
  }
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes taFade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ta-area,
  .ta-line {
    animation: none;
  }
  .ta-line {
    stroke-dasharray: none;
  }
}
</style>
