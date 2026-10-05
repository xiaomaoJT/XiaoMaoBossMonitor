<template>
  <transition name="slide-up">
    <section class="event-panel" v-if="open">
      <header>
        <span class="title">
          <span class="live" :class="{ active: hasNew }"></span>
          报警事件
          <em>{{ events.length }}</em>
        </span>
        <span class="spacer"></span>
        <button class="btn small" @click="emit('export')">导出</button>
        <button class="btn small danger" @click="emit('clear')">清空</button>
        <!--
          桌面端是右下角浮层，用横线表示「收起」；手机端整屏铺满（见 CSS 640px 断点），
          横线会让人误以为是收起面板，切到明确的 X。两个图标按断点二选一显示。
        -->
        <button class="icon-btn" title="关闭" @click="emit('close')">
          <svg class="close-collapse" viewBox="0 0 24 24" width="15" height="15">
            <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M6 12h12" />
          </svg>
          <svg class="close-x" viewBox="0 0 24 24" width="16" height="16">
            <path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>
      </header>

      <!-- 统计 + 已读管理 -->
      <div class="stats">
        <span class="st">
          <i>今日报警</i>
          <b>{{ todayCount }}</b>
        </span>
        <span class="st">
          <i>历史报警</i>
          <b>{{ events.length }}</b>
        </span>
        <span class="st unread" :class="{ hot: unreadCount > 0 }">
          <i>未读</i>
          <b>{{ unreadCount }}</b>
        </span>
        <span class="st read">
          <i>已读</i>
          <b>{{ readCount }}</b>
        </span>
        <span class="spacer"></span>
        <button class="btn small" :disabled="!unreadCount" @click="emit('mark-all-read')">全部已读</button>
      </div>

      <!-- 筛选栏：类型直接可见（常用），时间范围收进下拉，避免一排按钮挤成一团 -->
      <div class="filterbar">
        <div class="seg">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            class="seg-btn"
            :class="{ on: filter === f.key }"
            @click="filter = f.key"
          >
            {{ f.label }}
            <em v-if="countOf(f.key)">{{ countOf(f.key) }}</em>
          </button>
        </div>

        <span class="spacer"></span>

        <div class="range-wrap">
          <button class="range-btn" :class="{ on: range !== 'today' || hours.length }" @click.stop="rangeOpen = !rangeOpen">
            <svg viewBox="0 0 24 24" width="13" height="13">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v11A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5zM4 10h16M9 4v4M15 4v4"
              />
            </svg>
            <span class="rb-text">{{ rangeLabel }}</span>
            <em v-if="hours.length">{{ hours.length }}h</em>
            <svg class="caret" viewBox="0 0 24 24" width="11" height="11">
              <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 9.5l6 6 6-6" />
            </svg>
          </button>

          <div class="range-pop" v-if="rangeOpen">
            <div class="rp-head">时间范围</div>
            <div class="rp-grid">
              <button
                v-for="r in RANGES"
                :key="r.key"
                class="rp-item"
                :class="{ on: range === r.key }"
                @click="pickRange(r.key)"
              >
                {{ r.label }}
              </button>
            </div>
            <div class="rp-foot" v-if="isDayRange">
              <button class="rp-hour" :class="{ on: showHours }" @click="toggleHoursRow">
                按小时筛选
                <em>{{ hours.length ? `已选 ${hours.length} 小时` : '全天' }}</em>
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="tip-row">
        <em class="range-tip">
          {{ rangeLabel }}{{ hours.length ? ` · ${hours.length} 个时段` : '' }} · {{ filteredEvents.length }} 条
        </em>
      </div>

      <div class="hour-row" v-if="isDayRange && showHours">
        <button class="chip sm" :class="{ on: !hours.length }" @click="hours = []">全天</button>
        <button
          v-for="h in HOUR_LIST"
          :key="h"
          class="chip sm hour"
          :class="{ on: hours.includes(h) }"
          @click="toggleHour(h)"
        >
          {{ hh(h) }}
        </button>
      </div>

      <div class="custom-row" v-if="range === 'custom'">
        <input class="field mini" type="datetime-local" v-model="customFrom" />
        <span class="tilde">→</span>
        <input class="field mini" type="datetime-local" v-model="customTo" />
      </div>

      <div class="list" v-if="filteredEvents.length">
        <article
          class="item"
          v-for="(ev, i) in filteredEvents"
          :key="ev.key"
          :class="{ fresh: i === 0 && ev.time > Date.now() - 6000, unread: !ev.read }"
          @click="emit('focus', ev)"
        >
          <div class="thumb" :style="ev.thumb ? { backgroundImage: `url(${ev.thumb})` } : null">
            <span class="type" :class="ev.type">{{ typeLabel(ev) }}</span>
            <span class="unread-dot" v-if="!ev.read" title="未读"></span>
          </div>
          <div class="meta">
            <strong>{{ ev.name }}</strong>
            <span class="time">{{ formatTime(ev.time) }}</span>
            <span class="hint">
              {{
                ev.type === 'motion'
                  ? `画面变动幅度 ${(ev.ratio * 100).toFixed(1)}%`
                  : ev.text || alarmDetail(ev)
              }}
            </span>
            <span class="push" :class="ev.push" v-if="ev.push" :title="ev.pushError || ''">
              {{ pushText(ev) }}
            </span>
          </div>
          <div class="ops">
            <button
              class="op-btn"
              :class="{ on: !ev.read }"
              :title="ev.read ? '点一下标记回未读' : '标记为已读'"
              @click.stop="emit('mark-read', ev)"
            >
              <svg viewBox="0 0 24 24" width="13" height="13">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M4.5 12.5l4.5 4.5L19.5 6.5"
                />
              </svg>
              {{ ev.read ? '未读' : '已读' }}
            </button>
            <button class="op-btn" title="本条以及更早的全部标为已读" @click.stop="emit('mark-read-from', ev)">
              <svg viewBox="0 0 24 24" width="13" height="13">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M4 12.5l3.5 3.5L14 9M12 16.5L22 6.5"
                />
              </svg>
              以下已读
            </button>
            <button class="op-btn" title="查看事件详情与截图" @click.stop="openDetail(ev)">
              <svg viewBox="0 0 24 24" width="13" height="13">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  d="M12 5c4.5 0 7.5 3.5 9 7-1.5 3.5-4.5 7-9 7s-7.5-3.5-9-7c1.5-3.5 4.5-7 9-7z"
                />
                <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7" />
              </svg>
              详情
            </button>
          </div>
        </article>
      </div>

      <div class="empty" v-else>
        <p v-if="events.length">「{{ rangeLabel }}」{{ filter === 'all' ? '' : '该分类下' }}没有报警事件</p>
        <p v-else>暂无报警事件</p>
        <span v-if="events.length">
          试试把时间范围切到「近 7 天」或「全部」；也可以点上面的「按小时」只看某几个小时。
        </span>
        <span v-else>
          开启画面上的「移动 / 人形」检测后，触发时会自动记录在这里；通道离线/恢复也会记录。
        </span>
      </div>
    </section>
  </transition>

  <!-- 事件详情弹窗 -->
  <Teleport to="body">
    <transition name="lightbox">
      <div class="detail-mask" v-if="detail" @click.self="detail = null">
        <div class="detail" role="dialog" aria-modal="true">
          <header class="dt-head">
            <span class="lb-type" :class="detail.type">{{ typeLabel(detail) }}</span>
            <b class="dt-name">{{ detail.name }}</b>
            <span class="spacer"></span>
            <button class="icon-btn" title="关闭（Esc）" @click="detail = null">
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M7 7l10 10M17 7L7 17" />
              </svg>
            </button>
          </header>

          <div class="dt-body">
            <div class="dt-shot" @click="srcOf(detail) && openPreview(detail)">
              <img v-if="srcOf(detail)" :src="srcOf(detail)" alt="事件截图" />
              <div class="dt-shot-empty" v-else>本次事件没有留存截图</div>
              <div class="dt-shot-loading" v-if="shotLoading">
                <span class="spinner"></span> 正在读取高清原图…
              </div>
              <span class="dt-shot-hint" v-else-if="srcOf(detail)">
                <svg viewBox="0 0 24 24" width="13" height="13">
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.9"
                    stroke-linecap="round"
                    d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16.2 16.2L21 21M11 8.5v5M8.5 11h5"
                  />
                </svg>
                点击查看高清原图（可滚轮缩放）
              </span>
            </div>

            <dl class="dt-rows">
              <div class="dt-row">
                <dt>通道名称</dt>
                <dd>{{ detail.name }}</dd>
              </div>
              <div class="dt-row">
                <dt>事件类型</dt>
                <dd>
                  {{ typeLabel(detail) }}
                  <span class="dt-sub">{{ alarmDetail(detail) }}</span>
                </dd>
              </div>
              <div class="dt-row" v-if="detail.faceThumb">
                <dt>人脸</dt>
                <dd><img class="dt-face" :src="detail.faceThumb" alt="人脸" /></dd>
              </div>
              <div class="dt-row" v-if="detail.zoneName">
                <dt>检测区域</dt>
                <dd>{{ detail.zoneName }}</dd>
              </div>
              <div class="dt-row" v-if="detail.dwellMs">
                <dt>停留时长</dt>
                <dd>{{ Math.round((detail.dwellMs || 0) / 1000) }} 秒</dd>
              </div>
              <div class="dt-row" v-if="detail.actionText">
                <dt>识别动作</dt>
                <dd>{{ detail.actionText }}</dd>
              </div>
              <div class="dt-row" v-if="detail.counts">
                <dt>人数统计</dt>
                <dd>当前 {{ detail.counts.current }} 人 · 累计经过 {{ detail.counts.totalIn }} 人次</dd>
              </div>
              <div class="dt-row">
                <dt>发生时间</dt>
                <dd>{{ fullTime(detail.time) }}</dd>
              </div>
              <div class="dt-row" v-if="detail.type === 'motion'">
                <dt>变动幅度</dt>
                <dd>{{ ((detail.ratio || 0) * 100).toFixed(2) }} %</dd>
              </div>
              <div class="dt-row" v-if="detail.type === 'person' && detail.ratio">
                <dt>人形置信度</dt>
                <dd>{{ ((detail.ratio || 0) * 100).toFixed(1) }} %</dd>
              </div>
              <div class="dt-row" v-if="detail.resolution">
                <dt>分辨率 / 编码</dt>
                <dd>{{ detail.resolution }}</dd>
              </div>
              <div class="dt-row" v-if="detail.fps">
                <dt>帧率</dt>
                <dd>{{ detail.fps }} fps</dd>
              </div>
              <div class="dt-row" v-if="detail.kbps">
                <dt>码率</dt>
                <dd>{{ (detail.kbps / 8).toFixed(0) }} KB/s（{{ detail.kbps }} kbps）</dd>
              </div>
              <div class="dt-row">
                <dt>检测区域</dt>
                <dd>{{ detail.roi ? '已圈选局部区域' : '全画面' }}</dd>
              </div>
              <div class="dt-row" v-if="detail.text && detail.text !== alarmDetail(detail)">
                <dt>状态说明</dt>
                <dd>{{ detail.text }}</dd>
              </div>
              <div class="dt-row v-sep">
                <dt>推送结果</dt>
                <dd :class="pushResultClass">
                  {{ pushResultText }}
                  <span class="dt-sub" v-if="detail.pushError">{{ detail.pushError }}</span>
                </dd>
              </div>
              <div class="dt-row v-sep" v-if="detail.personShotNote">
                <dt>完整人形补图</dt>
                <dd>{{ detail.personShotNote }}</dd>
              </div>
              <div class="dt-row wide">
                <dt>推送通道</dt>
                <dd>
                  <div class="ch-list">
                    <span
                      v-for="c in pushRows"
                      :key="c.id"
                      class="ch-tag"
                      :class="{ on: c.on }"
                      :title="c.why"
                    >
                      <i class="ch-dot"></i>
                      {{ c.label }}
                      <em>{{ c.on ? 'on' : 'off' }}</em>
                    </span>
                    <span class="ch-note" v-if="!pushRows.length">
                      该通道已关闭「推送总开关」，三个渠道都不会推送
                    </span>
                  </div>
                  <ul class="ch-why" v-if="pushRows.some((c) => !c.on)">
                    <li v-for="c in pushRows.filter((x) => !x.on)" :key="c.id">
                      {{ c.label }}：{{ c.why }}
                    </li>
                  </ul>
                </dd>
              </div>
              <div class="dt-row" v-if="detail.seq">
                <dt>事件序号</dt>
                <dd>#{{ detail.seq }}</dd>
              </div>
              <div class="dt-row wide" v-if="detail.url">
                <dt>流地址</dt>
                <dd class="dt-url">{{ detail.url }}</dd>
              </div>
            </dl>
          </div>

          <footer class="dt-foot">
            <button class="btn small" @click="emit('focus', detail); detail = null">定位到该画面</button>
            <span class="spacer"></span>
            <a
              v-if="srcOf(detail)"
              class="btn small primary"
              :href="srcOf(detail)"
              :download="`${detail.name}-${detail.time}.jpg`"
            >
              下载截图
            </a>
            <button class="btn small" @click="detail = null">关闭</button>
          </footer>
        </div>
      </div>
    </transition>
  </Teleport>

  <!-- 截图看板：全屏显示，支持滚轮缩放 / 拖动平移 -->
  <Teleport to="body">
    <transition name="lightbox">
      <div class="lightbox" v-if="preview" @click.self="closePreview">
        <header class="lb-head" @click.stop>
          <span class="lb-title">
            <b>{{ preview.name }}</b>
            <em>{{ formatTime(preview.time) }}</em>
            <span class="lb-type" :class="preview.type">{{ typeLabel(preview) }}</span>
          </span>
          <span class="spacer"></span>
          <span class="lb-zoom">{{ zoomPercent }}%</span>
          <button class="btn small" @click="zoomBy(1 / 1.25)" title="缩小">−</button>
          <button class="btn small" @click="zoomBy(1.25)" title="放大">＋</button>
          <button class="btn small" @click="resetView" title="恢复原始大小">1:1</button>
          <a
            class="btn small primary"
            :href="srcOf(preview)"
            :download="`${preview.name}-${preview.time}.jpg`"
          >
            下载
          </a>
          <button class="icon-btn" title="关闭（Esc）" @click="closePreview">
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M7 7l10 10M17 7L7 17" />
            </svg>
          </button>
        </header>

        <div
          class="lb-stage"
          :class="{ grabbing: !!panFrom, movable: zoom > 1 }"
          @click.self="closePreview"
          @wheel.prevent="onWheel"
          @mousedown="startPan"
        >
          <img
            :src="srcOf(preview)"
            alt="事件截图"
            draggable="false"
            :style="{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              cursor: zoom > 1 ? (panFrom ? 'grabbing' : 'grab') : 'zoom-in'
            }"
            @dblclick="zoom > 1 ? resetView() : (zoom = 2.5)"
          />
        </div>

        <footer class="lb-foot" @click.self="closePreview">
          滚轮缩放 · 拖动平移 · 双击放大/还原 · 点击空白处关闭
        </footer>
      </div>
    </transition>
  </Teleport>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { alarmDetail } from '../composables/useAlarmText'

