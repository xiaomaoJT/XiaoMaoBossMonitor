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
      <!-- ============ 概览数字（报警 / 识别两张卡内嵌迷你趋势） ============ -->
      <div class="kpi-row">
        <div class="kpi">
          <i>报警次数</i>
          <b>{{ total.alarms }}</b>
          <em>{{ perDayText }}</em>
          <SparkLine
            v-if="trend.length > 1"
            class="kpi-spark"
            :values="trendValues"
            color="var(--accent)"
            label="报警次数趋势"
          />
        </div>
        <div class="kpi">
          <i>识别人次</i>
          <b>{{ total.personHits }}</b>
          <em>唯一 {{ total.people.length }} 人</em>
          <SparkLine
            v-if="trend.length > 1"
            class="kpi-spark"
            :values="hitValues"
            color="var(--type-face)"
            label="识别人次趋势"
          />
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

      <!-- ============ 报警趋势（面积折线） ============ -->
      <section class="card">
        <h4>报警趋势<em>按天 · 共 {{ total.alarms }} 次</em></h4>
        <TrendArea v-if="total.alarms > 0" :points="trend" unit="次" />
        <p class="no-data" v-else>该周期没有报警记录。</p>
        <p class="tip-line" v-if="trend.length > 1">点曲线上的某一天可以钉住数值，再点一下取消。</p>
      </section>

      <!-- ============ 报警类型占比（环形 + 图例） ============ -->
      <section class="card">
        <h4>报警类型占比<em>{{ typeTotal }} 次</em></h4>
        <DonutShare v-if="typeTotal > 0" :items="typeItems" unit="次" />
        <p class="no-data" v-else>该周期没有报警记录。</p>
      </section>

      <!-- ============ 报警类型分布（统一刻度横条） ============ -->
      <section class="card">
        <h4>报警类型分布<em>同一把尺子</em></h4>
        <DistBars v-if="typeTotal > 0" :rows="typeItems" unit="次" />
        <p class="no-data" v-else>该周期没有报警记录。</p>
      </section>

      <!-- ============ 时段热力图（日期/类型 × 24 小时） ============ -->
      <section class="card">
        <h4>时段热力图<em>{{ heatMetricLabel }}</em></h4>
        <div class="seg heat-seg">
          <button
            v-for="m in HEAT_METRICS"
            :key="m.id"
            class="seg-btn"
            :class="{ on: heatMetric === m.id }"
            @click="heatMetric = m.id"
          >
            {{ m.label }}
          </button>
        </div>
        <HeatGrid
          v-if="heatRows.length"
          :rows="heatRows"
          :color="heatColor"
          :metric-label="heatMetricLabel"
          unit="次"
        />
        <p class="no-data" v-else>这个维度本周期没有记录，换上面的指标看看。</p>
        <!--
          差额必须说出来：上面写"报警 17 次"、这张图写"共 13 次"，
          不解释的话看起来就是有一边算错了。差额只可能来自"升级前的老记录
          （当时只有按天汇总）"，等 7 天窗口滚过去就自然归零、提示自动消失。
        -->
        <p class="tip-line gap" v-if="heatGap > 0">
          注：按天汇总的{{ heatMetricName }}是 <b>{{ heatSummaryTotal }}</b> 次，这里只有
          <b>{{ heatTotal }}</b> 次 —— 差额来自<b>升级前</b>的老记录（当时只存按天合计，
          没有小时明细）。等这一周滚出 7 天窗口就会对齐。
        </p>
        <p class="tip-line">
          格子按<b>本机时钟的小时</b>聚合（不是 UTC）。每格只存计数、不存明细，所以历史不会因为
          事件列表被清空而消失；换时区看同一份历史时，横向会整体平移。
        </p>
      </section>

      <!-- ============ 三端推送（成功率刻度） ============ -->
      <section class="card">
        <h4>三端推送<em>成功 / 失败 / 成功率</em></h4>
        <PushStack :rows="channelRows" />
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
/**
 * 数据统计页。
 *
 * 图表全部**自绘 SVG / CSS，不引任何图表库**，理由（写在这里免得以后有人想换）：
 *   - 数据量天花板是"7 天 × 24 小时"这个量级 —— ECharts 的强项（大数据量 canvas、
 *     缩放刷选、地图）一条都用不上，而它的 gzip 体积比整个主包还大；
 *   - **canvas 读不到 CSS 变量**：主题切换（暗黑 / 亮色 / 液态）靠的是变量，
 *     用 canvas 就得把整套色板再维护一份，等于同一个事实有两处判定；
 *   - 自绘 SVG 在四个端（Web / WKWebView / 小程序 web-view / Electron）零适配差异，
 *     且在 4K 屏上永远锐利。
 *
 * 所有颜色一律 `var(--type-*)` / `var(--accent)` 这类变量，代码里**不出现 hex**。
 */
import { computed, ref } from 'vue'
import {
  KEEP_DAYS,
  STAT_ALARM_TYPES,
  STAT_CHANNELS,
  STAT_HOUR_METRICS,
  aggregate,
  dailyStats,
  hourRows,
  hourTypeRows,
  peakHour,
  recentDayKeys,
  resetDailyStats,
  statsOf
} from '../composables/useDailyStats'
import DistBars from './charts/DistBars.vue'
import DonutShare from './charts/DonutShare.vue'
import HeatGrid from './charts/HeatGrid.vue'
import PushStack from './charts/PushStack.vue'
import SparkLine from './charts/SparkLine.vue'
import TrendArea from './charts/TrendArea.vue'

const emit = defineEmits(['reset-done'])

