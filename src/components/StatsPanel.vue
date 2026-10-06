<template>
  <div class="stats-page">
    <!-- ============ 周期切换 ============ -->
    <div class="sp-head">
      <div class="seg">
        <button
          v-for="p in PERIODS"
          :key="p.key"
          class="seg-btn"
          :class="{ on: period === p.key }"
          @click="period = p.key"
        >
          {{ p.label }}
        </button>
      </div>
      <span class="sp-note">{{ periodNote }}</span>
      <span class="spacer"></span>
      <button class="btn tiny" :disabled="!hasData" @click="exportStats">导出统计</button>
      <button class="btn tiny danger" :disabled="!hasData" @click="onReset">清零统计</button>
    </div>

    <p class="empty-hint" v-if="!hasData">
      本周期还没有任何记录。产生报警或推送之后，这里会自动出现图表（统计按天保留最近 7 天）。
    </p>

    <template v-else>
      <!-- ============ 概览数字 ============ -->
      <div class="kpi-row">
        <div class="kpi">
          <i>报警次数</i>
          <b>{{ total.alarms }}</b>
          <em>{{ perDayText }}</em>
        </div>
        <div class="kpi">
          <i>识别人次</i>
          <b>{{ total.personHits }}</b>
          <em>唯一 {{ total.people.length }} 人</em>
        </div>
        <div class="kpi">
          <i>推送总数</i>
          <b>{{ pushTotal.ok + pushTotal.fail }}</b>
          <em>成功 {{ pushTotal.ok }} · 失败 {{ pushTotal.fail }}</em>
        </div>
        <div class="kpi" :class="{ warn: total.offline > 0 }">
          <i>通道断线</i>
          <b>{{ total.offline }}</b>
          <em>恢复 {{ total.online }} 次</em>
        </div>
      </div>

      <!-- ============ 报警趋势（柱状） ============ -->
      <section class="card">
        <h4>报警趋势<em>按天</em></h4>
        <div class="bars" v-if="trend.some((d) => d.alarms > 0)">
          <div class="bar-col" v-for="d in trend" :key="d.key" :title="`${d.label}：${d.alarms} 次报警`">
            <div class="bar-track">
              <div class="bar-fill" :style="{ height: barH(d.alarms) }"></div>
            </div>
            <span class="bar-num">{{ d.alarms || '' }}</span>
            <span class="bar-label">{{ d.label }}</span>
          </div>
        </div>
        <p class="no-data" v-else>该周期没有报警记录。</p>
      </section>

      <!-- ============ 报警类型分布（横向条） ============ -->
      <section class="card">
        <h4>报警类型分布</h4>
        <div class="hbar-list" v-if="typeRows.length">
          <div class="hbar" v-for="r in typeRows" :key="r.id" :title="`${r.label}：${r.n} 次`">
            <span class="hb-label">{{ r.label }}</span>
            <span class="hb-track">
              <span class="hb-fill" :class="r.id" :style="{ width: hbW(r.n) }"></span>
            </span>
            <span class="hb-num">{{ r.n }}</span>
          </div>
        </div>
        <p class="no-data" v-else>该周期没有报警记录。</p>
      </section>

      <!-- ============ 三端推送（成功率条） ============ -->
      <section class="card">
        <h4>三端推送<em>成功 / 失败 / 成功率</em></h4>
        <div class="push-list">
          <div class="push-row" v-for="c in channelRows" :key="c.id">
            <span class="pr-name">{{ c.label }}</span>
            <span class="pr-bar">
              <span class="pr-ok" :style="{ width: prW(c, 'ok') }"></span>
              <span class="pr-fail" :style="{ width: prW(c, 'fail') }"></span>
            </span>
            <span class="pr-num">
              <template v-if="c.total === 0">未推送</template>
              <template v-else>{{ c.ok }}/{{ c.total }} · {{ c.rate }}</template>
            </span>
          </div>
        </div>
        <p class="tip-line">
          成功率按「实际发出的推送」计算（成功 + 失败）。静默时段、限流、未勾选这些压根没发出去的，不计入。
        </p>
      </section>

      <!-- ============ 识别到的人 ============ -->
      <section class="card" v-if="total.people.length">
        <h4>识别到的人<em>{{ total.people.length }} 位</em></h4>
        <div class="people">
          <span class="p-chip" v-for="(n, i) in total.people" :key="i">{{ n }}</span>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  KEEP_DAYS,
  STAT_ALARM_TYPES,
  STAT_CHANNELS,
  aggregate,
  dailyStats,
  recentDayKeys,
  resetDailyStats,
  statsOf
} from '../composables/useDailyStats'