const props = defineProps({
  open: { type: Boolean, default: false },
  events: { type: Array, default: () => [] },
  /** 按 key 从 IndexedDB 取高清原图的函数（由 App 注入） */
  loadShot: { type: Function, default: null },
  /** 解析某条事件在三个渠道上的推送开关状态（由 App 注入） */
  pushState: { type: Function, default: null }
})

const emit = defineEmits([
  'close',
  'clear',
  'export',
  'focus',
  'mark-read',
  'mark-read-from',
  'mark-all-read'
])

const preview = ref(null)
const detail = ref(null)
const zoom = ref(1)
const pan = reactive({ x: 0, y: 0 })
let panFrom = null

/**
 * 高清原图按需加载。
 * 内存里的事件只有 360px 缩略图（列表要轻），原图存在 IndexedDB 里，
 * 打开详情 / 放大查看时才按 key 捞出来，所以这里要区分「已载入的 key」和「正在载入的 key」，
 * 不能用同一个变量（否则会把缩略图误判成原图已就绪）。
 */
const cachedShot = ref('')
const loadedKey = ref('')
const loadingKey = ref('')

const shotLoading = computed(() => !!detail.value && loadingKey.value === detail.value.key)

const zoomPercent = computed(() => Math.round(zoom.value * 100))

