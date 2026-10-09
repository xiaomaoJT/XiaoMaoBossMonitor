<template>
  <div
    class="tile"
    :class="{
      zoomed,
      free,
      locating: highlight,
      'is-error': status === 'error',
      'is-loading': status === 'connecting',
      alarmed: alarm,
      analyzing: analysisOn
    }"
    ref="tileEl"
    :draggable="free ? false : dragArmed"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragover.prevent="!free && emit('drag-over', index)"
    @dblclick="onDblClick"
  >
    <!-- 播放器挂载点 -->
    <div class="video-box" :class="{ blind: blindOn }" ref="boxEl"></div>

    <!-- 智能分析叠加层：检测框 / 检测区域 / 圈选交互 -->
    <canvas
      class="overlay"
      :class="{ editing: roiEditing }"
      ref="overlayEl"
      @pointerdown="onRoiDown"
      @pointermove="onRoiMove"
      @pointerup="onRoiUp"
      @pointercancel="onRoiUp"
    ></canvas>

    <!-- 顶部信息条 -->
    <div class="bar top">
      <span
        v-if="free"
        class="move-grip"
        title="按住拖动，改变画面位置"
        @pointerdown.stop.prevent="grabFree('move', $event)"
      >
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 4v16M4 12h16M12 4l-2.4 2.4M12 4l2.4 2.4M12 20l-2.4-2.4M12 20l2.4-2.4M4 12l2.4-2.4M4 12l2.4 2.4M20 12l-2.4-2.4M20 12l-2.4 2.4"
          />
        </svg>
      </span>
      <span class="dot" :class="{ [status]: true, pausedDot: manuallyPaused }"></span>
      <span class="name" :title="cam.name">{{ cam.name }}</span>
      <!--
        检测类标签：移动 / 人形 / 人脸 / 姿态 / 区域 / 计数。
        · hit  = 最近 5 秒内该类型命中过（对应标签高亮，见 markHit）
        · t-xxx= 每个类型一套配色，避免全是同色看不出区别
      -->
      <span
        v-if="analysisOn"
        class="chip t-motion"
        :class="{ on: true, hit: hitKinds.has('motion') }"
        title="已开启移动检测"
      >
        <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M13.5 5.5a2 2 0 1 0-4 0M6 12.5a2 2 0 1 0-4 0M22 12.5a2 2 0 1 0-4 0M19 21a2 2 0 1 0-4 0M3.5 21a2 2 0 1 0-4 0M11 10.5l-3 2M11 10.5l3.5 2M11 10.5V17M11 17l-5 3M11 17l4 3"
          />
        </svg>
        移动
      </span>
      <span
        v-if="cam.ai"
        class="chip t-person"
        :class="{ on: true, hit: hitKinds.has('person') }"
        :title="aiTitle"
      >
        <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
          <circle cx="12" cy="7" r="3.4" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            d="M5.5 20.5c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"
          />
        </svg>
        {{ aiChipText }}
      </span>
      <!--
        这一路人形识别之上**真正在跑**的附加分析（人脸 / 姿态 / 区域 / 计数）。
        没开启的（通道关了、或者全局总闸没开）一律不画 ——
        只在生效时才出现，看到标签就等于确认它在工作。
      -->
      <span
        v-for="e in extChips"
        :key="e.key"
        class="chip ext"
        :class="[`t-${e.key}`, { hit: hitKinds.has(e.key) }]"
        :title="e.title"
      >
        <svg class="ext-ico" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
          <path
            :d="EXT_ICON[e.key] || EXT_ICON.default"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ e.label }}
      </span>
      <span class="chip blind" v-if="cam.blind" title="盲视模式：画面已隐藏，检测仍在运行">盲视</span>
      <span class="chip mute" v-if="cam.push === false" title="该通道已关闭报警推送">推送关</span>
      <span class="spacer"></span>

      <!-- 画面参数：平时只留一个简洁标记，悬浮才展开帧率 / 码率 / 分辨率 -->
      <span class="stats-wrap" v-if="status === 'playing' && !manuallyPaused" :class="{ dim: !options.showStats }">
        <span class="info info-chip">
          {{ options.showStats && stats ? `${stats.fps}fps` : '参数' }}
        </span>
        <span class="stats-pop">
          <b class="sp-title">画面参数</b>
          <span class="sp-row" v-if="videoInfo"><i>分辨率</i><em>{{ videoInfo.width }} × {{ videoInfo.height }}</em></span>
          <span class="sp-row" v-if="videoInfo"><i>编码</i><em>{{ videoInfo.encType }}</em></span>
          <span class="sp-row"><i>帧率</i><em>{{ stats ? stats.fps : '-' }} fps</em></span>
          <span class="sp-row" v-if="kbps"><i>码率</i><em>{{ kbps }} kbps · {{ (kbps / 8 / 1024).toFixed(0) }} KB/s</em></span>
          <span class="sp-row" v-if="!videoInfo && !stats"><i>状态</i><em>正在获取画面信息…</em></span>
        </span>
      </span>
    </div>

    <!-- 盲视模式：画面已隐藏，显示检测 / 推送状态 -->
    <transition name="fade">
      <div class="blind-panel" v-if="blindOn && status === 'playing'">
        <div class="blind-head">
          <span class="b-dot" :class="{ run: anyDetectOn, hit: !!motionBox }"></span>
          <span class="b-title">盲视模式 · 检测{{ anyDetectOn ? '运行中' : '已关闭' }}</span>
        </div>
        <div class="b-rows">
          <span>{{ anyDetectOn ? '画面已隐藏，解码与检测照常运行' : '画面已隐藏；这一路没有开启任何检测' }}</span>
          <span>
            检测项：<b v-if="anyDetectOn" class="b-detect">{{ detectText }}</b><b v-else class="b-off">一个都没开</b>
          </span>
          <span class="b-ch-row">
            推送渠道：
            <b
              v-for="c in pushChannelRows"
              :key="c.id"
              class="b-ch"
              :class="c.state"
              :title="c.title"
            >
              {{ c.label }}
            </b>
            <em v-if="!anyPushOn" class="b-off">这一路当前不会推送到任何渠道</em>
          </span>
          <span>上次分析：<b>{{ analyzeAgo }}</b><template v-if="lastAnalyzeAt">（{{ clockText(lastAnalyzeAt) }}）</template></span>
          <span v-if="lastAlarmText">最近报警：<b class="b-alarm">{{ lastAlarmText }}</b></span>
          <span v-else>最近报警：暂无</span>
        </div>
        <button class="btn small primary" @click.stop="toggleBlind">显示画面</button>
      </div>
    </transition>

    <!-- 播放器自愈中：画面保持不动，只在角落提示（不盖蒙层，避免大屏一闪一闪） -->
    <transition name="pop">
      <div class="recover-tag" v-if="status === 'playing' && recovering">
        <span class="r-dot"></span>
        {{ recovering }} · 自动恢复中
      </div>
    </transition>

    <!-- 定位提示角标 -->
    <transition name="pop">
      <div class="locate-tag" v-if="highlight">
        <span class="ring"></span>
        已定位
      </div>
    </transition>

    <!-- 报警角标 -->
    <transition name="pop">
      <div class="alarm-tag" v-if="alarm">
        <span class="blink"></span>
        {{ alarmType === 'person' ? '检测到人形' : '检测到移动' }}
      </div>
    </transition>

    <!-- 中部状态 -->
    <transition name="fade">
      <div class="state" v-if="status !== 'playing'" :class="{ eco: !decode }" @click.stop="onEcoClick">
        <template v-if="!decode">
          <div class="eco-icon">
            <svg viewBox="0 0 24 24" width="26" height="26">
              <path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M13 2 4.5 13.5H11L9.5 22 19 9.5h-6.5z" />
            </svg>
          </div>
          <div class="state-msg">省流模式 · 点击播放</div>
        </template>
        <template v-else>
          <div class="spinner" v-if="status === 'connecting' || status === 'paused'"></div>
          <div class="state-msg">{{ statusText }}</div>
          <button class="btn small" @click.stop="reconnect">立即重连</button>
        </template>
      </div>
    </transition>

    <!-- 圈选检测区域时的提示条 -->
    <div class="roi-hint" v-if="roiEditing">
      <span>按住鼠标拖拽框选检测区域</span>
      <button class="btn small" @click.stop="clearRoi">清除区域</button>
      <button class="btn small primary" @click.stop="roiEditing = false">完成</button>
    </div>

    <!-- 底部操作条：只放操作按钮，低频操作收进「更多」 -->
    <div class="bar bottom" v-if="status !== 'idle' || decode">
      <span class="drag-handle" title="按住拖拽可调整位置" @pointerdown.stop="armDrag">
        <svg viewBox="0 0 24 24" width="15" height="15">
          <path fill="currentColor" d="M9 5.5h2v2H9zM13 5.5h2v2h-2zM9 11h2v2H9zM13 11h2v2h-2zM9 16.5h2v2H9zM13 16.5h2v2h-2z" />
        </svg>
      </span>
      <span class="spacer"></span>

      <button
        class="icon-btn"
        :class="{ active: manuallyPaused }"
        :title="manuallyPaused ? '恢复播放这一路' : '暂停这一路（保留连接，省 CPU）'"
        @click.stop="togglePause"
      >
        <svg v-if="manuallyPaused" viewBox="0 0 24 24" width="15" height="15">
          <path fill="currentColor" d="M8 5l11 7-11 7z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="15" height="15">
          <path fill="currentColor" d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" />
        </svg>
      </button>
      <button class="icon-btn" title="重新连接" @click.stop="reconnect">
        <svg viewBox="0 0 24 24" width="15" height="15">
          <path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 1 0-2.3 5.7M20 5.5V11h-5.5" />
        </svg>
      </button>
      <button class="icon-btn" title="截图" @click.stop="snapshot">
        <svg viewBox="0 0 24 24" width="15" height="15">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2l.9-1.6h8.8l.9 1.6h1.2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5zM12 16.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z"
          />
        </svg>
      </button>
      <button class="icon-btn" title="放大 / 还原" @click.stop="toggleZoom">
        <svg viewBox="0 0 24 24" width="15" height="15">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"
          />
        </svg>
      </button>

      <span class="more-wrap">
        <button
          ref="moreBtnEl"
          class="icon-btn"
          :class="{ active: moreOpen }"
          title="更多操作"
          @click.stop="toggleMore"
        >
          <svg viewBox="0 0 24 24" width="15" height="15">
            <path
              fill="currentColor"
              d="M6.5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"
            />
          </svg>
        </button>
      </span>

      <!--
        更多操作菜单。
        注意：它必须挂在 body 上（Teleport），不能用「相对按钮绝对定位」——
        外面 .tile 有 overflow:hidden（为了裁圆角），弹层向上展开时会被直接切掉，
        而且相邻画面之间还有层叠竞争。提到 body 后用 fixed 定位彻底绕开这两件事。
      -->
      <teleport to="body">
        <transition name="pop">
          <div
            v-if="moreOpen"
            ref="morePopEl"
            class="more-pop"
            :style="moreStyle"
            @click.stop
            @pointerdown.stop
          >
            <button class="mi" @click.stop="pickMore('motion')">
              <span class="mi-ico" :class="{ on: analysisOn }">◉</span> 移动检测
              <em>{{ analysisOn ? '已开启' : '已关闭' }}</em>
            </button>
            <button class="mi" @click.stop="pickMore('ai')">
              <span class="mi-ico" :class="{ on: cam.ai }">◉</span> 人形识别
              <em>{{ cam.ai ? '已开启' : '已关闭' }}</em>
            </button>
            <!--
              人形识别之上的附加能力，通道级分流开关。
              省算力主要靠这里：附加能力默认每一路都参与，把不看的通道关掉即可。
            -->
            <button
              v-for="e in EXT_ROWS"
              :key="e.key"
              class="mi ext"
              :class="{ off: !extOn(e.key) }"
              :title="extTitle(e)"
              @click.stop="pickMore(`ext:${e.key}`)"
            >
              <span class="mi-ico" :class="{ on: extOn(e.key) }">{{ e.icon }}</span> {{ e.label }}
              <em>{{ extLabel(e) }}</em>
            </button>
            <button class="mi" @click.stop="pickMore('roi')">
              <span class="mi-ico" :class="{ on: roiEditing }">▢</span> 圈选检测区域
              <em>{{ roiEditing ? '编辑中' : '' }}</em>
            </button>
            <button class="mi" @click.stop="pickMore('zone')">
              <span class="mi-ico" :class="{ on: zoneEditing }">▤</span> 进出 / 徘徊区域
              <em>{{ zoneCount ? `${zoneCount} 个` : '' }}</em>
            </button>
            <button v-if="zoneCount" class="mi" @click.stop="pickMore('zone-clear')">
              <span class="mi-ico">⌫</span> 清除全部区域
            </button>
            <button class="mi" @click.stop="pickMore('blind')">
              <span class="mi-ico" :class="{ on: blindOn }">◉</span> 盲视模式
              <em>{{ blindOn ? '画面已隐藏' : '' }}</em>
            </button>
            <button class="mi" @click.stop="pickMore('fullscreen')">
              <span class="mi-ico">⛶</span> 全屏显示
            </button>
            <div class="mi-sep"></div>
            <button class="mi danger" @click.stop="pickMore('close')">
              <span class="mi-ico">✕</span> 关闭这一路
            </button>
          </div>
        </transition>
      </teleport>
    </div>

    <!-- 自定义摆放：右下角拉伸手柄 -->
    <div
      v-if="free"
      class="resize-handle"
      title="拖动改变画面大小"
      @pointerdown.stop.prevent="grabFree('resize', $event)"
    >
      <svg viewBox="0 0 24 24" width="13" height="13">
        <path fill="currentColor" d="M20 20h-5.5l5.5-5.5zM20 12.5h-2.5L20 10zM12.5 20v-2.5L10 20z" />
      </svg>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FrameSampler } from '../composables/frameSampler'