const emit = defineEmits(['reset-done'])

/* ==================== 周期切换 ==================== */
const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'week', label: `近 ${KEEP_DAYS} 天` }
]
const period = ref('week')

/** 当前周期对应哪些日期键（早 → 晚） */
const rangeKeys = computed(() => {
  const now = Date.now()
  if (period.value === 'today') return [recentDayKeys(1, now)[0]]
  if (period.value === 'yesterday') {
    // 昨天 = 从今天键往前推一天。用本地日期算，别用 UTC（会错一天）。
    const d = new Date()
    d.setDate(d.getDate() - 1)
    const p = (n) => String(n).padStart(2, '0')
    return [`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`]
  }
  return recentDayKeys(KEEP_DAYS, now)
})

const total = computed(() => aggregate(rangeKeys.value))

const hasData = computed(() => {
  const t = total.value
  return (
    t.alarms > 0 ||
    t.personHits > 0 ||
    t.offline > 0 ||
    t.online > 0 ||
    t.people.length > 0 ||
    Object.values(t.push || {}).some((p) => (p.ok || 0) + (p.fail || 0) > 0)
  )
})

const periodNote = computed(() => {
  const keys = rangeKeys.value
  if (period.value === 'week') return `共 ${keys.length} 天（统计仅保留最近 ${KEEP_DAYS} 天）`
  return keys[0] || ''
})

const perDayText = computed(() => {
  const d = total.value.days || 1
  const avg = total.value.alarms / d
  return d > 1 ? `日均 ${avg.toFixed(1)} 次` : '当日'
})

/* ==================== 趋势柱状图 ==================== */
const trend = computed(() =>
  rangeKeys.value.map((k) => {
    const d = statsOf(k)
    // 只显示"月-日"，跨度大时更清爽
    const label = k.slice(5).replace('-', '/')
    return { key: k, label, alarms: d.alarms || 0 }
  })
)

const maxTrend = computed(() => Math.max(1, ...trend.value.map((d) => d.alarms)))
const barH = (n) => `${Math.max(n > 0 ? 6 : 0, (n / maxTrend.value) * 100)}%`

/* ==================== 类型分布 ==================== */
const typeRows = computed(() =>
  STAT_ALARM_TYPES.map((t) => ({ id: t.id, label: t.label, n: total.value.byType[t.id] || 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
)
const maxType = computed(() => Math.max(1, ...typeRows.value.map((r) => r.n)))
const hbW = (n) => `${Math.max(3, (n / maxType.value) * 100)}%`

/* ==================== 三端推送 ==================== */
const pushTotal = computed(() => {
  const sum = { ok: 0, fail: 0 }
  STAT_CHANNELS.forEach(({ id }) => {
    sum.ok += total.value.push[id].ok
    sum.fail += total.value.push[id].fail
  })
  return sum
})

const channelRows = computed(() =>
  STAT_CHANNELS.map(({ id, label }) => {
    const p = total.value.push[id]
    const ok = p.ok || 0
    const fail = p.fail || 0
    const n = ok + fail
    return {
      id,
      label,
      ok,
      fail,
      total: n,
      rate: n ? `${Math.round((ok / n) * 100)}%` : '—'
    }
  })
)

/** 成功段宽度按"占该渠道全部推送"算，失败段同理，两者拼满整条 */
function prW(c, kind) {
  if (!c.total) return '0%'
  return `${((kind === 'ok' ? c.ok : c.fail) / c.total) * 100}%`
}

/* ==================== 操作 ==================== */
function onReset() {
  // eslint-disable-next-line no-alert
  if (typeof confirm === 'function' && !confirm('确定清零全部统计数据？此操作不可撤销。')) return
  resetDailyStats()
  emit('reset-done')
}

function exportStats() {
  const keys = rangeKeys.value
  const rows = keys.map((k) => {
    const d = statsOf(k)
    const push = STAT_CHANNELS.map(({ id, label }) => {
      const p = d.push[id] || { ok: 0, fail: 0 }
      return `${label} ${p.ok}/${p.ok + p.fail}`
    }).join('  ')
    return {
      日期: k,
      报警次数: d.alarms || 0,
      人形: d.byType.person || 0,
      人脸: d.byType.face || 0,
      区域: d.byType.zone || 0,
      姿态: d.byType.pose || 0,
      移动: d.byType.motion || 0,
      计数: d.byType.count || 0,
      识别人次: d.personHits || 0,
      唯一人数: (d.people || []).length,
      断线: d.offline || 0,
      恢复: d.online || 0,
      推送明细: push
    }
  })
  const csv = toCsv(rows)
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `BossMonitor-统计-${keys[0]}至${keys[keys.length - 1]}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function toCsv(rows) {
  if (!rows.length) return ''
  const head = Object.keys(rows[0])
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`
  return [head.map(esc).join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n')
}

// 变更即刷新（事件产生 / 推送落定都会改 dailyStats）
void dailyStats
</script>

<style scoped>
.stats-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sp-note {
  font-size: 11.5px;
  color: var(--text-dim-2);
}

.spacer {
  flex: 1 1 auto;
}

.empty-hint {
  padding: 22px 14px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-dim-2);
  line-height: 1.7;
  border: 1px dashed var(--line);
  border-radius: 10px;
}

/* ---------- KPI ---------- */
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
}

.kpi {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--line-soft);
  background: var(--panel);
}

.kpi i {
  font-style: normal;
  font-size: 11px;
  color: var(--text-dim-2);
}

.kpi b {
  font-size: 21px;
  font-weight: 600;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.kpi.warn b {
  color: var(--err-text);
}

.kpi em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--text-dim-2);
}