/** 拉取高清原图；没有留档或读取失败就保持缩略图 */
async function ensureShot(ev) {
  if (!ev) return
  if (loadedKey.value === ev.key) return
  if (!props.loadShot || !ev.shotInStore) return
  const target = ev.key
  loadingKey.value = target
  try {
    const src = await props.loadShot(target)
    if (src) {
      cachedShot.value = src
      loadedKey.value = target
    }
  } catch (e) {
    /* 读取失败：继续用缩略图 */
  }
  if (loadingKey.value === target) loadingKey.value = ''
}

async function openDetail(ev) {
  detail.value = ev
  await ensureShot(ev)
}

/**
 * 暴露给父组件调用。
 *
 * 详情弹窗与截图看板都是 Teleport 到 body 的，**不受面板本身开合影响** ——
 * 所以右上角通知弹窗点一下就能直接开详情，不必先把事件面板拉出来。
 * 外部只该用这一个入口，省得自己去动 detail / cachedShot 那套内部状态。
 */
defineExpose({ openDetail })

/** 优先用原尺寸留档图，没有则退回小缩略图 */
function srcOf(ev) {
  if (!ev) return ''
  if (loadedKey.value === ev.key && cachedShot.value) return cachedShot.value
  return ev.shot || ev.thumb || ''
}