import { ensureJessibuca, isJessibucaReady } from '../composables/useJessibuca'
import { compareFrames, sensitivityToThreshold } from '../composables/useMotion'
import { aiState, detectPersons, loadModel, loadPersonModel, setGpuPref } from '../composables/useAiDetector'
import { activeDetects, activeFeatures, camExtOn, motionOn, useAiExtras } from '../composables/useAiExtras'
import { PUSH_CHANNEL_KEYS, channelUsable } from '../config/defaults.js'

const props = defineProps({
  cam: { type: Object, required: true },
  index: { type: Number, required: true },
  decoder: { type: String, required: true },
  options: { type: Object, required: true },
  zoomed: { type: Boolean, default: false },
  /** 是否参与解码；false = 省流模式（显示占位，点击加载） */
  decode: { type: Boolean, default: true },
  /** 是否处于「自定义摆放」布局（开启后可拖动 / 拉伸画面） */
  free: { type: Boolean, default: false },
  /** 定位高亮：事件面板点「定位」时该通道闪烁 3 秒 */
  highlight: { type: Boolean, default: false }
})

const emit = defineEmits([
  'zoom',
  'status',
  'close',
  'alarm',
  'alarm-shot',
  'update-camera',
  'roi-change',
  'zone-add',
  'zone-clear',
  'request-play',
  'drag-start',
  'drag-over',
  'drag-end',
  'free-grab'
])

const tileEl = ref(null)
const boxEl = ref(null)
const overlayEl = ref(null)

const status = ref('idle') // idle | connecting | playing | paused | error
const statusText = ref('准备中')
const videoInfo = ref(null)
const stats = ref(null)
const kbps = ref(0)

let player = null
let retryTimer = null
let retryCount = 0
const MAX_RETRY = 5

/* ==================== 拖拽排序 ==================== */
const dragArmed = ref(false)
const dragging = ref(false)

function armDrag(e) {
  // 自定义摆放模式下，手柄改为「自由移动」而不是「排序」
  if (props.free) {
    grabFree('move', e)
    return
  }
  dragArmed.value = true
  document.addEventListener('mouseup', onDocMouseUp, { once: true })
}

function grabFree(mode, e) {
  emit('free-grab', { id: props.cam.id, mode, ev: e })
}

/* ==================== 单路暂停 / 更多操作 ==================== */
/** 用户手动暂停这一路（保留连接，省 CPU） */
const manuallyPaused = ref(false)
const moreOpen = ref(false)
const moreBtnEl = ref(null)
const morePopEl = ref(null)
/** fixed 定位坐标（菜单挂在 body 上，见模板里的 teleport） */
const moreStyle = ref({ left: '-9999px', top: '-9999px' })

/**
 * 计算「更多操作」菜单的位置。
 * 菜单默认朝按钮的**上方**展开（工具栏在画面底部，朝下会直接出屏），
 * 上方放不下时翻到下方；左右夹紧在视口内，避免贴边被切。
 */
function placeMore() {
  const btn = moreBtnEl.value
  if (!btn) return
  const r = btn.getBoundingClientRect()
  const gap = 8
  const pop = morePopEl.value
  const w = (pop && pop.offsetWidth) || 190
  const h = (pop && pop.offsetHeight) || 300
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
  let top = r.top - gap - h
  if (top < 8) top = Math.min(r.bottom + gap, window.innerHeight - h - 8)
  moreStyle.value = { left: `${Math.round(left)}px`, top: `${Math.round(Math.max(8, top))}px` }
}

function togglePause() {
  if (!player) return
  if (manuallyPaused.value) {
    manuallyPaused.value = false
    player.play().catch(() => {})
  } else {
    // 先立标志再 pause：'pause' 事件回调里要靠它区分「用户暂停」和「内部自愈」
    manuallyPaused.value = true
    player.pause()
  }
}

function toggleMore() {
  if (moreOpen.value) {
    closeMore()
    return
  }
  moreOpen.value = true
  // 先量到真实尺寸再定位，否则第一帧会按估算高度摆错位置
  nextTick(() => {
    placeMore()
    // 再补一帧，处理字体 / 滚动条引起的尺寸微调
    requestAnimationFrame(placeMore)
    setTimeout(() => document.addEventListener('click', closeMore), 0)
    window.addEventListener('resize', placeMore)
    // 捕获阶段：大屏内部容器的滚动也要跟手
    window.addEventListener('scroll', placeMore, true)
  })
}

function closeMore() {
  moreOpen.value = false
  document.removeEventListener('click', closeMore)
  window.removeEventListener('resize', placeMore)
  window.removeEventListener('scroll', placeMore, true)
}

function pickMore(kind) {
  closeMore()
  // 通道级附加能力开关（人脸 / 姿态 / 区域）
  if (kind.startsWith('ext:')) {
    const key = kind.slice(4)
    return setExt(key, !camExtOn(props.cam, key))
  }
  if (kind === 'motion') return toggleMotion()
  if (kind === 'ai') return toggleAi()
  if (kind === 'roi') {
    zoneEditing.value = false
    return (roiEditing.value = !roiEditing.value)
  }
  if (kind === 'zone') {
    roiEditing.value = false
    zoneEditing.value = !zoneEditing.value
    drawOverlay()
    return
  }
  if (kind === 'zone-clear') {
    emit('zone-clear', { id: props.cam.id })
    return
  }
  if (kind === 'blind') return toggleBlind()
  if (kind === 'fullscreen') return toggleFullscreen()
  if (kind === 'close') return emit('close', props.index)
}

function onDocMouseUp() {
  if (!dragging.value) dragArmed.value = false
}

function onDragStart(e) {
  dragging.value = true
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(props.index))
  }
  emit('drag-start', props.index)
}

function onDragEnd() {
  dragging.value = false
  dragArmed.value = false
  emit('drag-end')
}

/* ==================== 播放状态 ==================== */
function setStatus(next, text) {
  status.value = next
  statusText.value = text || ''
  emit('status', { id: props.cam.id, status: next, text: text || '', info: videoInfo.value })
}

/**
 * 播放器自愈中的提示（**不打断画面**）。
 *
 * 为什么不能直接盖 loading 蒙层：
 *   Jessibuca 配了 heartTimeoutReplay / loadingTimeoutReplay（无限内部重连），
 *   心跳超时 / 数据中断时它会**自己**断开重连，画面短暂黑一下就恢复。
 *   以前这里直接 setStatus('connecting')，等于把这段自愈过程渲染成
 *   一块全画幅的 loading 蒙层 —— 几路画面一起抖动时整个大屏就是
 *   「loading 出现又消失」地闪，看起来像页面在被反复刷新（iOS 上尤其明显）。
 *
 * 现在改成：画面不动，只在角落挂一个轻量徽标；真断了 20 秒还没恢复
 * 才升级成蒙层 + 重试按钮，「这一路确实挂了」依然不会被藏住。
 */
const recovering = ref('')
let recoverEscalate = null

function markRecovering(text) {
  if (status.value === 'error' || status.value === 'idle') return
  recovering.value = text
  if (recoverEscalate) return
  recoverEscalate = setTimeout(() => {
    recoverEscalate = null
    if (!recovering.value) return
    retryCount = 0
    scheduleRetry(`${recovering.value}（长时间未恢复）`)
  }, 20000)
}

function clearRecovering() {
  if (recoverEscalate) {
    clearTimeout(recoverEscalate)
    recoverEscalate = null
  }
  recovering.value = ''
}

function errorText(code) {
  const E = (window.Jessibuca && window.Jessibuca.ERROR) || {}
  switch (code) {
    case E.websocketError:
      return 'WebSocket 连接失败'
    case E.fetchError:
      return '拉流请求失败'
    case E.wasmDecodeError:
      return '视频解码失败'
    case E.mediaSourceH265NotSupport:
    case E.webcodecsH265NotSupport:
      return '硬件解码不支持 H.265'
    case E.playError:
      return '播放参数无效'
    default:
      return code ? String(code) : '播放异常'
  }
}

