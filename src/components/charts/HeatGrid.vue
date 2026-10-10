<template>
  <div class="hg-wrap">
    <!-- 说明行：把"最忙的一格 / 悬停那一格"说清楚。放在 SVG 外面而不是浮层里：
         抽屉的 z-index 已经排到 600+，再新造一层浮层迟早打架，触屏上浮层还容易失灵 -->
    <div class="hg-head">
      <span class="hg-cap" :class="{ hot: !!cur }">{{ caption }}</span>
      <span class="hg-scale">
        <em>少</em>
        <i
          v-for="k in 5"
          :key="k"
          :style="{ background: color, opacity: heatOpacity((k - 1) * (dataMax / 4), dataMax) }"
        ></i>
        <em>多</em>
      </span>
    </div>

    <svg class="hg-svg" :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="ariaLabel">
      <title>{{ ariaLabel }}</title>

      <g class="hg-grid" @pointermove="onMove" @pointerleave="onLeave" @click="onTap">
        <template v-for="(row, ri) in grid" :key="row.id">
          <!-- 行底纹：悬停时整行提一下，方便在 168 格里定位 -->
          <rect
            v-if="activeRow === ri"
            class="hg-rowover"
            :x="padL"
            :y="rowTop(ri)"
            :width="gridW"
            :height="cellH"
            rx="2"
          />
          <text
            class="hg-rownum"
            :class="{ on: activeRow === ri }"
            :x="padL - 5"
            :y="rowTop(ri) + cellH / 2 + 3"
          >
            {{ row.label }}
          </text>
          <rect
            v-for="(v, ci) in row.cells"
            :key="ci"
            class="hg-cell"
            :class="{ on: activeRow === ri && activeCol === ci, peak: dataMax > 0 && v === dataMax }"
            :x="cellX(ci)"
            :y="rowTop(ri)"
            :width="cellW"
            :height="cellH"
            rx="1.8"
            :style="{ fill: row.color || color, fillOpacity: heatOpacity(v, dataMax) }"
            :data-r="ri"
            :data-c="ci"
          />
        </template>
      </g>

      <g class="hg-hours">
        <template v-for="(l, ci) in hourLabels" :key="ci">
          <text v-if="l" :x="cellX(ci) + cellW / 2" :y="H - 3.5">{{ l }}</text>
        </template>
      </g>
    </svg>

    <p class="hg-note">{{ note }}</p>
  </div>
</template>

<script setup>
/**
 * 热力图：行 × 24 小时的密度格（GitHub 提交图那种）。
 *
 * 为什么自己画、不用 ChartFrame：它的坐标轴是"y 轴是数值"，
 * 而热力图是**两个分类轴**（行是日期/类型，列是小时），刻度逻辑完全不同，
 * 硬套只会把 ChartFrame 塞满开关。
 *
 * 三条实现上的取舍：
 *  - **零值也要画格子**（用最浅的透明度），不能留白：留白表示"没有这一格"，
 *    而这里 0 是"这个小时没有报警"，是有效读数。用户要能数出 7×24 个格子。
 *  - 透明度用 `heatOpacity()`（带 0.6 的指数），否则最大值一大，
 *    1~2 次的小值会全部退化成看不见。
 *  - 事件挂在**一个 `<g>` 上**靠 `data-r` / `data-c` 分派，不给 168 个格子各挂一套
 *    监听（抽屉已经因为合成开销吃过一次性能亏，能省就省）。
 *
 * 不引任何图表库：这个图在 7 天窗口下最多 168 个 `<rect>`，
 * 自绘 SVG 直接吃 CSS 变量 —— 三套主题切换零成本、四个端零适配。
 */
import { computed, ref } from 'vue'
import { heatOpacity, fmtHour } from './scale.js'

const props = defineProps({
  /** [{ id, label, cells:number[24], color? }]，cells 会被补成 24 长 */
  rows: { type: Array, default: () => [] },
  /** 统一色（行自带 color 时以行为准） */
  color: { type: String, default: 'var(--accent)' },
  unit: { type: String, default: '次' },
  /** 指标名，用在说明行与无障碍标签里 */
  metricLabel: { type: String, default: '报警' }
})

const W = 480
const padL = 36
const padR = 5
const padT = 3
const padB = 15
const rowH = 15
const cellH = 12.4
const cols = 24

const gridW = W - padL - padR
const step = gridW / cols
const cellW = step - 1.6