async function openPreview(ev) {
  await ensureShot(ev)
  preview.value = ev
  resetView()
}

function closePreview() {
  preview.value = null
  resetView()
}

function resetView() {
  zoom.value = 1
  pan.x = 0
  pan.y = 0
}

function zoomBy(factor) {
  zoom.value = Math.min(8, Math.max(0.2, zoom.value * factor))
  if (zoom.value <= 1) {
    pan.x = 0
    pan.y = 0
  }
}

function onWheel(e) {
  zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
}

function startPan(e) {
  if (zoom.value <= 1) return
  e.preventDefault()
  panFrom = { sx: e.clientX - pan.x, sy: e.clientY - pan.y }
  window.addEventListener('mousemove', onPanMove)
  window.addEventListener('mouseup', endPan)
}

function onPanMove(e) {
  if (!panFrom) return
  pan.x = e.clientX - panFrom.sx
  pan.y = e.clientY - panFrom.sy
}

function endPan() {
  panFrom = null
  window.removeEventListener('mousemove', onPanMove)
  window.removeEventListener('mouseup', endPan)
}

function onKey(e) {
  if (preview.value) {
    if (e.key === 'Escape') closePreview()
    if (e.key === '+' || e.key === '=') zoomBy(1.25)
    if (e.key === '-') zoomBy(1 / 1.25)
    if (e.key === '0') resetView()
    return
  }
  if (detail.value && e.key === 'Escape') detail.value = null
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('click', onDocClick)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('click', onDocClick)
  endPan()
})

/* ==================== 统计 ==================== */

function startOfTodayTs() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 今日报警数（不含「恢复」这类系统消息，只算真正的报警） */
const todayCount = computed(() => {
  const t0 = startOfTodayTs()
  return props.events.filter((e) => e.time >= t0 && e.type !== 'online').length
})

const unreadCount = computed(() => props.events.filter((e) => !e.read).length)
const readCount = computed(() => props.events.length - unreadCount.value)

/* ==================== 时间筛选 ==================== */

const HOUR_MS = 3600000
const DAY_MS = 86400000

const RANGES = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'h1', label: '近 1 小时' },
  { key: 'h6', label: '近 6 小时' },
  { key: 'h24', label: '近 24 小时' },
  { key: 'h7', label: '近 7 天' },
  { key: 'custom', label: '自定义' },
  { key: 'all', label: '全部' }
]

const range = ref('today')
/** 按小时过滤：空数组 = 全天；只有在「今天 / 昨天」这类整天范围下才有意义 */
const hours = ref([])
const showHours = ref(false)
/** 时间范围下拉弹层（收纳了原来那一排时间 chip） */
const rangeOpen = ref(false)
const customFrom = ref('')
const customTo = ref('')

const isDayRange = computed(() => range.value === 'today' || range.value === 'yesterday')

function toTs(localValue) {
  if (!localValue) return null
  const t = new Date(localValue).getTime()
  return Number.isFinite(t) ? t : null
}

const rangeBounds = computed(() => {
  const now = Date.now()
  const t0 = startOfTodayTs()
  switch (range.value) {
    case 'today':
      return [t0, now + 1]
    case 'yesterday':
      return [t0 - DAY_MS, t0]
    case 'h1':
      return [now - HOUR_MS, now + 1]
    case 'h6':
      return [now - 6 * HOUR_MS, now + 1]
    case 'h24':
      return [now - 24 * HOUR_MS, now + 1]
    case 'h7':
      return [now - 7 * DAY_MS, now + 1]
    case 'custom': {
      const a = toTs(customFrom.value)
      const b = toTs(customTo.value)
      return [a === null ? 0 : a, b === null ? now + 1 : b + 60000]
    }
    default:
      return [0, now + 1]
  }
})