/**
 * 创建序号。
 * createPlayer 现在会 await 解码器就绪（defer 脚本，首屏不等它），
 * 等待期间画面可能被关掉、切省流或整个重建 —— 那时这次创建就必须作废，
 * 否则它醒来之后会凭空补一个播放器出来（幽灵画面 + 连接泄漏）。
 */
let createToken = 0

async function destroyPlayer() {
  clearRecovering()
  createToken += 1 // 作废所有正在等待解码器的创建流程
  clearTimeout(retryTimer)
  retryTimer = null
  stopAnalysis()
  if (!player) return
  const p = player
  player = null
  try {
    await p.destroy()
  } catch (e) {
    /* ignore */
  }
}

/**
 * 当前应该拉的流地址（子码流优先）。
 * 网格里多路同看时拉子码流 —— 分辨率低一档，wasm 软解的 CPU 压力小一个量级；
 * 点开放大单路（zoomed）才切回主码流看细节。
 * 没配子码流就永远拉主码流，老配置零感知。
 */
const activeUrl = computed(() => {
  if (props.zoomed) return props.cam.url
  return String(props.cam.urlSub || '').trim() || props.cam.url
})

async function createPlayer() {
  const token = ++createToken

  if (!props.decode) {
    setStatus('idle', '省流模式')
    return
  }
  if (!boxEl.value) {
    setStatus('error', '播放器未加载')
    return
  }

  /*
   * 解码器（jessibuca.js，469KB）在 index.html 里是 defer 引入的，首屏不再等它，
   * App 能立刻挂载。这里才是真正需要它的地方：没就绪就先显示加载态等着，
   * 而不是像以前那样直接判「播放器未加载」（那会让首屏那几秒必然报错）。
   */
  if (!isJessibucaReady()) {
    setStatus('connecting', '解码器加载中…')
    const ok = await ensureJessibuca()
    if (token !== createToken) return // 等待期间已被销毁或重建
    if (!ok) {
      setStatus('error', '解码器加载失败，可点此重试')
      return
    }
  }
  if (!boxEl.value) {
    setStatus('error', '播放器未加载')
    return
  }

  setStatus('connecting', retryCount > 0 ? `重连中（${retryCount}/${MAX_RETRY}）…` : '连接中…')

  player = new window.Jessibuca({
    container: boxEl.value,
    decoder: props.decoder,
    isFlv: true,
    isResize: true,
    hasAudio: !!props.options.hasAudio,
    useMSE: !!props.options.useHardDecode,
    useWCS: !!props.options.useHardDecode,
    autoWasm: true,
    debug: false,
    /*
     * 超时不能太短。H.265 在多数机器上是 WASM 软解（useHardDecode 只对 H.264 生效），
     * 多路 3200×1800 同时解时，某一帧晚几秒到是常事 —— 原来统一给 10 秒，
     * 于是「解码跟得上就正常、跟不上就判心跳超时然后重连」，表现成
     * 「基本只有一路能看，几秒就提示重连」，而机器其实只是忙不过来。
     * 放宽到 20 秒：慢机器上仍能自己恢复，闲机器上不影响。
     */
    timeout: 20,
    loadingTimeout: 20,
    heartTimeout: 20,
    loadingTimeoutReplay: true,
    loadingTimeoutReplayTimes: -1,
    heartTimeoutReplay: true,
    heartTimeoutReplayTimes: -1,
    wasmDecodeErrorReplay: true,
    hiddenAutoPause: false,
    supportDblclickFullscreen: false,
    loadingText: '',
    operateBtns: { fullscreen: false, screenshot: false, play: false, audio: false, record: false }
  })

  player.on('start', () => {
    retryCount = 0
    clearRecovering()
    setStatus('playing', '')
    startAnalysis()
  })
  player.on('videoInfo', (info) => (videoInfo.value = info))
  player.on('stats', (s) => (stats.value = s))
  player.on('kBps', (v) => (kbps.value = v || 0))
  player.on('pause', () => {
    // 播放器内部自愈（心跳重连）也会走一次 pause；
    // 只有用户真的点了暂停才盖蒙层，否则画面会无故闪一下 loading
    if (!manuallyPaused.value) return
    if (status.value !== 'error') setStatus('paused', '已暂停')
  })
  player.on('error', (code) => {
    const text = errorText(code)
    const E = window.Jessibuca.ERROR || {}
    if (code === E.websocketError || code === 'streamEnd') scheduleRetry(text)
    else {
      clearRecovering()
      setStatus('error', text)
    }
  })
  player.on('timeout', () => markRecovering('心跳超时'))
  player.on('loadingTimeout', () => markRecovering('数据中断'))

  player.play(activeUrl.value).catch((err) => scheduleRetry(errorText(err && err.message)))
}

function scheduleRetry(text) {
  clearRecovering()
  if (retryCount >= MAX_RETRY) {
    setStatus('error', `${text}（已停止重试，可点此重连）`)
    return
  }
  retryCount += 1
  setStatus('connecting', `${text}，3 秒后第 ${retryCount} 次重连…`)
  clearTimeout(retryTimer)
  retryTimer = setTimeout(async () => {
    await destroyPlayer()
    await nextTick()
    await createPlayer()
  }, 3000)
}

async function restart() {
  clearRecovering()
  if (!props.decode) {
    setStatus('idle', '省流模式')
    return
  }
  retryCount = 0
  videoInfo.value = null
  stats.value = null
  kbps.value = 0
  alarm.value = false
  personBoxes.value = []
  extras.reset()
  await destroyPlayer()
  await nextTick()
  await createPlayer()
}

function reconnect() {
  restart()
}

/* ==================== 智能分析 ==================== */
const alarm = ref(false)
const alarmType = ref('motion')
/**
 * 最近命中过的检测类型（item 13/105：命中时让对应的标签高亮）。
 * 用 Set 而不是单个值 —— 人形 + 人脸 + 区域可能同一帧一起命中，
 * 逐个高亮才准确；5 秒后自动熄灭，和报警角标的节奏一致。
 */
const hitKinds = ref(new Set())
let hitTimer = null
function markHit(...kinds) {
  const next = new Set(hitKinds.value)
  kinds.forEach((k) => k && next.add(k))
  hitKinds.value = next
  clearTimeout(hitTimer)
  hitTimer = setTimeout(() => (hitKinds.value = new Set()), 5000)
}
const personBoxes = ref([])
const motionBox = ref(null)
const roiEditing = ref(false)
/** 区域编辑模式：拖拽画面即新增一个「进出 / 徘徊」检测区域 */
const zoneEditing = ref(false)
const zoneCount = computed(() => (props.cam.zones || []).length)
const draftRect = ref(null)

/* ---------- AI 扩展分析（区域规则 / 人脸 / 姿态） ---------- */
/**
 * 这三项都建立在本帧的人形检测结果上：
 *   跟踪器（零成本）→ 区域进出 / 徘徊 / 人员计数
 *   SCRFD + MobileFaceNet → 人脸识别
 *   YOLOv8n-pose → 基础动作
 * 全部在 onAlarm 之前算完，事件统一走 emit('alarm') 上抛。
 */
const extras = useAiExtras(props.options)
const extCounts = extras.counts

/* ---------- 通道级附加能力开关（人脸 / 姿态 / 区域） ---------- */
/**
 * 这三项是「全局总闸 + 通道分流」两层控制：
 *   全局总开关在 设置 →「检测识别」页，管的是"要不要用这个能力"；
 *   这里管的是"这一路要不要跑它"。两层都开着才真正生效。
 * 把不看的通道关掉，是省算力最直接的一刀。
 */
const EXT_ROWS = [
  { key: 'face', label: '人脸识别', icon: '☺' },
  { key: 'pose', label: '人形姿态', icon: '⋔' },
  { key: 'zone', label: '区域规则', icon: '▤' }
]

/** 区域规则没有单一总开关（由进出 / 徘徊 / 计数几个子项决定），只有人脸和姿态要看全局 */
function extGlobalOn(key) {
  if (key === 'zone') return true
  const g = props.options[key]
  return !!(g && g.enabled)
}

/** 这一路实际是否在跑某个附加能力 */
function extOn(key) {
  return extGlobalOn(key) && camExtOn(props.cam, key)
}

function extLabel(e) {
  if (!camExtOn(props.cam, e.key)) return '已关闭'
  if (!extGlobalOn(e.key)) return '全局未开启'
  return '已开启'
}

function extTitle(e) {
  if (!camExtOn(props.cam, e.key)) return `这一路不参与${e.label}，点击恢复`
  if (!extGlobalOn(e.key)) return '总开关在「检测识别」页，开启后这一路才会生效'
  return `点击关闭这一路的${e.label}`
}

/**
 * 翻转这一路的附加能力。
 * 注意上层是浅合并（Object.assign），所以 aiExt 必须整个对象提交，不能只给单个键。
 */
function setExt(key, on) {
  const cur = props.cam.aiExt || {}
  const row = EXT_ROWS.find((r) => r.key === key)
  // 通道开关打开了、但总闸还关着 → 明确提示去哪儿开，避免"点了没反应"
  const needGlobal = !!on && !extGlobalOn(key)
  emit('update-camera', {
    id: props.cam.id,
    patch: {
      aiExt: { face: cur.face !== false, pose: cur.pose !== false, zone: cur.zone !== false, [key]: !!on }
    },
    notice: needGlobal ? `「${row ? row.label : key}」总开关在 设置 → 检测识别页，需先打开才会生效` : ''
  })
}

/* ---------- 盲视模式 ---------- */
const blindOn = computed(() => !!props.cam.blind)
/** 最近一次成功分析的 时间戳/报警摘要（供盲视面板显示） */
const lastAnalyzeAt = ref(0)
const lastAlarmInfo = ref(null)
const nowTick = ref(Date.now())
let blindTickTimer = null

watch(blindOn, (v) => {
  clearInterval(blindTickTimer)
  blindTickTimer = null
  if (v) {
    nowTick.value = Date.now()
    blindTickTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
    // 隐藏画面后不需要再画检测框，清掉叠加层
    nextTick(() => drawOverlay())
  }
})

/**
 * 相对时间文案。10 秒内算「刚刚」（item 106）——
 * 盲视面板每 1s 刷新一次，5 秒的门槛会让"上次分析"几乎永远显示成秒数，
 * 反而看不清到底是刚才还是几分钟前。超出 10 秒才给"X 秒 / X 分钟前"。
 */
function agoText(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((nowTick.value - ts) / 1000))
  if (s <= 10) return '刚刚'
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  return `${Math.floor(m / 60)} 小时前`
}

