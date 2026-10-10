<template>
  <div class="ps">
    <!--
      三端共用的**成功率刻度**：0% / 50% / 100%。
      为什么不给"推送条数"配刻度：三端各自的条都填满整行（= 该端自己的 100%），
      跨端的绝对量在同一个轴上没有可比性。真正能横向读的是**成功/失败的分割点**，
      所以尺子标的是成功率，条里还画一条 50% 参考线。
    -->
    <div class="ps-row ps-ruler" aria-hidden="true">
      <span></span>
      <span class="ps-axis">
        <i>0%</i>
        <i class="half">50%</i>
        <i>100%</i>
      </span>
      <span></span>
    </div>

    <div v-for="c in chans" :key="c.id" class="ps-row" :title="tip(c)">
      <span class="ps-name">{{ c.label }}</span>
      <span class="ps-track">
        <span class="ps-ok" :style="{ width: w(c, 'ok') }"></span>
        <span class="ps-fail" :style="{ width: w(c, 'fail') }"></span>
        <span class="ps-half"></span>
      </span>
      <span class="ps-num">
        <template v-if="!c.total">未推送</template>
        <template v-else>
          {{ c.ok }}/{{ c.total }} ·
          <b :class="c.tone">{{ c.rateText }}</b>
        </template>
      </span>
    </div>
  </div>
</template>

<script setup>
/**
 * 三端推送：成功/失败堆叠条 + 成功率刻度。
 *
 * 成功率**分档上色**（阈值写在下面 `toneOf`）：绿灯是常识里的"没问题"，
 * 但数字本身始终显示在旁边 —— 颜色只是让"哪一端在掉"一眼可见，不替代读数。
 * 没推送过（total = 0）显示"未推送"而不是 0%，这两件事不一样：
 * 0% 是"发了全失败"，是事故；未推送是"这段时间压根没触发"。
 */
import { computed } from 'vue'

const props = defineProps({
  /** [{ id, label, ok, fail }] */
  rows: { type: Array, default: () => [] }
})

/** 成功率分档阈值（仅影响颜色，数值始终显示） */
const TONE_OK = 0.9
const TONE_WARN = 0.5

/** 逐端算好成功率与色调（命名避开 props.rows，免得模板里两个 rows 打架） */
const chans = computed(() =>
  props.rows.map((c) => {
    const ok = Number(c.ok) || 0
    const fail = Number(c.fail) || 0
    const total = ok + fail
    const rate = total ? ok / total : -1
    return {
      id: c.id,
      label: c.label,
      ok,
      fail,
      total,
      rate,
      rateText: total ? `${Math.round(rate * 100)}%` : '—',
      tone: toneOf(rate, total)
    }
  })
)

function toneOf(rate, total) {
  if (!total) return ''
  if (rate >= TONE_OK) return 't-ok'
  if (rate >= TONE_WARN) return 't-warn'
  return 't-err'
}

/** 成功段 / 失败段各占整条的比例（两段拼满 = 该端自己的总量） */
function w(c, kind) {
  if (!c.total) return '0%'
  return `${((kind === 'ok' ? c.ok : c.fail) / c.total) * 100}%`
}

function tip(c) {
  if (!c.total) return `${c.label}：这段时间没有发出过推送`
  return `${c.label}：成功 ${c.ok} · 失败 ${c.fail} · 成功率 ${c.rateText}`
}
</script>

<style scoped>
.ps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ps-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 96px;
  align-items: center;
  gap: 8px;
}

.ps-ruler {
  gap: 8px;
}

.ps-axis {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid var(--line-soft);
  padding-bottom: 2px;
}

.ps-axis i {
  font-style: normal;
  font-size: 9.5px;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
}

.ps-name {
  font-size: 11.5px;
  color: var(--text-dim);
}

.ps-track {
  position: relative;
  display: flex;
  height: 15px;
  border-radius: 4px;
  overflow: hidden;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.ps-ok {
  background: var(--ok);
  transition: width 0.3s ease;
}

.ps-fail {
  background: var(--err);
  transition: width 0.3s ease;
}

/* 50% 参考线：夹在条上，据此能直接看出"过半没有" */
.ps-half {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line-strong);
  opacity: 0.85;
  pointer-events: none;
}

.ps-num {
  text-align: right;
  font-size: 11px;
  color: var(--text-soft);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ps-num b {
  font-weight: 600;
}

.ps-num b.t-ok {
  color: var(--ok-text);
}

.ps-num b.t-warn {
  color: var(--warn-text);
}

.ps-num b.t-err {
  color: var(--err-text);
}
</style>
