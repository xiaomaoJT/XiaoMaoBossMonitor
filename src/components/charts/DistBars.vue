<template>
  <div class="db">
    <!-- 统一刻度：六条横条共用同一个 max，上面配一把尺子。
         没有这把尺子的横条只能比"谁长谁短"，读不出"差多少" -->
    <div class="db-row db-ruler" aria-hidden="true">
      <span></span>
      <span class="db-axis">
        <i>0</i>
        <i>{{ midLabel }}</i>
        <i>{{ maxLabel }}</i>
      </span>
      <span></span>
      <span></span>
    </div>

    <div
      v-for="r in rows"
      :key="r.id"
      class="db-row"
      :class="{ on: active === r.id }"
      :title="`${r.label}：${r.n} ${unit}（占 ${pct(r.n)}）`"
      @pointermove="onMove($event, r.id)"
      @pointerleave="onLeave($event)"
      @click="onTap(r.id)"
    >
      <span class="db-lab">{{ r.label }}</span>
      <span class="db-track">
        <span class="db-fill" :style="{ width: w(r.n), background: r.color }"></span>
      </span>
      <span class="db-num">{{ r.n }}</span>
      <span class="db-pct">{{ pct(r.n) }}</span>
    </div>
  </div>
</template>

<script setup>
/**
 * 类型分布横条（保留 HTML/CSS 实现，不上 SVG）。
 *
 * 为什么不改成 SVG：六行"标签 + 条 + 数字 + 百分比"本质是一张**表格**，
 * HTML 的网格布局让文字换行、省略号、列宽自适应全部免费；
 * 换成 SVG 反而要手算文本宽度。这里"更高级"的落点是**统一刻度尺**
 * （六条共用一个 max，能读出差距大小）+ 类型主题色 + hover 联动。
 */
import { computed, ref } from 'vue'

const props = defineProps({
  /** [{ id, label, n, color }] */
  rows: { type: Array, default: () => [] },
  unit: { type: String, default: '次' }
})

const max = computed(() => Math.max(0, ...props.rows.map((r) => Number(r.n) || 0)))
const total = computed(() => props.rows.reduce((a, r) => a + (Number(r.n) || 0), 0))
const maxLabel = computed(() => (max.value > 0 ? `${max.value}` : '0'))
const midLabel = computed(() => (max.value > 0 ? `${Math.max(1, Math.round(max.value / 2))}` : ''))

const w = (n) => {
  const v = Number(n) || 0
  if (v <= 0) return '0%'
  // 最小 3%：一条"有数但极小"的条不该完全看不见
  return `${Math.max(3, (v / Math.max(1, max.value)) * 100)}%`
}

const pct = (n) => {
  const v = Number(n) || 0
  if (!total.value) return '—'
  return `${Math.round((v / total.value) * 100)}%`
}

const active = ref(null)
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
.db {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/* 四列网格：标签 / 条 / 数字 / 百分比。尺子用同一套模板，所以天然对齐 */
.db-row {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 38px 34px;
  align-items: center;
  gap: 6px;
}

.db-row:not(.db-ruler) {
  padding: 1px 3px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.db-row.on:not(.db-ruler) {
  background: var(--pop-hi);
}

.db-ruler {
  margin-bottom: 1px;
}

.db-axis {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid var(--line-soft);
  padding-bottom: 2px;
}

.db-axis i {
  font-style: normal;
  font-size: 9.5px;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
}

.db-lab {
  font-size: 11.5px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.db-track {
  height: 15px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  overflow: hidden;
}

.db-fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s ease;
}

.db-num {
  text-align: right;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
}

.db-pct {
  text-align: right;
  font-size: 10.5px;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
}
</style>