/** 绝对时间 HH:MM:SS */
function clockText(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const analyzeAgo = computed(() => agoText(lastAnalyzeAt.value))
const lastAlarmText = computed(() => {
  const a = lastAlarmInfo.value
  if (!a) return ''
  return `${a.type === 'person' ? '人形' : '移动'} · ${agoText(a.at)}`
})

function toggleBlind() {
  emit('update-camera', { id: props.cam.id, patch: { blind: !blindOn.value } })
}

let sampler = null
let aiSampler = null
let analysisTimer = null
let aiTimer = null
let busy = false
let aiBusy = false
let prevGray = null
let hitFrames = 0
let lastAlarmAt = 0
let alarmTimer = null

const analysisOn = computed(() => !!props.decode && motionOn(props.cam, props.options))

/* ---------- 盲视面板：检测 / 推送的快照 ---------- */
/**
 * 这一路上**配置为要跑**的检测项（画面变动 / 人形 / 人脸 / 姿态 / 区域 / 计数）。
 * 唯一权威是 features.js 的 activeDetects —— 与画面顶部那排芯片同源。
 *
 * ⚠️ 这里以前直接拿 `analysisOn` 当"有没有检测"，于是「关了移动检测、开着人形识别」
 *    时盲视面板写着「检测已关闭」，而画面顶上的人形芯片亮着 —— 自相矛盾。
 *    判据改成"任意一项开着即算有检测"。
 */
const detectLabels = computed(() => activeDetects(props.cam, props.options).map((d) => d.label))
const anyDetectOn = computed(() => detectLabels.value.length > 0)
const detectText = computed(() => detectLabels.value.join(' · '))

/**
 * 盲视面板：这一路当前会推送到哪些渠道。
 *
 * 判定 = 通道级开关（cam.push 总开关 + cam.channels[渠道]）× 渠道可用性（channelUsable）：
 *   on      —— 这一路开着、渠道也启用且凭据齐全 → 真的收得到
 *   unready —— 这一路开着，但渠道没启用 / 凭据没配好 → 实际一条都推不出去
 *   off     —— 这一路把这个渠道关了
 * 与设置页「监控通道」页那排渠道小勾、以及推送调度器 checkChannel 的口径一致。
 */
const pushChannelRows = computed(() =>
  PUSH_CHANNEL_KEYS.map(({ id, label }) => {
    const openForCam = props.cam.push !== false && !(props.cam.channels && props.cam.channels[id] === false)
    if (!openForCam) return { id, label, state: 'off', title: `这一路已关闭「${label}」推送` }
    if (!channelUsable(props.options, id))
      return { id, label, state: 'unready', title: `${label}未启用或凭据未配好，这一路实际推不出去` }
    return { id, label, state: 'on', title: `这一路的报警会推送到${label}` }
  })
)
const anyPushOn = computed(() => pushChannelRows.value.some((c) => c.state === 'on'))

const aiTitle = computed(() => {
  if (aiState.value === 'loading') return 'AI 模型加载中…'
  if (aiState.value === 'error') return 'AI 模型加载失败'
  return props.cam.ai ? '已开启人形识别' : '未开启人形识别'
})
const aiChipText = computed(() => {
  if (props.cam.ai && props.options.aiEnabled) {
    if (aiState.value === 'ready') return '人形'
    if (aiState.value === 'error') return 'AI 异常'
    return 'AI 加载中'
  }
  return '人形'
})

/**
 * 画面顶部要显示的附加分析标签。
 *
 * 定义收口在 useAiExtras 的 activeFeatures()：推送消息里那行「功能状态」用的是
 * 同一份定义，避免出现「画面显示开了、推送里说没开」这种自相矛盾。
 * 没生效的一律不出现（不占画面、不误导），所以这里不做"灰态"渲染。
 */
const extChips = computed(() =>
  activeFeatures(props.cam, props.options).map((d) => ({
    key: d.key,
    label: d.label,
    title: `这一路已开启${d.full}`
  }))
)

/** 附加分析标签的图标路径（统一 24×24 线性风格，stroke 用 currentColor 跟随配色） */
const EXT_ICON = {
  face: 'M4 8.5a2.5 2.5 0 1 1 4 0 2.5 2.5 0 0 1-4 0zM16 8.5a2.5 2.5 0 1 1 4 0 2.5 2.5 0 0 1-4 0zM9 15.2c.6-1.4 1.7-2.2 3-2.2s2.4.8 3 2.2M3 20.5c0-2.6 1.6-4.4 3.6-4.9M21 20.5c0-2.6-1.6-4.4-3.6-4.9',
  pose: 'M12 4.2a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4zM12 8v5m0 0-3.4 6M12 13l3.4 6M7 9.5l5 1.5 5-1.5',
  zone: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M12 14.5v-3M12 14.5l-2 2M12 14.5l2 2',
  count: 'M4 20V9m5 11V4m5 16v-7m5 7V7M2.5 20h19',
  default: 'M5 12h14'
}

/**
 * 触发报警的变动阈值（归一化，占总画面比例）。
 * 两个来源取「较大者」：
 *   1. 灵敏度换算出来的像素差阈值（灵敏度越高越容易触发）
 *   2. 手动设置的「变动档次」——只有画面被改动到这么大面积才算异常，
 *      用来滤掉光线变化、雨雪、噪点这类小抖动。
 */
const motionThreshold = computed(() => {
  const bySensitivity = sensitivityToThreshold(props.options.sensitivity)
  const floor = Math.max(0, Number(props.options.motionMinPercent) || 0) / 100
  return Math.max(bySensitivity, floor)
})

function ensureSampler() {
  if (!sampler) {
    sampler = new FrameSampler({
      getContainer: () => boxEl.value,
      getPlayer: () => player,
      width: 192
    })
  }
  return sampler
}

/**
 * 人形识别用独立采样器：分辨率远高于运动检测（默认 640），
 * 否则远距离的人在缩略图上只有几个像素高，模型根本认不出来。
 */
function ensureAiSampler() {
  const want = Math.max(320, Math.min(1280, Number(props.options.aiInputSize) || 640))
  if (!aiSampler || aiSampler.width !== want) {
    aiSampler = new FrameSampler({
      getContainer: () => boxEl.value,
      getPlayer: () => player,
      width: want
    })
  }
  return aiSampler
}

function startAnalysis() {
  stopAnalysis()
  if (analysisOn.value && status.value === 'playing') {
    const fps = Math.min(5, Math.max(1, Number(props.options.sampleFps) || 3))
    analysisTimer = setInterval(tickMotion, Math.round(1000 / fps))
  }
  if (props.options.aiEnabled && props.cam.ai) {
    // 每次建会话前把「允不允许用 GPU」同步给检测器：Windows 上 WebGPU 可能直接
    // 把推理线程炸掉（wasm trap），配置里关掉后这里就传 false，强制走 WASM。
    setGpuPref(props.options.aiGpu)
    loadPersonModel(props.options.aiModel).catch(() => {})
    /*
     * 扩展模型提前加载：等第一次分析时再加载，那一次就拿不到结果了。
     * 但只给「这一路真的参与」的能力预加载 —— 比如人脸特征模型有 13MB，
     * 通道级开关关掉人脸之后还去预加载，纯属白占内存。
     */
    if (props.options.face && props.options.face.enabled && camExtOn(props.cam, 'face')) {
      loadModel('face').catch(() => {})
      loadModel('faceemb').catch(() => {})
    }
    if (props.options.pose && props.options.pose.enabled && camExtOn(props.cam, 'pose')) {
      loadModel('pose').catch(() => {})
    }
    const interval = Math.max(1000, Number(props.options.aiIntervalMs) || 5000)
    aiTimer = setInterval(tickAi, interval)
    tickAi()
  }
}

function stopAnalysis() {
  clearInterval(analysisTimer)
  clearInterval(aiTimer)
  analysisTimer = null
  aiTimer = null
  // 补拍窗口跟着一起停，避免画面停了还在后台转
  stopPersonHunt()
  // 跟踪轨迹不能跨"停止-重启"保留，否则重启后会把旧轨迹当成同一个人
  extras.reset()
  hitFrames = 0
  prevGray = null
}

async function tickMotion() {
  if (busy || !props.decode || document.hidden || status.value !== 'playing' || !player) return
  busy = true
  try {
    const frame = await ensureSampler().grab()
    if (!frame) {
      drawOverlay()
      return
    }
    const res = compareFrames(prevGray, frame.imageData, currentRoi(), 22)
    prevGray = res.gray
    motionBox.value = res.ratio > motionThreshold.value ? res.box : null
    lastAnalyzeAt.value = Date.now()

    const now = Date.now()
    const cooldown = Math.max(2000, (Number(props.options.cooldownSec) || 10) * 1000)
    const need = Math.max(1, Number(props.options.confirmFrames) || 3)

    if (res.ratio > motionThreshold.value) {
      hitFrames += 1
      if (hitFrames >= need && now - lastAlarmAt > cooldown) {
        lastAlarmAt = now
        triggerAlarm('motion', res.ratio, frame.canvas)
      }
    } else {
      hitFrames = Math.max(0, hitFrames - 1)
    }
    // 盲视时跳过叠加层绘制，省一点渲染开销
    if (!blindOn.value) drawOverlay()
  } catch (e) {
    /* 分析失败不影响播放 */
  } finally {
    busy = false
  }
}

async function tickAi() {
  if (!props.decode || document.hidden || status.value !== 'playing' || !props.options.aiEnabled || !props.cam.ai) return
  if (aiBusy) return
  aiBusy = true
  try {
    const frame = await ensureAiSampler().grab()
    if (!frame) return
    lastAnalyzeAt.value = Date.now()
    const persons = await detectPersons(frame.canvas, Number(props.options.aiScore) || 0.5, {
      model: props.options.aiModel
    })
    personBoxes.value = persons
    const now = Date.now()
    if (persons.length) {
      const cooldown = Math.max(2000, (Number(props.options.cooldownSec) || 10) * 1000)
      if (now - lastAlarmAt > cooldown) {
        lastAlarmAt = now
        triggerAlarm('person', persons[0].score, frame.canvas)
      }
    }
    // 人形结果之外的三层能力：区域规则 / 人脸 / 姿态。
    // 它们复用这一帧，不再单独抓图（抓图本身有成本）。
    await extras.step(frame, persons, now, {
      cam: props.cam,
      emit: (evt) => emitExtraAlarm(evt, frame.canvas)
    })
    if (!blindOn.value) drawOverlay()
  } catch (e) {
    personBoxes.value = []
  } finally {
    aiBusy = false
  }
}

/**
 * 把扩展分析（区域 / 人脸 / 姿态 / 计数）产生的事件，整理成和普通报警
 * 完全一样的记录往上抛 —— 这样推送调度、事件面板、通知卡片全都不用改。
 */
function emitExtraAlarm(evt, canvas) {
  const type = evt.type
  if (!type) return
  // 与 triggerAlarm 统一走 grabArchiveShot：直接编码检测画布容易出黑图
  const thumb = grabArchiveShot(canvas, 360)
  const shot = canvas ? grabArchiveShot(canvas) : ''
  const info = videoInfo.value

  // 命中即高亮对应的标签（人脸/姿态/区域/计数）
  markHit(type)

  emit('alarm', {
    id: props.cam.id,
    name: props.cam.name,
    type,
    ratio: 0,
    thumb,
    shot,
    time: evt.at || Date.now(),
    /** 事件摘要（推送正文与通知卡片直接用这句） */
    text: evt.text || '',
    /** 人脸事件：识别到的人名与相似度 */
    faceName: evt.faceName || '',
    faceScore: evt.faceScore || 0,
    /** 人脸小图（放大后的 96×96），事件详情里单独展示 */
    faceThumb: evt.type === 'face' ? evt.thumb || '' : '',
    /** 区域事件的区域名 */
    zoneName: evt.zoneName || '',
    /** 姿态事件的动作 */
    action: evt.action || '',
    actionText: evt.actionText || '',
    /** 计数事件的统计值 */
    counts: evt.counts || null,
    /** 在区域内停留了多久 */
    dwellMs: evt.dwellMs || 0,
    info: info ? { width: info.width, height: info.height, encType: info.encType } : null,
    fps: stats.value ? stats.value.fps : null,
    kbps: kbps.value || null
  })

  // 计数是周期性统计，不需要补拍；其余场景补一张完整人形（能看清是谁）
  if (type !== 'count' && type !== 'pose') startPersonHunt()
}

/**
 * 把任意可绘制来源（canvas / video）编码成 JPEG。
 * maxWidth 传 0 表示保留原始分辨率；scale 只在需要缩小时才生效，不会放大。
 */
function encodeJPEG(source, maxWidth, quality) {
  if (!source || !source.width || !source.height) return ''
  const cap = Number(maxWidth) > 0 ? Number(maxWidth) : Number.MAX_SAFE_INTEGER
  const scale = Math.min(1, cap / source.width)
  const w = Math.max(1, Math.round(source.width * scale))
  const h = Math.max(1, Math.round(source.height * scale))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  try {
    ctx.drawImage(source, 0, 0, w, h)
    return c.toDataURL('image/jpeg', quality)
  } catch (e) {
    return ''
  }
}

/** 判断画面是不是"空帧"（全黑 / 毫无细节），用于识别取帧失败 */
function looksBlank(source) {
  try {
    const w = 32
    const h = Math.max(2, Math.round((source.height / source.width) * 32))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    ctx.drawImage(source, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    let min = 255
    let max = 0
    let sum = 0
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (v < min) min = v
      if (v > max) max = v
      sum += v
    }
    const avg = sum / (d.length / 4)
    return max - min < 6 || avg < 2
  } catch (e) {
    return false
  }
}

/**
 * 事件留档截图（详情弹窗 / 放大查看用的"原图"）。
 *
 * 取源优先级：把画面上所有可能的源都列出来，挑**分辨率最大的且不是空帧**的那个：
 *   1. 解码器画布（Jessibuca 会把 H.265 解到原生尺寸的画布，如 3200×1800）
 *   2. <video> 元素（走 MSE/原生解码时 videoWidth 才是真实分辨率）
 *   3. 检测采样帧（兜底，通常已经被缩小过）
 * 这样即使某个源被降采样或还没出画面，也不会把糊图存进事件记录。
 */
function grabArchiveShot(fallback, maxWidth) {
  const raw = props.options.alert ? Number(props.options.alert.shotWidth) : NaN
  // 未配置过该项（老版本配置）时回退到 0（原图）
  const cap = maxWidth > 0 ? maxWidth : Number.isFinite(raw) ? (raw > 0 ? raw : Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER

  const candidates = []
  if (boxEl.value) {
    const c = boxEl.value.querySelector('canvas')
    if (c && c.width > 2 && c.height > 2) candidates.push(c)
    const v = boxEl.value.querySelector('video')
    if (v && v.videoWidth > 2 && v.videoHeight > 2) {
      candidates.push({ width: v.videoWidth, height: v.videoHeight, __video: v })
    }
  }
  if (fallback && fallback.width > 2 && fallback.height > 2) candidates.push(fallback)

  // 面积从大到小试，第一个"有内容"的源就是我们要的
  candidates.sort((a, b) => b.width * b.height - a.width * a.height)
  for (const src of candidates) {
    if (looksBlank(src)) continue
    const out = encodeJPEG(src, cap, 0.92)
    if (out) return out
  }
  // 全部空白（画面本来就没出图）时，仍然留一张，便于排查
  if (candidates.length) return encodeJPEG(candidates[0], cap, 0.9)
  return ''
}

function triggerAlarm(type, ratio, canvas) {
  alarmType.value = type
  alarm.value = true
  // 命中即高亮对应标签（移动 / 人形）
  markHit(type)
  lastAlarmInfo.value = { type, at: Date.now() }
  clearTimeout(alarmTimer)
  alarmTimer = setTimeout(() => (alarm.value = false), 4000)

  /*
   * ⚠️ 列表缩略图原来直接拿 `canvas`（检测采样帧）编码，
   * 而详情用的 shot 走的是 grabArchiveShot —— 后者会跳过空帧挑真正有画面的源。
   * 检测画布在触发瞬间常常已经被清空 / 还没落帧，于是列表缩略图一片黑，
   * 只有打开详情（用 shot）才正常。现在两者统一走同一套取源逻辑。
   */
  const thumb = grabArchiveShot(canvas, 360)
  // 详情 / 放大查看用的原图
  const shot = grabArchiveShot(canvas)

  emit('alarm', {
    id: props.cam.id,
    name: props.cam.name,
    type,
    ratio,
    thumb,
    shot,
    time: Date.now(),
    info: videoInfo.value
      ? {
          width: videoInfo.value.width,
          height: videoInfo.value.height,
          encType: videoInfo.value.encType
        }
      : null,
    fps: stats.value ? stats.value.fps : null,
    kbps: kbps.value || null
  })

  // 报警「先推最快的」：上面这条已经带着当前帧发出去了。
  // 下面再开一个几秒的窗口补拍一张完整人形（只有开了人形识别的通道才做）。
  startPersonHunt()
}

/* ==================== 完整人形补拍 ==================== */
/**
 * 报警后补一张「完整人形」。
 *
 * 为什么不能直接截报警那一帧：报警讲究秒级时效，触发时人可能刚进画面一半、
 * 或者正好被画面边缘切断（只有半个身子），拿去推送 / 留档都不好看。
 *
 * 做法：
 *   1. 报警照旧用当前帧立刻推（时效不受影响）；
 *   2. 随后几秒内反复采样，用**低分辨率**的识别帧判断「人形是否完整」——
 *      框完整落在画面内 + 面积够大 + 置信度高，综合打分；
 *   3. 只有在出现更优帧时才去抓一张**高分辨率原图**（抓图有成本，不每帧都抓）；
 *   4. 拿到「完整且够大」的人形就提前收工，否则等到窗口结束取最优那张。
 */
/**
 * 补拍窗口的长度。
 * 实测人从"刚进画面半个身子"走到"整个人都在画面里"大约 1~2 秒，
 * 所以窗口给 3 秒足够，超过只是白白占着推理线程。
 */
const PERSON_HUNT_MS = 3000
/** 采样间隔：比常规分析密一些，才有机会抓到那一帧最完整的 */
const PERSON_HUNT_INTERVAL = 350
/** 首次采样前的等待：报警那一帧人往往还没走全，立刻抓多半是半个身子 */
const PERSON_HUNT_FIRST_DELAY = 700
let huntTimer = null
let huntDeadline = 0
let huntBest = null
let huntSeq = 0

/** 给一帧里的人形打分：完整（框在画面内）权重最高，其次面积与置信度 */
function scorePersonFrame(persons) {
  let best = null
  ;(persons || []).forEach((p) => {
    const margin = 0.012
    const inside =
      p.x >= margin && p.y >= margin && p.x + p.w <= 1 - margin && p.y + p.h <= 1 - margin
    const area = Math.max(0, p.w) * Math.max(0, p.h)
    // 被画面边缘切掉的人形直接打折，避免选到半个身子
    const score = area * (inside ? 1.6 : 0.55) * (0.55 + Math.min(1, Number(p.score) || 0))
    if (!best || score > best.score) {
      best = { score, inside, area, conf: Number(p.score) || 0, box: { ...p } }
    }
  })
  return best
}

function stopPersonHunt() {
  if (huntTimer) clearInterval(huntTimer)
  huntTimer = null
  huntDeadline = 0
  huntBest = null
}

function finishPersonHunt() {
  const best = huntBest
  stopPersonHunt()
  if (!best || !best.shot) return
  emit('alarm-shot', {
    id: props.cam.id,
    name: props.cam.name,
    at: best.at,
    shot: best.shot,
    thumb: best.thumb,
    box: best.box,
    inside: best.inside,
    area: best.area,
    score: best.conf,
    /** 同一轮补拍里顺便拿到的人脸 / 姿态信息（补推消息会带上） */
    meta: best.meta || null,
    huntSeq
  })
}

async function huntTick() {
  if (Date.now() > huntDeadline) return finishPersonHunt()
  // 不和常规的运动 / 人形分析抢 CPU，也不在没画面时瞎转
  if (aiBusy || busy || !props.decode || status.value !== 'playing') return
  aiBusy = true
  try {
    const frame = await ensureAiSampler().grab()
    if (!frame) return
    const persons = await detectPersons(frame.canvas, Number(props.options.aiScore) || 0.5, {
      model: props.options.aiModel
    })
    personBoxes.value = persons
    if (!blindOn.value) drawOverlay()

    const cand = scorePersonFrame(persons)
    if (!cand) return
    // 比已有的最优帧好 2% 以上才值得重新抓一张高清图
    if (huntBest && cand.score <= huntBest.score * 1.02) return

    const shot = grabArchiveShot(frame.canvas)
    if (!shot) return
    // 顺手确认「这个人是谁、在做什么」——只在配置开启时才真的推理
    const meta = await extras.probe(frame.canvas, cand.box, Date.now(), { cam: props.cam })
    huntBest = {
      score: cand.score,
      inside: cand.inside,
      area: cand.area,
      conf: cand.conf,
      box: cand.box,
      shot,
      thumb: encodeJPEG(frame.canvas, 360, 0.62),
      meta,
      at: Date.now()
    }
    // 已经拿到「完整且占画面够大」的人形，提前收工
    if (cand.inside && cand.area >= 0.05) finishPersonHunt()
  } catch (e) {
    /* 补拍失败不影响报警本身 */
  } finally {
    aiBusy = false
  }
}

/**
 * 启动补拍窗口。
 *
 * ⚠️ 这里**只看全局的人形识别开关，不看通道的「人形识别」**：
 * 用户明确要求「只开了画面检测、没开人形识别的通道，一旦检测到人形也要补图」。
 * 通道开关决定的是「人形能否单独触发报警」，而补拍属于报警的补充动作，
 * 只要机器还能跑人形检测就应该做。
 */
function startPersonHunt() {
  stopPersonHunt()
  if (!props.options.aiEnabled) return
  if (props.options.alert && props.options.alert.extraPersonShot === false) return
  huntSeq += 1
  huntBest = null
  huntDeadline = Date.now() + PERSON_HUNT_MS
  // 先等一小会儿再抓第一张：报警那一帧人往往只进来半个身子
  huntTimer = setInterval(huntTick, PERSON_HUNT_INTERVAL)
  setTimeout(() => {
    if (huntDeadline) huntTick()
  }, PERSON_HUNT_FIRST_DELAY)
}

function currentRoi() {
  if (draftRect.value) return draftRect.value
  return props.cam.roi || null
}

function toggleMotion() {
  emit('update-camera', { id: props.cam.id, patch: { motion: !analysisOn.value } })
}

function toggleAi() {
  const next = !props.cam.ai
  if (next && aiState.value !== 'ready') loadPersonModel().catch(() => {})
  emit('update-camera', { id: props.cam.id, patch: { ai: next } })
}

/* ---------- 圈选 ROI / 检测区域 ---------- */
function onRoiDown(e) {
  if (!roiEditing.value && !zoneEditing.value) return
  const rect = overlayEl.value.getBoundingClientRect()
  draftRect.value = {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
    w: 0,
    h: 0
  }
  drawOverlay()
}

function onRoiMove(e) {
  if ((!roiEditing.value && !zoneEditing.value) || !draftRect.value) return
  const rect = overlayEl.value.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
  const start = draftRect.value
  draftRect.value = {
    x: Math.min(x, start.x),
    y: Math.min(y, start.y),
    w: Math.abs(x - start.x),
    h: Math.abs(y - start.y)
  }
  drawOverlay()
}

function onRoiUp() {
  if (!draftRect.value) return
  const r = draftRect.value
  draftRect.value = null
  if (r.w < 0.04 || r.h < 0.04) {
    drawOverlay()
    return
  }
  if (zoneEditing.value) {
    emit('zone-add', { id: props.cam.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h } })
  } else if (roiEditing.value) {
    emit('roi-change', { id: props.cam.id, roi: { x: r.x, y: r.y, w: r.w, h: r.h } })
  }
  drawOverlay()
}

function clearRoi() {
  draftRect.value = null
  emit('roi-change', { id: props.cam.id, roi: null })
  drawOverlay()
}

/* ---------- 叠加层绘制 ---------- */
function drawOverlay() {
  if (blindOn.value) return
  const c = overlayEl.value
  if (!c) return
  const rect = c.getBoundingClientRect()
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  const ctx = c.getContext('2d')
  ctx.clearRect(0, 0, w, h)

  const roi = currentRoi()
  if (roi && !zoneEditing.value && (props.options.showRoi || roiEditing.value)) {
    ctx.lineWidth = Math.max(1, 1.5 * dpr)
    ctx.strokeStyle = roiEditing.value ? 'var(--warn)' : 'color-mix(in srgb, var(--accent) 85%, transparent)'
    ctx.setLineDash(roiEditing.value ? [6 * dpr, 4 * dpr] : [])
    ctx.strokeRect(roi.x * w, roi.y * h, roi.w * w, roi.h * h)
    ctx.setLineDash([])
  }

  // 正在拖拽的「新区域」草稿框
  if (zoneEditing.value && draftRect.value) {
    const d = draftRect.value
    ctx.lineWidth = Math.max(1, 1.8 * dpr)
    ctx.strokeStyle = 'var(--cyan)'
    ctx.setLineDash([7 * dpr, 4 * dpr])
    ctx.strokeRect(d.x * w, d.y * h, d.w * w, d.h * h)
    ctx.setLineDash([])
  }

  if (motionBox.value && props.options.showStats) {
    const b = motionBox.value
    ctx.lineWidth = Math.max(1, 1.5 * dpr)
    ctx.strokeStyle = 'color-mix(in srgb, var(--warn) 75%, transparent)'
    ctx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h)
  }

  personBoxes.value.forEach((p) => {
    const x = p.x * w
    const y = p.y * h
    const bw = p.w * w
    const bh = p.h * h
    ctx.lineWidth = Math.max(1.4, 2 * dpr)
    ctx.strokeStyle = 'var(--ok)'
    ctx.strokeRect(x, y, bw, bh)

    const label = `人形 ${(p.score * 100).toFixed(0)}%`
    ctx.font = `${Math.round(11 * dpr)}px -apple-system, "PingFang SC", sans-serif`
    const tw = ctx.measureText(label).width
    ctx.fillStyle = 'color-mix(in srgb, var(--ok) 92%, transparent)'
    ctx.fillRect(x, Math.max(0, y - 15 * dpr), tw + 10 * dpr, 15 * dpr)
    ctx.fillStyle = '#04240f'
    ctx.fillText(label, x + 5 * dpr, Math.max(11 * dpr, y - 4 * dpr))
  })

  /* ---------- 检测区域（进出 / 徘徊） ---------- */
  // 通道级「区域规则」关掉时不再画区域框 —— 否则会出现「框还在但事件不报」的错觉
  const zones = camExtOn(props.cam, 'zone') ? props.cam.zones || [] : []
  zones.forEach((z, i) => {
    if (!z.rect) return
    ctx.setLineDash([6 * dpr, 4 * dpr])
    ctx.lineWidth = Math.max(1, 1.4 * dpr)
    ctx.strokeStyle = 'color-mix(in srgb, var(--cyan) 72%, transparent)'
    ctx.strokeRect(z.rect.x * w, z.rect.y * h, z.rect.w * w, z.rect.h * h)
    ctx.setLineDash([])

    const label = z.name || `区域${i + 1}`
    ctx.font = `${Math.round(10.5 * dpr)}px -apple-system, "PingFang SC", sans-serif`
    const tw = ctx.measureText(label).width
    const ly = z.rect.y * h
    ctx.fillStyle = 'color-mix(in srgb, var(--cyan) 90%, transparent)'
    ctx.fillRect(z.rect.x * w, ly, tw + 10 * dpr, 15 * dpr)
    ctx.fillStyle = 'color-mix(in srgb, var(--cyan) 18%, var(--panel))'
    ctx.fillText(label, z.rect.x * w + 5 * dpr, ly + 11 * dpr)
  })

  /* ---------- 人脸框（识别到的人带上名字） ---------- */
  const faceCfg = props.options.face || {}
  if (faceCfg.drawBox !== false && camExtOn(props.cam, 'face')) {
    extras.faces.value.forEach((f) => {
      const x = f.x * w
      const y = f.y * h
      const bw = f.w * w
      const bh = f.h * h
      const known = !!f.known
      ctx.lineWidth = Math.max(1.4, 1.8 * dpr)
      ctx.strokeStyle = known ? 'var(--warn-text)' : 'color-mix(in srgb, var(--warn-text) 60%, transparent)'
      ctx.strokeRect(x, y, bw, bh)

      const label = known ? f.name : '未录入'
      ctx.font = `${Math.round(10.5 * dpr)}px -apple-system, "PingFang SC", sans-serif`
      const tw = ctx.measureText(label).width
      ctx.fillStyle = known ? 'color-mix(in srgb, var(--warn-text) 94%, transparent)' : 'color-mix(in srgb, var(--text-dim) 85%, transparent)'
      ctx.fillRect(x, Math.max(0, y - 15 * dpr), tw + 10 * dpr, 15 * dpr)
      ctx.fillStyle = known ? 'color-mix(in srgb, var(--warn) 22%, var(--panel))' : 'var(--text-bright)'
      ctx.fillText(label, x + 5 * dpr, Math.max(11 * dpr, y - 4 * dpr))
    })
  }

  /* ---------- 姿态骨架 ---------- */
  if (props.options.pose && props.options.pose.enabled && camExtOn(props.cam, 'pose')) {
    ctx.lineWidth = Math.max(1.2, 1.6 * dpr)
    ctx.strokeStyle = 'color-mix(in srgb, var(--purple) 85%, transparent)'
    extras.poses.value.forEach((p) => {
      const kps = p.kps || []
      SKELETON.forEach(([a, b]) => {
        const ka = kps[a]
        const kb = kps[b]
        if (!ka || !kb || ka.s < 0.3 || kb.s < 0.3) return
        ctx.beginPath()
        ctx.moveTo(ka.x * w, ka.y * h)
        ctx.lineTo(kb.x * w, kb.y * h)
        ctx.stroke()
      })
      ctx.fillStyle = 'color-mix(in srgb, var(--purple) 90%, transparent)'
      kps.forEach((k) => {
        if (k.s < 0.3) return
        ctx.beginPath()
        ctx.arc(k.x * w, k.y * h, Math.max(1.2, 2 * dpr), 0, Math.PI * 2)
        ctx.fill()
      })
    })
  }

  /* ---------- 画面内人数 ---------- */
  const zoneCfg = props.options.zone || {}
  if (zoneCfg.countEnabled && zoneCfg.showOnScreen !== false && camExtOn(props.cam, 'zone')) {
    const c = extCounts.value
    const mode = zoneCfg.countMode || 'current'
    const text =
      mode === 'total'
        ? `累计 ${c.totalIn} 人次`
        : mode === 'both'
          ? `${c.current} 人 · 累计 ${c.totalIn}`
          : `${c.current} 人`
    ctx.font = `600 ${Math.round(12 * dpr)}px -apple-system, "PingFang SC", sans-serif`
    const tw = ctx.measureText(text).width
    const bx = w - tw - 18 * dpr
    ctx.fillStyle = 'color-mix(in srgb, var(--bg-deep) 72%, transparent)'
    ctx.fillRect(bx, 8 * dpr, tw + 14 * dpr, 20 * dpr)
    ctx.fillStyle = '#8ecbff'
    ctx.fillText(text, bx + 7 * dpr, 22 * dpr)
  }
}