/** 时间范围 + 小时过滤后的结果（类型筛选在此之上叠加） */
const rangeEvents = computed(() => {
  const [from, to] = rangeBounds.value
  const picked = hours.value
  return props.events.filter((ev) => {
    if (ev.time < from || ev.time >= to) return false
    if (picked.length && !picked.includes(new Date(ev.time).getHours())) return false
    return true
  })
})

const rangeLabel = computed(() => {
  if (range.value === 'custom') return '自定义时间段'
  const hit = RANGES.find((r) => r.key === range.value)
  return hit ? hit.label : '全部'
})

function setRange(key) {
  range.value = key
  hours.value = []
  showHours.value = false
  if (key !== 'custom') {
    customFrom.value = ''
    customTo.value = ''
  }
}

/** 下拉里选中一个时间范围 */
function pickRange(key) {
  setRange(key)
  rangeOpen.value = false
}

/** 展开 / 收起小时刻度行（顺便收起下拉，避免两层浮层叠着） */
function toggleHoursRow() {
  rangeOpen.value = false
  showHours.value = !showHours.value
}

/** 点空白处收起时间范围下拉 */
function onDocClick(e) {
  if (!rangeOpen.value) return
  const el = e.target
  if (el && el.closest && el.closest('.range-wrap')) return
  rangeOpen.value = false
}

function toggleHour(h) {
  hours.value = hours.value.includes(h)
    ? hours.value.filter((x) => x !== h)
    : [...hours.value, h].sort((a, b) => a - b)
}

const HOUR_LIST = Array.from({ length: 24 }, (_, i) => i)
const hh = (n) => String(n).padStart(2, '0')

/* ==================== 类型筛选 ==================== */

const filter = ref('all')

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'person', label: '人形' },
  { key: 'face', label: '人脸' },
  { key: 'zone', label: '区域' },
  { key: 'pose', label: '姿态' },
  { key: 'motion', label: '移动' },
  { key: 'count', label: '计数' },
  { key: 'system', label: '通道状态' }
]

const filteredEvents = computed(() =>
  rangeEvents.value.filter((ev) => matches(ev, filter.value))
)

function matches(ev, key) {
  if (key === 'all') return true
  if (key === 'system') return ev.type === 'offline' || ev.type === 'online'
  // 区域一类里有走入 / 走出 / 徘徊三种事件
  if (key === 'zone') return ev.type === 'enter' || ev.type === 'exit' || ev.type === 'loiter'
  return ev.type === key
}

function countOf(key) {
  return rangeEvents.value.filter((ev) => matches(ev, key)).length
}

function typeLabel(ev) {
  switch (ev.type) {
    case 'person':
      return '人形'
    case 'motion':
      return '移动'
    case 'face':
      // 已识别到人时直接显示姓名，一眼知道是谁
      return ev.faceName || '人脸'
    case 'enter':
      return '走入'
    case 'exit':
      return '走出'
    case 'loiter':
      return '徘徊'
    case 'pose':
      return ev.actionText || '姿态'
    case 'count':
      return '计数'
    case 'offline':
      return '离线'
    case 'online':
      return '恢复'
    default:
      return '事件'
  }
}

const hasNew = computed(() => props.events.length > 0 && props.events[0].time > Date.now() - 6000)

function formatTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  // 历史报警会跨天保存，非今天的记录带上日期
  return sameDay ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
}