/**
 * 报警类型 → 主题色变量。
 * 单独开一组 `--type-*` 而不是复用 `--warn` / `--err`：分类色和语义色混用会串味
 * （区域报警用警告黄，看着像"区域报警是警告级别"）。同一类报警在环形、横条、
 * 热力图里必须是同一个颜色 —— 共用一个 token 才成立。
 */
const TYPE_COLOR = {
  person: 'var(--type-person)',
  face: 'var(--type-face)',
  zone: 'var(--type-zone)',
  pose: 'var(--type-pose)',
  motion: 'var(--type-motion)',
  count: 'var(--type-count)'
}

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

/* ==================== 趋势 ==================== */
const trend = computed(() =>
  rangeKeys.value.map((k) => {
    const d = statsOf(k)
    return {
      key: k,
      // 只显示"月/日"，跨度大时更清爽
      label: k.slice(5).replace('-', '/'),
      value: d.alarms || 0
    }
  })
)
const trendValues = computed(() => trend.value.map((d) => d.value))
/** 识别人次按天：直接用日汇总的 personHits —— 与小时桶之和恒等，且旧存档（无小时桶）也有值 */
const hitValues = computed(() => rangeKeys.value.map((k) => statsOf(k).personHits || 0))

/* ==================== 类型分布 ==================== */
/**
 * 六种类型**都列**（含 0）：零行也占一格，列表长度稳定，切周期时不会跳动。
 * 按次数降序，并列时保持声明顺序（Array.sort 是稳定排序）。
 */
const typeItems = computed(() =>
  STAT_ALARM_TYPES.map((t) => ({
    id: t.id,
    label: t.label,
    n: total.value.byType[t.id] || 0,
    color: TYPE_COLOR[t.id] || 'var(--accent)'
  })).sort((a, b) => b.n - a.n)
)
const typeTotal = computed(() => typeItems.value.reduce((a, r) => a + r.n, 0))

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
    return { id, label, ok: p.ok || 0, fail: p.fail || 0 }
  })
)

/* ==================== 热力图 ==================== */
/** 第四档「类型」不是指标，而是**换行维度**（行 = 报警类型，列 = 小时） */
const HEAT_METRICS = [...STAT_HOUR_METRICS, { id: 'types', label: '类型' }]
const heatMetric = ref('alarms')

const METRIC_COLOR = { alarms: 'var(--accent)', push: 'var(--ok)', hits: 'var(--type-face)' }
const heatColor = computed(() => METRIC_COLOR[heatMetric.value] || 'var(--accent)')

const heatMetricLabel = computed(() => {
  if (heatMetric.value === 'types') return `${total.value.alarms} 次 · 按类型分行`
  const m = STAT_HOUR_METRICS.find((x) => x.id === heatMetric.value)
  return m ? m.label : '报警'
})

const heatRows = computed(() => {
  if (heatMetric.value === 'types') {
    // 类型维度：行 = 类型，每种类型用自己在环形图里的那个颜色
    return hourTypeRows(rangeKeys.value).map((r) => ({ ...r, color: TYPE_COLOR[r.id] }))
  }
  return hourRows(rangeKeys.value, heatMetric.value)
})

/** 热力图里所有格子的合计 */
const heatTotal = computed(() =>
  heatRows.value.reduce((a, r) => a + r.cells.reduce((x, y) => x + y, 0), 0)
)

/** 同一指标在「按天汇总」里的合计（用来发现"小时明细不全"这件事） */
const heatSummaryTotal = computed(() => {
  if (heatMetric.value === 'push') return pushTotal.value.ok + pushTotal.value.fail
  if (heatMetric.value === 'hits') return total.value.personHits
  if (heatMetric.value === 'alarms') return total.value.alarms
  return 0 // 「类型」维度行是类型不是天，同比没有意义
})

/**
 * 差额 = 只有按天汇总、没有小时明细的那部分（= 升级前的老记录）。
 * 必须**说出来**：否则用户看到上面写"报警 17 次"、热力图写"共 13 次"，
 * 会以为哪边算错了。等这一周滚出 7 天窗口，差额自然归零，提示也就自己消失了。
 */
const heatGap = computed(() => Math.max(0, heatSummaryTotal.value - heatTotal.value))
const heatMetricName = computed(
  () => (STAT_HOUR_METRICS.find((x) => x.id === heatMetric.value) || {}).label || ''
)

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
    const hours = (d.hours && d.hours.alarms) || []
    const peak = peakHour(hours)
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
      高峰时段: peak >= 0 ? `${String(peak).padStart(2, '0')}:00` : '',
      // 24 个小时的原始计数：热力图的数据源，原样带出来供外部做分析
      报警按小时: hours.map((v) => v || 0).join('/'),
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

/*
 * 周期切换用的分段控件。
 * ⚠️ 这段样式原本只存在于 EventPanel 的 scoped 块里 —— 统计页用了同样的
 * `.seg` / `.seg-btn` 类名却**没有任何规则命中**，那排按钮一直是浏览器默认外观
 * （灰底方角，与玻璃主题完全脱节）。这里补上同一套外观。
 */
.seg {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}

.seg::-webkit-scrollbar {
  display: none;
}

.seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.14s ease;
}

.seg-btn:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--tint) 5%, transparent);
}

.seg-btn.on {
  color: var(--panel-deep);
  background: var(--accent);
  font-weight: 600;
}

.heat-seg {
  margin-bottom: 8px;
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

.kpi-spark {
  margin-top: 5px;
  opacity: 0.9;
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

.tip-line {
  margin: 9px 0 0;
  font-size: 10.5px;
  color: var(--text-dim-2);
  line-height: 1.6;
}

.tip-line.gap {
  color: var(--warn-text);
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