/** COCO 17 关键点的骨架连线 */
const SKELETON = [
  [5, 6],
  [5, 7],
  [7, 9],
  [6, 8],
  [8, 10],
  [5, 11],
  [6, 12],
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 4]
]

/* ==================== 交互 ==================== */
function onEcoClick() {
  if (!props.decode) emit('request-play', props.cam.id)
}

function onDblClick() {
  if (roiEditing.value || zoneEditing.value) return
  toggleZoom()
}

function toggleZoom() {
  emit('zoom', props.index)
}

async function toggleFullscreen() {
  const el = tileEl.value
  if (!el) return
  try {
    if (!document.fullscreenElement) await el.requestFullscreen()
    else await document.exitFullscreen()
  } catch (e) {
    /* ignore */
  }
}

function snapshot() {
  if (!player) return
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    player.screenshot(
      `${props.cam.name.replace(/[\\/:*?"<>|\s]/g, '_')}_${stamp}`,
      'png',
      0.92,
      'download'
    )
  } catch (e) {
    /* ignore */
  }
}

function onFullscreenChange() {
  nextTick(() => {
    player && player.resize()
    drawOverlay()
  })
}

/* ==================== 生命周期 ==================== */
let observer = null

onMounted(() => {
  // createPlayer 现在会 await 解码器就绪，这里不用等它 —— 首屏先出来，画面随后补上
  if (props.decode) createPlayer()
  else setStatus('idle', '省流模式')
  if (window.ResizeObserver) {
    observer = new ResizeObserver(() => {
      try {
        player && player.resize()
      } catch (e) {
        /* ignore */
      }
      drawOverlay()
    })
    observer.observe(boxEl.value)
  }
  document.addEventListener('fullscreenchange', onFullscreenChange)
  nextTick(drawOverlay)
})