const grid = computed(() =>
  props.rows.map((row) => {
    const src = row && Array.isArray(row.cells) ? row.cells : []
    const cells = []
    for (let i = 0; i < cols; i += 1) {
      const v = Number(src[i])
      cells.push(Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
    }
    return {
      id: (row && row.id) || `r${cells.join('')}`,
      label: (row && row.label) || '',
      color: row && row.color,
      cells,
      sum: cells.reduce((a, b) => a + b, 0)
    }
  })
)

const H = computed(() => padT + grid.value.length * rowH + padB)
const total = computed(() => grid.value.reduce((a, r) => a + r.sum, 0))
/** 数据里的最大值（全零时是 0 —— 不能兜成 1，否则说明行会写"最深 1 次"） */
const dataMax = computed(() => Math.max(0, ...grid.value.flatMap((r) => r.cells)))

const hourLabels = computed(() => {
  const out = []
  for (let i = 0; i < cols; i += 1) out.push(i % 3 === 0 ? fmtHour(i) : '')
  return out
})

const activeRow = ref(-1)
const activeCol = ref(-1)
const pinned = ref(null) // { r, c }

const cur = computed(() => {
  const p = pinned.value || (activeRow.value >= 0 ? { r: activeRow.value, c: activeCol.value } : null)
  if (!p) return null
  const row = grid.value[p.r]
  if (!row) return null
  return { row, c: p.c, v: row.cells[p.c] || 0, ri: p.r, ci: p.c }
})

const caption = computed(() => {
  if (!cur.value) return `${grid.value.length} 行 × ${cols} 小时 · 共 ${total.value} ${props.unit}`
  const c = cur.value
  return `${c.row.label} ${fmtHour(c.c)}:00 — ${c.v} ${props.unit}`
})

const note = computed(() =>
  dataMax.value > 0
    ? `最忙的一格是 ${dataMax.value} ${props.unit}（描边格）；每格 = 该小时${props.metricLabel}次数`
    : `这段时间还没有${props.metricLabel}记录，格子会以最浅色占位`
)

const ariaLabel = computed(
  () =>
    `热力图（${props.metricLabel}）：${grid.value
      .map((r) => `${r.label} 共 ${r.sum} ${props.unit}`)
      .join('，') || '暂无数据'}`
)

const rowTop = (ri) => padT + ri * rowH
const cellX = (ci) => padL + ci * step

function pick(e) {
  const t = e && e.target
  if (!t || !t.dataset || t.dataset.r == null || t.dataset.c == null) return null
  return { r: Number(t.dataset.r), c: Number(t.dataset.c) }
}

function onMove(e) {
  if (e && e.pointerType && e.pointerType !== 'mouse') return
  const p = pick(e)
  if (!p) return
  activeRow.value = p.r
  activeCol.value = p.c
}

function onLeave(e) {
  if (e && e.pointerType && e.pointerType !== 'mouse') return
  if (!pinned.value) {
    activeRow.value = -1
    activeCol.value = -1
  }
}

function onTap(e) {
  const p = pick(e)
  if (!p) return
  // 再点同一格取消钉住（触屏没有 hover，这是唯一能让说明行回到汇总的方式）
  if (pinned.value && pinned.value.r === p.r && pinned.value.c === p.c) {
    pinned.value = null
    activeRow.value = -1
    activeCol.value = -1
  } else {
    pinned.value = p
    activeRow.value = p.r
    activeCol.value = p.c
  }
}
</script>

<style scoped>
.hg-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-height: 17px;
}

.hg-cap {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11.5px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.hg-cap.hot {
  color: var(--text-bright);
}

.hg-scale {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.hg-scale i {
  width: 11px;
  height: 9px;
  border-radius: 2px;
  display: block;
}

.hg-scale em {
  font-style: normal;
  font-size: 10px;
  color: var(--text-dim-2);
  margin: 0 2px;
}

.hg-svg {
  width: 100%;
  height: auto;
  display: block;
  overflow: visible;
}

.hg-cell {
  transition: fill-opacity 0.18s ease;
  cursor: crosshair;
}

.hg-cell.on {
  stroke: var(--text-bright);
  stroke-width: 1.3;
}

.hg-cell.peak {
  stroke: var(--text-soft);
  stroke-width: 0.9;
  stroke-dasharray: 2 1.4;
}

.hg-rowover {
  fill: var(--pop-hi);
}

.hg-rownum {
  fill: var(--text-dim-2);
  font-size: 9px;
  text-anchor: end;
  font-variant-numeric: tabular-nums;
}

.hg-rownum.on {
  fill: var(--text-bright);
}

.hg-hours text {
  fill: var(--text-dim-2);
  font-size: 8.5px;
  text-anchor: middle;
  font-variant-numeric: tabular-nums;
}

.hg-note {
  margin: 0;
  font-size: 10.5px;
  color: var(--text-dim-2);
  line-height: 1.6;
}
</style>