/* ---------- 卡片 ---------- */
.card {
  padding: 11px 13px 13px;
  border-radius: 10px;
  border: 1px solid var(--line-soft);
  background: var(--panel);
}

.card h4 {
  margin: 0 0 10px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-soft);
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.card h4 em {
  font-style: normal;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-dim-2);
}

.no-data {
  margin: 0;
  padding: 10px 0;
  font-size: 11.5px;
  color: var(--text-dim-2);
  text-align: center;
}

/* ---------- 柱状趋势 ---------- */
.bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 130px;
  padding-top: 4px;
}

.bar-col {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  height: 100%;
}

.bar-track {
  flex: 1 1 auto;
  width: 100%;
  max-width: 34px;
  display: flex;
  align-items: flex-end;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  border-radius: 5px 5px 3px 3px;
  overflow: hidden;
}

.bar-fill {
  width: 100%;
  background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 45%, transparent));
  border-radius: 4px 4px 0 0;
  transition: height 0.3s ease;
  min-height: 2px;
}

.bar-num {
  font-size: 10px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  height: 12px;
}

.bar-label {
  font-size: 10px;
  color: var(--text-dim-2);
  white-space: nowrap;
}

/* ---------- 横向条（类型分布） ---------- */
.hbar-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hb-label {
  flex: 0 0 34px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.hb-track {
  flex: 1 1 auto;
  min-width: 0;
  height: 15px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  overflow: hidden;
}

.hb-fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
}

.hb-fill.face {
  background: #9b6dff;
}
.hb-fill.pose {
  background: #ff8a3d;
}
.hb-fill.zone {
  background: #f0b429;
}
.hb-fill.motion {
  background: #4d8ef7;
}
.hb-fill.count {
  background: var(--cyan, #35d0d8);
}

.hb-num {
  flex: 0 0 34px;
  text-align: right;
  font-size: 11.5px;
  color: var(--text-soft);
  font-variant-numeric: tabular-nums;
}

/* ---------- 三端推送 ---------- */
.push-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.push-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pr-name {
  flex: 0 0 46px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.pr-bar {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  height: 15px;
  border-radius: 4px;
  overflow: hidden;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.pr-ok {
  background: var(--ok, #35c98a);
}

.pr-fail {
  background: var(--err, #e5484d);
}

.pr-num {
  flex: 0 0 96px;
  text-align: right;
  font-size: 11px;
  color: var(--text-soft);
  font-variant-numeric: tabular-nums;
}

.tip-line {
  margin: 9px 0 0;
  font-size: 10.5px;
  color: var(--text-dim-2);
  line-height: 1.6;
}

/* ---------- 人员 ---------- */
.people {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.p-chip {
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--ok-text, #bfe9d1);
  background: color-mix(in srgb, var(--ok) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
}
</style>