onBeforeUnmount(async () => {
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  closeMore()
  observer && observer.disconnect()
  clearTimeout(alarmTimer)
  clearTimeout(hitTimer)
  clearInterval(blindTickTimer)
  await destroyPlayer()
})

watch(
  () => props.decode,
  async (v) => {
    if (v) {
      retryCount = 0
      await destroyPlayer()
      await nextTick()
      await createPlayer()
    } else {
      await destroyPlayer()
      videoInfo.value = null
      stats.value = null
      kbps.value = 0
      alarm.value = false
      personBoxes.value = []
      motionBox.value = null
      setStatus('idle', '省流模式')
    }
  }
)

watch(
  // activeUrl：网格态拉子码流、放大态切主码流 —— zoom 进出会在这里触发重启切流
  () => [activeUrl.value, props.options.hasAudio, props.options.useHardDecode],
  () => restart()
)

watch(
  () => [props.options.analysisEnabled, props.options.sampleFps, props.cam.motion],
  () => {
    if (status.value === 'playing') startAnalysis()
  }
)

watch(
  () => [props.options.aiEnabled, props.cam.ai, props.options.aiIntervalMs, props.options.aiModel, props.options.aiInputSize, props.options.aiGpu],
  () => {
    if (props.options.aiInputSize !== undefined) aiSampler = null
    if (status.value === 'playing') startAnalysis()
  }
)