/** 详情用：完整日期时间 */
function fullTime(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${week} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`
}

function pushText(ev) {
  const who = ev.pushChannels ? `（${ev.pushChannels}）` : ''
  switch (ev.push) {
    case 'ok':
      return `已推送${who}`
    case 'merged':
      return `已合并推送${who}`
    case 'sending':
      return '正在推送…'
    case 'queued':
      return '已排队（合并推送）'
    case 'fail':
      return '推送失败'
    case 'skip':
      return '未推送（超频丢弃）'
    case 'off':
      return '未推送'
    default:
      return ''
  }
}

/* ==================== 事件详情里的推送情况 ==================== */

/** 三个渠道在「这条事件发生的那一刻」的开关状态；App 没注入时退回记录里的通道快照 */
const pushRows = computed(() => {
  const ev = detail.value
  if (!ev) return []
  if (typeof props.pushState === 'function') {
    try {
      const rows = props.pushState(ev)
      if (Array.isArray(rows)) return rows
    } catch (e) {
      /* 解析失败就用下面的兜底 */
    }
  }
  const camCh = ev.channels || null
  return [
    ['ding', '钉钉'],
    ['wecom', '企微'],
    ['tg', 'TG']
  ].map(([id, label]) => ({
    id,
    label,
    on: camCh ? camCh[id] !== false : true,
    sent: false,
    why: camCh && camCh[id] === false ? '该通道未勾选此渠道' : '已开启'
  }))
})

const pushResultText = computed(() => {
  const ev = detail.value
  if (!ev) return ''
  if (!ev.push) return '没有推送记录（早于推送功能上线的事件）'
  // 'off' / 'skip' 的具体原因由下面的 dt-sub（pushError）展示，这里不重复
  return pushText(ev) || '未知状态'
})

const pushResultClass = computed(() => {
  const p = detail.value && detail.value.push
  if (p === 'fail') return 'bad'
  if (p === 'ok' || p === 'merged') return 'good'
  if (p === 'off' || p === 'skip') return 'warn'
  return ''
})
</script>

<style scoped>
.event-panel {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 95;
  width: 420px;
  max-width: 94vw;
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--panel) 97%, transparent);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  resize: both;
}

header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
}

.title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--text-soft);
}

.title em {
  font-style: normal;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
}

.live {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #43506a;
}

.live.active {
  background: var(--err);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--err) 20%, transparent);
  animation: blink 1s infinite;
}

@keyframes blink {
  50% {
    opacity: 0.25;
  }
}

.spacer {
  flex: 1 1 auto;
}

.list {
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.item {
  display: flex;
  gap: 9px;
  padding: 7px;
  border-radius: 9px;
  background: var(--panel-deep);
  border: 1px solid var(--line-soft);
  cursor: pointer;
  transition: all 0.15s ease;
}

.item:hover {
  border-color: var(--line-strong);
  background: var(--panel-2);
}

.item.fresh {
  border-color: color-mix(in srgb, var(--err) 50%, transparent);
}

.thumb {
  position: relative;
  width: 108px;
  height: 62px;
  flex: 0 0 auto;
  border-radius: 6px;
  background: var(--bg-deep) center/cover no-repeat;
  overflow: hidden;
}

/* ---------- 每行右侧操作（贴右对齐） ---------- */
.ops {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-end;
  gap: 6px;
  align-self: stretch;
}

.op-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 11.5px;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line);
  transition: all 0.15s ease;
  white-space: nowrap;
}

.op-btn:hover {
  color: var(--accent-text-strong);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.type {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  color: #fff;
  background: color-mix(in srgb, var(--warn) 92%, transparent);
}

.type.person {
  background: color-mix(in srgb, var(--ok) 92%, transparent);
  color: #042410;
}

.type.face {
  background: color-mix(in srgb, var(--warn-text) 94%, transparent);
  color: color-mix(in srgb, var(--warn) 22%, var(--panel));
}

.type.enter,
.type.exit,
.type.loiter {
  background: color-mix(in srgb, var(--cyan) 92%, transparent);
  color: color-mix(in srgb, var(--cyan) 18%, var(--panel));
}

.type.pose {
  background: color-mix(in srgb, var(--purple) 92%, transparent);
  color: #fff;
}

.type.count {
  background: color-mix(in srgb, var(--text-dim) 92%, transparent);
  color: #fff;
}

.type.offline {
  background: color-mix(in srgb, var(--err) 92%, transparent);
  color: #fff;
}

.type.online {
  background: color-mix(in srgb, var(--accent) 92%, transparent);
  color: color-mix(in srgb, var(--accent) 22%, var(--panel));
}

.filters {
  display: flex;
  gap: 5px;
  padding: 8px 8px 2px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line);
  transition: all 0.15s ease;
}

.chip:hover {
  color: var(--text-bright);
  border-color: var(--line-strong);
}

.chip.on {
  color: var(--accent-text-strong);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

.chip em {
  font-style: normal;
  font-size: 10px;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
}

.meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  justify-content: center;
}

.meta strong {
  font-size: 13px;
  font-weight: 500;
  color: #e0e9f7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.hint {
  font-size: 11px;
  color: var(--text-dim-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.push {
  margin-top: 2px;
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--tint) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--tint) 8%, transparent);
}

.push.ok {
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  border-color: color-mix(in srgb, var(--ok) 30%, transparent);
}

.push.fail {
  color: var(--err-text);
  background: color-mix(in srgb, var(--err) 14%, transparent);
  border-color: color-mix(in srgb, var(--err) 35%, transparent);
}

.push.sending,
.push.queued {
  color: var(--warn-text);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  border-color: color-mix(in srgb, var(--warn) 30%, transparent);
}

/* ---------- 事件详情弹窗 ---------- */
.detail-mask {
  position: fixed;
  inset: 0;
  z-index: 290;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bg-deep) 78%, transparent);
  backdrop-filter: blur(4px);
}

.detail {
  width: 640px;
  max-width: 94vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.7);
  overflow: hidden;
}

.dt-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-deep);
}

.dt-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dt-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dt-shot {
  position: relative;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--bg-deep);
  overflow: hidden;
  cursor: zoom-in;
  min-height: 180px;
  display: grid;
  place-items: center;
}

.dt-shot img {
  display: block;
  width: 100%;
  max-height: 46vh;
  object-fit: contain;
}

.dt-shot-empty {
  padding: 48px 0;
  font-size: 12.5px;
  color: var(--text-dim-2);
}

/* 原图是从 IndexedDB 按需读的，读取期间给个明确反馈 */
.dt-shot-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 12px;
  color: var(--accent-text-strong);
  background: rgba(6, 10, 16, 0.72);
  backdrop-filter: blur(1px);
}

.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-top-color: var(--accent);
  animation: dt-spin 0.7s linear infinite;
}

@keyframes dt-spin {
  to {
    transform: rotate(360deg);
  }
}

.dt-shot-hint {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--accent-text-strong);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.dt-shot:hover .dt-shot-hint {
  opacity: 1;
}

.dt-rows {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--line-soft);
}

.dt-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  background: var(--panel-deep);
}

.dt-row.wide {
  grid-column: 1 / -1;
}

.dt-row dt {
  font-size: 11.5px;
  color: var(--text-dim-2);
}

.dt-row dd {
  margin: 0;
  font-size: 13px;
  color: #dae5f5;
  word-break: break-all;
}

.dt-row dd.good {
  color: var(--ok-text);
}

.dt-row dd.bad {
  color: var(--err-text);
}

.dt-row dd.warn {
  color: var(--warn-text);
}

/* 推送情况：单独起一段，视觉上和画面信息分开 */
.dt-row.v-sep {
  grid-column: 1 / -1;
  border-top: 1px dashed var(--line);
  padding-top: 11px;
}

.ch-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.ch-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  background: #0e1621;
}

.ch-tag.on {
  color: #bfe9d1;
  border-color: color-mix(in srgb, var(--ok) 40%, transparent);
  background: color-mix(in srgb, var(--ok) 10%, transparent);
}

.ch-tag em {
  font-style: normal;
  font-size: 10px;
  letter-spacing: 0.3px;
  opacity: 0.85;
}

.ch-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4a5568;
}

.ch-tag.on .ch-dot {
  background: var(--ok);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ok) 18%, transparent);
}

.ch-note {
  font-size: 11.5px;
  color: var(--text-dim-2);
}

.ch-why {
  margin: 6px 0 0;
  padding: 0 0 0 14px;
  list-style: disc;
  font-size: 11.5px;
  color: var(--text-dim-2);
}

.ch-why li + li {
  margin-top: 2px;
}

.dt-sub {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-dim-2);
}

/* 人脸事件里那张放大的小脸，一眼确认是谁 */
.dt-face {
  width: 76px;
  height: 76px;
  border-radius: 8px;
  border: 1px solid var(--line);
  object-fit: cover;
  display: block;
}

.dt-url {
  font-size: 11.5px;
  color: var(--text-dim);
}

.dt-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-top: 1px solid var(--line);
  background: var(--panel-deep);
}

.dt-foot a {
  text-decoration: none;
}

.lightbox {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--bg-deep) 94%, transparent);
  backdrop-filter: blur(6px);
}

.lb-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 90%, transparent);
}

.lb-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.lb-title b {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 32vw;
}

.lb-title em {
  font-style: normal;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.lb-type {
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 11px;
  color: color-mix(in srgb, var(--warn) 18%, var(--panel));
  background: color-mix(in srgb, var(--warn) 90%, transparent);
}

.lb-type.person,
.lb-type.offline {
  color: #fff;
  background: color-mix(in srgb, var(--err) 90%, transparent);
}

.lb-type.online {
  color: color-mix(in srgb, var(--accent) 22%, var(--panel));
  background: color-mix(in srgb, var(--accent) 90%, transparent);
}

.lb-zoom {
  min-width: 52px;
  text-align: right;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.lb-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 18px;
}

.lb-stage img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  border: 1px solid var(--line);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.7);
  transition: transform 0.06s linear;
  user-select: none;
}

.lb-foot {
  padding: 9px 16px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim-2);
}

.lightbox .btn {
  text-decoration: none;
}

.lightbox-enter-active,
.lightbox-leave-active {
  transition: opacity 0.18s ease;
}

.lightbox-enter-from,
.lightbox-leave-to {
  opacity: 0;
}

.empty {
  padding: 26px 18px;
  text-align: center;
}

.empty p {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--text-soft);
}

.empty span {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim-2);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--text-dim);
}

/* 默认只显示「收起」横线，手机端断点里再切换成 X */
.close-x {
  display: none;
}

.icon-btn:hover {
  color: #fff;
  background: color-mix(in srgb, var(--tint) 10%, transparent);
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.22s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

/* ==================== 统计栏 + 已读管理 + 时间筛选 ==================== */

.stats {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 0;
}

.st {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 7px;
  background: var(--panel);
  border: 1px solid var(--line-soft);
}

.st i {
  font-style: normal;
  font-size: 11px;
  color: var(--text-dim-2);
}

.st b {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  font-variant-numeric: tabular-nums;
}

.st.unread b {
  color: var(--text-dim);
}

/* 有未读时给个明确的视觉提示 */
.st.unread.hot {
  border-color: color-mix(in srgb, var(--err) 45%, transparent);
  background: color-mix(in srgb, var(--err) 10%, transparent);
}

.st.unread.hot i {
  color: var(--err-text);
}

.st.unread.hot b {
  color: var(--err-text);
}

.st.read b {
  color: #7fd6a3;
}

/* ---------- 筛选栏（类型直接可见 + 时间范围收进下拉） ---------- */
.filterbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 8px 0;
  flex-wrap: wrap;
}

.seg {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
}

.seg-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
  background: transparent;
  cursor: pointer;
  transition: all 0.14s ease;
}

.seg-btn em {
  font-style: normal;
  font-size: 10px;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
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

.seg-btn.on em {
  color: color-mix(in srgb, var(--bg-deep) 66%, transparent);
}

.range-wrap {
  position: relative;
  flex: 0 0 auto;
}

.range-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding: 0 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--text-soft);
  background: var(--panel);
  cursor: pointer;
  transition: all 0.14s ease;
}

.range-btn:hover {
  border-color: var(--accent);
  color: #fff;
}

.range-btn.on {
  border-color: color-mix(in srgb, var(--accent-text-strong) 45%, transparent);
  color: var(--accent-text-strong);
  background: color-mix(in srgb, var(--accent-text-strong) 8%, transparent);
}

.range-btn em {
  font-style: normal;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  color: var(--panel-deep);
  background: var(--accent);
}

.range-btn .caret {
  opacity: 0.7;
}

.rb-text {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.range-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 12;
  width: 232px;
  padding: 9px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: #0f1723;
  box-shadow: 0 16px 34px rgba(0, 0, 0, 0.55);
}

.rp-head {
  font-size: 11px;
  color: var(--text-dim-2);
  padding: 0 4px 7px;
}

.rp-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.rp-item {
  height: 26px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid transparent;
  font-size: 11.5px;
  color: var(--text-dim);
  background: var(--panel-2);
  cursor: pointer;
  transition: all 0.13s ease;
}

.rp-item:hover {
  color: var(--text);
  border-color: var(--line);
}

.rp-item.on {
  color: var(--panel-deep);
  background: var(--accent);
  font-weight: 600;
}

.rp-foot {
  margin-top: 7px;
  padding-top: 7px;
  border-top: 1px dashed var(--line);
}

.rp-hour {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--text-dim);
  background: var(--panel-2);
  cursor: pointer;
}

.rp-hour em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--text-dim-2);
}

.rp-hour.on {
  color: var(--accent-text-strong);
  border-color: color-mix(in srgb, var(--accent-text-strong) 45%, transparent);
  background: color-mix(in srgb, var(--accent-text-strong) 8%, transparent);
}

/* 当前筛选结果的概览，单独一行细字，不占太多高度 */
.tip-row {
  padding: 5px 10px 0;
}

.custom-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 8px 0;
  flex-wrap: wrap;
}

.custom-row .field.mini {
  height: 26px;
  font-size: 11.5px;
  padding: 0 6px;
}

.tilde {
  color: var(--text-dim-2);
  font-size: 12px;
}

.chip.sm {
  height: 22px;
  padding: 0 8px;
  font-size: 11.5px;
  border-radius: 6px;
}

/* 24 个小时刻度：横向滚动，避免换行占掉太多高度 */
.hour-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 7px 8px 0;
  overflow-x: auto;
  scrollbar-width: thin;
}

.hour-row .chip.hour {
  min-width: 30px;
  justify-content: center;
  padding: 0 5px;
  font-variant-numeric: tabular-nums;
}

.hour-row::-webkit-scrollbar {
  height: 5px;
}

.hour-row::-webkit-scrollbar-thumb {
  background: #22304a;
  border-radius: 3px;
}

.hours-toggle.on {
  border-style: dashed;
}

.filterbar .spacer,
.stats .spacer {
  flex: 1 1 auto;
}

.range-tip {
  align-self: center;
  padding-right: 4px;
  font-size: 11px;
  font-style: normal;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 未读事件：整行加一条左侧高亮 + 缩略图上的红点 */
.item.unread {
  border-color: color-mix(in srgb, var(--err) 28%, transparent);
  background: var(--panel);
}

.item.unread .meta strong {
  color: #ffffff;
  font-weight: 600;
}

.unread-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--err);
  box-shadow: 0 0 0 2px rgba(6, 10, 16, 0.75);
}

/* 三条操作按钮要挤在一列里，压扁一点 */
.ops {
  gap: 4px;
}

.ops .op-btn {
  height: 21px;
  padding: 0 7px;
  font-size: 11px;
}

.op-btn.on {
  color: var(--err-text);
  border-color: color-mix(in srgb, var(--err) 35%, transparent);
  background: color-mix(in srgb, var(--err) 8%, transparent);
}

/* ==================== 手机：事件面板整屏铺满（对齐设置抽屉的手机端形态）==================== */
/*
 * 桌面端这里是右下角浮层：420px 宽、78vh 高、可拖拽缩放（resize: both）。
 * 手机上屏幕本来就小，浮层还压着监控画面，所以 ≤640px（与 SettingsDrawer 同断点）
 * 直接铺满整屏：
 *   - inset: 0 覆盖掉原本的 right/bottom 定位
 *   - 必须显式清掉 max-width / max-height，否则会被 94vw / 78vh 卡住，铺不满
 *   - resize 关掉：整屏容器没有拖拽缩放的意义
 *   - 去圆角 + 顶栏让开刘海、列表底部让开 Home 指示条
 */
@media (max-width: 640px) {
  .event-panel {
    inset: 0;
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    /* 手机浏览器地址栏收放时 100% 会跟着跳，dvh 更贴近真实可视高度；不支持的老内核自动忽略这行 */
    height: 100dvh;
    max-height: 100dvh;
    border: none;
    border-radius: 0;
    resize: none;
    /* 主题化：跟随 --panel，别写死（亮色主题下写死深色会变成「亮色里的黑洞」） */
    background: var(--panel);
  }

  /* 顶栏让开刘海/状态栏，左右也补上安全区 */
  .event-panel > header {
    padding: calc(9px + var(--safe-top)) calc(10px + var(--safe-right)) 9px calc(10px + var(--safe-left));
  }

  /* 关闭按钮加大热区（手机端没有遮罩可点，只能靠它关） */
  .event-panel > header .icon-btn {
    width: 34px;
    height: 34px;
  }

  /* 全屏形态下「收起」横线不再合适，换成明确的 X */
  .close-collapse {
    display: none;
  }

  .close-x {
    display: inline-flex;
  }

  /* 列表撑满剩余空间，滚动到底部时给 Home 指示条留白 */
  .list {
    flex: 1 1 auto;
    padding-bottom: calc(8px + var(--safe-bottom));
  }

  /* 空状态在整屏里垂直居中，别贴着顶部 */
  .empty {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  /* ---------- 以下为原 560px 断点的内容，随全屏一并收进来 ---------- */

  /* 统计栏允许换行 */
  .stats {
    flex-wrap: wrap;
    gap: 5px;
  }

  .stats .spacer {
    display: none;
  }

  .ops {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
  }

  .ops .op-btn {
    width: auto;
    height: 24px;
  }
}
</style>
