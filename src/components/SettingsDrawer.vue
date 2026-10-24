<template>
  <!--
    点遮罩空白处关闭。判定逻辑见 onMaskClick()：触屏上一次触摸可能产生不止一次 click，
    直接绑 @click.self 会让抽屉「闪一下就关」（iOS 必现），所以加了静默期 + 按下配对两道闸。
  -->
  <div class="mask sd-scope" @pointerdown.self="onMaskDown" @click.self="onMaskClick">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>监控配置</h2>
        <span class="head-sub">{{ currentTab.label }}</span>
        <span class="spacer"></span>
        <button class="icon-btn" title="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>
      </header>

      <div class="drawer-main">
        <nav class="tabs">
          <button
            v-for="t in TABS"
            :key="t.key"
            class="tab"
            :class="{ on: tab === t.key }"
            :title="t.desc"
            @click="tab = t.key"
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                :d="t.icon"
              />
            </svg>
            <span>{{ t.label }}</span>
            <em v-if="t.key === 'cams'">{{ cams.length }}</em>
            <em v-else-if="t.key === 'dingtalk'" :class="dt.enabled ? 'ok' : 'muted'">
              {{ dt.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'telegram'" :class="tg.enabled ? 'ok' : 'muted'">
              {{ tg.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'wecom'" :class="wc.enabled ? 'ok' : 'muted'">
              {{ wc.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'play'" :class="playBadgeClass">{{ playBadgeText }}</em>
            <!--
              ⚠️ 这个徽标必须读**全局**总开关（opts.statusAlerts / opts.patrol）。
              以前这里写的是 dt.statusAlerts / dt.patrol —— 那是「钉钉渠道是否接收」
              的子开关，于是出现「正文芯片写着未启用、页签却亮着 on」的自相矛盾：
              全局关着，渠道级却因为内置/初始化默认值是 true 而点亮。
            -->
            <em v-else-if="t.key === 'status'" :class="statusBadgeOn ? 'ok' : 'muted'">
              {{ statusBadgeOn ? 'on' : 'off' }}
            </em>
            <!--
              检测识别 / 后端检测两页也上 on/off 徽标：
              前者读本机「开启实时分析」（opts.analysisEnabled），后者读常驻服务开关
              （opts.backend.enabled）—— 这是**两件事**（本机跑 vs 服务端跑），
              必须各读各的，绝不共用同一个判据，否则会出现「本机页说 on、后端页也说 on」
              却只有一个在真正检测的假象。
            -->
            <em v-else-if="t.key === 'detect'" :class="opts.analysisEnabled ? 'ok' : 'muted'">
              {{ opts.analysisEnabled ? 'on' : 'off' }}
            </em>
            <!--
              拆出来的三页各读各自的总开关，绝不共用：
              区域规则看「进入/离开/徘徊」是否至少开了一项；
              人脸识别看 opts.face.enabled；人形姿态看 opts.pose.enabled。
              三项都还依赖「检测识别」页的 analysisEnabled + aiEnabled，
              所以总闸关掉时这里即便显示 on，也只是「预设为开、暂不生效」。
            -->
            <em v-else-if="t.key === 'zone'" :class="zoneAnyOn ? 'ok' : 'muted'">
              {{ zoneAnyOn ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'face'" :class="opts.face && opts.face.enabled ? 'ok' : 'muted'">
              {{ opts.face && opts.face.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'pose'" :class="opts.pose && opts.pose.enabled ? 'ok' : 'muted'">
              {{ opts.pose && opts.pose.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'backend'" :class="opts.backend && opts.backend.enabled ? 'ok' : 'muted'">
              {{ opts.backend && opts.backend.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'flow'" :class="flowTabOn ? 'ok' : 'muted'">
              {{ flowTabOn ? 'on' : 'off' }}
            </em>
          </button>
        </nav>

        <div class="drawer-body">
          <!-- 各分区已拆成独立子组件（见 ./settings/*Tab.vue）：只有当前页渲染，改任一选项不再重渲整页 -->
          <KeepAlive>
            <component :is="currentTabComp" />
          </KeepAlive>
        </div>
      </div>

      <footer class="drawer-foot">
        <button class="btn" @click="exportConfig">导出配置</button>
        <button class="btn" @click="pickFile">导入配置</button>
        <span class="spacer"></span>
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" @click="save">保存并应用</button>
        <input ref="fileEl" type="file" accept="application/json,.json" hidden @change="importConfig" />
      </footer>
    </aside>

    <!-- 待录入：点缩略图看捕获时的整帧原图（灯箱） -->
    <transition name="lb-fade">
      <div class="pending-shot-mask" v-if="pendingShot" @click.self="closePendingShot">
        <div class="pending-shot-box">
          <button class="pending-shot-close" @click="closePendingShot" title="关闭（Esc）">×</button>
          <img class="pending-shot-img" :src="pendingShot.full || pendingShot.thumb" alt="捕获时的原图" />
          <div class="pending-shot-cap">
            <span>{{ pendingShot.camName || '未知通道' }}</span>
            <span v-if="pendingShot.at"> · {{ fmtPendingAt(pendingShot.at) }}</span>
            <span v-if="pendingShot.name"> · 认成「{{ pendingShot.name }}」</span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, provide, reactive, ref, watch } from 'vue'
import '../styles/settings.css'
import {
  BRAND,
  BLOCK_MAX_AGE,
  camDigestState,
  camSilentState,
  clampDigestMinutes,
  cloneDefaultCameras,
  cloneDefaultOptions,
  cloneHiddenConfig,
  DEFAULT_BACKEND_URL,
  DEFAULT_CAM_DIGEST_CHANNELS,
  DEFAULT_CAM_SILENT_CHANNELS,
  DEFAULT_SILENT_CHANNELS,
  defaultCamDigest,
  defaultCamSilent,
  DIGEST_INTERVAL_CHOICES,
  DIGEST_INTERVAL_MAX,
  DIGEST_INTERVAL_MIN,
  FACE_QUALITY,
  digestCfgOf,
  digestIntervalLabel,
  silentYieldSlots,
  dayTypeOf,
  WEEK_MODES,
  matchSilentSlotAt,
  parseSilentSlots,
  HIDDEN_PASSCODE_HASH,
  syncChannelCameras,
  defaultFlow,
  flowValid,
  clampFlowWindowSec,
  FLOW_WINDOW_MIN,
  FLOW_WINDOW_MAX,
  FLOW_WINDOW_DEFAULT,
  FLOW_MAX_NODES,
  FLOW_FULL_ZONE,
  FLOW_FULL_ZONE_NAME
} from '../config/defaults'
import { SECRET_SCOPE } from '../config/auth'
import { secretDigest, secretMatches } from '../composables/sha256'
import { resetPushStats } from '../composables/usePushStats'
import {
  backendState,
  backendStateText,
  backendOn,
  backendStatus,
  backendWatchdog,
  deleteBackendTgWebhook,
  refreshBackendStatus,
  refreshBackendWatchdog,
  testBackendTgRemote
} from '../composables/useBackendEvents'
import { syncState, syncStateText, localRev, syncRev, pullState, pullError, pushOverwrote, pushFacesSkipped } from '../composables/useBackendSync'
import { refreshWatchStatus, watchState, watchStatusText } from '../composables/useWatchBridge'
import { confirmDialog, alertDialog } from '../composables/confirm.js'
import FaceAssignSelect from './FaceAssignSelect.vue'
import {
  AI_MODELS,
  aiBackend,
  aiCost,
  aiError,
  aiModel,
  aiState,
  loadPersonModel,
  releaseModel,
  setGpuPref
} from '../composables/useAiDetector'
import { FIELD_KEYS, buildAlarmMessage, fieldLabel, normalizeDingTalk, sendDingTalk } from '../composables/useDingTalk'
import {
  directPushEventOn as tgDirectEventOn,
  directPushRecipients as tgDirectRecipients,
  getBotInfo,
  getChatInfo,
  normalizeTelegram,
  sendTelegramText
} from '../composables/useTelegram'
import {
  normalizeWeCom,
  normalizeWeComWebhook,
  sendWeCom
} from '../composables/useWeCom'
import { parseMobiles } from '../composables/useAlertPush'
import { estimateUsage, formatBytes } from '../composables/useEventStore'
import { EVENT_DEFAULTS, EVENT_GROUPS } from '../composables/useAlarmText'
import { aiSlotBackend, aiSlotState } from '../composables/useAiDetector'
import { camExtOn } from '../composables/useAiExtras'
import { blockMergeThreshold, BLOCK_MERGE, HIT_MARGIN, hitMarginThreshold } from '../composables/vecMatch'
import {
  DEFAULT_FACE_MAX,
  DEFAULT_FACE_THRESHOLD,
  addFace,
  addFaceBlock,
  backendFaceHits,
  backendFaceHitsError,
  backendFaceHitsLoadedAt,
  backendPendingError,
  backendPendingFaces,
  backendPendingLoadedAt,
  addFaceSplits,
  clearFaces,
  clearPendingFaces,
  blockLibOpen,
  currentFaceBlocks,
  currentSplits,
  deleteFaces,
  dropBackendFaceHit,
  dropBackendPendingFace,
  enrollFromImage,
  faceBlocksVersion,
  faceLibOpen,
  faceRowsVersion,
  faceSplitsVersion,
  faceWriteErrKind,
  faceWriteTimeoutStreak,
  faces as faceLib,
  getAllFaces,
  groupFaces,
  GROUP_SIM_KEY,
  hitReviewOpen,
  loadBackendFaceHits,
  loadBackendPendingFaces,
  mergeFaces,
  pendingFaces,
  pendingLibOpen,
  planEvictOldest,
  rawFaceRows,
  readGroupSim,
  refreshFaces,
  removeFaceBlock,
  removePendingFace,
  renameFace,
  renameFaces,
  setPrimaryFace,
  clearPrimaryFace
} from '../composables/useFaceLib'
import { runtimeInfo, runtimeLine } from '../composables/useDeviceInfo'
import {
  BACKEND_LABEL as WAKE_BACKEND_LABEL,
  applyWakeLock,
  wakeLockState
} from '../composables/useWakeLock'
import {
  requestNotifyPermission,
  sysNotifyState,
  sysNotifySummary
} from '../composables/useSystemNotify'
import PushTemplatePanel from './PushTemplatePanel.vue'
import SelectField from './SelectField.vue'
import InfoTip from './InfoTip.vue'
import SilentSlotRow from './SilentSlotRow.vue'
/* 设置页各分区（自 v1.9 起拆成独立子组件）：父级 provide('sd', …) 下发全部状态/函数/emit，
 * 子组件 inject('sd') 同名解构，模板与逻辑零改动；好处是改某分区选项只重渲该子组件。 */
import CamsTab from './settings/CamsTab.vue'
import PlayTab from './settings/PlayTab.vue'
import AlertTab from './settings/AlertTab.vue'
import StatusTab from './settings/StatusTab.vue'
import DetectTab from './settings/DetectTab.vue'
import ZoneTab from './settings/ZoneTab.vue'
import FaceTab from './settings/FaceTab.vue'
import PoseTab from './settings/PoseTab.vue'
import FlowTab from './settings/FlowTab.vue'
import BackendTab from './settings/BackendTab.vue'
import TelegramTab from './settings/TelegramTab.vue'
import WecomTab from './settings/WecomTab.vue'
import DingtalkTab from './settings/DingtalkTab.vue'
import TemplatesTab from './settings/TemplatesTab.vue'
import MaskTab from './settings/MaskTab.vue'
import ProfilesTab from './settings/ProfilesTab.vue'
import MaintainTab from './settings/MaintainTab.vue'
import { sampleQualityLabel, SAMPLE_SCORE_RECOMMEND } from '../composables/faceSampleScore.js'
import { faceAttrText } from '../composables/faceAttr.js'

/*
 * ---------------- 下拉选项 ----------------
 * 原来这一堆选项是写在 <option :value> 上的，换成自绘下拉后挪到这儿成常量数组：
 * 数组本身不变（避免每次渲染都新建同一个数组），value 的类型与写进配置的完全一致
 * （数字就是数字，不能 "3" 和 3 混着比）。
 */
const OPT_AUTO_PLAY = [
  { value: 0, label: '不自动播放' },
  { value: 1, label: '仅第一路' },
  { value: 2, label: '前 2 路' },
  { value: 4, label: '前 4 路' },
  { value: 99, label: '全部' },
  { value: 'custom', label: '自定义…' }
]

const OPT_MAX_DECODE = [
  { value: 1, label: '1 路' },
  { value: 2, label: '2 路' },
  { value: 4, label: '4 路' },
  { value: 6, label: '6 路' },
  { value: 9, label: '9 路' },
  { value: 0, label: '不限制' },
  { value: 'custom', label: '自定义…' }
]

const OPT_SHOT_WIDTH = [
  { value: 0, label: '原图（最清晰，推荐）' },
  { value: 2560, label: '超清 2560px' },
  { value: 1920, label: '高清 1920px' },
  { value: 1280, label: '标清 1280px' },
  { value: 960, label: '省空间 960px' }
]

const OPT_MOTION_LEVEL = [
  { value: 0.3, label: '1 档 · 极轻微（0.3%）' },
  { value: 1, label: '2 档 · 轻微（1%）' },
  { value: 2.5, label: '3 档 · 一般（2.5%）' },
  { value: 5, label: '4 档 · 明显（5%）' },
  { value: 10, label: '5 档 · 剧烈（10%）' }
]

const OPT_SAMPLE_FPS = [
  { value: 1, label: '1 帧 / 秒' },
  { value: 2, label: '2 帧 / 秒' },
  { value: 3, label: '3 帧 / 秒' },
  { value: 5, label: '5 帧 / 秒' }
]

const OPT_CONFIRM_FRAMES = [
  { value: 1, label: '1 帧' },
  { value: 2, label: '2 帧' },
  { value: 3, label: '3 帧' }
]

const OPT_AI_INTERVAL = [
  { value: 1000, label: '1 秒' },
  { value: 2000, label: '2 秒' },
  { value: 3000, label: '3 秒' },
  { value: 5000, label: '5 秒' },
  { value: 10000, label: '10 秒' }
]

const OPT_LOITER_RADIUS = [
  { value: 0.04, label: '很小（4%）· 几乎站定' },
  { value: 0.08, label: '小（8%）· 推荐' },
  { value: 0.15, label: '中（15%）· 小范围踱步' },
  { value: 0.25, label: '大（25%）· 宽松' }
]

const AI_MODELS_AS_OPTIONS = AI_MODELS.map((m) => ({ value: m.key, label: m.label }))

/* ---------------- 人员流向（跨摄像头走向）配置辅助 ---------------- */
const OPT_FLOW_WINDOW = [
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 120, label: '2 分钟（默认）' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' }
]

/** 摄像头下拉项：只列「已启用」（未隐藏）的摄像头，避免选到被隐藏的通道 */
const camOptions = computed(() =>
  cams.value.filter((c) => !hidden.value.includes(c.id)).map((c) => ({ value: c.id, label: c.name || c.id }))
)

/** 人员流向判定 / 区域下拉所用的摄像头清单（取 props.cameras 这个权威源，实时反映区域增删） */
const flowCams = computed(() =>
  Array.isArray(props.cameras) && props.cameras.length ? props.cameras : cams.value
)

/**
 * 某摄像头下的区域下拉项；没选摄像头时给空数组（SelectField 显示占位文字）。
 * 「画面全区域」永远在第一位：不圈选也能配流向 —— 整幅画面的「出现 / 离开」即进出。
 */
function zoneOptions(camId) {
  const cam = flowCams.value.find((c) => c.id === camId)
  if (!cam) return []
  const full = { value: FLOW_FULL_ZONE, label: `画面全区域（不圈选，整幅画面）` }
  const zones = Array.isArray(cam.zones) ? cam.zones.map((z) => ({ value: z.id, label: z.name || z.id })) : []
  return [full, ...zones]
}

/** 该摄像头是否真的圈过区域（决定「去圈选」提示是否显示；全区域选项不算） */
function camHasZones(camId) {
  const cam = flowCams.value.find((c) => c.id === camId)
  return !!(cam && Array.isArray(cam.zones) && cam.zones.length)
}

/** 新增一条默认流向（默认 2 节点：起点 → 终点） */
function addFlow() {
  if (!Array.isArray(opts.flows)) opts.flows = []
  opts.flows.push(defaultFlow())
}

/** 删除第 i 条流向 */
function removeFlow(i) {
  if (Array.isArray(opts.flows)) opts.flows.splice(i, 1)
}

/** 在 path 末尾加一个途经点（支持 A→B→C 多跳），受 FLOW_MAX_NODES 上限约束 */
function addFlowNode(flow) {
  if (!Array.isArray(flow.path)) flow.path = [{ cam: '', zone: '' }, { cam: '', zone: '' }]
  if (flow.path.length >= FLOW_MAX_NODES) return
  flow.path.push({ cam: '', zone: '' })
}

/** 删除 path 第 ni 个节点（至少保留 2 个） */
function removeFlowNode(flow, ni) {
  if (Array.isArray(flow.path) && flow.path.length > 2) flow.path.splice(ni, 1)
}

/** 单条流向的有效性判定（与引擎共用一份 flowValid） */
function flowStateOf(flow) {
  return flowValid(flow, flowCams.value)
}

/** 顶部状态条：生效数 / 启用数，以及是否有启用但无效的 */
const flowSummary = computed(() => {
  const list = Array.isArray(opts.flows) ? opts.flows : []
  const enabled = list.filter((f) => f.enabled)
  const okCount = enabled.filter((f) => flowValid(f, flowCams.value).valid).length
  const hasBad = enabled.length > okCount
  return {
    text: `${okCount}/${enabled.length} 条生效`,
    enabled: enabled.length > 0,
    ok: okCount > 0 && !hasBad
  }
})

/** 页签 on/off 徽标：存在「已启用且有效」的流向才算 on */
const flowTabOn = computed(() => {
  const list = Array.isArray(opts.flows) ? opts.flows : []
  return list.some((f) => f.enabled && flowValid(f, flowCams.value).valid)
})

/**
 * 「区域规则」页签的 on/off 徽标：进入 / 离开 / 徘徊 至少开一项才算 on。
 * 只陈述「这一页的规则有没有开」，不代表此刻真的会报警 ——
 * 还要叠加「检测识别」页的人形识别与通道级区域开关（那是另一层，见各条 hint）。
 */
const zoneAnyOn = computed(() => {
  const z = opts.zone || {}
  return !!(z.enterAlarm || z.exitAlarm || z.loiterAlarm)
})

const props = defineProps({
  cameras: { type: Array, required: true },
  options: { type: Object, required: true },
  hiddenIds: { type: Array, default: () => [] },
  layouts: { type: Array, default: () => [] },
  layoutKey: { type: String, default: 'auto' },
  /** 是否跑在 Capacitor 原生壳里（iOS App 为 true），决定「自动」主题档是否展示 */
  native: { type: Boolean, default: false },
  /** 报警事件列表，「关于系统」页要用它统计条数与未读数 */
  events: { type: Array, default: () => [] },
  /** 打开抽屉时希望落在哪一页（如 'status' = 状态巡检）；不传则用上次停留的页 */
  openTab: { type: String, default: '' },
  /** 临时静默状态（App 每秒回传，item 112） */
  tempSilent: { type: Object, default: () => ({ active: false }) }
})

const emit = defineEmits([
  'close',
  'save',
  'reset',
  'patrol',
  'update:layoutKey',
  'update-cameras',
  'update-keepawake',
  'force-exit',
  'watch-sync',
  'backend-sync',
  'pull-backend',
  'flush-silent',
  'test-pre-silent',
  'test-post-silent',
  'restart-system',
  /* 临时静默（item 112） */
  'start-temp-silent',
  'end-temp-silent'
])

/* ---------- Apple Watch ---------- */
/**
 * 手表端只做「看事件」，所以这里不需要任何配置项 —— 配对了、装了 App 就自动同步。
 * 设置页只负责两件事：把当前连接状态说清楚（不然用户会反复怀疑"是不是没生效"），
 * 以及给一个手动同步按钮（改完配置想立刻推一次）。
 */
const watchChip = computed(() => {
  if (!watchState.supported) return '不支持'
  if (!watchState.activated) return '连接中'
  if (!watchState.paired) return '未配对'
  if (!watchState.installed) return '手表未安装'
  return watchState.reachable ? '在线' : '离线'
})

function refreshWatch() {
  void refreshWatchStatus()
}

/* ---------- 屏幕常亮 ---------- */
/**
 * 同样即时生效、不走「保存」按钮 —— 常亮是个「按下去就该立刻看到效果」的开关，
 * 让用户按保存才生效会很别扭（而且他没法立刻判断有没有生效）。
 * 真正的申请逻辑在 useWakeLock 里，这里只负责把意图转发上去 + 展示实时状态。
 */
function toggleKeepAwake() {
  opts.keepAwake = !opts.keepAwake
  emit('update-keepawake', opts.keepAwake)
}

/** 一句话状态：让用户知道「开关是开的」≠「真的生效了」 */
const wakeLine = computed(() => {
  if (!opts.keepAwake) return '已关闭'
  const s = wakeLockState
  if (s.active) return `已生效 · ${WAKE_BACKEND_LABEL[s.backend] || '未知后端'}`
  if (s.supported === false) return '⚠️ 当前环境不支持'
  if (s.error) return `⚠️ ${s.error}`
  return '待生效（切回页面后自动申请）'
})

const wakeCls = computed(() => {
  if (!opts.keepAwake) return 'off'
  if (wakeLockState.active) return 'ok'
  return 'warn'
})

/** 系统通知的状态徽标（复用 wake-state 三色样式） */
const notifyCls = computed(() => {
  if (!opts.alert.desktopNotify) return 'off'
  const p = sysNotifyState.permission
  if (p === 'granted') return 'ok'
  return 'warn'
})

/* ---------- 遮罩关闭 ---------- */
/**
 * 「点遮罩空白处关闭」在触屏上有两个坑，都表现为「抽屉闪一下就没了」：
 *   1) 一次触摸可能产生不止一次 click（触屏抖动、以及 touchend 之后浏览器合成的
 *      click）。第一次 click 把抽屉打开，第二次就落在刚刚铺满全屏的遮罩上 ——
 *      于是立刻又被关掉。桌面鼠标不抖，所以这个问题只在手机 / iPad 上必现。
 *   2) 从抽屉内部按下滑到遮罩上再抬手，也会被算成「点了遮罩」。
 *
 * 所以这里加两道闸：打开后 400ms 静默期 + 要求按下与抬手属于同一次交互。
 * 注：头部 X 按钮和底部「取消」是用户的明确意图，不走这里，不受静默期影响。
 */
const OPEN_GUARD_MS = 400
const openedAt = Date.now()
let maskDownAt = 0

function onMaskDown() {
  maskDownAt = Date.now()
}

function onMaskClick() {
  const now = Date.now()
  // 闸门 1：刚打开的一小段时间内忽略遮罩点击（挡掉触屏重复 click）
  if (now - openedAt < OPEN_GUARD_MS) return
  // 闸门 2：按下过、但离得太久 —— 说明是从抽屉里拖出来在遮罩上抬手的，
  //        不算「点遮罩」。注意这里用 `maskDownAt &&` 而不是 `!maskDownAt ||`：
  //        某些环境（触摸模拟、部分内嵌 WebView）压根不派发 pointerdown，
  //        若把「没按下」也判成非法，遮罩就永远关不掉了。
  if (maskDownAt && now - maskDownAt > 1200) return
  emit('close')
}

/* ---------- 分类导航 ---------- */
/** 通道级推送开关的三个渠道（顺序 = 展示顺序） */
const CAM_CHANNELS = [
  { key: 'ding', label: '钉钉' },
  { key: 'wecom', label: '企业微信' },
  { key: 'tg', label: 'Telegram' }
]

/*
 * 页签顺序 = 使用动线，刻意按「先画面/性能 → 再看报警链路 → 再钻进检测细节 → 收尾维护」排：
 *   ① 监控通道 / 播放性能           —— 最常动的两页（加通道、调解码），必须最先够到
 *   ② 报警提醒 / 状态巡检           —— 「什么时候响、怎么响」，接着就是它
 *   ③ 检测识别 → 区域规则 → 人脸识别 → 人形姿态 —— 「拿什么判定」；
 *      原来这四块全挤在一页（人脸一块就 800+ 行），现在按模块拆成独立大标签，
 *      顺序按「零额外算力 → 中等 → 最吃算力」排，各自带 on/off 徽标
 *   ③' 人员流向 / 后端检测          —— 建立在上面的识别能力之上；本机 vs 服务端成对出现
 *   ④ 三个推送渠道 → 推送模板       —— 「发去哪、长什么样」，渠道按 TG / 企微 / 钉钉
 *   ⑤ 隐私遮罩 / 配置方案         —— 低频与整体方案；
 *      「外观布局」已移出为独立抽屉（顶栏设置下拉进入）
 *   ⑥ 系统维护                     —— 收尾维护；
 *      「关于系统 / 数据统计」已移出为独立「系统信息」抽屉（顶栏设置下拉进入），
 *      这里只留「要动手的东西」
 */
const TABS = [
  {
    key: 'cams',
    label: '监控通道',
    desc: '增删通道、改名称与流地址、开关检测',
    icon: 'M3.5 7.5A2 2 0 0 1 5.5 5.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2zM14.5 10.5l6-3.2v9.4l-6-3.2z'
  },
  {
    key: 'play',
    label: '播放性能',
    desc: '解码、自动播放路数、性能保护',
    icon: 'M7 4.8l12 7.2-12 7.2zM4 4v16'
  },
  {
    key: 'alert',
    label: '报警提醒',
    desc: '通知、声音、自动放大',
    icon: 'M6 9a6 6 0 1 1 12 0v4.5l1.6 2.6H4.4L6 13.5zM10 18.5a2 2 0 0 0 4 0'
  },
  {
    key: 'status',
    label: '状态巡检',
    desc: '通道异常推送与定时巡检报告',
    icon: 'M3 12h4l2.5-6 4 12 2.5-6h5'
  },
  {
    key: 'detect',
    label: '检测识别',
    desc: '移动检测、人形识别与推理设置',
    icon: 'M4 18a9 9 0 0 1 16 0M7.5 18a5.5 5.5 0 0 1 9 0M12 18h.01'
  },
  /*
   * 以下三页原来都挤在「检测识别」里（人脸一块就 800+ 行），纵向翻查极累。
   * 拆成独立大标签：入口一眼可见、各自带 on/off 徽标，页签顺序仍按依赖关系排 ——
   * 区域规则（不额外吃算力）→ 人脸识别 → 人形姿态（最吃算力）。
   */
  {
    key: 'zone',
    label: '区域规则',
    desc: '走入 / 走出 / 徘徊：基于人形轨迹，零额外算力',
    icon: 'M4 6.5h16v11H4zM8.5 10.5h7v4h-7z'
  },
  {
    key: 'face',
    label: '人脸识别',
    desc: '人脸检测、特征比对、本地人脸库与待录入队列',
    icon: 'M12 4.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6M4.6 20a7.4 7.4 0 0 1 14.8 0'
  },
  {
    key: 'pose',
    label: '人形姿态',
    desc: '跌倒 / 举手 / 蹲下 / 站立等动作识别',
    icon: 'M12 3.8a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4M12 7.4v6.2m0 0l-3.2 5.4M12 13.6l3.2 5.4M7 10.2l5 1.1 5-1.1'
  },
  /* 人员流向（跨摄像头走向）紧跟检测识别：它建立在人形轨迹 / 人脸之上，依赖上面的识别能力 */
  {
    key: 'flow',
    label: '人员流向',
    desc: '跨摄像头人员走向：谁从哪路去了哪路',
    icon: 'M4 12h12M13 7l5 5-5 5M20 6v12'
  },
  /* 后端检测紧跟检测识别：两者是「同一件事跑在哪」的两种选择，必须成对出现、挨着看 */
  {
    key: 'backend',
    label: '后端检测',
    desc: '常驻后端服务：本机页面关了也在检测与推送',
    icon: 'M4 5.5h16v5H4zM4 13.5h16v5H4zM7.5 8h.01M7.5 16h.01M17 8h.01M17 16h.01'
  },
  {
    key: 'telegram',
    label: 'TG 推送',
    desc: 'Telegram 机器人：文字 + 报警截图上传',
    icon: 'M21.5 4.5L2.8 11.6c-.9.35-.86 1.6.05 1.9l4.2 1.35 1.6 4.9c.28.86 1.4.98 1.87.2l2.3-3.9 4.5 3.3c.72.53 1.75.14 1.94-.73z'
  },
  {
    key: 'wecom',
    label: '企微推送',
    desc: '企业微信群机器人：markdown + 直接发截图',
    icon: 'M4 5.5h16A1.5 1.5 0 0 1 21.5 7v8a1.5 1.5 0 0 1-1.5 1.5h-7.2L8 20.5v-4H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5zM7.5 10h9M7.5 13h5'
  },
  {
    key: 'dingtalk',
    label: '钉钉推送',
    desc: '机器人凭据、推送内容与频率限制',
    icon: 'M21 4L3 11l7 2.5L12.5 21z'
  },
  {
    key: 'templates',
    label: '推送模板',
    desc: '三端报警消息的自定义排版与实时预览',
    icon: 'M4 5h16v11H8l-4 4zM8 9h8M8 12h5'
  },
  {
    key: 'mask',
    label: '隐私遮罩',
    desc: '一键盖住大屏、解锁密码',
    icon: 'M3 12s3.5-6 9-6c1.3 0 2.5.3 3.5.8M21 12s-3.5 6-9 6c-1.3 0-2.5-.3-3.5-.8M4 20L20 4'
  },
  {
    key: 'profiles',
    label: '配置方案',
    desc: '多套配置保存 / 切换 / 导入导出',
    icon: 'M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 4v5h5M8 13h8M8 17h5'
  },
  {
    key: 'maintain',
    label: '系统维护',
    desc: '流自愈（持续异常自动恢复）与定时重启系统',
    icon: 'M12 4v3M12 17v3M4 12H1M23 12h-3M5.6 5.6 3.5 3.5M20.5 20.5l-2.1-2.1M18.4 5.6l2.1-2.1M3.5 20.5l2.1-2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'
  },
]

const tab = ref('cams')
/** 重启诊断数据（后端模式下由 /api/restart-status 拉取） */
const restartInfo = ref(null)
// 切到「报警提醒」时顺手刷一次手表状态：抽屉是常驻组件，
// 只在打开时查一次的话，用户中途配对好手表再切过来看到的还是旧状态。
watch(tab, (t) => {
  if (t === 'alert') refreshWatch()
  // 切到「系统维护」时拉一次重启诊断，「上次重启到底怎么样了」一眼可见
  if (t === 'maintain') refreshRestartInfo()
})

/*
 * 允许外部把抽屉直接切到某一页。
 * 场景：事件面板「通道状态」标签里点「配置异常推送」——
 * 那组开关（是否推异常、要不要推恢复、多久重提醒、三个渠道各自收不收）
 * 藏在「状态巡检」页里，靠用户自己翻页签找到它的概率很低。
 */
watch(
  () => props.openTab,
  (t) => {
    if (t) tab.value = t
  },
  { immediate: true }
)
const currentTab = computed(() => TABS.find((t) => t.key === tab.value) || TABS[0])
/** 当前页签 → 子组件（「关于系统」「外观布局」已移出为独立抽屉，见 SystemInfoDrawer.vue / AppearanceDrawer.vue） */
const TAB_COMPS = {
  cams: CamsTab,
  play: PlayTab,
  alert: AlertTab,
  status: StatusTab,
  detect: DetectTab,
  zone: ZoneTab,
  face: FaceTab,
  pose: PoseTab,
  flow: FlowTab,
  backend: BackendTab,
  telegram: TelegramTab,
  wecom: WecomTab,
  dingtalk: DingtalkTab,
  templates: TemplatesTab,
  mask: MaskTab,
  profiles: ProfilesTab,
  maintain: MaintainTab
}
const currentTabComp = computed(() => TAB_COMPS[tab.value] || CamsTab)

const cams = ref([])
// 深拷贝一份，未点「保存」前不影响正在运行的播放器
const opts = reactive(JSON.parse(JSON.stringify({ ...cloneDefaultOptions(), ...props.options })))

/* ==================== 静默时段（免打扰推送） ==================== */
/* 本地实时时钟：让「当前状态」文案每秒刷新（距离静默结束还有多久） */
const nowTs = ref(Date.now())
let _silentTick = null
onMounted(() => {
  _silentTick = setInterval(() => (nowTs.value = Date.now()), 30000)
  /*
   * 人脸库**打开设置页就加载**，不要等用户点「管理」。
   *
   * `faces` 这个 ref 是模块级的，但只有 `refreshFaces()` 会填它，而原先只有
   * 「管理」按钮的 watch 会调 —— 于是刚打开设置页时标题写的是
   * 「人脸库（0 / 50）」、名单是空的。用户看到的是**底库丢了**，
   * 而不是"还没加载"（没有任何加载中状态，就是干干净净的 0）。
   *
   * 抽屉是 `v-if`，每次打开都会重新挂载 —— 所以这里挂一次就等价于
   * "每次打开设置页都刷一次"，正好也是我们想要的时效性。
   */
  refreshFaces().catch(() => {})
})
onUnmounted(() => {
  if (_silentTick) clearInterval(_silentTick)
})

const CH_LABELS = { ding: '钉钉', wecom: '企业微信', tg: 'TG' }

/**
 * 工作日历：保证 opts.calendar 字段齐全（老存档可能没有），之后直接读写 opts.calendar。
 * 与静默时段的升级 watch 同理，放在这里就地补，避免渲染期写状态。
 */
watch(
  () => opts.calendar,
  (c) => {
    if (!c || typeof c !== 'object') {
      opts.calendar = { weekMode: 'double', customRestDays: [0, 6], alternateAnchor: '2026-01-05', holidays: [], makeups: [] }
      return
    }
    if (!Array.isArray(c.holidays)) c.holidays = []
    if (!Array.isArray(c.makeups)) c.makeups = []
    if (!Array.isArray(c.customRestDays)) c.customRestDays = [0, 6]
    if (!WEEK_MODES.some((w) => w.id === c.weekMode)) c.weekMode = 'double'
    if (typeof c.alternateAnchor !== 'string' || !c.alternateAnchor) c.alternateAnchor = '2026-01-05'
  },
  { immediate: true }
)
const cal = computed(() => opts.calendar)
const WEEKDAYS = [
  { id: 0, label: '周日' }, { id: 1, label: '周一' }, { id: 2, label: '周二' },
  { id: 3, label: '周三' }, { id: 4, label: '周四' }, { id: 5, label: '周五' }, { id: 6, label: '周六' }
]
const holidayInput = ref('')
const makeupInput = ref('')
function _isIsoDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || '')
}
function addHoliday() {
  const v = (holidayInput.value || '').trim()
  if (!_isIsoDate(v) || cal.value.holidays.includes(v)) return
  cal.value.holidays.push(v)
  holidayInput.value = ''
}
function removeHoliday(i) {
  cal.value.holidays.splice(i, 1)
}
function addMakeup() {
  const v = (makeupInput.value || '').trim()
  if (!_isIsoDate(v) || cal.value.makeups.includes(v)) return
  cal.value.makeups.push(v)
  makeupInput.value = ''
}
function removeMakeup(i) {
  cal.value.makeups.splice(i, 1)
}
/** 今天的工作日 / 放假日类型（含原因），用于设置页预览 */
const todayDayType = computed(() => {
  const dt = dayTypeOf(new Date(), cal.value)
  const LABEL = { weekday: '工作日', weekend: '周末', holiday: '法定假日', makeup: '调休补班（上班）' }
  return { type: dt.type, label: LABEL[dt.reason] || dt.type }
})

const silentActiveNow = computed(() => {
  const c = opts.silent
  if (!c || !c.enabled) return false
  // 用与引擎同源的 matchSilentSlotAt：含跨零点 + 多时段 + 作用域（工作日/放假日）过滤
  return !!matchSilentSlotAt(parseSilentSlots(c), nowTs.value, cal.value)
})
/**
 * 「运行设备」悬浮说明（item 107）。
 * runtimeLine 是一整行「网页端 · Chrome 120 · macOS 14.2 · 192.168.x.x · 2560×1440」，
 * 直接塞进原生 title 气泡会被挤成窄高一条。改成按 ' · ' 拆行展示。
 */
const runtimeTipText = computed(() => {
  const info = runtimeInfo(BRAND)
  const head = `运行环境：${info.label}`
  const parts = String(info.detail || '')
    .split(' · ')
    .map((s) => s.trim())
    .filter(Boolean)
  return [head, ...parts.map((p) => `· ${p}`), '', '这一行会写进每条推送消息，用来分辨是哪个端发出的'].join('\n')
})

/* ---------------- 静默时段列表（item 114：支持多时段） ---------------- */
/**
 * 老配置只有 silent.start / silent.end（单时段）：初次打开时**就地**把它收口成
 * slots 数组。这样下面的时间输入框 v-model 直接绑在真实配置对象上，改完
 * 「保存并应用」才会真正落盘（之前返回的是新拷贝，改了也白改、再打开还是旧的）。
 * 只在缺 slots 时补一次；之后 slots 是唯一数据源。
 */
watch(
  () => opts.silent,
  (s) => {
    if (!s) return
    if (!Array.isArray(s.slots) || s.slots.length === 0) {
      s.slots = [
        {
          start: s.start != null ? String(s.start) : '19:00',
          end: s.end != null ? String(s.end) : '08:00',
          scope: 'all'
        }
      ]
    }
  },
  { immediate: true }
)

/**
 * 直接返回真实的 slots 数组（引用稳定）。
 * 时间输入框 v-model 原地改 opts.silent.slots[i].start / .end，
 * 保存即生效；也避免每次渲染都生成新对象导致输入框失焦、「点不灵敏」。
 */
const slotsOf = computed(() =>
  opts.silent && Array.isArray(opts.silent.slots) ? opts.silent.slots : []
)

/**
 * 点时间输入框任意位置都弹出原生选择器（桌面端默认只有小箭头能点开，
 * 监控大屏触屏上特别「点不灵敏」）。
 *
 * ⚠️ 必须挂在 **mousedown** 而不是 click：
 *   浏览器自己会在 mousedown 的默认动作里弹选择器，而 click 是 mouseup 之后才触发的。
 *   在 click 里再调 showPicker()，等于和浏览器「已经弹了一半」的原生流程撞车 ——
 *   要么抛 InvalidStateError 被吞掉、要么等原生流程自己收尾，表现为「点完很久才弹」。
 *   在 mousedown 里 preventDefault() 接管默认行为，再自己 showPicker()，才是即时的。
 *   （mousedown 上 preventDefault 会连带阻止自动聚焦，所以要手动 focus 一下。）
 */
function openPicker(e) {
  const el = e && e.target
  if (!el || typeof el.showPicker !== 'function') return
  // 同一次按压只弹一次：mousedown 之后再补一道 click 兜底（部分浏览器只派发 click）
  if (el.__pickerOpened) return
  try {
    e.preventDefault()
  } catch (_) {
    /* 忽略 */
  }
  el.focus()
  el.__pickerOpened = true
  // 下一个手势再允许弹（用 setTimeout 0 避开本次按压后续派发的事件）
  setTimeout(() => {
    el.__pickerOpened = false
  }, 0)
  try {
    el.showPicker()
  } catch (_) {
    /* 不支持 / 被策略拦截时退回普通聚焦，用户点小箭头仍可选 */
  }
}

/* 敏感字段（token / webhook / secret / chatId 等）默认以密码框遮罩，
 * 点眼睛图标临时显示，避免旁人瞥见凭据。每个字段独立开关。 */
const revealed = reactive({
  dtWebhook: false,
  dtSecret: false,
  // 关键事件独立机器人（钉钉 / 企微各一个独立 webhook，钉钉另含加签密钥）
  dtCritWebhook: false,
  dtCritSecret: false,
  wcCritWebhook: false,
  tgToken: false,
  tgChat: false,
  tgGroup: false,
  wcWebhook: false,
  maskPwd: false
})

/** 把 slots 写回配置；老字段 start/end 同步为首个时段，兼容旧版本读取 */
function persistSlots(list) {
  if (!opts.silent) opts.silent = {}
  opts.silent.slots = list.map((s) => ({
    start: s.start,
    end: s.end,
    scope: s.scope === 'workdays' || s.scope === 'restdays' ? s.scope : 'all'
  }))
  const first = opts.silent.slots[0]
  if (first) {
    opts.silent.start = first.start
    opts.silent.end = first.end
  }
}

function addSlot() {
  const list = [...slotsOf.value]
  // 新时段默认给一个明显不同的区间（午休 12:00~13:00），避免和已有时段重叠
  list.push({ start: '12:00', end: '13:00', scope: 'all' })
  persistSlots(list)
}

function removeSlot(i) {
  if (slotsOf.value.length <= 1) return
  const list = slotsOf.value.filter((_, x) => x !== i)
  persistSlots(list)
}

/** 当前命中的是哪个时段（用于提示"当前生效：夜里 19:00~08:00"） */
const activeSlotLabel = computed(() => {
  const c = opts.silent
  if (!c || !c.enabled) return ''
  // 与引擎同源：含跨零点 + 作用域（工作日/放假日）过滤
  const hit = matchSilentSlotAt(parseSilentSlots(c), Date.now(), cal.value)
  if (!hit) return ''
  const p2 = (n) => String(n).padStart(2, '0')
  const fmt = (ms) => {
    const x = new Date(ms)
    return `${p2(x.getHours())}:${p2(x.getMinutes())}`
  }
  return `${fmt(hit.startMs)} ~ ${hit.crossDay ? '次日 ' : ''}${fmt(hit.endMs)}`
})

const silentStatusText = computed(() => {
  const c = opts.silent
  if (!c || !c.enabled) return '未开启'
  const ch = (c.channels || []).map((id) => CH_LABELS[id] || id)
  // 把所有时段都列出来，别只显示第一个
  const slots = slotsOf.value
  const slotsLabel = slots.length ? slots.map((s) => `${s.start}~${s.end}`).join('、') : '无'
  const base = `静默渠道：${ch.length ? ch.join(' / ') : '无'}（${slotsLabel}）`
  if (!silentActiveNow.value) return `未进入静默 · ${base}`

  /*
   * 静默中：算「距离结束点还有多久」。
   * 与引擎同源（matchSilentSlotAt，含跨零点 + 作用域过滤 + 取最晚结束），
   * 否则显示的剩余时间会跟实际推送时刻对不上。
   */
  const hit = matchSilentSlotAt(parseSilentSlots(c), nowTs.value, cal.value)
  if (!hit) return `静默中 · ${base}`
  const leftMs = Math.max(0, hit.endMs - nowTs.value)
  const diffMin = Math.round(leftMs / 60000)
  const hh = Math.floor(diffMin / 60)
  const mm = diffMin % 60
  const dur = hh ? `${hh} 小时 ${mm} 分` : `${mm} 分`
  const p2 = (n) => String(n).padStart(2, '0')
  const x = new Date(hit.endMs)
  const endText = `${hit.crossDay ? '次日 ' : ''}${p2(x.getHours())}:${p2(x.getMinutes())}`
  return `静默中 · 将于 ${endText} 自动推送结束提醒 + 汇总（约 ${dur} 后）· ${base}`
})
function flushSilentNow() {
  emit('flush-silent')
}

/** 试发一条「免打扰已开启」提醒（调完文案先看一眼效果） */
function testPreSilence() {
  emit('test-pre-silent')
}

/** 试发一条「免打扰已结束」提醒（不动真实缓冲，随便点都不会丢事件） */
function testPostSilence() {
  emit('test-post-silent')
}

/* ---------------- 临时静默（item 112） ---------------- */

/** 快捷时长（小时） */
const TEMP_HOURS = [0.5, 1, 2, 4, 8]
const TEMP_CHANNEL_OPTS = [
  { id: 'ding', label: '钉钉' },
  { id: 'wecom', label: '企微' },
  { id: 'tg', label: 'TG' }
]

/**
 * 「远程静默指令默认静默哪些渠道」（TG 推送 → 远程控制 → 可用指令）。
 *
 * 直接读配置里的 `telegram.remote.silentChannels`，不另存一份到组件状态 ——
 * 界面上勾一下、手机上发条 /silent，走的就是同一个值，
 * 不会出现「界面上勾了却不生效」这种两头不认账的情况。
 *
 * ⚠️ 这里**不**把空数组当"没配"：空 = 用户明确一个都不勾（远程指令会拒绝执行），
 * 界面上如实显示成"一个都没勾"才对。当成"没配"再填回默认值，
 * 就等于用户取消勾选反而静默了默认的两个渠道 —— 正是要避免的那种反直觉。
 */
const remoteSilentChannels = computed(() => {
  const r = opts.telegram && opts.telegram.remote
  return r && Array.isArray(r.silentChannels) ? r.silentChannels : []
})

/**
 * 读「默认渠道」的兜底值：只有字段缺失（老存档）才用内置默认；
 * 显式空数组照原样返回，不替换。
 */
function readRemoteDefaultChannels() {
  const r = opts.telegram && opts.telegram.remote
  const cfg = r && r.silentChannels
  return Array.isArray(cfg) ? cfg.slice() : [...DEFAULT_SILENT_CHANNELS]
}

function toggleRemoteSilentChannel(id) {
  const r = opts.telegram && opts.telegram.remote
  if (!r) return
  const cur = Array.isArray(r.silentChannels) ? r.silentChannels : []
  r.silentChannels = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
}

const tempHours = ref(1)
/** 'hours' 按小时 | 'until' 指定到几点 */
const tempMode = ref('hours')
/**
 * datetime-local 的值，形如 2026-10-07T08:00。
 * 初值给「明天早上 08:00」—— 空着的话用户切到这个模式还得自己挑，
 * 而"静默到明天早上"恰好是最常用的意图。
 */
const tempUntilLocal = ref('')
const tempLabel = ref('')
/**
 * 本次手动开启临时静默要静默哪几端。
 *
 * 初值 = 上面那份「远程静默默认渠道」，同一个概念不该让用户配两遍还不一致。
 * 抽屉是 v-if 挂载的（见 App.vue），每次打开都会重新取一次 ——
 * 所以这是"打开时的默认"，而不是组件生命周期里一次性定死的快照。
 */
const tempChannels = ref(readRemoteDefaultChannels())
/** 临时静默是否正在生效（由 App 通过 temp-silent prop 回传） */
const tempActive = computed(() => !!props.tempSilent.active)
const tempInfo = computed(() => props.tempSilent || { active: false })

/** 生成本地 datetime 字符串（datetime-local 控件要的就是这个格式，且不能用 toISOString——那是 UTC） */
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 快捷预设：明天早上 08:00 / 今晚 24:00 */
const tomorrowMorning = computed(() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return toLocalInput(d)
})
const tonightMidnight = computed(() => {
  const d = new Date()
  d.setHours(24, 0, 0, 0)
  // setHours(24) 会溢出到次日 00:00，正好就是"今晚 24:00"
  return toLocalInput(d)
})

// 预填「明天早上 08:00」：切到"静默到几点"时就能直接点开启
tempUntilLocal.value = tomorrowMorning.value

/** 把 datetime-local 的值转成时间戳；空值返回 0 */
function tempUntilTs() {
  if (!tempUntilLocal.value) return 0
  const t = new Date(tempUntilLocal.value).getTime()
  return Number.isFinite(t) ? t : 0
}

/** 预估结束时刻提示，让人点之前就知道会静默到什么时候 */
const tempPreview = computed(() => {
  if (tempMode.value === 'until') {
    const t = tempUntilTs()
    if (!t) return '请选择一个结束时间'
    if (t <= Date.now()) return '结束时间需要晚于当前时间'
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    const span = t - Date.now()
    // 分钟先进位到小时，否则 2h59m 会显示成 "2 小时 60 分"
    const totalMin = Math.round(span / 60000)
    const hh = Math.floor(totalMin / 60)
    const mm = totalMin % 60
    const how = hh ? `${hh} 小时 ${mm} 分` : `${mm} 分`
    return `将静默至 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes()
    )}（约 ${how} 后）`
  }
  const h = Number(tempHours.value) || 0
  if (!h) return '请选择时长'
  const d = new Date(Date.now() + h * 3600000)
  const p = (n) => String(n).padStart(2, '0')
  return `将静默至今天/明天 ${p(d.getHours())}:${p(d.getMinutes())}`
})

function toggleTempChannel(id) {
  const i = tempChannels.value.indexOf(id)
  if (i >= 0) tempChannels.value = tempChannels.value.filter((x) => x !== id)
  else tempChannels.value = [...tempChannels.value, id]
}

function startTempNow() {
  emit('start-temp-silent', {
    hours: Number(tempHours.value) || 0,
    channels: tempChannels.value.slice(),
    label: tempLabel.value.trim(),
    // 'until' 模式传绝对时间戳；'hours' 模式传 0 走时长分支
    untilAt: tempMode.value === 'until' ? tempUntilTs() : 0
  })
}

function endTempNow(flush) {
  emit('end-temp-silent', !!flush)
}

/** 设置页「立即重启系统」按钮：交给 App.vue 决定走 Electron 原生重启还是后端 API */
function restartSystemNow() {
  emit('restart-system')
  // 顺手盯一下结果：后端会先释放端口，前几秒请求失败是预期行为
  pollRestartResult()
}

/* ---------------- 重启诊断（后端模式） ---------------- */

function backendBase() {
  return String((props.options.backend && props.options.backend.url) || '').replace(/\/+$/, '')
}

/** 是否启用了后端检测服务（数据库在后端服务器上，才能导出 monitor.db） */
const backendEnabled = computed(
  () => !!(props.options.backend && props.options.backend.enabled && props.options.backend.url)
)

/** 重启结果码 → 人话 */
function restartResultText(r) {
  const map = {
    ok: '成功（新进程已接管端口）',
    'rollback-ok': '失败，但已自动回滚（服务未中断）',
    'rollback-failed': '失败且回滚失败（服务已停止）',
    storm: '被「重启风暴保护」拦下（连续失败过多次）',
    busy: '已有一次重启在进行中'
  }
  if (!r) return '暂无记录'
  return map[r] || String(r)
}

function fmtRestartTime(ts) {
  try {
    return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false })
  } catch (e) {
    return ''
  }
}

/**
 * 待录入人脸卡片底部展示的「捕获时间」。
 * 卡片只有 88px 宽，不能塞整条 toLocaleString，这里压成紧凑格式：
 *   - 今天 → 只显示 `HH:mm:ss`（最关心的是"刚抓到还是几小时前"）；
 *   - 跨天 → 补上 `M-D`，变成 `M-D HH:mm:ss`，仍能一眼分清是哪天的。
 * 入参是 ms 时间戳（前端 pushPendingFace 与后端 store.listPendingFaces 都给的是这个）。
 */
function fmtPendingAt(ts) {
  const d = new Date(Number(ts))
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hms = d.toLocaleTimeString('zh-CN', { hour12: false })
  return sameDay ? hms : `${d.getMonth() + 1}-${d.getDate()} ${hms}`
}

async function refreshRestartInfo() {
  const base = backendBase()
  if (!base) {
    // 本地模式（浏览器直跑 / 桌面端）没有后端可问，不必显示成错误
    restartInfo.value = { ok: false }
    return null
  }
  try {
    const r = await fetch(`${base}/api/restart-status`)
    const data = await r.json()
    restartInfo.value = { ok: true, ...data }
    return restartInfo.value
  } catch (e) {
    restartInfo.value = { ok: false, error: (e && e.message) || '网络错误' }
    return null
  }
}

/**
 * 重启后轮询结果。
 * 后端重启会先释放端口，所以前几秒请求失败是**预期行为**而不是错误。
 * 用 lastAt 判断「这条记录是不是本次重启产生的」，免得读到上一次的旧结果。
 */
let restartPolling = false
async function pollRestartResult() {
  if (restartPolling || !backendBase()) return
  restartPolling = true
  const sentAt = Date.now()
  const deadline = sentAt + 90000
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const data = await refreshRestartInfo()
      if (data && Number(data.lastAt) >= sentAt - 2000) return
    }
  } finally {
    restartPolling = false
  }
}

/* ==================== 配置补齐 ==================== */
/**
 * 顶层是浅合并，后加进来的配置块（face / pose / zone）如果老存档里存在、
 * 但缺字段，就会整块带着 undefined 进来。这里按默认值补齐嵌套字段。
 */
const _DEFAULTS = cloneDefaultOptions()
;['face', 'pose', 'zone'].forEach((k) => {
  opts[k] = { ..._DEFAULTS[k], ...(opts[k] || {}) }
})
opts.pose.actions = { ..._DEFAULTS.pose.actions, ...(opts.pose.actions || {}) }
// 老存档里没有 backend 块时补齐（默认 enabled:false，行为不变）
opts.backend = { ..._DEFAULTS.backend, ...(opts.backend || {}) }

/* ==================== 后端检测服务（headless） ==================== */
const backendTesting = ref(false)

/** 切换后端检测总开关（enabled 的 watch 在 App.vue 里，这里只改配置） */
function toggleBackend() {
  if (!opts.backend) opts.backend = { ..._DEFAULTS.backend }
  opts.backend.enabled = !opts.backend.enabled
  // 刚打开时地址多半是空的（老配置里没有这个字段）→ 直接填上那台常驻设备的地址，
  // 省得用户还要去翻 IP。填错了也还能手动改。
  if (opts.backend.enabled && !String(opts.backend.url || '').trim()) {
    opts.backend.url = DEFAULT_BACKEND_URL
  }
  // 打开瞬间主动探测一次，让状态文本立刻有反馈
  if (opts.backend.enabled && opts.backend.url) onBackendTest()
}

/** 手动刷新一次服务状态快照 */
async function onBackendTest() {
  if (backendTesting.value) return
  if (!opts.backend || !opts.backend.url) return
  backendTesting.value = true
  try {
    // 一次刷新把两份快照都拿回来：服务本身（/api/status）+ 状态哨兵（/api/watchdog）
    await Promise.all([refreshBackendStatus(opts), refreshBackendWatchdog(opts)])
  } finally {
    backendTesting.value = false
  }
}

/** 后端通道状态 → 中文（与后端 STATE_LABEL 同口径，这里只取短词） */
function stateTextOf(state) {
  switch (state) {
    case 'playing':
      return '正常'
    case 'error':
      return '异常'
    case 'connecting':
      return '连接中'
    case 'closed':
      return '已关闭'
    default:
      return '未接入'
  }
}

/** 「还有多久」倒计时（下次巡检时间用） */
function formatCountdown(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000))
  if (s < 60) return `${s} 秒后`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟后`
  return `${(m / 60).toFixed(1)} 小时后`
}

/* ---------- 待录入人脸（后端链路） ----------
 * ⚠️ 这三个声明必须排在下面那个 immediate watcher 之前 ——
 * watcher 带 immediate:true 会在 setup 期间同步执行回调，
 * 引用到后面才初始化的 const 会直接抛 TDZ 错误（faceBackendOn before initialization）。 */

/** 后端检测服务是否接管（决定待录入人脸从哪来） */
const faceBackendOn = computed(() => !!(opts.backend && opts.backend.enabled && opts.backend.url))

/**
 * 「待录入」列表 = 前端自己检测到的 + 后端检测到的。
 *
 * 两种模式下来源不同，但**必须都显示**，否则会出现「抓到了人脸却没进库」：
 *   - 纯前端链路 → 前端检测写进内存队列（pendingFaces）
 *   - 后端链路   → 后端检测写进它自己的 SQLite（backendPendingFaces）
 * 之前只读前端那份，后端模式下永远是空的。
 */
const allPendingFaces = computed(() =>
  faceBackendOn.value ? [...backendPendingFaces.value, ...pendingFaces.value] : [...pendingFaces.value]
)

/**
 * 待录入排序：默认「按时间」—— 用户要在这堆抓拍里核对现场顺序（谁先谁后到），
 * 时间线连续比「哪张画质好」更要紧；画质信息交给每张卡上的 ★/评分标签，
 * 挑样本时用户自己会看，不需要默认把好样本顶到前面、把时间线打乱。
 *
 * 「按样本质量」可选切换：把分高的排前面、未评分（老行，采集时没拿到几何量）
 * 垫底 —— 「不知道」不该被摆在「知道很差」前面冒充好样本。
 */
const pendingSort = ref(
  (() => {
    try {
      return localStorage.getItem('pendingSort') === 'score' ? 'score' : 'time'
    } catch (e) {
      return 'time'
    }
  })()
)
function togglePendingSort() {
  pendingSort.value = pendingSort.value === 'score' ? 'time' : 'score'
  try {
    localStorage.setItem('pendingSort', pendingSort.value)
  } catch (e) {}
  // 排序换了，页码回到第一页（否则可能停在一个看起来没变的页上）
  pendingPage.value = 1
}

const sortedPendingFaces = computed(() => {
  const list = allPendingFaces.value.slice()
  if (pendingSort.value !== 'score') {
    /*
     * 时间优先：显式按捕获时间倒序，别原样返回。
     * 后端那份本来就是 ORDER BY at DESC、前端那份是 unshift（新的在前），
     * 但后端模式下是「后端 + 前端」拼起来的，拼完并不全局有序 ——
     * 原样返回会让「时间优先」在混合队列里变成"两段各自有序"，
     * 用户看到的时间线是断的。排一次不贵（队列 ≤ 200）。
     */
    return list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
  }
  // 稳定排序：同分按时间倒序（新抓的在前）
  return list.sort((a, b) => {
    const sa = Number(a.score)
    const sb = Number(b.score)
    const ua = !Number.isFinite(sa) || sa < 0
    const ub = !Number.isFinite(sb) || sb < 0
    if (ua !== ub) return ua ? 1 : -1 // 未评分永远垫底
    if (!ua && !ub && sa !== sb) return sb - sa
    return (Number(b.at) || 0) - (Number(a.at) || 0)
  })
})

/** 一条待录入的质量标签。score < 0 = 未评分（老行 / 采集时没拿到几何量），
 *  不能显示成「差」—— 那是把「不知道」说成「很差」，用户会白扔一批好样本。 */
function pfQuality(pf) {
  const s = Number(pf && pf.score)
  if (!Number.isFinite(s) || s < 0) return { key: 'unknown', text: '未评分', tone: 'muted' }
  return sampleQualityLabel(s)
}

/** 评分明细（鼠标悬停看）：三个分项各自的物理量，不是只有一个黑箱分数 */
function pfScoreTip(pf) {
  const s = Number(pf && pf.score)
  if (!Number.isFinite(s) || s < 0) return '这条是早期抓的，没记下画质指标 —— 按时间排序可找到它'
  const parts = []
  if (pf.boxW && pf.boxH) parts.push(`人脸 ${pf.boxW}×${pf.boxH}px`)
  parts.push(`清晰度 ${Math.round(Number(pf.sharp) || 0)}`)
  const yaw = Math.abs(Number(pf.yaw) || 0)
  parts.push(`偏航 ${yaw.toFixed(2)}${yaw > 0.35 ? '（侧脸）' : ''}`)
  if (pf.frameW && pf.frameH) parts.push(`原帧 ${pf.frameW}×${pf.frameH}`)
  const q = pfQuality(pf)
  return `样本质量 ${q.text}（${s.toFixed(2)}）· ${parts.join(' · ')}`
}

/** 是否达到「建议先录」线（低于它的大概率是侧脸/糊脸/太小） */
function pfRecommended(pf) {
  const s = Number(pf && pf.score)
  return Number.isFinite(s) && s >= 0 && s >= SAMPLE_SCORE_RECOMMEND
}

/*
 * 待录入 / 命中卡片的属性徽标直接用 faceAttrText（见文件顶部的 import）。
 * 50% 阈值和「墨镜优先于眼镜」这类判定只在 faceAttr.js 一份 ——
 * 两处各写一份的话，迟早出现「卡片上写着口罩、统计里没算他一顶」。
 */

/** 刷新待录入：加载态 + 结果提示（以前点下去毫无反馈，用户不知道有没有生效） */
const pendingRefreshing = ref(false)
const pendingRefreshNote = ref('')

/** 拉一次后端待录入队列（后端模式下人脸是在服务端抓的） */
async function refreshBackendPending() {
  if (!faceBackendOn.value || pendingRefreshing.value) return
  pendingRefreshing.value = true
  pendingRefreshNote.value = ''
  try {
    await loadBackendPendingFaces(opts.backend.url)
    if (backendPendingError.value) {
      pendingRefreshNote.value = `刷新失败：${backendPendingError.value}`
    } else {
      const n = backendPendingFaces.value.length
      const t = new Date(backendPendingLoadedAt.value || Date.now()).toLocaleTimeString('zh-CN')
      pendingRefreshNote.value = `已刷新 · ${n} 张 · ${t}`
    }
  } finally {
    pendingRefreshing.value = false
  }
}

/**
 * 「待录入」为空时的占位文案。
 *
 * 四种"空"的原因完全不同，给的下一步动作也完全不同，所以必须分开说 ——
 * 合成一句「暂无数据」等于什么都没解释：
 *   ① 后端开着但这次没拉上 → 说清是网络/超时问题，并提示列表**没被清空**；
 *   ② 没开「收集陌生人脸」      → 这是最常见的一类，直接指到那个开关；
 *   ③ 后端开着、确实没人未录入  → 告诉他抓取在后端，稍等或点刷新；
 *   ④ 纯前端链路、确实没人      → 说明暂存规则（只留最近若干张、不落盘）。
 */
const pendingEmpty = computed(() => {
  if (faceBackendOn.value && backendPendingError.value) {
    const stale = backendPendingLoadedAt.value
      ? `（下面这份是 ${new Date(backendPendingLoadedAt.value).toLocaleTimeString('zh-CN')} 拿到的）`
      : ''
    return {
      icon: '⚠️',
      title: '待录入队列没能拉回来',
      hint: `${backendPendingError.value}${stale}。拉取失败不会清空已有列表，点下方「刷新待录入」重试即可。`
    }
  }
  if (!opts.face.collectUnknown) {
    return {
      icon: '⚪',
      title: '「收集陌生人脸」是关着的',
      hint: '打开它，检测到没录入的人就会先暂存在这里，方便事后一键建档。'
    }
  }
  if (faceBackendOn.value) {
    return {
      icon: '📭',
      title: '后端暂未抓到未录入的人脸',
      hint: '跑检测的是后端服务（人脸是在服务端抓的），抓到就会出现在这里；刚重启或刚改过配置时，稍等一会儿点「刷新待录入」。'
    }
  }
  return {
    icon: '📭',
    title: '还没有暂存任何陌生人脸',
    hint: '等摄像头拍到没录入的人，脸会先暂存在这里 —— 只留最近 24 张，且不落盘，重启后就没有了。'
  }
})

/* ---------- 命中修正（后端链路） ----------
 * 「命中修正」列表 = 后端检测服务每次认出库里的人时存下的样本
 * （向量 + 当时认定的名字 + 相似度 + 原图，store.addHitFace）。
 * 只有后端模式下有内容：前端自己跑检测时不落这份样本。 */
const hitRefreshing = ref(false)
const hitRefreshNote = ref('')
const hitAssign = reactive({}) // h.id -> '' | 已知名字 | '__custom__'
const hitCustom = reactive({}) // h.id -> 自定义正确名字文本
const fixingHit = reactive({}) // h.id -> bool（修正进行中）

/** 拉一次后端命中样本（后端模式下识别是在服务端跑的） */
async function refreshBackendFaceHits() {
  if (!faceBackendOn.value || hitRefreshing.value) return
  hitRefreshing.value = true
  hitRefreshNote.value = ''
  try {
    await loadBackendFaceHits(opts.backend.url)
    if (backendFaceHitsError.value) {
      hitRefreshNote.value = `刷新失败：${backendFaceHitsError.value}`
    } else {
      const n = backendFaceHits.value.length
      const t = new Date(backendFaceHitsLoadedAt.value || Date.now()).toLocaleTimeString('zh-CN')
      hitRefreshNote.value = `已刷新 · ${n} 条 · ${t}`
    }
  } finally {
    hitRefreshing.value = false
  }
}

/** 把下拉 + 自定义框解析成「正确名字」；'' = 还没选 */
function hitAssignName(h) {
  const a = hitAssign[h.id]
  if (a === '__custom__') return (hitCustom[h.id] || '').trim()
  return a || ''
}
/** 卡片被修正 / 忽略后清掉它占用的选择状态，别留 stale key */
function clearHitAssign(h) {
  delete hitAssign[h.id]
  delete hitCustom[h.id]
}

/**
 * 修正一条命中样本：把它的向量按**正确名字**录进人脸库。
 *
 * 为什么这能提升精准度：matchFace 是「余弦相似度找最像的样本」——
 * 同一张脸在库里同时有「小刘」「大刘」两个标签的样本时，谁分数高就报谁。
 * 按正确名字补一条同 vectors 的样本后，这张脸对正确名字的分数被抬上去，
 * 后续命中就会落到对的人名下。样本录完即从后端删除（使命完成）。
 *
 * ⚠️ 必须走前端 addFace：前端人脸库是 source of truth，会随配置推送
 *    自动同步覆盖后端；后端自己 addFace 会被下一次同步整体替换掉，白录。
 */
async function doFixHit(h) {
  if (!h || fixingHit[h.id]) return
  const name = hitAssignName(h)
  if (!name) {
    alertDialog({
      title: '还没选名字',
      message: '先在下拉里选这个人的正确名字（或选「自定义」填一个），再点「修正」。',
      variant: 'default'
    })
    return
  }
  if (name === h.name) {
    alertDialog({
      title: '名字没变',
      message: `选的名字和当前认成的「${h.name}」一样，修正它没有意义 —— 要提升精准度，请选成另一个人（或自定义成对的名字）。`,
      variant: 'default'
    })
    return
  }
  fixingHit[h.id] = true
  try {
    const res = await addFace(h.vector, h.thumb, name, Number(opts.face.libMax) || 50)
    if (!res.ok) {
      alertDialog({ title: '修正失败', message: res.reason || '录入失败', variant: 'danger' })
      return
    }
    // 与待录入同口径：落库成功后本地乐观移除卡片，后端删除放后台异步跑
    clearHitAssign(h)
    dropBackendFaceHit(opts.backend.url, h.backendId) // 故意不 await
    delete fixingHit[h.id] // 落库即解锁，不等网络
  } catch (e) {
    // 同 doAddPending：超时可能只是"已写入、刷新没跟上"，先核实这张脸是否已入库
    const landed = await verifyVectorLanded(h.vector)
    if (landed) {
      clearHitAssign(h)
      dropBackendFaceHit(opts.backend.url, h.backendId) // 故意不 await
      return
    }
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '修正超时' : '修正失败',
      message: faceWriteFailMessage(e, '这条样本还在列表里，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete fixingHit[h.id]
  }
}

/** 忽略一条命中样本（不想修正也不想再看到它） */
function doIgnoreHit(h) {
  if (!h) return
  dropBackendFaceHit(opts.backend.url, h.backendId)
  clearHitAssign(h)
}

/**
 * 忽略当前列出的全部命中样本（不修正、不标记反例，仅从列表移除）。
 * 危险操作（批量删样本、不可撤销），先二次确认。
 * dropBackendFaceHit 内部会按 backendId 过滤掉列表项并后台发删除请求，
 * 这里用进入循环前的快照遍历，避免边删边迭代响应式数组出问题。
 */
async function doIgnoreAllHits() {
  const list = backendFaceHits.value
  if (!list.length) return
  const ok = await confirmDialog({
    title: '全部忽略？',
    message: `将忽略当前列出的 ${list.length} 条命中样本（不修正、也不标记反例，仅从列表移除）。忽略后这些样本即被删掉，要再修正就得等新的命中进来。`,
    okText: '全部忽略',
    variant: 'danger'
  })
  if (!ok) return
  for (const h of list) dropBackendFaceHit(opts.backend.url, h.backendId)
  // 清掉本地选择态，避免留下 stale key
  for (const k of Object.keys(hitAssign)) delete hitAssign[k]
  for (const k of Object.keys(hitCustom)) delete hitCustom[k]
  hitRefreshNote.value = `已忽略全部（${list.length} 条）`
}

/**
 * 把一条命中样本标成「认错」（陌生人反例）。
 *
 * 为什么「忽略」不够：忽略只是把样本从列表删掉，库内样本与这张陌生脸的
 * 余弦依然过高，下次照认。反例把这条脸的向量存下来（addFaceBlock），
 * 匹配时「反例分 ≥ 阈值且 ≥ 库内最像分」即判未录入 —— 同一张脸再来
 * 直接走待录入/陌生人路径。库里真人本人不受影响。
 *
 * 与修正同一套规矩：必须走前端 addFaceBlock（前端 IndexedDB 是 source of
 * truth，随配置同步覆盖后端；后端直接写会被下一次同步替换掉，白标）。
 */
async function doMarkStranger(h) {
  if (!h || fixingHit[h.id]) return
  if (!h.vector || !h.vector.length) {
    alertDialog({
      title: '没法标记',
      message: '这条样本没有可用的特征向量（可能是旧版本后端存的），换个样本或先刷新命中。',
      variant: 'default'
    })
    return
  }
  fixingHit[h.id] = true
  try {
    // 传合并阈值（options.face.blockMergeThreshold）：同一个人反复被认错时
    // 只给已有那条 count+1，不再往库里插新条
    const res = await addFaceBlock({
      vector: h.vector,
      thumb: h.thumb,
      name: h.name || '',
      mergeThreshold: blockMergeThreshold(opts.face)
    })
    if (!res.ok) {
      alertDialog({ title: '标记失败', message: res.reason || '写入反例失败', variant: 'danger' })
      return
    }
    // 与修正同口径：本地落库成功后乐观移除卡片，后端删除放后台异步跑
    clearHitAssign(h)
    dropBackendFaceHit(opts.backend.url, h.backendId) // 故意不 await
    delete fixingHit[h.id] // 落库即解锁，不等网络
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '标记超时' : '标记失败',
      message: faceWriteFailMessage(e, '这条样本还在列表里，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete fixingHit[h.id]
  }
}

/** 解除一条陌生人标记（之后这张脸重新参与正常匹配） */
async function doUnmarkStranger(b) {
  if (!b) return
  try {
    await removeFaceBlock(b.id)
  } catch (e) {
    alertDialog({ title: '解除失败', message: ((e && e.message) || e), variant: 'danger' })
  }
}

/**
 * 「陌生人标记」列表（轻量，去掉向量）。
 * 依赖 faceBlocksVersion：反例增删后缓存刷新会自增它，这里才会重算。
 * 按误认次数（count）从高到低排序 ——×N 不再是装饰，而是「待处理优先级」：
 * 一个陌生人被反复误认成库里某人，说明它制造的误命中噪声最大，越靠前越该处理
 * （确认是常客就录入人脸库、确是陌生人就保持反例拦截）。
 */
const strangerMarks = computed(() => {
  void faceBlocksVersion.value
  return currentFaceBlocks()
    .map((b) => ({
      id: b.id,
      thumb: b.thumb || '',
      name: b.name || '',
      at: b.at || 0,
      // 合并计数：同一个陌生人被"认错"了多少回（老存档没有这个字段 → 1）
      count: Math.max(1, Math.round(Number(b.count)) || 1)
    }))
    .sort((a, b) => b.count - a.count)
})

/**
 * 反例合并阈值的滑杆显示值。
 * 只读解析、**不回写配置**：老存档没有 `blockMergeThreshold` 字段时，
 * 滑杆显示默认 0.6，但配置里仍然是「没配」—— 由 blockMergeThreshold()
 * 在真正用到的前端后两端各自解析。用户拖一下滑杆才落成具体数字。
 */
const mergeThresholdShown = computed(() => {
  const raw = opts.face.blockMergeThreshold
  if (raw === undefined || raw === null || raw === '') return BLOCK_MERGE.th.def
  const n = Number(raw)
  if (!Number.isFinite(n)) return BLOCK_MERGE.th.def
  return Math.max(0, Math.min(BLOCK_MERGE.th.max, n))
})

/**
 * 「命中修正」为空时的占位文案。
 * 三种"空"的原因完全不同，必须分开说：
 *   ① 后端开着但这次没拉上 → 网络/超时问题，列表**没被清空**，点刷新重试；
 *   ② 「命中已录入人脸时报警」关着 → 后端根本不发已知命中事件，也就没有样本；
 *   ③ 确实还没有命中 → 说明样本从哪来、什么时候会出现。
 */
const hitEmpty = computed(() => {
  if (backendFaceHitsError.value) {
    const stale = backendFaceHitsLoadedAt.value
      ? `（下面这份是 ${new Date(backendFaceHitsLoadedAt.value).toLocaleTimeString('zh-CN')} 拿到的）`
      : ''
    return {
      icon: '⚠️',
      title: '命中样本没能拉回来',
      hint: `${backendFaceHitsError.value}${stale}。拉取失败不会清空已有列表，点下方「刷新命中」重试即可。`
    }
  }
  if (!opts.face.eventOnKnown) {
    return {
      icon: '⚪',
      title: '「命中已录入人脸时报警」是关着的',
      hint: '打开它，识别到库里的人才会留下命中样本，也才能在这里修正「认错了人」。'
    }
  }
  return {
    icon: '📭',
    title: '后端还没有命中样本',
    hint:
      '跑检测的是后端服务，识别到库里的人后，这里会出现最近 20 条样本（带原图）。刚启动或刚录完人脸库时，稍等一会儿点「刷新命中」。' +
      '如果是陌生人被误认成了某人（而不是库里的真人被认错了名字），点卡片上的「认错」把它标成反例，之后同一张脸再来会直接判未录入。'
  }
})

/**
 * 抽屉一打开（或后端刚连上）就把状态哨兵快照拉回来。
 * 后端模式下掉线监控与定时巡检都在服务端，用户打开设置最想看的就是
 * 「它到底在不在盯、下次什么时候发报告」——不该还要手动点刷新。
 */
watch(
  () => [backendState.value, opts.backend && opts.backend.enabled],
  () => {
    if (backendState.value === 'polling' && !backendWatchdog.value) refreshBackendWatchdog(opts)
    // 后端模式下未录入人脸是在服务端抓的，进「人脸识别」页就把待录入队列拉回来，
    // 否则用户看到的是空列表，以为「抓到的脸没进库」
    if (faceBackendOn.value) {
      refreshBackendPending()
      // 命中样本同理：后端识别到库里的人才会留下可修正的样本，进页就拉一次
      refreshBackendFaceHits()
    }
  },
  { immediate: true }
)

/**
 * 手动把整份配置推给后端。
 * 真正的打包（options + cameras + 人脸库）在 App.vue 里 —— 那边才拿得到 cameras
 * 和 IndexedDB 里的人脸库，这里只负责发出请求，并顺手刷新一次状态显示。
 */
function onBackendSync() {
  emit('backend-sync')
  onBackendTest()
}

/** 从后端整体拉一份配置回来（覆盖本机前 App.vue 会先确认一次） */
function onBackendPull() {
  emit('pull-backend')
}

/*
 * 「本机版本 / 后端版本」两个数字，以及"本机落后了"这个结论。
 * 两个 rev 的语义完全不同，别混：
 *   localRev = 本机这份配置对应后端的哪个版本（落盘，只有真的推/拉成功才变）；
 *   syncRev  = 后端当前版本（轮询 /api/status 就会被刷新）。
 * 用 syncRev 当"本机版本"会让落后判定永远成立 —— 自己一推完就"落后"了。
 */
const localRevText = computed(() => (localRev.value > 0 ? `rev ${localRev.value}` : '未对齐'))
const syncRevText = computed(() => (syncRev.value > 0 ? `rev ${syncRev.value}` : '—'))
const behindBackend = computed(() => localRev.value > 0 && syncRev.value > localRev.value)

/* ==================== 通道级附加能力（人脸 / 姿态 / 区域） ==================== */
/**
 * 和「人脸识别 / 人形姿态 / 区域规则」三个页签的全局开关是**两层**控制：
 *   全局开着 + 本通道开着 → 这一路才真的跑。
 * 这里管的是"这一路要不要参与"，目的是把算力集中到真正在看的那几路上。
 */
const EXT_ITEMS = [
  { key: 'face', label: '人脸', globalLabel: '人脸识别' },
  { key: 'pose', label: '姿态', globalLabel: '人形姿态' },
  { key: 'zone', label: '区域', globalLabel: '区域规则' },
  { key: 'enterExit', label: '进出', globalLabel: '走入/走出' }
]

/** 区域规则没有单一总开关（由进出 / 徘徊 / 计数几个子项决定），只有人脸和姿态要看全局 */
function extGlobalOn(key, cam) {
  // 走入/走出 与区域规则同族：通道先开区域规则才谈得上进出捕获
  if (key === 'enterExit') return camExtOn(cam, 'zone')
  if (key === 'zone') return true
  const g = opts[key]
  return !!(g && g.enabled)
}

function camExtTitle(cam, e) {
  if (!cam.ai) return `先开启这一路的「人形识别」——${e.globalLabel}建立在人形检测之上`
  if (!camExtOn(cam, e.key)) return `这一路目前不参与${e.globalLabel}，点击恢复`
  if (!extGlobalOn(e.key, cam)) {
    return e.key === 'enterExit'
      ? `先开启这一路的「区域规则」（更多操作 → 区域规则），走入/走」才会生效`
      : `「${e.globalLabel}」的全局总开关还没开（在左侧「${e.globalLabel}」页），这里只是预设这一路是否参与`
  }
  return `点击让这一路不再跑${e.globalLabel}（省这一路的算力）`
}

/** 翻转这一路的附加能力（cams 是直接改对象的，跟上面 motion / ai 的写法保持一致） */
function toggleCamExt(cam, key) {
  if (!cam.ai) return
  const cur = cam.aiExt || {}
  cam.aiExt = {
    face: cur.face !== false,
    pose: cur.pose !== false,
    zone: cur.zone !== false,
    enterExit: cur.enterExit !== false,
    // 保留历史 aiExt.hit 字段（旧存档可能有），它现在是无害的残留，不再参与推送判定
    hit: cur.hit === true,
    [key]: cur[key] === false
  }
}


/* ==================== 推送渠道联动 ==================== */
/*
 * 补齐三个渠道的旧配置字段。
 *
 * ⚠️ 这里必须在 setup 阶段一次做完，**绝不能放进 computed**：
 *    normalizeDingTalk / normalizeWeCom 内部的补齐是「无条件赋值」写法
 *    （dt.events = normalizeEvents(events)，每次都产生一个新对象）。
 *    在 computed 里做的话，求值时读了 opts.xxx、又写了 opts.xxx.events，
 *    就会变成「求值 → 自己的依赖失效 → 再求值 → 再写」的死循环。
 *    Vue 会直接抛 "Maximum recursive updates exceeded"，表现为
 *    手机端打开设置抽屉「闪一下就没了」。
 *    顺带一提：所有标签页用的是 v-show，抽屉一打开全部模板都要渲染，
 *    所以这里的任何抖动都会被放大。
 */
if (opts.dingtalk) normalizeDingTalk(opts.dingtalk)
if (opts.wecom) normalizeWeCom(opts.wecom)
if (opts.telegram) normalizeTelegram(opts.telegram)

/*
 * 兜底：确保「关键事件独立机器人」子块存在。
 * 正常路径下 App 载入时 fillMissingOptions 已经补齐，但抽屉可能拿到一份
 * 尚未迁移的老 options（或首次渲染早于迁移）；缺了它，下面的 v-model
 * 会直接写 undefined.critical.webhook 报错。默认值取自同一份 defaults.js。
 */
{
  const _def = cloneDefaultOptions()
  if (opts.dingtalk && !opts.dingtalk.critical) {
    opts.dingtalk.critical = JSON.parse(JSON.stringify(_def.dingtalk.critical))
  }
  if (opts.wecom && !opts.wecom.critical) {
    opts.wecom.critical = JSON.parse(JSON.stringify(_def.wecom.critical))
  }
}

/** 钉钉 / 企业微信只要有一个开着，Telegram 就必须开着（它承载图片与原图链接） */
const tgForced = computed(() => !!opts.dingtalk.enabled || !!opts.wecom.enabled)

function setTgEnabled(v) {
  // 被强制开启时不允许关掉，否则另外两个渠道会失去图片与原图入口
  if (tgForced.value && !v) return
  opts.telegram.enabled = v
}

function toggleChannel(key, v) {
  opts[key].enabled = v
  if (v && !opts.telegram.enabled) opts.telegram.enabled = true
}

function evOn(cfg, key) {
  if (!cfg) return false
  const e = cfg.events || {}
  return e[key] === undefined ? EVENT_DEFAULTS[key] : e[key] !== false
}

function toggleEvent(channelKey, evKey) {
  const target = opts[channelKey]
  if (!target) return
  if (!target.events) target.events = {}
  target.events[evKey] = !evOn(target, evKey)
}

/**
 * 「关键事件单独提醒」的五类事件。
 * 与上面的 EVENT_GROUPS（报警类型分组）**不是一回事**：那是"哪些类型的报警要推"，
 * 这是"哪几类关键事件要额外单独提醒"。键与执行层（TG directPush.events /
 * 钉钉、企微 critical.events）严格一一对应。
 */
const CRIT_EVENTS = [
  { key: 'silence', label: '静默开始/结束', desc: '免打扰时段开始与结束的状态提醒（各一条）' },
  { key: 'summary', label: '静默汇总', desc: '免打扰结束时，把本时段收存的报警汇总成一条' },
  { key: 'face', label: '在库人脸命中', desc: '识别到已录入（在库）的人脸时，带图单独提醒' },
  { key: 'pending', label: '待录入满库', desc: '待录入人脸库达到预警 / 满库线时提醒处理' },
  { key: 'flow', label: '人员走向', desc: '匹配到跨摄像头走向（且该条流向开了「作为关键事件实时推送」）时，带图单独提醒' }
]

/** 某渠道的「关键事件」子开关是否开启（缺省即开，与执行层同一语义 `!== false`） */
function critOn(channelKey, evKey) {
  const crit = (opts[channelKey] || {}).critical
  if (!crit) return false
  const e = crit.events || {}
  return e[evKey] !== false
}

function toggleCritEvent(channelKey, evKey) {
  const crit = (opts[channelKey] || {}).critical
  if (!crit) return
  if (!crit.events) crit.events = {}
  crit.events[evKey] = !critOn(channelKey, evKey)
}

/**
 * 取某个渠道的「关键事件」配置块。
 * TG 那处叫 directPush（私聊推送），钉钉 / 企微那两处叫 critical（独立机器人）。
 */
function critBlockOf(which) {
  if (which === 'tg') return opts.telegram && opts.telegram.directPush
  const ch = which === 'wecom' ? opts.wecom : opts.dingtalk
  return ch && ch.critical
}

/**
 * 「静默时段也允许推送」（关键事件）是否开启。
 *
 * ⚠️ 缺省 true —— 这几类关键事件在老版本里是**硬编码放行**的（静默期间照样推），
 * 所以默认必须保持"静默也推"，否则升级用户行为会突变：原本夜里能收到的
 * 静默汇总 / 人脸命中，升级后突然收不到了。
 * 判定与执行层（useAlertPush.criticalSilentBlocked）严格一致：**只有显式 false 才算关**。
 *
 * @param {string} which 'dingtalk' | 'wecom' | 'tg'
 */
function critThroughSilence(which) {
  const blk = critBlockOf(which)
  return !!blk && blk.throughSilence !== false
}

function toggleCritThroughSilence(which) {
  const blk = critBlockOf(which)
  if (!blk) return
  blk.throughSilence = blk.throughSilence === false
}

/**
 * 「结算汇总只走关键事件」（summaryOnly）是否开启。
 *
 * 场景：关键事件机器人与日常推送是两个机器人，免打扰结束后两边各推一条
 * **内容相同**的结算汇总（用户原话："两个机器人会各推一条结算汇总，但内容
 * 其实是一样的"）。缺省 false = 两条都发（与老版本一致）；打开后这一端的
 * 日常推送不再发，只由这个关键事件机器人单独发（"免打扰已结束"短提醒内容
 * 不同、不算重复，仍照发）。
 * ⚠️ 与执行层 takenOverSummaryChannels 同一语义：**只有显式 true 才算开**；
 *    且只有这个机器人确实发得出去（启用 + 勾了静默汇总 + 配了 Webhook）才
 *    真正让位，没配好时日常推送仍会兜底发这条。
 *
 * @param {string} which 'dingtalk' | 'wecom' | 'tg'
 */
function critSummaryOnly(which) {
  const blk = critBlockOf(which)
  return !!blk && blk.summaryOnly === true
}

function toggleCritSummaryOnly(which) {
  const blk = critBlockOf(which)
  if (!blk) return
  blk.summaryOnly = blk.summaryOnly !== true
}

/* ==================== AI 扩展分析 ==================== */
/** 运行时的推理后端（给用户一个"这台机器能不能开重模型"的判断依据） */
const gpuReady = computed(() => (aiSlotBackend.value || {}).detector === 'webgpu')

const gpuText = computed(() => {
  const b = aiSlotBackend.value || {}
  const any = Object.keys(b).length > 0
  if (!any) return '尚未运行'
  return gpuReady.value ? 'WebGPU 可用（推荐）' : 'WebGPU 不可用 · 回退 WASM'
})

/** 人脸库 */
// faceLibOpen 来自 useFaceLib（模块级）：抽屉关掉再打开时展开状态要保留，见那里的说明

/* ---------- 同一个人的多角度样本：归类显示 ----------
 * 用户在库里看到的问题是：同一个人被拍了好几次（正面 / 侧面 / 低头），
 * 每次都占一张卡片、各顶着「人脸 7」「人脸 12」这种自动编号 ——
 * 十几张卡片其实没几个人，**推送里也会按命中的那一条各叫各的名字**。
 * 所以这里按「人」显示：一「人」一张卡片，点开看他的全部角度。
 */
/** 正在改名的那张卡片 —— 存的是**一「人」的组 key**，不是某一条记录的 id */
const faceRenameKey = ref(null)
const faceRenameText = ref('')
/** 正在保存名字的组 key（按组记录：一个人在存，不影响另一个人继续改） */
const renamingFace = reactive({})
/** 正在合并的组 key / 正在删除的样本记录 id */
const mergingGroup = ref('')
const deletingSample = reactive({})
/** 当前点开看全部角度的那一组 */
const selectedGroupKey = ref('')
/**
 * 组面板里「参与合并」的样本 id 勾选。
 *
 * 展开组时默认全选（保持一键合并的旧习惯），用户取消勾选即可把某些角度
 * 排除在外。为什么必须能让用户选：合并是多向量**加权平均**成一条，
 * 把不同角度全并成一张"平均脸"会丢角度覆盖 —— 识别是逐条样本取最高
 * 相似度（matchFace），角度留得全才容易命中；合并真正适合的是
 * 同一角度拍重了的去重 / 腾 libMax 名额。
 */
const mergeSelected = ref([])
const mergeSelCount = computed(() => mergeSelected.value.length)
const mergeAllChecked = computed(
  () => !!selectedGroup.value && mergeSelected.value.length === selectedGroup.value.items.length
)
/** 全选 / 全不选当前组的合并勾选 */
function toggleMergeAll() {
  if (!selectedGroup.value) return
  mergeSelected.value = mergeAllChecked.value ? [] : selectedGroup.value.items.map((i) => i.id)
}

/**
 * 是否按相似度把「同一个人」的多角度样本归到一张卡片。
 *
 * 默认开 —— 这正是要的效果：同一个人只占一张卡片、只有一个名字。
 * 但相似度是**概率**，偶尔会把两个长得像的人并到一起，所以必须留一个关掉的开关：
 * 关掉后只按「同名」这个**确定**的判据归类，立刻恢复一张一条。
 * 这个偏好存 localStorage：它属于"我想怎么看这份名单"，不该每次打开设置都被重置。
 *
 * GROUP_SIM_KEY / readGroupSim 从 useFaceLib 导入（单一来源）——识别路径
 * （useAiExtras 的 matchFaceGroup）也读同一份偏好，才能保证"识别报的名字"
 * 和"库里归类显示"用的是同一套归类判据。
 */
const groupBySim = ref(readGroupSim())
function toggleGroupBySim() {
  groupBySim.value = !groupBySim.value
  try {
    localStorage.setItem(GROUP_SIM_KEY, groupBySim.value ? '1' : '0')
  } catch (e) {}
}

/**
 * 归类用的相似度判据 = **设置页那个「识别阈值」**（上面「识别阈值」滑块）。
 *
 * 刻意不另立一套常量：识别时判「这是同一个人」用的是它，库里归类显示也该是它。
 * 否则会出现"推送说认出是谁了、库里却把这个人分成两条"这种自相矛盾的界面。
 */
const groupThreshold = computed(() => Number(opts.face.matchThreshold) || DEFAULT_FACE_THRESHOLD)

/**
 * 人脸库按「人」分组。依赖 faceRowsVersion —— 完整记录（含向量）在 useFaceLib 里
 * 刻意不进响应式（512 维 × 人数，白花代理开销），只用一个版本号当"库变了"的信号。
 */
const faceGroups = computed(() => {
  void faceRowsVersion.value
  /*
   * 拆分声明也要当依赖：faceSplitsVersion 一变（新增 / 解除 / 从后端拉回）
   * 就重算分组 —— 否则拆完界面不刷新，用户以为"点了没用"。
   */
  void faceSplitsVersion.value
  return groupFaces(rawFaceRows(), {
    threshold: groupThreshold.value,
    bySimilarity: groupBySim.value,
    splits: currentSplits()
  })
})

/** 一个"人"占了多条、多出来的条数：>0 才展示归类开关与说明 */
const groupedExtra = computed(() => Math.max(0, faceLib.value.length - faceGroups.value.length))

/** 当前展开的那一组（没展开 / 组已不存在时为 null） */
const selectedGroup = computed(
  () => faceGroups.value.find((g) => g.key === selectedGroupKey.value && g.count > 1) || null
)
/** 组没了（被合并 / 删除 / 改名后不再同名）就自动收起面板，别留一个空壳 */
watch(faceGroups, (gs) => {
  if (selectedGroupKey.value && !gs.some((g) => g.key === selectedGroupKey.value && g.count > 1)) {
    selectedGroupKey.value = ''
  }
})
/* 展开 / 切换组时把合并勾选重置为全选；组被合并没或收起时清空 */
watch(
  () => selectedGroup.value?.key || '',
  (k) => {
    mergeSelected.value = k && selectedGroup.value ? selectedGroup.value.items.map((i) => i.id) : []
  }
)
function toggleGroupPanel(g) {
  if (!g || g.count < 2) return
  selectedGroupKey.value = selectedGroupKey.value === g.key ? '' : g.key
}
/** 相似度显示成百分比（界面与探针共用同一处格式化） */
function simPct(s) {
  return Math.round(Math.max(0, Math.min(1, Number(s) || 0)) * 100) + '%'
}

/* ---------- 一键拆分：把全部「混合名」卡片按名字拆开 ----------
 * 归类判据是概率（相似度），用户的"这是两个人"是确定事实。这里把确定事实
 * 落成持久声明：id 对 + 名字对都记（见 useFaceLib.addFaceSplits 与
 * defaults.normalizeFaceSplits），链式合并也绕不过去（groupFaces 里是簇级检查）。
 * 拆分后这两人各自成卡、推送各叫各的名；之后新录入的同名样本也受同一条声明保护。
 * 撤销拆分 = 把两人归入同名（改名），maintainSplitsAfterRename 会自动让声明退休。
 */

/** 组里去重后的名字列表（按名字拆分配对用） */
function splitNames(g) {
  return [...new Set((g && Array.isArray(g.names) ? g.names : []).filter((x) => String(x || '').trim()))]
}

/**
 * 把一个混合名组按名字拆成不同的人：组内每两个不同名字之间记一条声明
 * （名字对管新样本、id 对管改名）。纯逻辑、不含确认框 / UI 状态，
 * 单组与库级「一键拆分」共用同一份配对规则。
 */
async function splitMixedGroupByName(g) {
  const names = splitNames(g)
  if (names.length < 2) return { ok: true, added: 0 }
  const byName = new Map()
  for (const it of g.items || []) {
    const nm = String(it.name || '').trim()
    if (!nm) continue
    if (!byName.has(nm)) byName.set(nm, [])
    byName.get(nm).push(it)
  }
  const pairs = []
  const ns = [...byName.keys()]
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      for (const a of byName.get(ns[i])) {
        for (const b of byName.get(ns[j])) {
          pairs.push({ aId: a.id, aName: ns[i], bId: b.id, bName: ns[j] })
        }
      }
    }
  }
  return addFaceSplits(pairs)
}

/**
 * 当前按「真实归类」（相似度 + 名字，与检测端一致，不受显示开关影响）算出来的
 * 混合名组 —— 这些组里名字不止一个，是「一键拆分」要处理的对象。
 * 用 bySimilarity:true 而不是显示用的 groupBySim：即使关掉"同一人归类显示"，
 * 底层相似度合并仍然发生，混合名簇照样该被拆开。
 */
const realMixedGroups = computed(() => {
  void faceRowsVersion.value
  void faceSplitsVersion.value
  return groupFaces(rawFaceRows(), {
    threshold: groupThreshold.value,
    bySimilarity: true,
    splits: currentSplits()
  }).filter((g) => g.sameName === false && splitNames(g).length >= 2)
})

/** 「一键拆分」按钮的可用性与数量提示 */
const mixedGroupNameCount = computed(() => realMixedGroups.value.length)

const bulkSplitting = ref(false)

/**
 * 「一键拆分（全部不同名）」：对当前所有混合名卡片按名字拆开。
 * 幂等：已拆过的声明 addFaceSplits 会自动去重；重复点只补新的。
 * 撤销 = 把两人归入同名（改名），maintainSplitsAfterRename 让对应的拆分声明退休。
 */
async function doBulkSplitAll() {
  if (bulkSplitting.value) return
  const groups = realMixedGroups.value
  if (!groups.length) return
  const namesUnion = [...new Set(groups.flatMap((g) => splitNames(g)))]
  const msg =
    `把 ${groups.length} 个「名字混在一起」的卡片按名字拆开？\n\n` +
    `涉及名字：${namesUnion.join('、')}\n\n` +
    '拆分后：各自成卡，推送也各叫各的名；之后新录入的同名样本同样受保护。\n' +
    '撤销 = 把两人归入同名（改名），会自动解除对应的拆分声明。\n' +
    (faceBackendOn.value
      ? '当前是后端模式：拆完还需要点一次「同步到后端」，服务端才会按拆分后的名字推送。\n'
      : '')
  if (!(await confirmDialog({ title: '一键拆分', message: msg }))) return
  bulkSplitting.value = true
  try {
    let total = 0
    let done = 0
    for (const g of groups) {
      const r = await splitMixedGroupByName(g)
      if (!r.ok) {
        alertDialog({ title: '拆分失败', message: (r && r.reason) || '拆分失败', variant: 'danger' })
        return
      }
      total += r.added || 0
      done += 1
    }
    alertDialog({
      title: '已拆分',
      message: `已处理 ${done} 个混合名卡片${total > 0 ? `（新增 ${total} 条拆分声明）` : '（均已拆好，无新增）'}。`,
      variant: 'success'
    })
  } catch (e) {
    alertDialog({ title: '拆分失败', message: (e && e.message) || '拆分失败', variant: 'danger' })
  } finally {
    bulkSplitting.value = false
  }
}

/** 正在录入中的待录入卡片 id（防止「点下去没反馈 → 连点 → 同一张脸被建出多条」）。
 *  按 id 记录而不是全局一个开关：一张在录不影响其它卡片继续点。 */
const enrollingPending = reactive({})

/** 正在删除中的卡片组 key（同 enrollingPending 思路：按组记录，
 *  删除中显「删除中」、隐藏「改名」，防止连点 / 误操作）。 */
const deletingFace = reactive({})

/* ---------- 手动归入：待录入卡片录入时归入某人 / 改名 ----------
 * 用户诉求：录入待录入人脸时，不只"永远建一条新的人脸 N"，还要能
 *   - 归入一个已知的人（同名 → 归到他那一堆样本里）
 *   - 自定义一个名字（而不是让系统自动编号「人脸 N」）
 * 做法：每张待录入卡片挂一个「归入」下拉，选中值记到 pendingAssign[pf.id]，
 * 点「录入」时把这个名字传给 addFace（留空 = 自动编号，保持旧行为）。 */
const pendingAssign = reactive({}) // pf.id -> ''（新建）| 已知名字 | '__custom__'
const pendingCustom = reactive({}) // pf.id -> 自定义名字文本
/** 当前人脸库里已有的「归类名称」集合：下拉「归入某人」的选项来源。
 * 刻意取 faceGroups 的组名（而不是每条样本各自的 name）——库里归好类的人
 * 只应有一个名字出现在列表里，否则下拉会出现「人脸 1」「人脸 12」这种
 * 同一个人被拆成多个选项，与卡片显示、识别上报的归类名都不一致。 */
const faceNameOptions = computed(() => {
  const s = new Set()
  for (const g of faceGroups.value || []) if (g && g.name) s.add(g.name)
  return [...s]
})
/** 把下拉 + 自定义框解析成最终传给 addFace 的名字：'' = 自动编号 */
function pendingAssignName(pf) {
  const a = pendingAssign[pf.id]
  if (a === '__custom__') return (pendingCustom[pf.id] || '').trim()
  return a || ''
}
/** 卡片被录入 / 忽略后，清掉它占用的归入状态，别留 stale key */
function clearPendingAssign(pf) {
  delete pendingAssign[pf.id]
  delete pendingCustom[pf.id]
}

/* ---------- 手动归入：已录入样本归入某人 ----------
 * 用户诉求：人脸库里已建档的样本，也能手动归入某个已知的人（修自动归类误并的问题）。
 * 做法：展开某「人」看全部角度时，每条样本加一个「归入」下拉，
 * 选好（或自定义）后调 renameFace 把这一条单独改名到目标人。 */
const sampleAssign = reactive({}) // it.id -> '' | 已知名字 | '__custom__'
const sampleCustom = reactive({}) // it.id -> 自定义名字文本
const assigningSample = reactive({}) // it.id -> bool（改名进行中）
/** 下拉选了已知名字就直接归入；选「自定义」则等用户填完点「确定」 */
function onSampleAssign(it) {
  const v = sampleAssign[it.id]
  if (v && v !== '__custom__') commitSampleAssign(it)
}
async function commitSampleAssign(it) {
  if (!it || assigningSample[it.id]) return
  const v = sampleAssign[it.id]
  const name = v === '__custom__' ? (sampleCustom[it.id] || '').trim() : v
  if (!name) return
  assigningSample[it.id] = true
  try {
    const r = await renameFace(it.id, name)
    if (!r.ok) {
      alertDialog({ title: '归入失败', message: r.reason || '归入失败', variant: 'danger' })
      return
    }
    // 改名成功：这条样本离开了当前组（或换到别的人），selectedGroup 会因
    // faceGroups 重算而自动更新；清掉本行归入状态，别留"选了旧名字"的假象。
    sampleAssign[it.id] = ''
    sampleCustom[it.id] = ''
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '归入超时' : '归入失败',
      message: faceWriteFailMessage(e, '这条样本没有改名，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete assigningSample[it.id]
  }
}

/* ---------- 手动归类（卡级）：把"这个人"整体归入另一个已知的人 ----------
 * 用户诉求：人脸库里已建档的「人」也要能手动归类，而不仅是单条样本。
 * 典型场景：自动归类把同一个人拆成了两张卡（不同角度 / 不同摄像头各一张），
 * 用户想手动声明"这两张卡是同一个人" —— 在源卡上选目标卡的名字，
 * 这一整张卡的样本会一起改名过去、重新并到目标那一组。
 * 做法：每张卡片挂一个「归入到…」下拉（选项 = 库里其它人的名字，排除自己），
 * 选好后调 renameFaces 把整组样本改名（保留各角度向量，只统一名字 → 重分组）。
 * 语义与单条样本归入一致：只是批量改名、不弹确认框（可逆，改名回来即可）。 */
const groupAssign = reactive({}) // g.key -> '' | 目标名字
const assigningGroup = reactive({}) // g.key -> bool（归入进行中）
/** 库里"其它人"的名字列表：下拉选项来源，排除当前这张卡自己的名字
 * （避免把自己并入自己这种无意义操作；同名的两张卡在按名分组下本就不会并存）。 */
function otherNames(g) {
  return (faceNameOptions.value || []).filter((n) => n !== (g && g.name))
}
/** 下拉选了已知名字就直接归入（自定义场景不存在于卡级：新建人用「改名」即可） */
function onGroupAssign(g) {
  const v = groupAssign[g.key]
  if (v) doGroupAssign(g, v)
}
async function doGroupAssign(g, name) {
  if (!g || !name || assigningGroup[g.key]) return
  assigningGroup[g.key] = true
  try {
    const r = await renameFaces(g.items.map((i) => i.id), name)
    if (!r.ok) {
      alertDialog({ title: '归入失败', message: r.reason || '归入失败', variant: 'danger' })
      return
    }
    // 整组样本改过去后：源卡消失、目标卡多了这些样本；清掉本卡归入状态，
    // 源卡若正展开也收起（watch 也会兜底，这里显式更稳）。
    groupAssign[g.key] = ''
    if (selectedGroupKey.value === g.key) selectedGroupKey.value = ''
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '归入超时' : '归入失败',
      message: faceWriteFailMessage(e, '这张卡没有归入到目标人名下，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete assigningGroup[g.key]
  }
}

/* ---------- 待录入：点击缩略图看捕获时的整帧原图 ----------
 * 缩略图只是人脸裁剪，看不出"这人是在什么画面里被抓到的"。
 * 点缩略图打开一个轻量灯箱，显示 capture 时存的整帧（pf.full），
 * 没存到整帧（老数据 / 极早期）就退回缩略图。 */
const pendingShot = ref(null) // 当前查看的待录入对象（null = 灯箱关）
function openPendingShot(pf) {
  if (!pf || !pf.full) return
  pendingShot.value = pf
}
function closePendingShot() {
  pendingShot.value = null
}
function onPendingShotKey(e) {
  if (e && e.key === 'Escape') closePendingShot()
}
// 灯箱靠窗口级 Esc 关闭（div 上 @keydown 没焦点不会触发）
onMounted(() => window.addEventListener('keydown', onPendingShotKey))
onUnmounted(() => window.removeEventListener('keydown', onPendingShotKey))

/**
 * 人脸库写失败时的**统一提示文案**（录入 / 修正 / 删除 / 改名 / 合并 / 清空 共用）。
 *
 * 为什么值得单独写一个：以前每个 catch 都只给一句「××时出错：<原始报错>」，
 * 用户看到的是「本地数据库写入超时（15s）：请关闭本应用的其它标签页后重试」——
 * 这句话有三个问题：
 *   1. 没说**具体**要关什么（设置面板？窗口？整个应用？），用户猜不出来；
 *   2. 把"超时"说成了"失败"，于是用户以为没录上、反复点（这正是重复入库的来源）；
 *   3. 连撞很多次也不升级提示，用户就一直撞同一堵墙。
 * 所以这里按 faceWriteErrKind 分类给"下一步做什么"，并在连续超时（streak ≥ 2）时
 * 升级成"完全退出应用再打开"—— 只关设置面板并不会释放数据库连接（实测如此）。
 *
 * @param {any} e 捕获到的错误
 * @param {string} [tail] 这次操作额外要说的一句（比如"这张脸还在待录入里"）
 */
function faceWriteFailMessage(e, tail) {
  const kind = faceWriteErrKind(e)
  const detail = (e && e.message) || String(e || '未知原因')
  const lines = []
  if (kind === 'timeout') {
    lines.push(
      '本地人脸库 15 秒内没有返回，这次写入被中止了（连接已自动重建，直接重试通常就恢复）。',
      '',
      '常见原因：',
      '· 本应用在另一个窗口 / 标签页里正在批量读写（录入、导入、导出、清空），把连接占住了；',
      '· 页面被切到后台 / 手机锁屏，浏览器把数据库连接挂起了；',
      '· 上一次写入卡住还没清完（会连带后面每一次都超时）。',
      '',
      '请这样处理：',
      '1. 关掉本应用的其它窗口和标签页（尤其是正在录入 / 导入的那个）；',
      '2. 回到这里再操作一次。'
    )
    if (faceWriteTimeoutStreak() >= 2) {
      lines.push(
        '',
        `已经连续 ${faceWriteTimeoutStreak()} 次超时了，说明连接确实卡死了 —— 只关设置面板不够，请完全退出本应用（关掉所有窗口 / 手机端结束后台进程）再重新打开。`
      )
    }
  } else if (kind === 'blocked') {
    lines.push(
      '本地人脸数据库正被本应用的其它窗口 / 标签页占用（它可能正在打开或升级数据库）。',
      '',
      '请关掉本应用的其它窗口和标签页（只留当前这一个），然后重试。'
    )
  } else if (kind === 'unsupported') {
    lines.push(
      '当前环境不支持本地数据库（IndexedDB），人脸库无法读写。',
      '',
      '请换用新版 Chrome / Edge，或退出浏览器的无痕模式后再试。'
    )
  } else {
    lines.push('写入本地人脸库时出错：' + detail)
  }
  if (kind === 'timeout' || kind === 'blocked') {
    // 这句很重要：用户上次就是被"超时"骗了，以为没写进去又点了一遍
    lines.push('（超时不一定等于没写进去 —— 上面这条是核对过库之后的结果，确实没有落库。）')
  }
  if (tail) lines.push('', tail)
  return lines.join('\n')
}

/**
 * 写操作报超时后核实：这张脸的向量是不是**其实已经入库**了。
 *
 * 背景（真实故障）：本地写事务可能已经提交，只是随后的缓存刷新没在 15s 看门狗内完成，
 * 于是 addFace 被判定"写入超时"抛错。旧逻辑把它当失败 → 卡片留在待录入 →
 * 用户再点一次 → 同一个人被重复录入。这里在报错前先查一次库，命中就当成功。
 *
 * 带 4s 上限：核实本身不能再把界面卡住。
 * @returns {Promise<object|null>} 命中则返回已存在的那条记录（含 id/name）
 */
async function verifyVectorLanded(vector) {
  if (!vector || !vector.length) return null
  try {
    const all = await Promise.race([
      getAllFaces(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('verify-timeout')), 4000))
    ])
    return (
      (all || []).find(
        (r) =>
          Array.isArray(r.vector) &&
          r.vector.length === vector.length &&
          r.vector.every((v, i) => Math.abs((Number(v) || 0) - (Number(vector[i]) || 0)) < 1e-6)
      ) || null
    )
  } catch (e) {
    return null
  }
}

async function doAddPending(pf) {
  // 已经在录这张了：连点直接拦掉（addFace 是 runExclusive，再点会排队，
  // 等上一张建完再建一张 → 自动编号出「人物2」，纯属重复建档）。
  if (enrollingPending[pf.id]) return
  enrollingPending[pf.id] = true
  try {
    // 把卡片上的「归入」选择解析成名字：留空=自动编号（旧行为），否则归入某人/自定义名。
    const name = pendingAssignName(pf)
    const res = await addFace(pf.vector, pf.thumb, name, Number(opts.face.libMax) || 50)
    if (!res.ok) {
      alertDialog({ title: '录入失败', message: res.reason || '录入失败', variant: 'danger' })
      return
    }
    // 优先录入、其余写入暂缓：addFace 落库成功后**立刻本地乐观移除卡片**，
    // 后端队列的删除放后台异步跑（dropBackendPendingFace 内部先同步剔掉本地镜像再 fetch 服务端，
    // 这里**不 await** 它），界面不再被网络超时拖在「录入中」。
    clearPendingAssign(pf)
    if (pf.fromBackend) dropBackendPendingFace(opts.backend.url, pf.backendId) // 故意不 await
    else removePendingFace(pf.id)
    delete enrollingPending[pf.id] // 落库即解锁，不等网络
  } catch (e) {
    /*
     * 超时 ≠ 没写进去：写事务可能**已提交**，只是刷新没在时限内完成（旧实现把两者
     * 算在一起，是"超时但其实已入库 → 重试重复入库"的根因）。报错前先核实这张脸
     * 是不是其实已经在库里：在 → 按成功处理，静默清掉卡片，不弹"失败"误导用户。
     */
    const landed = await verifyVectorLanded(pf.vector)
    if (landed) {
      clearPendingAssign(pf)
      if (pf.fromBackend) dropBackendPendingFace(opts.backend.url, pf.backendId) // 故意不 await
      else removePendingFace(pf.id)
      return
    }
    /*
     * 确实没写进去：必须接住异常（本地库卡死 / 被别的标签页占住），
     * 以前这里没有 catch —— 于是卡片就停在「录入中」，界面上一条提示都没有，
     * 用户只能反复点。宁可明确告诉他"没录上、为什么没录上"。
     */
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '录入超时' : '录入失败',
      message: faceWriteFailMessage(e, '这张脸还在待录入里，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete enrollingPending[pf.id]
  }
}

/* ==================== 手动上传照片录入 ====================
 * 编排全在 useFaceLib.enrollFromImage 里；这里只负责「触发选择 → 拿文件 → 调它 → 把结果翻译成反馈」。
 * 三个明确诉求：① 一张一录 ② 上传要有提示 ③ 上传后反馈成功/失败。
 * 反馈用内联状态条（不是 alert）：进行中显「录入中…」，结束显成功/失败文案。 */
const enrollFileEl = ref(null)
const enrollState = ref('idle') // idle | loading | done | error
const enrollMsg = ref('')
const enrollOk = ref(false)

/* ---- 采集调优（高级）----
 * 检测输入边长的候选值：**32 的倍数**（解码按 stride 8/16/32 铺 anchor，
 * 非 32 的倍数会把 anchor 网格铺错）。默认 640 即历史值。 */
const FACE_DET_SIZES = [320, 480, 640, 800, 960, 1280]
const faceTuneOpen = ref(false)

/**
 * 恢复采集调优的旋钮。
 * 默认值从 **同一份** `cloneDefaultOptions()`（= defaults.js，其 face 默认值又取自
 * useTracker.FACE_TUNING / PENDING_FULL）读，不在这里另写字面量 —— 免得「恢复默认」恢复出另一个数。
 */
function resetFaceTune() {
  const d = _DEFAULTS.face || {}
  opts.face.retryMs = d.retryMs
  opts.face.headRatio = d.headRatio
  opts.face.detSize = d.detSize
  opts.face.dedupeSec = d.dedupeSec
  opts.face.pendingFullAt = d.pendingFullAt
  opts.face.pendingWarnRatio = d.pendingWarnRatio
  opts.face.pendingDedupeSec = d.pendingDedupeSec
}

function triggerEnrollFile() {
  // 先清掉上一条反馈，避免和上次的结论混在一起
  enrollState.value = 'idle'
  enrollMsg.value = ''
  if (enrollFileEl.value) enrollFileEl.value.click()
}

async function onEnrollFile(e) {
  const input = e && e.target
  const file = input && input.files && input.files[0]
  // 允许同一张照片重复选（change 不触发时，手动清 value）
  if (input) input.value = ''
  if (!file) return
  // 展开人脸库，让录入结果（新出现的一张）立即可见
  faceLibOpen.value = true
  enrollState.value = 'loading'
  enrollMsg.value = '正在加载人脸识别模型…'
  try {
    const r = await enrollFromImage(file, { score: 0.4, max: Number(opts.face.libMax) || 50 })
    if (r.ok) {
      enrollOk.value = true
      enrollState.value = 'done'
      enrollMsg.value =
        r.detected > 1
          ? `录入成功：${r.name}（照片里检测到 ${r.detected} 张人脸，已录入最清晰的一张；其余请分别上传）`
          : `录入成功：${r.name}（已自动同步到后端）`
    } else {
      enrollOk.value = false
      enrollState.value = 'error'
      enrollMsg.value = r.reason || '录入失败'
    }
  } catch (err) {
    enrollOk.value = false
    enrollState.value = 'error'
    enrollMsg.value = '录入过程出错：' + ((err && err.message) || err)
  }
}

function doIgnorePending(pf) {
  if (pf.fromBackend) dropBackendPendingFace(opts.backend.url, pf.backendId)
  else removePendingFace(pf.id)
  clearPendingAssign(pf)
}

/** 一键忽略所有待录入人脸（前端内存队列 + 后端 SQLite 队列都清掉） */
async function doIgnoreAllPending() {
  const n = allPendingFaces.value.length
  if (!n) return
  /*
   * 必须二次确认：这个动作**不可撤销**，而且一次清掉的是**全部** ——
   * 前端内存队列与后端 SQLite 队列都会被删，删完只能等它们再出现。
   * 「清空人脸库」「删除单个人脸」本来就有 confirm，这里没理由例外。
   */
  const scope = faceBackendOn.value ? '前端暂存和后端队列都会清掉，' : ''
  if (
    !(await confirmDialog({
      title: '忽略全部待录入',
      message: `确定忽略全部 ${n} 张待录入人脸？\n${scope}此操作不可撤销。`,
      variant: 'danger'
    }))
  )
    return
  // 前端内存队列：直接清空
  clearPendingFaces()
  // 后端队列：逐条回服务端删除，否则下次刷新又冒出来
  const list = backendPendingFaces.value
  for (const pf of list) {
    dropBackendPendingFace(opts.backend.url, pf.backendId)
  }
}

/**
 * 忽略「当前这一页」的待录入人脸（不是全部）。
 * 复用 doIgnorePending 的单一判定（前端内存队列 vs 后端 SQLite 队列分开处理），
 * 这里只是把"当前页可见的那几张"批量走一遍同样的忽略逻辑。
 * 删完列表会变短，pendingPageCount 的 watcher 会自动把越界的页码拉回最后一页。
 */
async function doIgnorePagePending() {
  const list = pagedPending.value
  if (!list.length) return
  const scope = faceBackendOn.value ? '（含来自后端的）' : ''
  if (
    !(await confirmDialog({
      title: '忽略本页待录入',
      message: `确定忽略本页 ${list.length} 张待录入人脸？${scope}此操作不可撤销。`,
      variant: 'danger'
    }))
  )
    return
  for (const pf of list) doIgnorePending(pf)
}

/**
 * 删除一张卡片 = 删除**这个人**（可能含多个角度样本）。
 *
 * 文案必须说清"是一整组几条"，因为这些记录在库里是"一个人"：
 * 只删掉其中一条，剩下的还会以这个人的样子出现在推送里。
 */
async function doDeleteGroup(g) {
  // 已经在删这张了：连点直接拦掉（确认弹窗是 modal，正常点不到，这里兜底防重入）
  if (!g || deletingFace[g.key]) return
  const n = g.count || 1
  const sameName = g.sameName !== false
  /* 名字不一致时，名字没法用「某某」指代 —— 那样会让用户以为删的是别的人 */
  const who = sameName ? `「${g.name}」` : `这一组（${g.names.join(' / ')}）`
  const msg =
    n > 1
      ? `确定删除${who}的 ${n} 条人脸记录？\n（这一组是同一个人的 ${n} 个角度样本，会一起删掉；删除后再次出现会重新当作陌生人。）`
      : `确定删除${who}的人脸记录？\n删除后再次出现会重新当作陌生人。`
  if (!(await confirmDialog({ title: '删除人脸记录', message: msg, variant: 'danger' }))) return
  deletingFace[g.key] = true
  try {
    await deleteFaces(g.items.map((i) => i.id))
    if (selectedGroupKey.value === g.key) selectedGroupKey.value = ''
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '删除超时' : '删除失败',
      message: faceWriteFailMessage(e, '这张卡片还在列表里（没有删掉），可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete deletingFace[g.key]
  }
}

/** 删掉一个人的其中一张角度样本（模糊 / 拍歪了的那张），保留这个人的其它样本 */
async function doDeleteSample(it) {
  if (!it || deletingSample[it.id]) return
  if (
    !(await confirmDialog({
      title: '删除这张样本',
      message: `确定删除「${it.name}」的这一张样本（${fmtPendingAt(it.createdAt)}）？\n该样本的人脸特征会一起删掉，其它角度的样本不受影响。`,
      variant: 'danger'
    }))
  )
    return
  deletingSample[it.id] = true
  try {
    await deleteFaces([it.id])
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '删除超时' : '删除失败',
      message: faceWriteFailMessage(e, '这张样本还在库里（没有删掉），可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete deletingSample[it.id]
    // 样本没了，勾选集合里别留 stale id（否则头部"全选"计数对不上）
    mergeSelected.value = mergeSelected.value.filter((id) => id !== it.id)
  }
}

/* ---------- 主样本（★）：每个名字下的代表样本，用户自己指定 ----------
 * 用途：① 人脸库卡片封面；② 待录入打分时「最像谁」的对比基准；
 *      ③ 清理废样本时「保留哪一张」的默认选项。
 * 刻意不参与匹配数学（匹配对该名字下所有样本取最高相似度）——
 * 让它加权会动摇 0.38 阈值 / 分差门槛那套已验证的体系。
 * 唯一性（一个名字最多一条）由 useFaceLib.setPrimaryFace 的事务兜底，
 * 这里只做「点哪张」的交互，不再自己判一遍（判两遍必漂）。 */

/** 正在设主样本的记录 id（按钮置灰 + 「设置中」反馈，防连点） */
const settingPrimary = reactive({})

/** 卡片级快捷操作：把这张卡的封面样本（最早录入那条）设为主样本 */
async function doSetPrimaryCard(g) {
  if (!g || settingPrimary[g.id]) return
  settingPrimary[g.id] = true
  try {
    const r = await setPrimaryFace(g.id)
    if (!r.ok) alertDialog({ title: '设置失败', message: r.reason || '设置主样本失败', variant: 'danger' })
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '设置超时' : '设置失败',
      message: faceWriteFailMessage(e, '没有改成，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete settingPrimary[g.id]
  }
}

/** 组面板里把某条样本设为主样本 */
async function doSetPrimarySample(it) {
  if (!it || settingPrimary[it.id]) return
  settingPrimary[it.id] = true
  try {
    const r = await setPrimaryFace(it.id)
    if (!r.ok) alertDialog({ title: '设置失败', message: r.reason || '设置主样本失败', variant: 'danger' })
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '设置超时' : '设置失败',
      message: faceWriteFailMessage(e, '没有改成，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete settingPrimary[it.id]
  }
}

/** 组面板里取消某条样本的主样本标记（回到「没有主样本」的默认态） */
async function doClearPrimarySample(it) {
  if (!it || settingPrimary[it.id]) return
  settingPrimary[it.id] = true
  try {
    const r = await clearPrimaryFace(it.id)
    if (!r.ok) alertDialog({ title: '取消失败', message: r.reason || '取消主样本失败', variant: 'danger' })
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '取消超时' : '取消失败',
      message: faceWriteFailMessage(e, '没有取消成，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete settingPrimary[it.id]
  }
}

/**
 * 把这一组的多角度样本**合并成一条**。
 *
 * 合并后特征按样本数加权平均、名字沿用这条人的名字，于是无论哪个角度被拍到，
 * 命中的都是同一条记录、推送里都是同一个名字，而且腾出人脸库名额。
 * 属于不可撤销（合并后各角度各自的缩略图不再单独保留），所以要二次确认。
 */
async function doMergeGroup(g) {
  if (!g || g.count < 2 || mergingGroup.value) return
  // 只合并**勾选**的样本；没勾选的角度原样留在库里（各自成组或继续归在人名下）
  const picked = g.items.filter((i) => mergeSelected.value.includes(i.id))
  if (picked.length < 2) {
    alertDialog({
      title: '至少勾选 2 条',
      message: '合并至少要勾选 2 个角度样本；不想合并的角度请保持不勾选，它们会原样保留。',
      variant: 'warn'
    })
    return
  }
  const partial = picked.length < g.count
  const sameName = g.sameName !== false
  if (
    !(await confirmDialog({
      title: '合并为一条人脸记录',
      message:
        `把${sameName ? `「${g.name}」` : `这一组（${g.names.join(' / ')}）`}勾选的 ${picked.length} 条样本合并成 1 条` +
        `${partial ? `，其余 ${g.count - picked.length} 条原样保留` : ''}？\n` +
        `合并后名字沿用「${g.name}」，人脸特征取加权平均${partial ? '' : `，并腾出 ${g.count - 1} 个名额`}。\n` +
        '此操作不可撤销。',
      variant: 'danger'
    }))
  )
    return
  mergingGroup.value = g.key
  try {
    // keepId 传勾选里的第一条（保序于 items）：合并后它当代表样本
    const r = await mergeFaces(
      picked.map((i) => i.id),
      picked[0].id
    )
    if (!r.ok) {
      alertDialog({ title: '合并失败', message: r.reason || '合并失败', variant: 'danger' })
      return
    }
    selectedGroupKey.value = ''
  } catch (e) {
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '合并超时' : '合并失败',
      message: faceWriteFailMessage(e, '这一组没有变动（没有合并），可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    mergingGroup.value = ''
  }
}

function startRenameGroup(g) {
  if (!g) return
  faceRenameKey.value = g.key
  faceRenameText.value = g.name
}

/**
 * 提交改名 —— 改的是**这个人**（该组全部样本一起改）。
 *
 * 为什么要一起改：库里的名字直接决定推送内容。只改其中一条的话，
 * 同一个人的不同角度会各推各的名字（用户看到的就是"一次叫小刘、一次叫人脸 7"），
 * 而且"同名归类"的判据就是名字，改一条会让这张卡片立刻散开。
 *
 * 这里的三个细节都是踩过的坑：
 *   1. **保存中要有反馈**：写入是排队执行的（前面可能还压着别的写操作），
 *      不给反馈时用户看到的就是"点了没反应"，于是连点、以为卡住。
 *   2. **防重入**：同一张卡片保存期间再触发（回车后紧接着失焦）直接返回。
 *   3. **只收尾自己那一次**：改 A 的时候顺手去改 B，A 的 await 回来时不能把
 *      B 的编辑框关掉（以前就是这个 bug，表现为"点 B 的改名一开就没了"）。
 */
async function commitRenameGroup() {
  const key = faceRenameKey.value
  if (key == null || renamingFace[key]) return
  const g = faceGroups.value.find((x) => x.key === key)
  if (!g) {
    faceRenameKey.value = null
    return
  }
  const name = String(faceRenameText.value || '').trim()
  // 空名字 / 没改动：什么都不写（空名字会被库拒掉，白写一次还会往后端推一遍配置）
  if (!name || (name === g.name && g.sameName !== false)) {
    faceRenameKey.value = null
    return
  }
  renamingFace[key] = true
  try {
    const r = await renameFaces(g.items.map((i) => i.id), name)
    if (!r.ok) {
      faceRenameKey.value = null
      alertDialog({ title: '改名失败', message: r.reason || '改名失败', variant: 'danger' })
      return
    }
    faceRenameKey.value = null
  } catch (e) {
    /*
     * 失败必须收掉编辑态并**明说**：
     * 以前这里既不 catch 也不提示，一次写入失败（比如数据库被别的标签页占住）
     * 就是"输入框一直开着、怎么点都没反应" —— 用户说的"经常卡住"。
     * 收掉编辑态还有个副作用要避免：编辑框留着、弹窗又抢走焦点会再触发一次失焦提交，
     * 变成反复重试。
     */
    faceRenameKey.value = null
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '改名超时' : '改名失败',
      message: faceWriteFailMessage(e, '名字没有改动，可以稍后重试。'),
      variant: 'danger'
    })
  } finally {
    delete renamingFace[key]
  }
}

async function doClearFaces() {
  if (
    !(await confirmDialog({
      title: '清空人脸库',
      message: '确定清空整个人脸库？\n该操作不可撤销。',
      variant: 'danger'
    }))
  )
    return
  try {
    await clearFaces()
  } catch (e) {
    // 同 doAddPending：写库失败必须说出来，不能让按钮点下去毫无反应
    alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '清空超时' : '清空失败',
      message: faceWriteFailMessage(e, '人脸库没有被清空，可以稍后重试。'),
      variant: 'danger'
    })
  }
}

watch(faceLibOpen, (v) => {
  if (v) {
    refreshFaces().catch(() => {})
    libPage.value = 1
  }
})

// 待录入对称：展开时回到第一页（收起状态不留页码）
watch(pendingLibOpen, (v) => {
  if (v) pendingPage.value = 1
})

/* ---------- 人脸库分页：默认最多 4 行，超出翻页 ----------
 * 卡片宽度固定 88px，**一行能放几个随抽屉宽度变**（桌面宽、手机窄），
 * 所以每页数量必须现算：一行几张 × 4 行。
 * 已录入 / 待录入两张网格**各自独立分页**，互不影响。
 */
const FACE_ROWS = 4
/** 与 .face-card / .face-grid 的 CSS 保持一致（卡片 88px、间距 8px） */
const FACE_CARD_W = 88
const FACE_GAP = 8
const libGridEl = ref(null)
const pendingGridEl = ref(null)
/** 上次量到的列数（读不到时保留旧值；初值给 6 只是兜底，挂载后会立刻校准） */
const libCols = ref(6)
const pendingCols = ref(6)
const libPage = ref(1)
const pendingPage = ref(1)

/**
 * 一行能放下几张脸 —— 按**容器实际宽度**算。
 *
 * ⚠️ 绝对不要用 `getComputedStyle(el).gridTemplateColumns` 去数轨道。
 *    本抽屉所有标签页用的是 `v-show`（见文件里"所有标签页用的是 v-show"那段）：
 *    抽屉一打开**全部模板都渲染**，未选中的人脸 tab 只是 `display:none`。
 *    此时 Chrome 返回的是**未解析的指定值** `"repeat(auto-fill, 88px)"`，
 *    按空格切正好切成 2 段 —— 于是列数被误判成 2，每页只切 2×4=8 张：
 *    50 张待录入被分成 **7 页**，而每页实际只用真实宽度（7 列）铺出**两排**
 *    （第二排还只有 1 张），看起来就像"没铺满就翻页了"。
 *    （最小复现与对照：/tmp/face-probe/repro.html）
 *
 * 元素不可见时 clientWidth 为 0 → 返回 0 → 调用方保留上一次的值，不会被污染。
 */
function countCols(el) {
  if (!el) return 0
  const w = el.clientWidth
  if (!w) return 0
  return Math.max(1, Math.floor((w + FACE_GAP) / (FACE_CARD_W + FACE_GAP)))
}

function measureFaceCols() {
  const lc = countCols(libGridEl.value)
  if (lc) libCols.value = lc
  const pc = countCols(pendingGridEl.value)
  if (pc) pendingCols.value = pc
}

/**
 * 尺寸一变就重算列数。
 *
 * 为什么非要有它：人脸 tab 不是当前页时 grid 是 `display:none`（v-show 的后果），
 * 这时量不到宽度；用户切到人脸 tab 那一刻它才从 0 变成真实宽度。
 * ResizeObserver 正好覆盖「从隐藏变可见」「抽屉宽度变化」「首屏布局完成」三种时机，
 * 不必去猜该在哪个 watch 里补一次测量。
 */
let faceColsRO = null
function observeFaceGrids() {
  if (typeof ResizeObserver === 'undefined') return
  if (!faceColsRO) faceColsRO = new ResizeObserver(() => measureFaceCols())
  faceColsRO.disconnect()
  if (libGridEl.value) faceColsRO.observe(libGridEl.value)
  if (pendingGridEl.value) faceColsRO.observe(pendingGridEl.value)
}

const libPageSize = computed(() => Math.max(1, libCols.value * FACE_ROWS))
const pendingPageSize = computed(() => Math.max(1, pendingCols.value * FACE_ROWS))
/** 人脸库按「人」分页（不是按记录）：一「人」一张卡片，页数才不会因为多角度样本虚高 */
const libPageCount = computed(() =>
  Math.max(1, Math.ceil((faceGroups.value.length || 0) / libPageSize.value))
)
const pendingPageCount = computed(() =>
  Math.max(1, Math.ceil((allPendingFaces.value.length || 0) / pendingPageSize.value))
)
const pagedFaceGroups = computed(() => {
  const p = Math.min(Math.max(1, libPage.value), libPageCount.value)
  return faceGroups.value.slice((p - 1) * libPageSize.value, p * libPageSize.value)
})
const pagedPending = computed(() => {
  const p = Math.min(Math.max(1, pendingPage.value), pendingPageCount.value)
  return sortedPendingFaces.value.slice((p - 1) * pendingPageSize.value, p * pendingPageSize.value)
})

/** 数据变短（删除 / 录入后）当前页可能越界，拉回最后一页，避免停在空白页 */
watch(libPageCount, (n) => {
  if (libPage.value > n) libPage.value = n
})
watch(pendingPageCount, (n) => {
  if (pendingPage.value > n) pendingPage.value = n
})

/**
 * 这些变化后都要重量列数：展开/收起、数据增减、**切到人脸 tab**，
 * 以及两个 grid 元素本身被 `v-if` 重建（元素换了，ResizeObserver 得重新挂）。
 * 不可见时量不到 → 保留旧值，等它可见时由这里或 ResizeObserver 补上。
 */
watch(
  [faceLibOpen, pendingLibOpen, faceLib, allPendingFaces, tab, libGridEl, pendingGridEl],
  () =>
    nextTick(() => {
      observeFaceGrids()
      measureFaceCols()
    })
)

onMounted(() => {
  // 抽屉宽度会随窗口 / 横竖屏变化，列数跟着变 → 重新量一次并让分页自动纠正
  window.addEventListener('resize', measureFaceCols)
  nextTick(() => {
    observeFaceGrids()
    measureFaceCols()
  })
})
onUnmounted(() => {
  window.removeEventListener('resize', measureFaceCols)
  if (faceColsRO) {
    faceColsRO.disconnect()
    faceColsRO = null
  }
})

/** 区域归属：把各通道的区域汇总成一张列表，方便统一改名 / 开关 */
const zoneRows = computed(() =>
  (props.cameras || []).flatMap((cam) =>
    (cam.zones || []).map((z) => ({ camId: cam.id, camName: cam.name, zone: z }))
  )
)

/* ---------- 计数推送间隔：常用档位下拉 + 自定义值自动入列 ---------- */
const COUNT_INTERVAL_PRESETS = [
  { value: 600, label: '10 分钟' },
  { value: 1800, label: '30 分钟' },
  { value: 3600, label: '1 小时' },
  { value: 14400, label: '4 小时（默认）' },
  { value: 43200, label: '12 小时' },
  { value: 86400, label: '24 小时' }
]

/** 旧配置里可能是任意秒数（比如老默认 60），下拉里要能原样显示而不是被悄悄改掉 */
function formatInterval(sec) {
  if (sec % 3600 === 0) return `${sec / 3600} 小时`
  if (sec % 60 === 0) return `${sec / 60} 分钟`
  return `${sec} 秒`
}

const countIntervalPicked = computed({
  get: () => Number(opts.zone && opts.zone.countIntervalSec) || 14400,
  set: (v) => {
    opts.zone.countIntervalSec = Number(v) || 14400
  }
})

const countIntervalChoices = computed(() => {
  const cur = countIntervalPicked.value
  const list = COUNT_INTERVAL_PRESETS.slice()
  if (!list.some((p) => p.value === cur)) {
    list.push({ value: cur, label: `自定义 · ${formatInterval(cur)}` })
    list.sort((a, b) => a.value - b.value)
  }
  return list
})


function zoneUpdate(camId, zoneId, patch) {
  const cam = (props.cameras || []).find((c) => c.id === camId)
  if (!cam) return
  const next = (cam.zones || []).map((z) => (z.id === zoneId ? { ...z, ...patch } : { ...z }))
  emit('update-cameras', { id: camId, zones: next })
}

function zoneRemove(camId, zoneId) {
  const cam = (props.cameras || []).find((c) => c.id === camId)
  if (!cam) return
  emit('update-cameras', { id: camId, zones: (cam.zones || []).filter((x) => x.id !== zoneId) })
}
const hidden = ref([...props.hiddenIds])
const fileEl = ref(null)

function clone(list) {
  return list.map((c) => ({
    ...c,
    roi: c.roi ? { ...c.roi } : null,
    rect: c.rect ? { ...c.rect } : null,
    channels: c.channels ? { ...c.channels } : { ding: true, wecom: true, tg: true },
    aiExt: c.aiExt ? { ...c.aiExt } : { face: true, pose: true, zone: true, enterExit: true },
    /*
     * 通道静默必须**深拷贝**（slots 是数组）。只靠上面的 `...c` 会与外面的
     * cam.silent 共享同一个对象 —— 在抽屉里改时段会立刻写进真实配置，
     * 点「取消」也回不去（取消只丢弃本地副本，改动早就漏出去了）。
     */
    silent: c.silent ? JSON.parse(JSON.stringify(c.silent)) : defaultCamSilent()
  }))
}

watch(
  () => props.cameras,
  (list) => {
    cams.value = clone(list)
  },
  { immediate: true }
)

watch(
  () => props.hiddenIds,
  (ids) => {
    hidden.value = [...ids]
  }
)

function uid() {
  return `cam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/* ---------- 同时播放通道 / 自定义档位 ---------- */
/** 自定义同时播放通道（勾选哪几路就只播哪几路；空数组 = 走「前 N 路」规则） */
const autoPlayIds = computed({
  get: () => (Array.isArray(opts.autoPlayIds) ? opts.autoPlayIds : []),
  set: (v) => {
    opts.autoPlayIds = Array.isArray(v) ? v : []
  }
})

const AUTO_COUNT_PRESETS = [0, 1, 2, 4, 99]
const MAX_DECODE_PRESETS = [0, 1, 2, 4, 6, 9]
/** 当前值不在预设档位里时，下拉框自动落到「自定义…」并显示数字输入框 */
const autoCountCustom = ref(!AUTO_COUNT_PRESETS.includes(Number(opts.autoPlayCount)))
const maxDecodeCustom = ref(!MAX_DECODE_PRESETS.includes(Number(opts.maxDecode)))

function onAutoCountSelect(v) {
  if (v === 'custom') {
    autoCountCustom.value = true
    if (!Number(opts.autoPlayCount)) opts.autoPlayCount = 3
    return
  }
  autoCountCustom.value = false
  opts.autoPlayCount = Number(v)
}

function onMaxDecodeSelect(v) {
  if (v === 'custom') {
    maxDecodeCustom.value = true
    if (!Number(opts.maxDecode)) opts.maxDecode = 3
    return
  }
  maxDecodeCustom.value = false
  opts.maxDecode = Number(v)
}

/** 加入 / 移出「同时播放」，并按通道列表顺序规范化（顺序即播放优先级） */
function toggleAutoPlay(id) {
  const cur = autoPlayIds.value.filter((x) => x !== id)
  if (!autoPlayIds.value.includes(id)) cur.push(id)
  autoPlayIds.value = cams.value.filter((c) => cur.includes(c.id)).map((c) => c.id)
}

/** 删除通道时，顺手把它从同时播放列表里摘掉 */
function pruneAutoPlayIds(list) {
  const ids = new Set(list.map((c) => c.id))
  const picked = autoPlayIds.value
  if (picked.some((id) => !ids.has(id))) {
    autoPlayIds.value = picked.filter((id) => ids.has(id))
  }
  // 顺序始终跟随通道列表，保证「第 1 路先播」的直觉
  autoPlayIds.value = list.filter((c) => autoPlayIds.value.includes(c.id)).map((c) => c.id)
}

/** 导入配置后重新判定下拉框是否落在「自定义…」档位 */
function syncCustomFlags() {
  autoCountCustom.value = !AUTO_COUNT_PRESETS.includes(Number(opts.autoPlayCount))
  maxDecodeCustom.value = !MAX_DECODE_PRESETS.includes(Number(opts.maxDecode))
}

/** 「播放性能」页签上的路数徽标：优先显示自定义通道数 */
const playBadgeText = computed(() => {
  const picked = autoPlayIds.value.length
  if (picked) return `${picked} 路`
  const n = Number(opts.autoPlayCount)
  if (n >= 99) return '全部'
  if (n === 0) return '手动'
  return `${n} 路`
})

const playBadgeClass = computed(() =>
  autoPlayIds.value.length || Number(opts.autoPlayCount) > 0 ? 'ok' : 'muted'
)

/**
 * 「状态巡检」页签徽标：只反映**全局**总开关
 * （异常推送 opts.statusAlerts 或 定时巡检 opts.patrol，任一开启即算 on）。
 *
 * 为什么不把渠道级子开关算进来：正文那两枚「已启用 / 未启用」芯片读的就是全局值，
 * 徽标必须与它同源。混进渠道级字段会出现「正文写未启用、页签亮 on」的矛盾观感 ——
 * 而渠道级默认值恰好是 true，所以只要全局没开，这个矛盾就必然出现。
 * 至于「全局开了但三个渠道全关 → 其实也不会推」，那是用户自己在渠道勾选里做的取舍，
 * 不该由页签徽标来"纠正"，否则用户会找不到开关到底在哪。
 */
const statusBadgeOn = computed(() => !!(opts.statusAlerts?.enabled || opts.patrol?.enabled))

function addCamera() {
  cams.value.push({
    id: uid(),
    name: `画面 ${cams.value.length + 1}`,
    url: '',
    motion: true,
    ai: false,
    // 附加能力与区域列表要一起给，否则新通道的 cam.aiExt 是 undefined，
    // 后面按「!== false」判断时看着像开着，开关列却渲染不出正确状态
    aiExt: { face: true, pose: true, zone: true, enterExit: true },
    blind: false,
    roi: null,
    rect: null,
    push: true,
    channels: { ding: true, wecom: true, tg: true },
    zones: [],
    // 通道静默要给默认值，否则新加的通道 cam.silent 是 undefined，
    // 卡片里的静默开关读不到字段、状态会显示成"未开启"却又点不动时段
    silent: defaultCamSilent(),
    // 日常事件静默同理：新通道也带上，别等用户点一下开关才长出这个字段
    digest: defaultCamDigest()
  })
}

const aiStateText = computed(() => {
  if (aiState.value === 'loading') return '模型加载中'
  if (aiState.value === 'ready') return 'AI 就绪'
  if (aiState.value === 'error') return 'AI 加载失败'
  return 'AI 未加载'
})

/** 变动档次的解释：说明门槛与灵敏度是「取较大者」的关系 */
const motionLevelHint = computed(() => {
  const v = Number(opts.motionMinPercent) || 0
  if (v <= 0) return '不设门槛，完全按灵敏度判断'
  return `画面变动面积达到 ${v}% 才算异常（低于它的抖动被忽略，不通知也不推送）；与灵敏度取较大者生效`
})

/**
 * 是否跑在后端检测模式（服务端推理、浏览器不加载模型）。
 * 与 App.vue 的 backendActive 同一个判据（backendOn 纯函数，单一来源）。
 */
const backendModeOn = computed(() => backendOn(opts))

const modelDesc = computed(() => {
  const m = AI_MODELS.find((x) => x.key === opts.aiModel) || AI_MODELS[1]
  const base = `${m.desc} · 模型文件 ${m.size} MB`
  // 后端模式下人形识别跑在服务端，模型也由服务端加载 —— 不说清楚的话，
  // 用户在页面上换了模型只会看到"没有变化"（浏览器压根没在推理）
  return backendModeOn.value ? `${base} · 后端模式：由服务端加载并热切换` : base
})

/**
 * 「分析频率」到底在调哪一端，取决于检测跑在哪。
 * 后端模式下浏览器不推理（aiEnabled 被临时置 false），这个值通过配置同步
 * 变成服务端的抽帧帧率；前端模式下它管浏览器自己的抽样节奏。
 * 两处是同一个概念，所以共用这一个控件，但必须说明白，否则用户改完
 * 发现"没用"——其实是作用在另一头。
 */
const sampleFpsHint = computed(() =>
  backendModeOn.value
    ? '服务端每秒抽帧分析的帧数，越高越灵敏但更费 CPU（改后自动重连拉流）'
    : '每秒取样分析的帧数，越高越灵敏但更耗 CPU'
)

const backendText = computed(() => {
  if (aiState.value === 'error') return '失败'
  if (aiState.value === 'loading') return '加载中'
  if (aiState.value !== 'ready') return '待启用'
  return aiBackend.value === 'webgpu' ? 'WebGPU 硬件加速' : 'CPU (WASM)'
})

const backendDesc = computed(() => {
  if (aiState.value === 'error') return aiError.value || '模型加载失败'
  if (aiState.value !== 'ready') return '开启后自动选择最优后端'
  return aiBackend.value === 'webgpu'
    ? `走显卡推理，几乎不占 CPU，单帧约 ${aiCost.value || '-'} ms`
    : `未启用 WebGPU，走 CPU 推理，单帧约 ${aiCost.value || '-'} ms；建议改用更小的模型`
})

function toggleAi() {
  opts.aiEnabled = !opts.aiEnabled
  if (opts.aiEnabled) {
    loadPersonModel(opts.aiModel).catch(() => {})
  } else {
    releaseModel()
  }
}

/**
 * 切换 GPU 加速。
 * 关键点：WebGPU 的 wasm trap 是「线程级」故障，只清 readyKey 不够 ——
 * 必须把旧会话真的释放掉，Worker 才会按新偏好重建 WASM 会话。
 */
function toggleAiGpu() {
  opts.aiGpu = !opts.aiGpu
  setGpuPref(opts.aiGpu)
  if (opts.aiEnabled) {
    // 先全量释放，再按当前偏好重新加载
    releaseModel()
    loadPersonModel(opts.aiModel).catch(() => {})
  }
}

/* ---------- 系统通知授权 ---------- */
/**
 * 三端统一走 useSystemNotify（Electron 原生 / iOS 本地通知 / 浏览器 Notification）。
 * 打开开关时顺手申请权限 —— iOS 首次会弹系统授权框，浏览器弹授权气泡；
 * 被拒绝过的话 iOS 再调不会弹框，只能引导用户去系统设置里手动打开。
 */
async function toggleDesktopNotify() {
  const next = !opts.alert.desktopNotify
  opts.alert.desktopNotify = next
  if (!next) return
  const granted = await requestNotifyPermission()
  if (!granted && sysNotifyState.permission === 'denied') {
    testState.kind = 'fail'
    testState.text = '通知权限已被拒绝，请到系统设置里手动允许后重试'
  } else if (!granted && sysNotifyState.permission === 'unsupported') {
    testState.kind = 'fail'
    testState.text = '当前环境不支持系统通知'
  }
}

/** 开关旁边的一句话状态（让用户知道现在到底能不能收到） */
const notifyLine = computed(() => {
  if (!opts.alert.desktopNotify) return '已关闭'
  return sysNotifySummary()
})

/* ---------- 钉钉推送 ---------- */
const dt = computed(() => opts.dingtalk)
const testState = reactive({ kind: '', text: '' })

/**
 * 这一路当前是否会推送到渠道 ch。
 * = 通道级总开关（cam.push）+ 该渠道小勾（cam.channels[ch]）—— 唯一权威口径，
 * 与 useAlertPush.checkChannel 完全一致。
 */
function camPushOn(cam, ch) {
  return cam.push !== false && channelOn(cam, ch)
}

/** 当前会推送到钉钉的通道数（用于「没有通道会推送」这句提示） */
const pushCamCount = computed(() => cams.value.filter((c) => camPushOn(c, 'ding')).length)

/**
 * 渠道页的「需要推送的监控」标签 —— 写回**通道级**开关，而不是改那份派生名单。
 * 关：只取消这一路对钉钉的勾（总开关与其他渠道不受影响）；
 * 开：把这一路对钉钉打开，并顺带抬起总开关（否则小勾是灰的、等于没开）。
 *
 * ⚠️ 这里刻意**不去改** `opts.dingtalk.cameras` ——
 * 那份名单是通道级配置的派生结果，抽屉里改的是「本地副本 + 共享 options」两样东西，
 * 保存前两者并不同步；在这里顺手写名单只会和 App 侧落盘时的重算互相覆盖。
 * 统一由 save() / 落盘 / 载入时的 syncChannelCameras 一次性对齐。
 */
function togglePushCamera(id) {
  const cam = cams.value.find((c) => c.id === id)
  if (!cam) return
  if (camPushOn(cam, 'ding')) {
    ensureChannels(cam).ding = false
  } else {
    ensureChannels(cam).ding = true
    cam.push = true
  }
}

/** 全选 / 清空：批量改通道级的钉钉小勾 */
function setAllPushCameras(on) {
  cams.value.forEach((cam) => {
    ensureChannels(cam).ding = on
    if (on) cam.push = true
  })
}

async function testPush() {
  testState.kind = 'loading'
  testState.text = '发送中…'
  try {
    const cam = cams.value[0] || {}
    const sample = {
      id: cam.id || 'cam-1',
      name: cam.name || '测试通道',
      type: 'person',
      ratio: 0.88,
      time: Date.now(),
      thumb: '',
      seq: 1,
      url: cam.url || '',
      roi: cam.roi || null,
      resolution: '1920×1080 · H265(HEVC)',
      fps: 25,
      kbps: 2860
    }
    const msg = buildAlarmMessage(sample, { ...dt.value, titlePrefix: `【测试】${dt.value.titlePrefix || ''}` }, '')
    // 钉钉 @指定人：必须把 @手机号 字面写进正文，机器人才能真正通知到人
    const atMobiles = parseMobiles(dt.value.atMobiles)
    const atAll = !!dt.value.atAll
    let body = msg
    if (atMobiles.length) {
      const tokens = atMobiles.map((m) => `@${m}`).join(' ')
      body = { ...msg, text: `${msg.text || ''}\n${tokens}` }
    }
    await sendDingTalk(
      { webhook: dt.value.webhook, secret: dt.value.secret, useProxy: dt.value.useProxy },
      { ...body, msgType: dt.value.msgType, atAll, atMobiles }
    )
    testState.kind = 'ok'
    testState.text = atAll
      ? '发送成功（已@所有人），请查看钉钉群'
      : atMobiles.length
        ? `发送成功（已@ ${atMobiles.length} 个手机号），请查看钉钉群`
        : '发送成功，请查看钉钉群'
  } catch (e) {
    testState.kind = 'fail'
    testState.text = (e && e.message) || '发送失败'
  }
}

/* ---------- 钉钉「关键事件独立机器人」连通性测试 ---------- */
const dtCritState = reactive({ kind: '', text: '' })

async function testDingCritical() {
  dtCritState.kind = 'loading'
  dtCritState.text = '发送中…'
  try {
    const c = (dt.value && dt.value.critical) || {}
    if (!String(c.webhook || '').trim()) throw new Error('还没有填写关键事件机器人的 Webhook')
    const msgType = c.msgType || 'markdown'
    // 钉钉 @指定人：必须把 @手机号 字面写进正文，机器人才能真正通知到人
    const atMobiles = parseMobiles(c.atMobiles)
    const atAll = !!c.atAll
    let bodyText =
      msgType === 'text'
        ? `【测试】关键事件独立机器人连通性测试：配置正常，关键事件会推送到本群。`
        : `**【测试】关键事件独立机器人**\n> 配置正常，关键事件（静默 / 人脸命中 / 满库）会推送到本群。`
    if (atMobiles.length) bodyText = `${bodyText}\n${atMobiles.map((m) => `@${m}`).join(' ')}`
    await sendDingTalk(
      { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy !== false, proxyBase: c.proxyBase || '' },
      { title: `【测试】${c.titlePrefix || ''}`, text: bodyText, msgType, atAll, atMobiles }
    )
    dtCritState.kind = 'ok'
    dtCritState.text = atAll
      ? '发送成功（已@所有人），请到关键事件所在的那个钉钉群确认'
      : atMobiles.length
        ? `发送成功（已@ ${atMobiles.length} 个手机号），请到关键事件所在的那个钉钉群确认`
        : '发送成功，请查看关键事件所在的那个钉钉群'
  } catch (e) {
    dtCritState.kind = 'fail'
    dtCritState.text = (e && e.message) || '发送失败'
  }
}

/* ---------- 企业微信推送 ---------- */
/*
 * 只做纯引用。旧配置字段的补齐已经在上面的 setup 阶段一次性做完了 ——
 * 这里若再调 normalizeWeCom() 会原地写 opts.wecom.events，造成渲染死循环。
 */
const wc = computed(() => opts.wecom)
const wcState = reactive({ kind: '', text: '' })

/** 钉钉 / 企业微信「截图方式」下拉框下方的说明文字 */
const dingShotHint = computed(() => {
  switch (dt.value.screenshotMode) {
    case 'tg':
      return '消息末尾附一条 Telegram 原图链接，不传图片、零额外开销'
    case 'litterbox':
      return '上传到零配置图床后直接嵌图（国内可直连，最长 72 小时），链接照旧带上'
    case 'upload':
      return '钉钉要求图片是公网 http(s) 地址，需自备上传接口'
    default:
      return '既不带图也不带链接，钉钉群里只有文字'
  }
})

const wcShotHint = computed(() => {
  switch (wc.value.screenshotMode) {
    case 'image':
      return 'image 消息直接发图，不需要图床（超过 2MB 会自动压缩）'
    case 'tg':
      return '在文字消息里附一条 Telegram 原图链接（拿不到消息链接时给群链接）'
    case 'litterbox':
      return '上传到零配置图床后在文字消息里附链接'
    default:
      return '不附带截图，仅本地留档'
  }
})

/** 本地格式校验（企业微信没有「查机器人信息」接口，只能本地校验 + 实发一条） */
function checkWecom() {
  wcState.kind = 'loading'
  wcState.text = '正在检查配置…'
  try {
    const url = normalizeWeComWebhook(wc.value.webhook)
    if (!url) throw new Error('还没有填写群机器人 Webhook')
    if (!/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send/i.test(url)) {
      if (!/\/cgi-bin\/webhook\/send/i.test(url)) {
        throw new Error('地址看起来不是群机器人 Webhook，应形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx')
      }
    }
    let key = ''
    try {
      key = new URL(url).searchParams.get('key') || ''
    } catch (e) {
      throw new Error('Webhook 地址格式不正确')
    }
    if (!key) throw new Error('地址里没有找到 key 参数')
    if (!/^[0-9a-f-]{16,}$/i.test(key)) throw new Error('key 格式看起来不对（应为一段 UUID）')
    wcState.kind = 'ok'
    wcState.text = `✓ 地址格式正确（key: ${key.slice(0, 8)}…）。点「发送测试」向群里实发一条消息验证连通性。`
  } catch (e) {
    wcState.kind = 'fail'
    wcState.text = (e && e.message) || '检查失败'
  }
}

/** 向企业微信群机器人发一条测试消息 */
async function testWecom() {
  wcState.kind = 'loading'
  wcState.text = '正在发送测试消息…'
  try {
    // 企业微信 markdown 不支持 @：配置了 @ 时自动改用 text 消息，保证测试真的能 @ 到人
    const atMobiles = parseMobiles(wc.value.atMobiles)
    const atAll = !!wc.value.atAll
    const needAt = atAll || atMobiles.length > 0
    const msgType = needAt ? 'text' : (wc.value.msgType || 'markdown')
    const mdContent = '**【监控报警】企业微信推送连通性测试**\n> 配置正常，报警事件会推送到本群。'
    const textContent = '【监控报警】企业微信推送连通性测试：配置正常，报警事件会推送到本群。'
    const content = needAt ? textContent : mdContent
    await sendWeCom(wc.value, {
      msgType,
      content,
      atAll: needAt ? atAll : false,
      atMobiles: needAt ? atMobiles : []
    })
    wcState.kind = 'ok'
    wcState.text = atAll
      ? '✓ 测试消息已发送（已@所有人），请到企业微信群里确认'
      : atMobiles.length
        ? `✓ 测试消息已发送（已@ ${atMobiles.length} 个手机号），请到企业微信群里确认`
        : '✓ 测试消息已发送，请到企业微信群里确认'
  } catch (e) {
    wcState.kind = 'fail'
    wcState.text = (e && e.message) || '发送失败'
  }
}

/* ---------- 企业微信「关键事件独立机器人」连通性测试 ---------- */
const wcCritState = reactive({ kind: '', text: '' })

async function testWecomCritical() {
  wcCritState.kind = 'loading'
  wcCritState.text = '正在发送测试消息…'
  try {
    const c = (wc.value && wc.value.critical) || {}
    if (!String(c.webhook || '').trim()) throw new Error('还没有填写关键事件机器人的 Webhook')
    // 企业微信 markdown 不支持 @：配置了 @ 时自动改用 text 消息，保证测试真的能 @ 到人
    const atMobiles = parseMobiles(c.atMobiles)
    const atAll = !!c.atAll
    const needAt = atAll || atMobiles.length > 0
    const msgType = needAt ? 'text' : (c.msgType || 'markdown')
    const mdContent = '**【测试】关键事件独立机器人**\n> 配置正常，关键事件（静默 / 人脸命中 / 满库）会推送到本群。'
    const textContent = '【测试】关键事件独立机器人连通性测试：配置正常，关键事件会推送到本群。'
    const content = needAt ? textContent : mdContent
    await sendWeCom(
      { webhook: c.webhook, proxyBase: c.proxyBase || '' },
      { msgType, content, atAll: needAt ? atAll : false, atMobiles: needAt ? atMobiles : [] }
    )
    wcCritState.kind = 'ok'
    wcCritState.text = atAll
      ? '✓ 测试消息已发送（已@所有人），请到关键事件所在的那个企业微信群确认'
      : atMobiles.length
        ? `✓ 测试消息已发送（已@ ${atMobiles.length} 个手机号），请到关键事件所在的那个企业微信群确认`
        : '✓ 测试消息已发送，请到关键事件所在的那个企业微信群确认'
  } catch (e) {
    wcCritState.kind = 'fail'
    wcCritState.text = (e && e.message) || '发送失败'
  }
}

/* ---------- 通道级推送开关（每一路单独选渠道） ---------- */
function ensureChannels(cam) {
  if (!cam.channels || typeof cam.channels !== 'object') {
    cam.channels = { ding: true, wecom: true, tg: true }
  }
  return cam.channels
}

function channelOn(cam, ch) {
  const c = ensureChannels(cam)
  return c[ch] !== false
}

function toggleCamChannel(cam, ch) {
  const c = ensureChannels(cam)
  c[ch] = c[ch] === false
}

function togglePushCam(cam) {
  cam.push = cam.push === false
}

/* ---------- 通道静默（每一路单独配时段 + 渠道） ---------- */

/**
 * 只读地取这一路的静默配置。不存在时返回一个空常量，**不在渲染期写状态** ——
 * 渲染期补字段等于边渲染边改响应式数据（本项目对此有前车之鉴）。
 * 真正要写的时候走下面的 ensureCamSil。
 */
const EMPTY_CAM_SILENT = {
  enabled: false,
  slots: [],
  channels: [],
  tempUntil: 0,
  tempSince: 0,
  tempChannels: [],
  tempLabel: ''
}
function camSilCfg(cam) {
  return cam && cam.silent && typeof cam.silent === 'object' ? cam.silent : EMPTY_CAM_SILENT
}

/** 写之前才把配置对象补齐（只在事件处理里调用） */
function ensureCamSil(cam) {
  if (!cam.silent || typeof cam.silent !== 'object') cam.silent = defaultCamSilent()
  const s = cam.silent
  if (!Array.isArray(s.slots)) s.slots = []
  if (!Array.isArray(s.channels)) s.channels = [...DEFAULT_CAM_SILENT_CHANNELS]
  return s
}

function camSilChannels(cam) {
  const c = camSilCfg(cam).channels
  return Array.isArray(c) ? c : []
}

/**
 * 这一路此刻的通道静默状态 —— 直接调调度器用的同一个纯函数（camSilentState），
 * 界面与引擎同源。各算一份的话，迟早出现「界面显示静默中、实际没静默」。
 */
function camSilInfo(cam) {
  return camSilentState(cam)
}
function camSilActive(cam) {
  return camSilInfo(cam).active === true
}

function toggleCamSilent(cam) {
  const s = ensureCamSil(cam)
  s.enabled = !s.enabled
  // 开启时补一个默认时段：开了却没有任何时段，看起来会像"没生效"
  if (s.enabled && !s.slots.length) s.slots.push({ start: '19:00', end: '08:00', scope: 'all' })
}

function toggleCamSilChannel(cam, ch) {
  const s = ensureCamSil(cam)
  /*
   * 刻意允许取消到空（不像「远程静默默认渠道」那样"一个都不选就拒绝"）：
   * 这里是长期配置，先清空再逐个勾是很自然的操作，卡住反而别扭。
   * 空数组在 camSilentState 里就是不生效，行为明确、不会静默掉别的东西。
   */
  s.channels = s.channels.includes(ch) ? s.channels.filter((x) => x !== ch) : [...s.channels, ch]
}

function addCamSilSlot(cam) {
  ensureCamSil(cam).slots.push({ start: '12:00', end: '13:00', scope: 'all' })
}
function removeCamSilSlot(cam, i) {
  ensureCamSil(cam).slots.splice(i, 1)
}

/* ---------- 日常事件静默（每一路单独配间隔 + 渠道） ---------- */

/**
 * 只读地取这一路的日常静默配置 —— 直接复用 defaults 的 digestCfgOf。
 * 它返回的是**兜底后的副本**（缺字段给默认值、不往 cam 上补字段），
 * 正是渲染期该用的东西；真正要写的时候走下面的 ensureCamDigest。
 */
function camDigestCfg(cam) {
  return digestCfgOf(cam)
}

/** 写之前才把配置对象补齐（只在事件处理里调用） */
function ensureCamDigest(cam) {
  if (!cam.digest || typeof cam.digest !== 'object') cam.digest = defaultCamDigest()
  const d = cam.digest
  d.intervalMinutes = clampDigestMinutes(d.intervalMinutes)
  if (!Array.isArray(d.channels)) d.channels = [...DEFAULT_CAM_DIGEST_CHANNELS]
  return d
}

/**
 * 这一路此刻的日常静默状态 —— 与引擎（useAlertPush.digestStateOf）用的是
 * **同一个纯函数** camDigestState，只是喂进去的「此刻有没有静默窗口」由界面这边的
 * 三份状态拼出来：
 *   ① 全局免打扰时段（silentActiveNow）
 *   ② 全局临时静默（tempActive）
 *   ③ 这一路的通道静默（camSilActive）
 * 各算一份的话，迟早出现「界面说在汇总、实际没汇总」。
 */
function camDigestInfo(cam) {
  return camDigestState(cam, {
    silentActive: silentActiveNow.value || tempActive.value || camSilActive(cam)
  })
}

function toggleCamDigest(cam) {
  const d = ensureCamDigest(cam)
  d.enabled = !d.enabled
}

function toggleCamDigestChannel(cam, ch) {
  const d = ensureCamDigest(cam)
  // 与通道静默一致：刻意允许清空（空数组即不生效，行为明确，不会静默掉别的东西）
  d.channels = d.channels.includes(ch) ? d.channels.filter((x) => x !== ch) : [...d.channels, ch]
}

function setCamDigestInterval(cam, v) {
  ensureCamDigest(cam).intervalMinutes = clampDigestMinutes(v)
}

/** 总开关：是否所有通道都开了日常事件静默 */
const allDigestOn = computed(() =>
  cams.value.length > 0 && cams.value.every((c) => !!(c.digest && c.digest.enabled === true))
)
/** 部分通道开了（用于总开关显示中间态） */
const someDigestOn = computed(() =>
  cams.value.some((c) => !!(c.digest && c.digest.enabled === true))
)

/** 总开关旁的「汇总间隔」选择器：把已开启的通道对齐到该间隔；关闭的通道保留各自缓存的间隔 */
function setMasterDigestInterval(v) {
  const iv = clampDigestMinutes(v)
  opts.digestIntervalMinutes = iv
  // 仅对齐当前已开启的通道；关闭的通道不动，使其缓存的间隔在再次开启时回显原值
  cams.value.forEach((cam) => {
    const d = ensureCamDigest(cam)
    if (d.enabled) d.intervalMinutes = iv
  })
}

/** 一键开启 / 关闭所有通道的日常事件静默（保留各通道独立的渠道与间隔设置） */
function toggleAllCamDigest() {
  const turnOn = !allDigestOn.value
  // 保留各通道已配置的间隔，不强行套用总开关间隔（关闭再开应回显原值）；
  // 仅当开启时该路没选渠道才补默认渠道（camDigestState 要求 channels 非空，否则开了也不生效）
  cams.value.forEach((cam) => {
    const d = ensureCamDigest(cam)
    d.enabled = turnOn
    if (turnOn && !d.channels.length) d.channels = [...DEFAULT_CAM_DIGEST_CHANNELS]
  })
}

/* ---------- 配置方案（多套配置保存 / 切换 / 导入导出） ---------- */
const PROFILE_KEY = 'monitor-wall-profiles-v1'
const profileName = ref('')
const activeProfileId = ref('')

const profiles = ref(loadProfiles())

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function persistProfiles() {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles.value))
  } catch (e) {
    alertDialog({ title: '保存失败', message: '方案保存失败（本地存储不可用）：' + ((e && e.message) || e), variant: 'danger' })
  }
}

function snapshot() {
  return {
    cameras: JSON.parse(JSON.stringify(cams.value)),
    options: JSON.parse(JSON.stringify(opts)),
    hiddenIds: [...hidden.value],
    layoutKey: props.layoutKey
  }
}

function saveProfile() {
  const name = String(profileName.value || '').trim()
  if (!name) {
    alertDialog({ title: '请填写名称', message: '请先填一个方案名称' })
    return
  }
  const snap = snapshot()
  const hit = profiles.value.find((p) => p.name === name)
  const id = hit ? hit.id : `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const item = {
    id,
    name,
    count: cams.value.length,
    updatedAt: Date.now(),
    data: snap
  }
  if (hit) profiles.value = profiles.value.map((p) => (p.id === hit.id ? item : p))
  else profiles.value = [...profiles.value, item]
  persistProfiles()
  activeProfileId.value = id
  profileName.value = ''
  testState.kind = 'ok'
  testState.text = `方案「${name}」已保存`
}

function applyProfile(p) {
  const d = p && p.data
  if (!d) return
  cams.value = JSON.parse(JSON.stringify(d.cameras || []))
  const merged = { ...cloneDefaultOptions(), ...(d.options || {}) }
  Object.keys(opts).forEach((k) => delete opts[k])
  Object.assign(opts, merged)
  hidden.value = Array.isArray(d.hiddenIds) ? [...d.hiddenIds] : []
  activeProfileId.value = p.id
  if (d.layoutKey) emit('update:layoutKey', d.layoutKey)
  testState.kind = 'ok'
  testState.text = `已切换到方案「${p.name}」，记得点右下角「保存并应用」生效`
}

async function removeProfile(id) {
  const hit = profiles.value.find((p) => p.id === id)
  if (!hit) return
  if (!(await confirmDialog({ title: '删除方案', message: `确定删除方案「${hit.name}」？`, variant: 'danger' }))) return
  profiles.value = profiles.value.filter((p) => p.id !== id)
  persistProfiles()
  if (activeProfileId.value === id) activeProfileId.value = ''
}

function formatDate(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ---------- 本地存储占用（报警记录 + 截图） ---------- */
const storageInfo = ref(null)
const storageText = computed(() => {
  const s = storageInfo.value
  if (!s) return '统计中…'
  if (!s.quota) return '当前环境不支持容量统计'
  return `已用 ${formatBytes(s.usage || 0)} / 可用 ${formatBytes(s.quota || 0)}`
})

async function refreshStorage() {
  try {
    storageInfo.value = await estimateUsage()
  } catch (e) {
    storageInfo.value = { usage: 0, quota: 0 }
  }
}

watch(
  () => [tab.value, opts.maxEvents],
  ([t]) => {
    if (t === 'profiles') refreshStorage()
  }
)

/* ---------- Telegram 推送 ---------- */
/* 同上：补齐已在 setup 阶段做完，这里只做纯引用 */
const tg = computed(() => opts.telegram)
const botState = reactive({ kind: '', text: '' })

/** 校验 Token + 会话 id，能立刻发现 chat_id 少了 -100 前缀这类问题 */
async function checkBot() {
  botState.kind = 'loading'
  botState.text = '正在校验机器人与会话…'
  try {
    const me = await getBotInfo(tg.value.token)
    const chat = await getChatInfo(tg.value)
    botState.kind = 'ok'
    botState.text = `✓ 机器人 @${me.username} 正常；目标会话：${
      chat.title || chat.username || chat.id
    }（${chat.type}）`
  } catch (e) {
    botState.kind = 'fail'
    botState.text = (e && e.message) || '校验失败'
  }
}

/** 发一条测试消息 */
async function testTelegram() {
  botState.kind = 'loading'
  botState.text = '正在发送测试消息…'
  try {
    const me = await getBotInfo(tg.value.token)
    await sendTelegramText(
      tg.value,
      `✅ <b>连通性测试</b>\n机器人 @${me.username} 正常，监控报警会推送到这里。`
    )
    botState.kind = 'ok'
    botState.text = '✓ 测试消息已发送，请到 Telegram 里确认'
  } catch (e) {
    botState.kind = 'fail'
    botState.text = (e && e.message) || '发送失败'
  }
}

/* ---------------- 关键事件单独提醒（私聊推送） ---------------- */

/** 五类关键事件。key 与 useTelegram.directPushEventOn 的 kind 一一对应 */
const DIRECT_EVENT_OPTS = [
  { id: 'silence', label: '静默开始/结束', desc: '免打扰时段开始与结束的状态提醒（各一条）' },
  { id: 'summary', label: '静默汇总', desc: '免打扰结束时，把本时段收存的报警汇总成一条' },
  { id: 'face', label: '在库人脸命中', desc: '识别到人脸库里的人时，带图单独提醒' },
  { id: 'pending', label: '待录入满库', desc: '未建档人脸攒满收集上限时，提醒及时处理（每个填满周期只提醒一次）' },
  { id: 'flow', label: '人员走向', desc: '匹配到跨摄像头走向（且该条流向开了「作为关键事件实时推送」）时，带图单独提醒' }
]

const newDirectId = ref('')
const directIdError = ref('')
/** 试发结果（贴着按钮显示，不弹窗） */
const directState = reactive({ kind: '', text: '' })

/**
 * 判据与调度层同源（useTelegram 的纯函数），不在组件里再推一遍逻辑 ——
 * 否则界面"已勾选"和实际"发不发"会走偏。
 * ⚠️ 判据是 `!== false`（缺省即开）：老配置没有这个字段时照样算勾上。
 */
function directEventOn(kind) {
  return tgDirectEventOn(tg.value, kind)
}

function toggleDirectEvent(kind) {
  const dp = tg.value.directPush
  if (!dp) return
  if (!dp.events || typeof dp.events !== 'object') dp.events = {}
  dp.events[kind] = !directEventOn(kind)
}

/** 与推送调度器同一份计算（含「授权用户名单 + 额外 id，去重去主会话」） */
const directRecipients = computed(() => tgDirectRecipients(tg.value))

function addDirectId() {
  const v = String(newDirectId.value || '').trim()
  // 只收纯数字：填 @用户名 / 群 id 都发给不了私聊，早点报错比运行时静默失败好
  if (!/^\d+$/.test(v)) {
    directIdError.value = '用户 id 应为纯数字（在 Telegram 里找 @userinfobot 查询）'
    return
  }
  directIdError.value = ''
  if (!tg.value.directPush.chatIds.includes(v)) tg.value.directPush.chatIds.push(v)
  newDirectId.value = ''
}

/**
 * 试发一条私聊，逐个接收人串行发（与调度层一致，避免并发触发 TG 限流）。
 * 走的是真实 Bot API，所以能直接验证「这个人到底收不收得到」——
 * 最常见的失败原因就是对方从没私聊过机器人。
 */
async function testDirectPush() {
  const to = directRecipients.value
  if (!to.length) {
    directIdError.value = '没有可用的接收人：授权用户名单为空，且未额外添加'
    return
  }
  directIdError.value = ''
  directState.kind = 'loading'
  directState.text = '正在发送…'
  const results = []
  for (const id of to) {
    try {
      await sendTelegramText(
        { ...tg.value, chatId: id },
        '✅ <b>关键事件单独提醒 · 测试</b>\n收到这条说明机器人可以私聊推送给这个会话。'
      )
      results.push(`${id} ✅`)
    } catch (e) {
      results.push(`${id} ❌ ${(e && e.message) || '失败'}`)
    }
  }
  const allOk = results.every((r) => r.endsWith('✅'))
  directState.kind = allOk ? 'ok' : 'fail'
  directState.text = `试发结果：${results.join('；')}`
}

/* ---------------- 远程控制（方案 C，TG 私聊指令） ---------------- */
/**
 * 指令清单。与后端 server/tg-remote.mjs 的 COMMANDS 一一对应 ——
 * 那份才是真正注册到 TG 命令菜单的（`/help` 与命令菜单都由它生成），
 * 这里只是把说明也展示出来，免得用户还要去翻后端代码才知道有哪些指令。
 *
 * ⚠️ 这是**有意为之的第二份**：前端不能直接 import 那个模块（它顶层用了
 * node:fs / node:path，进不了浏览器打包）。所以**新增指令时两处都要改**。
 * 只改后端 → 指令能用但设置页看不到；只改这里 → 列表里有但发出去是「未知指令」。
 * `/tmp/hits-img-probe/parity-commands.mjs` 里有一组断言专门盯着这份列表：
 * 逐条比对 cmd 与 **usage**（用户照着设置页抄的用法串必须与后端逐字一致），
 * 并配「后端每条都在前端」「前端没有后端不认的」两条方向相反的检查。
 */
const TG_COMMANDS = [
  { cmd: 'help', usage: '/help', desc: '查看全部可用指令与用法说明（在输入框敲 / 也能唤起指令菜单）' },
  { cmd: 'start', usage: '/start', desc: '系统与机器人介绍：这套监控系统能做什么、机器人能帮你远程做什么' },
  {
    cmd: 'silent',
    usage: '/silent <小时数> [渠道]',
    desc: '临时静默 N 小时，开启/结束各推一条提醒，到点附带汇总；不写渠道就走上面那份默认'
  },
  { cmd: 'until', usage: '/until <HH:MM> [渠道]', desc: '静默到指定时刻（已过则顺延到明天），同样可以跟渠道' },
  { cmd: 'resume', usage: '/resume', desc: '立刻结束静默，并推送结束提醒 + 汇总' },
  { cmd: 'patrol', usage: '/patrol', desc: '立即推送一次巡检报告' },
  {
    cmd: 'status',
    usage: '/status',
    desc: '完整运行状态：运行时长（含中断）/ 通道出帧 / 检测能力 / 推送渠道 / 静默 / 远程控制 / 记录与登录'
  },
  {
    cmd: 'compile',
    usage: '/compile',
    desc: '统计报表：今日/昨日/近 7 天的报警类型分布、小时高峰、人脸命中榜、三端推送成功率、断线恢复、人脸库与通道状态'
  },
  {
    cmd: 'collect',
    usage: '/collect [T|Y] [起-止] [img]',
    desc: '时段内事件汇总（整天完整、不再按 1000 条截断）：T=今日、Y=昨日（省略为今日），起止按小时如 9-18（省略为全天）。人脸命中逐个列出每次记录；汇总过长分多条发送；加 img 连截图一起推'
  },
  {
    cmd: 'hits',
    usage: '/hits [T|Y] [序号] [img]',
    desc: '人脸库概览：待录入数量 + 已录入名单 + 今日/昨日的命中记录（时间 / 通道 / 是谁）。T=今日、Y=昨日，省略为今日；加 img 连命中截图一起推；再写一个序号（如 /hits T img 5）就只看第 5 条、只推这一条的图'
  },
  {
    cmd: 'flow',
    usage: '/flow [T|Y] [序号] [img]',
    desc: '人员走向记录：今日/昨日的跨摄像头走向事件（谁、从哪到哪、间隔多久）。T=今日、Y=昨日，省略为今日；加 img 连各节点的轨迹截图一起推；再写一个序号（如 /flow T img 20）就只看第 20 条、只推那个人的轨迹图'
  },
  {
    cmd: 'search',
    usage: '/search [T|Y] HH:MM [img]',
    desc: '检索某一天的某一分钟内的所有事件（加 img 连截图一起推）。仅支持 T(今日)/Y(昨日)，如 /search T 14:11 img'
  },
  {
    cmd: 'hit',
    usage: '/hit [条数|时刻] [img]',
    desc: '查最近的人脸命中样本（带编号，默认 20 条）。可写条数（/hit 50）或按时刻查（/hit 14:23:05 300）；末尾加 img 连命中截图一起推，如 /hit img 20',
    detail: '从命中样本表里捞记录并给出编号，供下面三条修正指令指哪打哪。同一秒可能有多路通道各自命中，用编号认条才不会改错人。省略参数=最近 20 条；首个数当条数（1-200）；写成 HH:MM[:SS] 则按该时刻 ±窗口查。'
  },
  {
    cmd: 'hitfix',
    usage: '/hitfix <编号> <人名>',
    desc: '把某条命中样本修正为指定人名：用该样本的特征+截图补录进人脸库（认错人时把脸录到正确的人名下）。不带参数=列人脸库现有人员名单',
    detail: '与设置页「命中修正」的录入同一套动作；库满时会拒绝并提示先删人或改用 /hitblock。改完后端立即生效，前端数秒内自动拉取新底库。不带参数时列出人脸库现有人员（人名/样本条数/容量），免得猜不准名字。'
  },
  {
    cmd: 'hitblock',
    usage: '/hitblock <编号>',
    desc: '把某条命中样本标记为陌生人反例（设置页上叫「认错」）：之后同一张脸再来直接判未录入，不再冒名',
    detail: '即设置页命中卡片上的「认错」。反例不占人脸库容量；库里真人本人不受影响。同一张脸已经标过会自动合并（计数 +1，不再新增），阈值见「同一个人合并阈值」。'
  },
  {
    cmd: 'hitignore',
    usage: '/hitignore <编号|all>',
    desc: '忽略命中样本：从命中记录里删掉它（录错/不想留的样本）。写 all 一次清空当前全部样本',
    detail: '只删样本、不改人脸库；若这张脸是被认错了的陌生人，用 /hitblock 标反例才能阻止以后再被认错。'
  },
  {
    cmd: 'csilent',
    usage: '/csilent <通道> <小时数|HH:MM|off> [渠道]',
    desc: '通道静默：只让某一路监控在指定时段不推送。如 /csilent 门口 2（2 小时）、/csilent 门口 08:00（到 08:00）、/csilent off 门口（恢复）'
  },
  { cmd: 'cams', usage: '/cams', desc: '通道状态一览：每路在线/出帧、通道静默与日常静默', detail: '逐路显示是否在线出帧、当前画面人数、是否正处在通道静默（含到几点、静默哪些渠道），以及日常事件静默（按间隔汇总）是否开启、间隔与渠道。' },
  {
    cmd: 'digest',
    usage: '/digest <on|off> [间隔]',
    desc: '日常事件静默总开关：一键开/关全部通道的按间隔汇总',
    detail: '开启后所有通道的非关键事件不再实时推，而是按各自设置的间隔摊平成定期汇总；设备离线/上线与定时巡检也一并收入。可追加间隔，如 /digest on 30（分钟）、/digest on 2h（2 小时）。关掉后各通道恢复实时推送。各通道独立开关见 /cdigest。'
  },
  {
    cmd: 'cdigest',
    usage: '/cdigest <通道> <on|off> [间隔]',
    desc: '开/关指定通道的日常事件静默（其余不受影响）',
    detail: '只开或关某一路的日常事件静默，与总开关是同一份配置的两个入口。通道可用名称（门口）、id（cam-1）或序号（1）。可追加间隔，如 /cdigest 门口 on 30。'
  },
  /*
   * 这里**不再**有 `check` 条目：`/check duty` 已合并进 `/duty`（服务端只认
   * `/duty` 与免空格的 `/checkduty`），旧列表还留着它 → 用户照着设置页发
   * `/check duty` 会收到「未知指令」。列表跟着**真正能用的指令**走。
   */
  { cmd: 'duty', usage: '/duty', desc: '静默查岗：把静默期间积压的事件汇总推过来（含全部截图）；旧写法 /checkduty 仍可用' },
  {
    cmd: 'db',
    usage: '/db',
    desc: '导出当前运行的数据库（monitor.db，含报警/人脸/统计/待录入），热备成自包含文件发到本私聊'
  },
  {
    cmd: 'config',
    usage: '/config',
    desc: '导出当前生效的完整配置（通道 / 区域 / 推送 / 人脸库），发到本私聊'
  },
  { cmd: 'reboot', usage: '/reboot', desc: '重启检测服务（需二次确认，且要单独开启）', cat: 'system' },
  { cmd: 'stop', usage: '/stop', desc: '终止监控服务（仅退进程，机器仍开机，需手动重启；需单独开启 + 二次确认）', cat: 'system' },
  { cmd: 'hardreboot', usage: '/hardreboot', desc: '重启整台电脑（最后手段，需两次开启 + 二次确认）', cat: 'system' },
  { cmd: 'shutdown', usage: '/shutdown', desc: '关闭整台电脑（比硬重启更彻底，需开启电源操作 + 二次确认）', cat: 'system' },
  { cmd: 'system', usage: '/system', desc: '查看系统操作类指令（重启 / 终止 / 硬重启 / 关机）的完整说明与各自的二次确认方式', cat: 'system' }
]

const newAllowId = ref('')
/** 添加白名单时的行内错误提示（不弹窗，贴着输入框更直观） */
const allowIdError = ref('')

function addAllowId() {
  const v = String(newAllowId.value || '').trim()
  // 只接受纯数字：填成群 id / @用户名 / 昵称都无效，早点报错比运行时静默失败好
  if (!/^\d+$/.test(v)) {
    allowIdError.value = '用户 id 应为纯数字（在 Telegram 里找 @userinfobot 查询自己的 id）'
    return
  }
  allowIdError.value = ''
  if (!tg.value.remote.allowUserIds.includes(v)) {
    tg.value.remote.allowUserIds.push(v)
  }
  newAllowId.value = ''
}

function removeAllowId(i) {
  tg.value.remote.allowUserIds.splice(i, 1)
}

/**
 * 后端监听状态。
 * 直接读 /api/status 里的 tgRemote —— 用户最怕的是"配好了但不知道有没有生效"，
 * 所以必须把「后端到底有没有在听」如实显示出来。
 *
 * running 为 false 时不再只说一句「后端未运行」：把后端算出来的原因（note）
 * 直接拼进去（比如"没填 Token""白名单为空"），否则用户只能看到一个否定结论，
 * 不知道该去改哪儿。
 */
const tgRemoteChip = computed(() => {
  const st = backendStatus.value && backendStatus.value.tgRemote
  if (!st) return { cls: '', text: '未连接后端', running: false }
  if (!st.enabled) return { cls: '', text: '未开启', running: false }
  if (!st.running) return { cls: 'err', text: st.note ? `未运行 · ${st.note}` : '后端未运行', running: false }
  const parts = [`已监听 · 收到 ${st.received} 条`]
  if (st.executed) parts.push(`已执行 ${st.executed}`)
  if (st.rejected) parts.push(`拒绝 ${st.rejected}`)
  if (st.lastCmd) parts.push(`最近 ${st.lastCmd}`)
  return { cls: 'ready', text: parts.join(' · '), running: true }
})

/* ---------------- Telegram 远程控制：连接自检 ---------------- */

/** 后端算出的诊断快照（/api/status.tgRemote） */
const tgDiag = computed(() => (backendStatus.value && backendStatus.value.tgRemote) || {})
const tgBotInfo = computed(() => tgDiag.value.bot || null)
const tgWebhookSet = computed(() => {
  const b = tgBotInfo.value
  return !!(b && b.webhook && b.webhook.set)
})
/**
 * 「Telegram 侧还有多少条指令没被处理」—— 直接回答「是不是有积压的指令」。
 *
 * 数据来自 `getWebhookInfo.pending_update_count`（后端自检时取的），所以它是
 * **上次自检那一刻**的快照，不是实时值。判读方式：
 *   - 恒为 0          → 一切正常；
 *   - 持续不为 0      → 监听器没在消费（或刚从一大堆积压里启动），可用
 *                       `--drop-pending` 启动一次清空；
 *   - 未知（-1）      → 还没自检过 / 自检失败，点「测试连接」查一次。
 * 「确定 0 条」和「没查到」必须区分开，否则用户会把"没查到"当成"没问题"。
 */
const tgPending = computed(() => Number(tgDiag.value.pendingUpdates))
const tgPendingText = computed(() => {
  const n = tgPending.value
  if (!tgDiag.value.running) return '—（监听器未运行）'
  if (!Number.isFinite(n) || n < 0) return '未知 —— 点「测试连接」查一次'
  if (n === 0) return '0 条（正常）'
  return `${n} 条待处理 —— 长期不降可用 --drop-pending 启动一次清空`
})
const tgPendingClass = computed(() => {
  const n = tgPending.value
  if (!Number.isFinite(n) || n < 0) return 'muted'
  return n > 0 ? 'err-text' : 'ok-text'
})

const tgTesting = ref(false)
/** 自检结果文本（贴着按钮显示，不弹 toast —— 排障时更需要能反复看） */
const tgProbeMsg = ref('')

/**
 * 「测试连接」：让后端真去打一次 Telegram（getMe + getWebhookInfo）。
 * 状态片只能反映本地怎么看，连不上外网 / Token 错了 / 被 Webhook 挡着，
 * 都只有真打一次接口才知道。
 */
async function testTgConnection() {
  if (tgTesting.value) return
  const base = backendBase()
  if (!base) {
    tgProbeMsg.value = '未配置后端地址'
    return
  }
  tgTesting.value = true
  tgProbeMsg.value = ''
  try {
    const r = await testBackendTgRemote(base)
    const p = (r && r.probe) || {}
    if (r && r.ok && p.ok) {
      tgProbeMsg.value = `✅ 连接正常 · @${p.username || '?'}${p.webhook && p.webhook.set ? ' · ⚠️ 该机器人设置了 Webhook' : ''}`
    } else {
      tgProbeMsg.value = `❌ ${p.error || (r && r.reason) || '自检失败'}${p.hint ? ' · ' + p.hint : ''}`
    }
    await refreshBackendStatus(props.options)
  } catch (e) {
    tgProbeMsg.value = `❌ ${(e && e.message) || '自检失败'}`
  } finally {
    tgTesting.value = false
  }
}

/** 删除 Webhook（getUpdates 与它互斥，不清掉就永远收不到指令） */
async function deleteTgWebhookNow() {
  if (tgTesting.value) return
  const base = backendBase()
  if (!base) return
  tgTesting.value = true
  try {
    const r = await deleteBackendTgWebhook(base)
    tgProbeMsg.value = r && r.ok ? '✅ Webhook 已删除，现在应该能收到指令了' : `❌ 删除失败：${(r && r.reason) || '未知原因'}`
    await refreshBackendStatus(props.options)
  } catch (e) {
    tgProbeMsg.value = `❌ ${(e && e.message) || '删除失败'}`
  } finally {
    tgTesting.value = false
  }
}

function remove(i) {
  const id = cams.value[i].id
  cams.value.splice(i, 1)
  hidden.value = hidden.value.filter((x) => x !== id)
  pruneAutoPlayIds(cams.value)
}

function move(i, delta) {
  const target = i + delta
  if (target < 0 || target >= cams.value.length) return
  const [item] = cams.value.splice(i, 1)
  cams.value.splice(target, 0, item)
  // 同时播放列表的顺序 = 播放优先级，跟着通道排序一起走
  pruneAutoPlayIds(cams.value)
}

function toggleVisible(id) {
  hidden.value = hidden.value.includes(id)
    ? hidden.value.filter((x) => x !== id)
    : [...hidden.value, id]
}

/* ---------- 抽屉内拖拽排序 ---------- */
const dragArmedIndex = ref(-1)
const dragFrom = ref(-1)

function armRowDrag(i) {
  dragArmedIndex.value = i
  document.addEventListener('mouseup', () => (dragArmedIndex.value = -1), { once: true })
}

function onDragStart(i, e) {
  dragFrom.value = i
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(i) {
  const from = dragFrom.value
  if (from < 0 || from === i) return
  const [item] = cams.value.splice(from, 1)
  cams.value.splice(i, 0, item)
  dragFrom.value = i
}

function onDragEnd() {
  dragFrom.value = -1
  dragArmedIndex.value = -1
}

/* ---------- 保存 / 重置 / 导入导出 ---------- */
/**
 * 「人脸库容量」调小到当前库存之下时的明确警告 + 自动淘汰最旧。
 *
 * 为什么放在保存前：libMax 是配置项，改数字那一刻没有任何反馈，用户直到下次
 * 录入被拒（"人脸库已满"）才发现上限变了 —— 而库里其实已经超额。
 * 现在保存前先把账算清楚（计划由纯函数 planEvictOldest 产出，可单测）：
 *   - 不需要淘汰（上限 ≥ 当前条数）→ 直接放行；
 *   - 需要淘汰 → danger 确认框写明「当前 X 条（Y 人）→ 新上限 Z，将淘汰最旧的
 *     N 人共 M 条（不可恢复），保留 …」，确定才砍并继续保存，取消则**整个保存作废**
 *     （回去把上限调大，或先去人脸库里手动删人）。
 *
 * 为什么整组淘汰而不是砍单条：一张卡片 = 一个人，砍掉这个人一半的样本，
 * 卡片还在、样本少几张，用户会以为出了 bug。
 *
 * ⚠️ 删除只动本地 IndexedDB；随后 faceList 变化会经 App.vue 的推送指纹
 * （pushSignature 含 faces）自动同步给后端，不需要在这里手动推。
 *
 * @returns {Promise<boolean>} true = 可以继续保存；false = 用户取消 / 淘汰失败
 */
async function ensureLibMaxRoom() {
  const cap = Math.max(1, Math.round(Number(opts.face.libMax) || DEFAULT_FACE_MAX))
  const plan = planEvictOldest(faceLib.value, faceGroups.value, cap)
  if (plan.need <= 0) return true
  const ok = await confirmDialog({
    title: '人脸库容量已调小',
    variant: 'danger',
    okText: '自动淘汰并保存',
    cancelText: '取消',
    message:
      `当前人脸库 ${plan.totalRecords} 条样本（${plan.totalPeople} 人），新上限 ${cap} 条，多出 ${plan.need} 条。\n\n` +
      `保存后将自动淘汰最旧的 ${plan.removedPeople} 人（共 ${plan.removedRecords} 条样本，不可恢复），` +
      `保留 ${plan.keepPeople} 人（${plan.keepRecords} 条）。\n\n` +
      `点「取消」放弃本次保存：可以把上限调大，或先去人脸库里手动删人。`
  })
  if (!ok) return false
  try {
    const r = await deleteFaces(plan.victimIds)
    if (!r || !r.ok) {
      await alertDialog({ title: '淘汰失败', message: (r && r.reason) || '删除旧样本时出错', variant: 'danger' })
      return false
    }
  } catch (e) {
    await alertDialog({
      title: faceWriteErrKind(e) === 'timeout' ? '淘汰超时' : '淘汰失败',
      message: faceWriteFailMessage(e, '旧样本没有被删除，人脸库容量没变。'),
      variant: 'danger'
    })
    return false
  }
  return true
}

async function save() {
  const cleaned = cams.value
    .filter((c) => c.url && c.url.trim())
    .map((c, i) => ({ ...c, name: c.name || `画面 ${i + 1}` }))
  /*
   * 派生名单按**保存后的**通道重算一遍 ——
   * 删掉/隐藏某一路之后，名单里不能还留着它的 id（否则后端会去盯一个不存在的通道）。
   */
  syncChannelCameras(cleaned, opts)
  // 上限调小到库存之下：先明确警告 + 自动淘汰，用户取消则整个保存作废
  if (!(await ensureLibMaxRoom())) return
  emit('save', { cameras: cleaned, options: { ...opts }, hiddenIds: hidden.value })
}

/** 「恢复初始化」的二次确认状态（内联确认条，不用弹窗） */
const resetAsk = ref(false)

/** 打开确认条（入口在「配置方案」页，紧挨着「加载内置配置」） */
function askResetInit() {
  tab.value = 'profiles'
  resetAsk.value = true
}

function doResetInit() {
  resetAsk.value = false
  resetAll(resetWipeData.value)
}

/** 恢复初始化时是否连数据（报警记录 + 人脸库）一起清。确认条里的勾选项，默认「要」 */
const resetWipeData = ref(true)

/** 强制终结的二次确认状态 */
const exitAsk = ref(false)

function askExitApp() {
  tab.value = 'profiles'
  exitAsk.value = true
}

function doExitApp() {
  exitAsk.value = false
  emit('force-exit')
}

/**
 * 恢复初始化：通道全部清空、配置回到空白默认
 * （cloneDefaultCameras() 现在返回空数组，所以清完就是一块空大屏）。
 *
 * @param wipeData 是否连「数据」一起清（报警记录 + 人脸库）。确认条里有勾选项，默认勾。
 */
function resetAll(wipeData) {
  cams.value = cloneDefaultCameras()
  const fresh = cloneDefaultOptions()
  Object.keys(opts).forEach((k) => delete opts[k])
  Object.assign(opts, fresh)
  // 空白配置里没有通道，也就没有「哪几路被隐藏」这回事
  hidden.value = []
  syncCustomFlags()

  /*
   * 「配置是干净的」必须包含**配置方案本身**：
   * 已保存的方案里存着完整的通道 + 推送凭据（等于一份完整的可一键恢复的旧配置），
   * 留着它，"恢复初始化"就只是把配置藏起来了，点一下「切换」全都回来。
   */
  try {
    localStorage.removeItem(PROFILE_KEY)
  } catch (e) {
    /* ignore */
  }
  profiles.value = []
  activeProfileId.value = ''
  // 推送统计同属"这次会话的东西"，一起归零（系统信息抽屉里的三渠道战绩清零）
  try {
    localStorage.removeItem('monitor-wall-push-stats-v1')
  } catch (e) {
    /* ignore */
  }
  resetPushStats()

  emit('reset', { wipeData: !!wipeData })
}

function exportConfig() {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    cameras: cams.value,
    options: { ...opts },
    hiddenIds: hidden.value
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `monitor-config-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出后端运行的数据库（monitor.db 在线热备下载） */
const dbExporting = ref(false)
async function exportDatabase() {
  const base = backendBase()
  if (!base) {
    alertDialog({
      title: '无法导出',
      message: '未配置后端检测服务地址。数据库在后端服务器上，请先在「后端检测」页开启并填写服务地址。',
      variant: 'danger'
    })
    return
  }
  dbExporting.value = true
  try {
    const res = await fetch(`${base}/api/db/export`)
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`)
    const blob = await res.blob()
    if (!blob.size) throw new Error('导出的文件为空')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // 优先用服务端给的文件名（带时间戳），否则兜底
    const cd = res.headers.get('Content-Disposition')
    const m = cd && cd.match(/filename="?([^";]+)"?/)
    a.download = m ? m[1] : `monitor-${Date.now()}.db`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    alertDialog({
      title: '导出成功',
      message: '数据库文件已下载（含 WAL 热备，是完整一致的快照）。可用于备份或迁移到其它设备。',
      variant: 'ok'
    })
  } catch (e) {
    alertDialog({
      title: '导出失败',
      message: '数据库导出失败：' + ((e && e.message) || e),
      variant: 'danger'
    })
  } finally {
    dbExporting.value = false
  }
}

function pickFile() {
  fileEl.value && fileEl.value.click()
}

function importConfig(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result))
      if (Array.isArray(data.cameras)) {
        cams.value = data.cameras.map((c, i) => ({
          id: c.id || uid(),
          name: c.name || `画面 ${i + 1}`,
          url: c.url || '',
          motion: c.motion !== false,
          ai: !!c.ai,
          blind: !!c.blind,
          roi: c.roi && typeof c.roi === 'object' ? { ...c.roi } : null,
          rect: c.rect && typeof c.rect === 'object' ? { ...c.rect } : null,
          push: c.push !== false,
          channels:
            c.channels && typeof c.channels === 'object'
              ? { ding: c.channels.ding !== false, wecom: c.channels.wecom !== false, tg: c.channels.tg !== false }
              : { ding: true, wecom: true, tg: true },
          // 附加能力（人脸 / 姿态 / 区域）与区域列表必须一起带过来，
          // 否则导入配置后"圈好的区域全没了、通道开关也回到默认"
          aiExt:
            c.aiExt && typeof c.aiExt === 'object'
              ? { face: c.aiExt.face !== false, pose: c.aiExt.pose !== false, zone: c.aiExt.zone !== false, enterExit: c.aiExt.enterExit !== false }
              : { face: true, pose: true, zone: true, enterExit: true },
          zones: Array.isArray(c.zones)
            ? c.zones.map((z) => ({ ...z, rect: z && z.rect ? { ...z.rect } : z.rect }))
            : []
        }))
      }
      if (data.options) {
        const merged = { ...cloneDefaultOptions(), ...data.options }
        Object.keys(opts).forEach((k) => delete opts[k])
        Object.assign(opts, merged)
      }
      hidden.value = Array.isArray(data.hiddenIds) ? data.hiddenIds : []
      // 导入进来的名单可能是旧格式（跟通道级开关对不上），按通道级重算一次
      syncChannelCameras(cams.value, opts)
      syncCustomFlags()
      pruneAutoPlayIds(cams.value)
      testState.kind = 'ok'
      testState.text = '配置已导入，点右下角「保存并应用」生效'
    } catch (err) {
      alertDialog({ title: '导入失败', message: '配置文件解析失败：' + err.message, variant: 'danger' })
    }
  }
  reader.readAsText(file)
  e.target.value = ''
}

/* ---------- 遮罩解锁密码（存摘要、只写不回显） ---------- */
/*
 * 输入框里的明文只活在这个 ref 里，`applyMaskPwd` 一跑就换成摘要写进 opts，
 * 随后 ref 被清空 —— 和登录页那条链路同一个口径：明文只活到算出摘要为止。
 */
const maskPwdNew = ref('')
const maskPwdState = reactive({ kind: '', text: '' })

/**
 * 把输入框里的新密码换算成摘要写进配置。
 * 绑定在 @change（失焦 / 回车）上，避免"输入框里还留着明文就点了保存"。
 *
 * ⚠️ 这里改的是抽屉自己的**局部副本**（opts 是 props.options 的深拷贝），
 *   所以提示语要写明"点保存并应用才生效" —— 否则用户会以为没生效。
 *
 * ⚠️ 输入为空时**什么都不做**，不是"清空密码"。
 *   留空的语义是"我不改"，想真的清掉必须点旁边的「清除密码」——
 *   否则用户点进输入框又点走（其实是没打算改）就会把已设的密码悄悄抹掉。
 */
function applyMaskPwd() {
  const plain = String(maskPwdNew.value || '')
  if (!plain) return
  opts.mask.passwordHash = secretDigest(SECRET_SCOPE.MASK, plain)
  maskPwdNew.value = ''
  revealed.maskPwd = false
  maskPwdState.kind = 'ok'
  maskPwdState.text = '解锁密码已更新，点右下角「保存并应用」后生效'
}

/** 清除密码 → 回到「点击屏幕任意位置即可恢复」 */
function clearMaskPwd() {
  opts.mask.passwordHash = ''
  maskPwdNew.value = ''
  maskPwdState.kind = 'ok'
  maskPwdState.text = '已清除，改为免密码；点右下角「保存并应用」后生效'
}

/* ---------- 加载内置隐藏配置 ---------- */
const hiddenPwd = ref('')
const hiddenState = reactive({ kind: '', text: '' })

function loadHidden() {
  if (!hiddenPwd.value) {
    hiddenState.kind = 'fail'
    hiddenState.text = '请先输入访问密码'
    return
  }
  /*
   * 只比摘要（secretMatches 内部走 secretDigest + 定长异或）。
   * 这里**没有** HIDDEN_PASSCODE 这样的明文常量可对 —— 代码里那份已经换成摘要了。
   */
  if (!secretMatches(SECRET_SCOPE.HIDDEN, hiddenPwd.value, HIDDEN_PASSCODE_HASH)) {
    hiddenState.kind = 'fail'
    hiddenState.text = '访问密码不正确'
    hiddenPwd.value = ''
    return
  }
  const { cameras: hc, options: ho, hiddenIds: hh } = cloneHiddenConfig()
  cams.value = hc
  Object.keys(opts).forEach((k) => delete opts[k])
  Object.assign(opts, ho)
  // 内置配置自带「哪几路默认不显示」，一并带过来（大屏只留大门外 / 电梯 / 大门内）
  hidden.value = Array.isArray(hh) ? [...hh] : []
  hiddenPwd.value = ''
  syncCustomFlags()
  pruneAutoPlayIds(cams.value)
  hiddenState.kind = 'ok'
  hiddenState.text = `内置配置已载入（${hc.length} 路通道），点右下角「保存并应用」生效`
}
/*
 * 把全部状态 / 函数 / emit / props 下发给各分区子组件（见 ./settings/*Tab.vue）。
 * 子组件 inject("sd") 后同名解构：ref/computed/reactive/函数按引用共享，
 * 故子组件里改 opts、调 emit(...) 与在父组件里做完全等价（事件仍由本组件 defineEmits 冒泡给 App）。
 */
provide('sd', {AI_MODELS, AI_MODELS_AS_OPTIONS, AUTO_COUNT_PRESETS, BLOCK_MAX_AGE, BLOCK_MERGE, BRAND, CAM_CHANNELS, CH_LABELS, COUNT_INTERVAL_PRESETS, CRIT_EVENTS, DEFAULT_BACKEND_URL, DEFAULT_CAM_DIGEST_CHANNELS, DEFAULT_CAM_SILENT_CHANNELS, DEFAULT_FACE_MAX, DEFAULT_FACE_THRESHOLD, DEFAULT_SILENT_CHANNELS, DIGEST_INTERVAL_CHOICES, DIGEST_INTERVAL_MAX, DIGEST_INTERVAL_MIN, DIRECT_EVENT_OPTS, EMPTY_CAM_SILENT, EVENT_DEFAULTS, EVENT_GROUPS, EXT_ITEMS, FACE_CARD_W, FACE_DET_SIZES, FACE_GAP, FACE_QUALITY, FACE_ROWS, FIELD_KEYS, FLOW_FULL_ZONE, FLOW_FULL_ZONE_NAME, FLOW_MAX_NODES, FLOW_WINDOW_DEFAULT, FLOW_WINDOW_MAX, FLOW_WINDOW_MIN, FaceAssignSelect, GROUP_SIM_KEY, HIDDEN_PASSCODE_HASH, HIT_MARGIN, InfoTip, MAX_DECODE_PRESETS, OPEN_GUARD_MS, OPT_AI_INTERVAL, OPT_AUTO_PLAY, OPT_CONFIRM_FRAMES, OPT_FLOW_WINDOW, OPT_LOITER_RADIUS, OPT_MAX_DECODE, OPT_MOTION_LEVEL, OPT_SAMPLE_FPS, OPT_SHOT_WIDTH, PROFILE_KEY, PushTemplatePanel, SAMPLE_SCORE_RECOMMEND, SECRET_SCOPE, SelectField, SilentSlotRow, TABS, TEMP_CHANNEL_OPTS, TEMP_HOURS, TG_COMMANDS, WAKE_BACKEND_LABEL, WEEKDAYS, WEEK_MODES, _DEFAULTS, _isIsoDate, _silentTick, activeProfileId, activeSlotLabel, addAllowId, addCamSilSlot, addCamera, addDirectId, addFace, addFaceBlock, addFaceSplits, addFlow, addFlowNode, addHoliday, addMakeup, addSlot, aiBackend, aiCost, aiError, aiModel, aiSlotBackend, aiSlotState, aiState, aiStateText, alertDialog, allDigestOn, allPendingFaces, allowIdError, applyMaskPwd, applyProfile, applyWakeLock, armRowDrag, askExitApp, askResetInit, assigningGroup, assigningSample, autoCountCustom, autoPlayIds, backendBase, backendDesc, backendEnabled, backendFaceHits, backendFaceHitsError, backendFaceHitsLoadedAt, backendModeOn, backendOn, backendPendingError, backendPendingFaces, backendPendingLoadedAt, backendState, backendStateText, backendStatus, backendTesting, backendText, backendWatchdog, behindBackend, blockLibOpen, blockMergeThreshold, botState, buildAlarmMessage, bulkSplitting, cal, camDigestCfg, camDigestInfo, camDigestState, camExtOn, camExtTitle, camHasZones, camOptions, camPushOn, camSilActive, camSilCfg, camSilChannels, camSilInfo, camSilentState, cams, channelOn, checkBot, checkWecom, clampDigestMinutes, clampFlowWindowSec, clearFaces, clearHitAssign, clearMaskPwd, clearPendingAssign, clearPendingFaces, clearPrimaryFace, clone, cloneDefaultCameras, cloneDefaultOptions, cloneHiddenConfig, closePendingShot, commitRenameGroup, commitSampleAssign, computed, confirmDialog, countCols, countIntervalChoices, countIntervalPicked, critBlockOf, critOn, critSummaryOnly, critThroughSilence, currentFaceBlocks, currentSplits, currentTab, dayTypeOf, dbExporting, defaultCamDigest, defaultCamSilent, defaultFlow, deleteBackendTgWebhook, deleteFaces, deleteTgWebhookNow, deletingFace, deletingSample, digestCfgOf, digestIntervalLabel, dingShotHint, directEventOn, directIdError, directRecipients, directState, doAddPending, doBulkSplitAll, doClearFaces, doClearPrimarySample, doDeleteGroup, doDeleteSample, doExitApp, doFixHit, doGroupAssign, doIgnoreAllHits, doIgnoreAllPending, doIgnoreHit, doIgnorePagePending, doIgnorePending, doMarkStranger, doMergeGroup, doResetInit, doSetPrimaryCard, doSetPrimarySample, doUnmarkStranger, dragArmedIndex, dragFrom, dropBackendFaceHit, dropBackendPendingFace, dt, dtCritState, emit, endTempNow, enrollFileEl, enrollFromImage, enrollMsg, enrollOk, enrollState, enrollingPending, ensureCamDigest, ensureCamSil, ensureChannels, ensureLibMaxRoom, estimateUsage, evOn, exitAsk, exportConfig, exportDatabase, extGlobalOn, faceAttrText, faceBackendOn, faceBlocksVersion, faceColsRO, faceGroups, faceLib, faceLibOpen, faceNameOptions, faceRenameKey, faceRenameText, faceRowsVersion, faceSplitsVersion, faceTuneOpen, faceWriteErrKind, faceWriteFailMessage, faceWriteTimeoutStreak, fieldLabel, fileEl, fixingHit, flowCams, flowStateOf, flowSummary, flowTabOn, flowValid, flushSilentNow, fmtPendingAt, fmtRestartTime, formatBytes, formatCountdown, formatDate, formatInterval, getAllFaces, getBotInfo, getChatInfo, gpuReady, gpuText, groupAssign, groupBySim, groupFaces, groupThreshold, groupedExtra, hidden, hiddenPwd, hiddenState, hitAssign, hitAssignName, hitCustom, hitEmpty, hitMarginThreshold, hitRefreshNote, hitRefreshing, hitReviewOpen, holidayInput, importConfig, libCols, libGridEl, libPage, libPageCount, libPageSize, loadBackendFaceHits, loadBackendPendingFaces, loadHidden, loadPersonModel, loadProfiles, localRev, localRevText, makeupInput, maskDownAt, maskPwdNew, maskPwdState, matchSilentSlotAt, maxDecodeCustom, measureFaceCols, mergeAllChecked, mergeFaces, mergeSelCount, mergeSelected, mergeThresholdShown, mergingGroup, mixedGroupNameCount, modelDesc, motionLevelHint, move, newAllowId, newDirectId, nextTick, normalizeDingTalk, normalizeTelegram, normalizeWeCom, normalizeWeComWebhook, notifyCls, notifyLine, nowTs, observeFaceGrids, onAutoCountSelect, onBackendPull, onBackendSync, onBackendTest, onDragEnd, onDragOver, onDragStart, onEnrollFile, onGroupAssign, onMaskClick, onMaskDown, onMaxDecodeSelect, onMounted, onPendingShotKey, onSampleAssign, onUnmounted, openPendingShot, openPicker, openedAt, opts, otherNames, pagedFaceGroups, pagedPending, parseMobiles, parseSilentSlots, pendingAssign, pendingAssignName, pendingCols, pendingCustom, pendingEmpty, pendingFaces, pendingGridEl, pendingLibOpen, pendingPage, pendingPageCount, pendingPageSize, pendingRefreshNote, pendingRefreshing, pendingShot, pendingSort, persistProfiles, persistSlots, pfQuality, pfRecommended, pfScoreTip, pickFile, planEvictOldest, playBadgeClass, playBadgeText, pollRestartResult, profileName, profiles, props, pruneAutoPlayIds, pullError, pullState, pushCamCount, pushFacesSkipped, pushOverwrote, rawFaceRows, reactive, readGroupSim, readRemoteDefaultChannels, realMixedGroups, ref, refreshBackendFaceHits, refreshBackendPending, refreshBackendStatus, refreshBackendWatchdog, refreshFaces, refreshRestartInfo, refreshStorage, refreshWatch, refreshWatchStatus, releaseModel, remoteSilentChannels, remove, removeAllowId, removeCamSilSlot, removeFaceBlock, removeFlow, removeFlowNode, removeHoliday, removeMakeup, removePendingFace, removeProfile, removeSlot, renameFace, renameFaces, renamingFace, requestNotifyPermission, resetAll, resetAsk, resetFaceTune, resetPushStats, resetWipeData, restartInfo, restartPolling, restartResultText, restartSystemNow, revealed, runtimeInfo, runtimeLine, runtimeTipText, sampleAssign, sampleCustom, sampleFpsHint, sampleQualityLabel, save, saveProfile, secretDigest, secretMatches, selectedGroup, selectedGroupKey, sendDingTalk, sendTelegramText, sendWeCom, setAllPushCameras, setCamDigestInterval, setGpuPref, setMasterDigestInterval, setPrimaryFace, setTgEnabled, settingPrimary, silentActiveNow, silentStatusText, silentYieldSlots, simPct, slotsOf, snapshot, someDigestOn, sortedPendingFaces, splitMixedGroupByName, splitNames, startRenameGroup, startTempNow, stateTextOf, statusBadgeOn, storageInfo, storageText, strangerMarks, syncChannelCameras, syncCustomFlags, syncRev, syncRevText, syncState, syncStateText, sysNotifyState, sysNotifySummary, tab, tempActive, tempChannels, tempHours, tempInfo, tempLabel, tempMode, tempPreview, tempUntilLocal, tempUntilTs, testBackendTgRemote, testDingCritical, testDirectPush, testPostSilence, testPreSilence, testPush, testState, testTelegram, testTgConnection, testWecom, testWecomCritical, tg, tgBotInfo, tgDiag, tgDirectEventOn, tgDirectRecipients, tgForced, tgPending, tgPendingClass, tgPendingText, tgProbeMsg, tgRemoteChip, tgTesting, tgWebhookSet, toLocalInput, todayDayType, toggleAi, toggleAiGpu, toggleAllCamDigest, toggleAutoPlay, toggleBackend, toggleCamChannel, toggleCamDigest, toggleCamDigestChannel, toggleCamExt, toggleCamSilChannel, toggleCamSilent, toggleChannel, toggleCritEvent, toggleCritSummaryOnly, toggleCritThroughSilence, toggleDesktopNotify, toggleDirectEvent, toggleEvent, toggleGroupBySim, toggleGroupPanel, toggleKeepAwake, toggleMergeAll, togglePendingSort, togglePushCam, togglePushCamera, toggleRemoteSilentChannel, toggleTempChannel, toggleVisible, tomorrowMorning, tonightMidnight, triggerEnrollFile, uid, verifyVectorLanded, wakeCls, wakeLine, wakeLockState, watch, watchChip, watchState, watchStatusText, wc, wcCritState, wcShotHint, wcState, zoneAnyOn, zoneOptions, zoneRemove, zoneRows, zoneUpdate})

</script>


