<template>
  <div class="dn-wrap">
    <svg
      class="dn-svg"
      :style="{ width: size + 'px' }"
      viewBox="0 0 200 200"
      role="img"
      :aria-label="ariaLabel"
    >
      <title>{{ title || ariaLabel }}</title>
      <!-- 底环：没有任何数据时也要看得见"这是个环形图" -->
      <circle cx="100" cy="100" :r="R" class="dn-base" :stroke-width="thick" />

      <!-- 从 12 点开始顺时针：rotate(-90) 把 3 点的起点挪到顶端 -->
      <g transform="rotate(-90 100 100)">
        <circle
          v-for="it in slices"
          :key="it.id"
          class="dn-arc"
          :class="{ on: active === it.id }"
          cx="100"
          cy="100"
          :r="R"
          fill="none"
          :stroke-width="active === it.id ? thick + 5 : thick"
          :stroke-dasharray="`${it.len} ${C - it.len}`"
          :stroke-dashoffset="-it.start"
          :style="{ stroke: it.color }"
          :opacity="active == null || active === it.id ? 1 : 0.32"
          @pointermove="onMove($event, it.id)"
          @pointerleave="onLeave($event)"
          @click="onTap(it.id)"
        />
      </g>

      <!-- 圆心：默认合计，hover/tap 时显示那一项的数值 -->
      <text class="dn-num" x="100" :y="98">{{ centerValue }}</text>
      <text class="dn-lab" x="100" :y="114">{{ centerLabel }}</text>
    </svg>

    <ul class="dn-legend">
      <li
        v-for="r in rows"
        :key="r.id"
        :class="{ on: active === r.id, dead: r.n === 0 }"
        @pointermove="onMove($event, r.id)"
        @pointerleave="onLeave($event)"
        @click="onTap(r.id)"
      >
        <i :style="{ background: r.color }"></i>
        <span class="dn-name">{{ r.label }}</span>
        <b>{{ r.n }}</b>
        <em>{{ r.pct }}</em>
      </li>
    </ul>
  </div>
</template>

<script setup>
/**
 * 占比环形图（报警类型分布）。
 *
 * 用「描边圆 + dasharray」而不是 path 圆弧：不用算弧线端点，
 * 每片只是同一段路径上的不同 dash 区间，代码量少一个量级，且天然支持过渡。
 *
 * 数字就在 SVG 里、图例用 HTML：图例要换行、要对齐、要跟着字号走，
 * 这些交给 HTML 排版最省事（SVG 里做文字换行是自找麻烦）。
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** [{ id, label, n, color }]，color 传 CSS 变量（如 'var(--type-face)'） */
  items: { type: Array, default: () => [] },
  /** 渲染宽度（px）。viewBox 固定 200×200，等比缩放 */
  size: { type: Number, default: 132 },
  unit: { type: String, default: '次' },
  title: { type: String, default: '' }
})

const R = 72
const thick = 19
const C = 2 * Math.PI * R

const rows = computed(() => {
  const list = props.items.filter((it) => it && Number(it.n) > 0)
  const total = list.reduce((a, b) => a + (Number(b.n) || 0), 0)
  let acc = 0
  const out = list.map((it) => {
    const n = Number(it.n) || 0
    const frac = total ? n / total : 0
    const start = acc * C
    acc += frac
    return {
      id: it.id,
      label: it.label,
      color: it.color,
      n,
      // 百分比按"占总数的份额"算，四舍五入到整数
      pct: `${Math.round(frac * 100)}%`,
      len: frac * C,
      start
    }
  })
  return out
})

/** 原样保留 zero 行给图例用（用户要能看到"这一类是 0"），但环形里不画 */
const slices = computed(() => rows.value.filter((r) => r.n > 0))
const totalN = computed(() => rows.value.reduce((a, b) => a + b.n, 0))

/**
 * 高亮用**项的 id**标识，不用下标 —— 环上只画 n>0 的片、图例里还留着 n=0 的行，
 * 两者下标对不上；用 id 就不会"点图例高亮了另一片"。
 */
const active = ref(null)
const activeRow = computed(() => rows.value.find((r) => r.id === active.value) || null)
const centerValue = computed(() => (activeRow.value ? activeRow.value.n : totalN.value) || 0)
const centerLabel = computed(() => (activeRow.value ? activeRow.value.label : `合计（${props.unit}）`))

const ariaLabel = computed(
  () => `占比：${rows.value.map((r) => `${r.label} ${r.n}（${r.pct}）`).join('，') || '暂无数据'}`
)

function onMove(e, id) {
  if (e && e.pointerType && e.pointerType !== 'mouse') return
  active.value = id
}

function onLeave(e) {
  if (e && e.pointerType && e.pointerType !== 'mouse') return
  active.value = null
}

function onTap(id) {
  active.value = active.value === id ? null : id
}
</script>

<style scoped>
.dn-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.dn-svg {
  flex: 0 0 auto;
  height: auto;
  display: block;
  animation: dnIn 0.45s ease both;
}

.dn-base {
  fill: none;
  stroke: var(--line-soft);
}

.dn-arc {
  transition:
    stroke-width 0.18s ease,
    opacity 0.18s ease;
  cursor: pointer;
}

.dn-num {
  fill: var(--text-bright);
  font-size: 26px;
  font-weight: 600;
  text-anchor: middle;
  font-variant-numeric: tabular-nums;
}

.dn-lab {
  fill: var(--text-dim-2);
  font-size: 10.5px;
  text-anchor: middle;
}

.dn-legend {
  flex: 1 1 132px;
  min-width: 0;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dn-legend li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-soft);
  padding: 2px 5px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.dn-legend li.on {
  background: var(--pop-hi);
}

.dn-legend li.dead {
  color: var(--text-dim-2);
}

.dn-legend i {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.dn-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dn-legend b {
  font-weight: 600;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
}

.dn-legend em {
  flex: 0 0 34px;
  font-style: normal;
  text-align: right;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
}

@keyframes dnIn {
  from {
    opacity: 0;
    transform: scale(0.94);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dn-svg {
    animation: none;
  }
}
</style>