watch(
  () => [props.cam.roi, props.options.showRoi],
  () => drawOverlay()
)

/*
 * 通道级附加能力开关（人脸 / 姿态 / 区域）+ 对应的全局总开关。
 * 变化时要立刻做两件事，否则用户在画面上点了开关"看不到任何反应"：
 *   1. 重画叠加层（人脸框 / 骨架 / 区域框该出现就出现、该消失就消失）
 *   2. 重启分析循环，顺带把新启用的能力需要的模型预加载上
 *      （人脸特征模型有 13MB，不预热的话第一次分析拿不到结果）
 */
watch(
  () => [
    props.cam.aiExt && props.cam.aiExt.face,
    props.cam.aiExt && props.cam.aiExt.pose,
    props.cam.aiExt && props.cam.aiExt.zone,
    props.options.face && props.options.face.enabled,
    props.options.pose && props.options.pose.enabled
  ],
  () => {
    // 关掉的能力立刻把残留的框清掉，别让"已经关了还画着"误导人
    if (!camExtOn(props.cam, 'face') || !(props.options.face && props.options.face.enabled)) {
      extras.faces.value = []
    }
    if (!camExtOn(props.cam, 'pose') || !(props.options.pose && props.options.pose.enabled)) {
      extras.poses.value = []
    }
    if (status.value === 'playing') startAnalysis()
    drawOverlay()
  }
)

watch(
  () => props.zoomed,
  () =>
    nextTick(() =>
      setTimeout(() => {
        player && player.resize()
        drawOverlay()
      }, 60)
    )
)

defineExpose({
  reconnect: restart,
  /** 页面 pagehide（iOS bfcache）时由 App 统一调用，防僵尸播放器 */
  destroy: () => destroyPlayer(),
  pause: () => {
    if (player) {
      player.pause()
      manuallyPaused.value = true
    }
  },
  resume: () => {
    if (player) {
      player.play().catch(() => {})
      manuallyPaused.value = false
    }
  },
  getStatus: () => (manuallyPaused.value ? 'paused' : status.value),
  /** 供定时巡检等场景读取当前画面快照 */
  getSnapshot: () => ({
    id: props.cam.id,
    name: props.cam.name,
    url: props.cam.url,
    status: status.value,
    text: statusText.value,
    resolution: videoInfo.value
      ? `${videoInfo.value.width}×${videoInfo.value.height} · ${videoInfo.value.encType}`
      : '',
    fps: stats.value ? stats.value.fps : null,
    kbps: kbps.value || null
  })
})
</script>

<style scoped>
.tile {
  position: relative;
  min-width: 0;
  min-height: 0;
  background: #05070b;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.tile:hover {
  border-color: var(--line-strong);
}

.tile.zoomed {
  position: fixed;
  inset: 12px;
  z-index: 90;
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.75);
  border-radius: 12px;
}

.tile.is-error {
  border-color: color-mix(in srgb, var(--err) 45%, transparent);
}

.tile.alarmed {
  border-color: var(--err);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--err) 50%, transparent), 0 0 26px color-mix(in srgb, var(--err) 35%, transparent) inset;
  animation: alarmPulse 1.1s ease-in-out infinite;
}

@keyframes alarmPulse {
  50% {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--err) 85%, transparent), 0 0 40px color-mix(in srgb, var(--err) 45%, transparent) inset;
  }
}

.video-box {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/*
 * 注意：绝对不要给播放器 canvas 设 width/height 100%！
 * 播放器（Jessibuca）把 canvas 的属性尺寸设为视频原始分辨率（如 3200×1800），
 * 再用 transform: scale() 等比缩放到容器，并按未缩放的尺寸计算 left/top 偏移。
 * 一旦用 CSS 强行改写 canvas 盒子尺寸，偏移就会算错，画面会被推到可视区外
 * （表现为黑屏，或只有放大/全屏时在角落露出一小块）。
 * 这里只做 display 设置，尺寸完全交给播放器自己控制。
 */
.video-box :deep(canvas) {
  display: block;
}

.video-box :deep(video) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 4;
  pointer-events: none;
}

.overlay.editing {
  pointer-events: auto;
  cursor: crosshair;
  background: rgba(6, 10, 16, 0.18);
}

.video-box.blind :deep(canvas),
.video-box.blind :deep(video) {
  /* 保留布局尺寸（播放器 resize 依赖它），但让浏览器跳过绘制合成 */
  visibility: hidden;
}

.blind-panel {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 7;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 62%;
  max-width: 88%;
  padding: 12px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel) 90%, transparent);
  border: 1px solid var(--line);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
}

.blind-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-bright);
}

.b-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-dim-2);
  flex: 0 0 auto;
}

.b-dot.run {
  background: var(--ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 16%, transparent);
  animation: blink 2s infinite;
}

.b-dot.hit {
  background: var(--err);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--err) 25%, transparent);
  animation: blink 0.6s infinite;
}

.b-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.b-rows b {
  color: var(--text-soft);
  font-weight: 600;
}

.b-rows .b-alarm {
  color: var(--err-text);
}

/*
 * 检测项 / 「一个都没开」/ 推送渠道
 * ----------------------------------------------------------------
 * 这一段全部走主题变量。以前这里是写死的浅灰（#8fa0ba / #c4d2e8），
 * 在深色面板上没问题，但亮色主题下面板是白底 → 浅灰字几乎看不见。
 */
.b-rows .b-detect {
  color: var(--accent-text-strong);
}

.b-rows .b-off {
  color: var(--text-dim-2);
  font-weight: 400;
  font-style: normal;
}

.b-ch-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.b-rows .b-ch {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-soft);
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--tint) 6%, transparent);
}

/* 会推送到该渠道 */
.b-rows .b-ch.on {
  color: var(--ok-text);
  border-color: color-mix(in srgb, var(--ok) 45%, transparent);
  background: color-mix(in srgb, var(--ok) 16%, transparent);
}

/* 这一路开着，但渠道没启用 / 凭据没配好 */
.b-rows .b-ch.unready {
  color: var(--warn-text);
  border-color: color-mix(in srgb, var(--warn) 45%, transparent);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
}

/* 这一路自己关掉的渠道：划掉 —— 与「没配好」区分开 */
.b-rows .b-ch.off {
  color: var(--text-dim-2);
  border-style: dashed;
  text-decoration: line-through;
}

.blind-panel .btn {
  align-self: center;
}

.bar {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 12px;
  pointer-events: none;
  z-index: 5;
}

.bar.top {
  top: 0;
  /* 必须高于 .state（z-index 7）：否则省流 / 异常状态下，
     画面中央的状态层会盖住左上角的「十字拖动柄」，导致无法拖动画面 */
  z-index: 10;
  background: linear-gradient(180deg, rgba(4, 6, 10, 0.82), rgba(4, 6, 10, 0));
}

.bar.bottom {
  bottom: 0;
  background: linear-gradient(0deg, rgba(4, 6, 10, 0.85), rgba(4, 6, 10, 0));
  opacity: 0;
  transition: opacity 0.18s ease;
  padding-top: 16px;
}

.tile:hover .bar.bottom,
.tile.zoomed .bar.bottom {
  opacity: 1;
}

.spacer {
  flex: 1 1 auto;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-dim-2);
  flex: 0 0 auto;
}

.dot.playing {
  background: var(--ok);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 16%, transparent);
}

.dot.connecting {
  background: var(--warn);
  animation: blink 1s infinite;
}

.dot.error {
  background: var(--err);
}

.dot.paused {
  background: var(--text-dim-2);
}

@keyframes blink {
  50% {
    opacity: 0.25;
  }
}

.name {
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-bright);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

.info,
.stats {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

/* ---------- 右上角画面参数：悬浮展开 ---------- */
.stats-wrap {
  position: relative;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
}

/* .bar 整体是 pointer-events: none，所以这里要单独打开，
   但未悬浮时不希望它挡住画面的双击放大，用透明区域 + 只让 chip 可点 */
.info-chip {
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 11px;
  line-height: 1;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--bg-deep) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--text-dim-2) 50%, transparent);
  cursor: default;
  transition: color 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}

.stats-wrap.dim .info-chip {
  opacity: 0.7;
}

.stats-wrap:hover .info-chip {
  color: var(--accent-text-strong);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  background: color-mix(in srgb, var(--panel-2) 90%, transparent);
}

.stats-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 168px;
  padding: 8px 10px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--panel) 96%, transparent);
  border: 1px solid color-mix(in srgb, var(--text-dim-2) 60%, transparent);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  line-height: 1.5;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: opacity 0.15s ease, transform 0.15s ease, visibility 0.15s;
  z-index: 20;
}

.stats-wrap:hover .stats-pop {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.sp-title {
  font-size: 11px;
  font-weight: 600;
  color: #7fa0c8;
  letter-spacing: 0.4px;
  margin-bottom: 2px;
}

.sp-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.sp-row i {
  flex: 0 0 44px;
  font-style: normal;
  color: #6d809a;
}

.sp-row em {
  font-style: normal;
  color: #dce7f6;
  font-variant-numeric: tabular-nums;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 17px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 11px;
  line-height: 1;
  color: #8fa6c4;
  background: color-mix(in srgb, var(--tint) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--tint) 8%, transparent);
}

.chip.on {
  color: #7fd6ff;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}

.chip.ai {
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  border-color: color-mix(in srgb, var(--ok) 30%, transparent);
}

/* 人形识别之上的附加分析：人脸 / 姿态 / 区域 / 计数（只在真正生效时出现） */
.chip.ext {
  color: #7fe3d4;
  background: color-mix(in srgb, var(--cyan) 14%, transparent);
  border-color: color-mix(in srgb, var(--cyan) 30%, transparent);
}

/* 扩展标签的图标与文字之间留一点呼吸，视觉上更紧凑 */
.chip .ext-ico {
  flex: 0 0 auto;
  opacity: 0.9;
}

/*
 * 每个检测类型一套配色（item 105）。
 * 以前移动是蓝、人形是绿、附加分析一律青色，三种颜色混在一起
 * 分不清谁是谁；现在按类型分色，扫一眼画面就知道开了哪些能力。
 * 颜色沿用项目既有变量，避免和整体主题脱节。
 */
.chip.t-motion {
  color: #7fb6ff;
  background: color-mix(in srgb, #4d8ef7 16%, transparent);
  border-color: color-mix(in srgb, #4d8ef7 34%, transparent);
}

.chip.t-person {
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  border-color: color-mix(in srgb, var(--ok) 32%, transparent);
}

.chip.t-face {
  color: #c3a6ff;
  background: color-mix(in srgb, #9b6dff 16%, transparent);
  border-color: color-mix(in srgb, #9b6dff 34%, transparent);
}

.chip.t-pose {
  color: #ffb27f;
  background: color-mix(in srgb, #ff8a3d 16%, transparent);
  border-color: color-mix(in srgb, #ff8a3d 34%, transparent);
}

.chip.t-zone {
  color: #ffd980;
  background: color-mix(in srgb, #f0b429 16%, transparent);
  border-color: color-mix(in srgb, #f0b429 34%, transparent);
}

.chip.t-count {
  color: #7fe3d4;
  background: color-mix(in srgb, var(--cyan) 14%, transparent);
  border-color: color-mix(in srgb, var(--cyan) 32%, transparent);
}

/*
 * 命中高亮（item 13）：检测到该类型的瞬间，标签整体提亮 + 轻微脉冲，
 * 5 秒后由 markHit 自动熄灭。这样「刚才那一帧到底是什么触发的报警」
 * 在画面上就有直接的视觉落点，不必去翻事件列表。
 */
.chip.hit {
  color: #fff;
  background: color-mix(in srgb, currentColor 34%, transparent);
  border-color: color-mix(in srgb, currentColor 70%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 45%, transparent),
    0 0 10px color-mix(in srgb, currentColor 55%, transparent);
  animation: chip-hit 0.55s ease-out;
  z-index: 2;
}

@keyframes chip-hit {
  0% {
    transform: scale(1);
  }
  35% {
    transform: scale(1.14);
  }
  100% {
    transform: scale(1);
  }
}

.alarm-tag {
  position: absolute;
  left: 10px;
  top: 38px;
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 7px;
  font-size: 12px;
  color: #fff;
  background: color-mix(in srgb, var(--err) 92%, transparent);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--err) 35%, transparent);
}

.alarm-tag .blink {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #fff;
  animation: blink 0.9s infinite;
}

.state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  z-index: 7;
  background: color-mix(in srgb, var(--bg-deep) 72%, transparent);
}

.state.eco {
  cursor: pointer;
  background: repeating-linear-gradient(
      -45deg,
      color-mix(in srgb, var(--panel-2) 55%, transparent),
      color-mix(in srgb, var(--panel-2) 55%, transparent) 14px,
      color-mix(in srgb, var(--panel) 75%, transparent) 14px,
      color-mix(in srgb, var(--panel) 75%, transparent) 28px
    );
}

.state.eco:hover {
  background: color-mix(in srgb, var(--panel-2) 88%, transparent);
}

.eco-icon {
  color: #5f7398;
}

.state.eco:hover .eco-icon {
  color: var(--accent-text-strong);
}

.tile.is-error .state {
  background: color-mix(in srgb, var(--err) 20%, var(--panel));
}

.state-msg {
  color: #a9b8d0;
  font-size: 13px;
  max-width: 84%;
  text-align: center;
  word-break: break-all;
}

.tile.is-error .state-msg {
  color: #ff8d99;
}

.spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.85s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.roi-hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 9px;
  font-size: 12px;
  color: #dbe6f5;
  background: color-mix(in srgb, var(--panel) 94%, transparent);
  border: 1px solid var(--line);
}

.icon-btn,
.drag-handle,
.move-grip {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--text-dim);
  transition: all 0.15s ease;
}

.icon-btn:hover,
.drag-handle:hover,
.move-grip:hover {
  color: #fff;
  background: color-mix(in srgb, var(--tint) 12%, transparent);
}

.move-grip {
  cursor: grab;
  color: var(--accent-text);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
}

.move-grip:active {
  cursor: grabbing;
}

/* ---------- 自定义摆放：拉伸手柄 ---------- */
.resize-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  z-index: 9;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  color: var(--accent-text);
  cursor: nwse-resize;
  opacity: 0.5;
  transition: opacity 0.15s ease;
}

.resize-handle:hover {
  opacity: 1;
  color: var(--accent-text-strong);
}

.tile.free {
  border-style: dashed;
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}

.tile.free:hover {
  border-color: color-mix(in srgb, var(--accent) 85%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
}

.tile.free .bar.bottom {
  opacity: 1;
  /* 同上：自定义摆放时要能点到右下角的排序手柄与拉伸角标 */
  z-index: 9;
}

/* ---------- 定位高亮（3 秒后由父组件移除 highlight） ---------- */
.tile.locating {
  border-color: var(--warn);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 85%, transparent), 0 0 34px color-mix(in srgb, var(--warn) 40%, transparent) inset;
  animation: locatePulse 0.6s ease-in-out 5;
  z-index: 8;
}

@keyframes locatePulse {
  50% {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 30%, transparent), 0 0 10px color-mix(in srgb, var(--warn) 12%, transparent) inset;
  }
}

.locate-tag {
  position: absolute;
  right: 10px;
  top: 38px;
  z-index: 9;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 7px;
  font-size: 12px;
  color: color-mix(in srgb, var(--warn) 18%, var(--panel));
  background: color-mix(in srgb, var(--warn) 95%, transparent);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--warn) 40%, transparent);
}

/* 播放器自愈徽标：故意做成小角标而不是蒙层 —— 自愈通常一两秒就完事，
   盖蒙层只会让大屏一闪一闪；徽标挂着不挡内容，断了 20 秒才升级成蒙层 */
.recover-tag {
  position: absolute;
  right: 10px;
  top: 38px;
  z-index: 8;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--warn-text);
  background: color-mix(in srgb, var(--bg-deep) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}

.recover-tag .r-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warn);
  animation: recover-pulse 1.1s ease-in-out infinite;
}

@keyframes recover-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.locate-tag .ring {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--warn) 18%, var(--panel));
  animation: blink 0.7s infinite;
}

.icon-btn.active {
  color: var(--accent-text-strong);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.drag-handle {
  cursor: grab;
}

.close-btn:hover {
  color: #fff;
  background: color-mix(in srgb, var(--err) 85%, transparent);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.pop-enter-active {
  transition: all 0.2s ease;
}

.pop-enter-from {
  opacity: 0;
  transform: translateY(-6px);
}

/* ================================================================== */
/*                    底部操作条 / 「更多」菜单                        */
/* ================================================================== */

.more-wrap {
  position: relative;
  display: inline-flex;
  pointer-events: auto;
}

/* 菜单挂在 body 上（teleport），所以是 fixed；z-index 要压过放大态画面(90)与顶栏 */
.more-pop {
  position: fixed;
  z-index: 640;
  min-width: 190px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 98%, transparent);
  border: 1px solid var(--line);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(6px);
}

.mi {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 12.5px;
  color: #cdd9ec;
  text-align: left;
  transition: background 0.14s ease;
  white-space: nowrap;
}

.mi:hover {
  background: color-mix(in srgb, var(--tint) 7%, transparent);
  color: #fff;
}

.mi em {
  margin-left: auto;
  font-size: 11px;
  font-style: normal;
  color: var(--text-dim-2);
}

.mi-ico {
  width: 15px;
  display: inline-flex;
  justify-content: center;
  color: #5f6f8a;
  font-size: 12px;
}

.mi-ico.on {
  color: var(--ok);
}

.mi.danger {
  color: var(--err-text);
}

.mi.danger .mi-ico {
  color: var(--err);
}

/* 通道级附加能力：缩进一级，视觉上从属于上面的「人形识别」 */
.mi.ext {
  padding-left: 22px;
  height: 31px;
  font-size: 12px;
  color: #b7c4d8;
}

.mi.ext.off {
  color: #7b8798;
}

.mi.ext.off em {
  color: #6c7788;
}

.mi-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--line-soft);
}

/* 顶部新增的两个状态小标签 */
.chip.blind {
  color: #c9b0ff;
  background: color-mix(in srgb, var(--purple) 16%, transparent);
  border-color: color-mix(in srgb, var(--purple) 32%, transparent);
}

.chip.mute {
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 14%, transparent);
  border-color: color-mix(in srgb, var(--warn) 32%, transparent);
}

.dot.pausedDot {
  background: var(--text-dim-2);
}

/* ================================================================== */
/*                          移动端 / 触屏适配                          */
/* ================================================================== */

/* 触屏没有 hover，底部工具条必须常显，否则手机上根本点不到按钮 */
@media (pointer: coarse) {
  .bar.bottom {
    opacity: 1;
    pointer-events: auto;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    touch-action: pan-x;
    /* 单列布局下按钮较多，允许横向滑动 */
    gap: 4px;
  }

  .bar.bottom::-webkit-scrollbar {
    display: none;
  }

  .icon-btn,
  .drag-handle {
    width: 34px;
    height: 34px;
    flex: 0 0 auto;
    border-radius: 9px;
  }

  .icon-btn:active,
  .drag-handle:active {
    background: color-mix(in srgb, var(--tint) 16%, transparent);
  }

  /* 圈选检测区域时，触摸拖动不能带动页面滚动 */
  .overlay.editing {
    touch-action: none;
  }

  /* 自定义摆放的两个手柄：触摸拖动期间锁定手势 */
  .move-grip,
  .resize-handle {
    touch-action: none;
    width: 34px;
    height: 34px;
  }

  /* 手机上尺寸信息容易挤压标题，藏起来（悬浮面板在触屏上也没意义） */
  .bar.top .info,
  .stats-wrap {
    display: none;
  }

  .blind-panel {
    min-width: 74%;
    padding: 14px 16px;
  }
}

/* 手机竖屏：放大主要操作（点击播放 / 重连按钮） */
@media (max-width: 640px) {
  .state .btn.small {
    height: 38px;
    padding: 0 16px;
    font-size: 14px;
  }

  .state-msg {
    font-size: 13px;
  }

  /* 全部屏时才铺满，普通格子里 inset 缩小一点 */
  .tile.zoomed {
    inset: calc(6px + var(--safe-top)) calc(6px + var(--safe-right))
      calc(6px + var(--safe-bottom)) calc(6px + var(--safe-left));
  }
}
</style>
