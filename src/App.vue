<template>
  <div class="app">
    <TopBar
      :layouts="LAYOUTS"
      :layout-key="layoutKey"
      :total="cameras.length"
      :online="onlineCount"
      :hidden-count="hiddenIds.length"
      :unread="unreadCount"
      :masked="masked"
      :today-count="todayCount"
      :last-event="lastEventText"
      :backend="backendActive"
      @reconnect-all="reconnectAll"
      @pause-all="pauseAll"
      @resume-all="resumeAll"
      @restore-hidden="restoreHidden"
      @toggle-events="toggleEventPanel"
      @toggle-mask="maskNow"
      @settings="settingsOpen = true"
    />

    <main class="wall" :class="{ 'is-phone': isPhone, 'is-free': layoutKey === 'free' }" ref="wallEl">
      <!--
        空大屏分两种情况：
          1. 一路都没配（初始化就是这种状态）→ 引导去设置里新增
          2. 配了但全被隐藏 → 一键恢复
      -->
      <div v-if="!visibleCameras.length" class="empty">
        <template v-if="!cameras.length">
          <p>还没有添加任何画面</p>
          <button class="btn primary" @click="openCameraSettings">去设置里添加画面</button>
        </template>
        <template v-else>
          <p>当前没有显示任何画面</p>
          <button class="btn primary" @click="restoreHidden">恢复全部画面</button>
        </template>
      </div>

      <div
        v-else
        :class="layoutKey === 'free' ? 'free-wall' : 'grid'"
        :style="gridStyle"
        @dragover.prevent
      >
        <CameraTile
          v-for="(cam, i) in visibleCameras"
          :key="cam.id"
          :ref="(el) => setTileRef(i, el)"
          :cam="cam"
          :index="i"
          :decoder="DECODER_PATH"
          :options="effectiveOptions"
          :free="layoutKey === 'free'"
          :highlight="flashId === cam.id"
          :zoomed="zoomIndex === i"
          :decode="decodeIds.includes(cam.id)"
          :style="tileStyle(i)"
          @zoom="toggleZoom"
          @close="hideCamera"
          @status="onTileStatus"
          @alarm="onAlarm"
          @alarm-shot="onAlarmShot"
          @update-camera="onUpdateCamera"
          @roi-change="onRoiChange"
          @zone-add="onZoneAdd"
          @zone-clear="onZoneClear"
          @request-play="onRequestPlay"
          @drag-start="onWallDragStart"
          @drag-over="onTileDragOver"
          @drag-end="onWallDragEnd"
          @free-grab="onFreeGrab"
        />
      </div>

      <!-- 自定义摆放时的对齐辅助线 -->
      <div class="free-guides" v-if="layoutKey === 'free' && freeDrag">
        <span class="gv" :style="{ left: guide.x + '%' }"></span>
        <span class="gh" :style="{ top: guide.y + '%' }"></span>
        <div class="guide-badge" :style="{ left: guide.x + '%', top: guide.y + '%' }">
          {{ guideText }}
        </div>
      </div>

      <transition name="fade">
        <div class="zoom-tip" v-if="zoomIndex !== null">
          <span class="tip-kbd">按 <kbd>Esc</kbd> 退出放大 · <kbd>R</kbd> 重连</span>
          <span class="tip-touch">再点一次「放大」按钮收起</span>
        </div>
        <div class="zoom-tip" v-else-if="layoutKey === 'free' && !masked">
          自定义摆放：拖左上角<b>十字手柄</b>移动 · 拖右下角<b>角标</b>缩放
        </div>
      </transition>
    </main>

    <SettingsDrawer
      v-if="settingsOpen"
      :open-tab="settingsTab"
      :cameras="cameras"
      :options="options"
      :hidden-ids="hiddenIds"
      :layouts="LAYOUTS"
      :layout-key="layoutKey"
      :native="isNativeApp"
      :events="events"
      :temp-silent="tempSilentState"
      @temp-state="refreshTempSilentState"
      @close="settingsOpen = false"
      @save="applyConfig"
      @reset="onReset"
      @patrol="runPatrol('manual')"
      @update:layout-key="setLayout"
      @update-cameras="onUpdateCameras"
      @reset-free="resetFreeRects"
      @update-theme="onThemeChange"
      @update-keepawake="onKeepAwakeChange"
      @force-exit="onForceExit"
      @watch-sync="onWatchSync"
      @backend-sync="onBackendSyncNow"
      @pull-backend="onBackendPull"
      @flush-silent="onFlushSilent"
      @test-pre-silent="onTestPreSilence"
      @test-post-silent="onTestPostSilence"
      @restart-system="onRestartSystem"
      @start-temp-silent="onStartTempSilent"
      @end-temp-silent="onEndTempSilent"
    />

    <EventPanel
      ref="eventPanelRef"
      :open="eventPanelOpen"
      :events="events"
      :load-shot="loadEventShot"
      :push-state="pushStateOf"
      :error-log="errorLog"
      :today-count="todayCount"
      :pos="uiOptions.eventPanel"
      :pos-offset="uiOptions.eventPanelGap"
      @close="eventPanelOpen = false"
      @clear="clearEvents"
      @export="exportEvents"
      @focus="focusEvent"
      @mark-read="markEventRead"
      @mark-read-from="markEventReadFrom"
      @mark-all-read="markAllEventsRead"
      @open-status-config="openStatusConfig"
    />

    <!--
      报警通知卡片（item 117 恢复）。
      ⚠️ 上一轮我误把它当成「与事件面板重复」删掉了，其实两者定位不同：
        - NotifyStack：报警瞬间弹入的卡片，10 秒自动消失，告诉你「刚才发生了什么」；
        - EventPanel：常驻右下角的可点开列表，能翻历史、能导出、能标已读。
      同一条数据两处都出现不是重复，而是「即时提醒」+「事后查阅」的分工。
      位置可在「设置 → 外观」里配四角（默认左上）。
    -->
    <NotifyStack
      :items="notifies"
      :life="NOTIFY_LIFE"
      :pos="notifyPos"
      :pos-offset="notifyGap"
      @focus="focusEvent"
      @dismiss="dismissNotify"
    />

    <PrivacyMask
      :open="masked"
      :has-password="!!maskPasswordHash"
      :error="maskError"
      :ask-signal="maskAskSignal"
      @unlock="unlockMask"
    />

    <transition name="toast">
      <div class="toast" v-if="toast">{{ toast }}</div>
    </transition>

    <!--
      全局错误条：main.js 里三层错误入口（Vue errorHandler / window.onerror /
      unhandledrejection）都会汇到 composables/useErrorLog，这里把它变成可见提示。
      以前这类错误只躺在控制台里，界面上表现为「闪一下就没了」，手机上根本没法查。
    -->
    <transition name="toast">
      <div class="err-bar" v-if="fatalError">
        <div class="err-head" @click="errExpanded = !errExpanded">
          <span class="err-dot"></span>
          <span class="err-src">
            {{ fatalError.source }}<template v-if="fatalError.extra"> · {{ fatalError.extra }}</template>
          </span>
          <span class="err-msg">{{ fatalError.message }}</span>
          <button class="err-btn" @click.stop="copyErrorLog">{{ errCopied ? '已复制' : '复制' }}</button>
          <button class="err-btn" @click.stop="dismissError()">关闭</button>
        </div>
        <div class="err-body" v-if="errExpanded">
          <p class="err-hint">最近 {{ errorLog.length }} 条错误 —— 点「复制」可整段发给开发者</p>
          <pre class="err-pre">{{ errorLogText() }}</pre>
        </div>
      </div>
    </transition>

    <!--
      强制终结后的收尾遮罩：iOS / 桌面端会直接退出进程，根本看不到这层；
      只有 Web 端（浏览器不允许脚本关非脚本打开的页面）才会停留在这里，
      明确告诉用户"任务已全部停止，请手动关页"，绝不能假装退干净了。
    -->
    <transition name="fade">
      <div class="exit-mask" v-if="exitState.phase === 'done'">
        <div class="exit-card">
          <div class="exit-icon">⏹</div>
          <h3>应用已终止</h3>
          <p class="exit-msg">{{ exitState.message }}</p>
          <p class="exit-sub">播放、检测、推送与后台任务均已停止</p>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import CameraTile from './components/CameraTile.vue'
import EventPanel from './components/EventPanel.vue'
import PrivacyMask from './components/PrivacyMask.vue'
import TopBar from './components/TopBar.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import {
  BRAND,
  DECODER_PATH,
  LAYOUTS,
  STORAGE_KEY,
  cloneDefaultCameras,
  cloneDefaultOptions,
  migrateSecretFields,
  normalizeCameraChannels,
  normalizeCameraSilent,
  syncChannelCameras
} from './config/defaults'
import { SECRET_SCOPE } from './config/auth'
import { secretMatches } from './composables/sha256'
import { useAlertPush } from './composables/useAlertPush'
import { clearErrorLog, dismissError, errorLog, errorLogText, fatalError } from './composables/useErrorLog'
import NotifyStack from './components/NotifyStack.vue'
import { dayKey, dailyStats, statAlarm, statChannelState, statPersonHit, statPush } from './composables/useDailyStats'
import {
  buildPatrolMessage,
  buildStatusAlertMessage,
  normalizeDingTalk
} from './composables/useDingTalk'
import { buildTelegramPatrolText, buildTelegramStatusText } from './composables/useTelegram'
import {
  clearEvents as dbClearEvents,
  deleteEvents as dbDeleteEvents,
  getAllEvents,
  getEvent as dbGetEvent,
  markRead as dbMarkRead,
  migrateLegacyHistory,
  normalizeStuckPushes,
  patchEvent as dbPatchEvent,
  pruneEvents,
  putEvent as dbPutEvent,
  toLightRecord
} from './composables/useEventStore'
import { exportEventsToFolder, downloadJson, supportsDirectoryPicker } from './composables/useFileIO'
import { alarmBrief, alarmLabel } from './composables/useAlarmText'
import {
  backendOn,
  markReadOnBackend,
  refreshBackendWatchdog,
  runBackendPatrol,
  sendBackendSilentNotice,
  startBackendPolling,
  stopBackendPolling
} from './composables/useBackendEvents'
import {
  backendBase,
  localRev,
  markSynced,
  pullConfig,
  refreshRemoteStatus,
  scheduleConfigSync,
  stopConfigSync,
  syncConfigNow,
  syncRev
} from './composables/useBackendSync'
import { featureState } from './composables/useAiExtras'
import {
  beginRunSession,
  startUptimeHeartbeat,
  stopUptimeHeartbeat,
  touchRunSession
} from './composables/useSystemUptime'
import {
  clearFaces,
  clearPendingFaces,
  faces as faceList,
  getAllFaces,
  replaceFaces
} from './composables/useFaceLib'
import {
  clearWatch,
  onWatchCommand,
  refreshWatchStatus,
  syncWatch,
  syncWatchNow,
  watchState
} from './composables/useWatchBridge'
import { exitAppNow, exitState } from './composables/useAppExit'
import { applyWakeLock, dropWakeLock, initWakeLock } from './composables/useWakeLock'
import {
  initSystemNotify,
  onSystemNotifyClick,
  requestNotifyPermission,
  sendSystemNotify
} from './composables/useSystemNotify'

/*
 * 是否允许用户直接操作（目前只有一组键盘快捷键）。
 *
 * 后端模式下 App 会照常挂载在**登录遮罩下面**（监测在常驻设备上跑，
 * 本页只是看画面的窗口）。遮罩挡得住鼠标，挡不住挂在 window 上的键盘监听 ——
 * 不置 false 的话，未登录的人随手敲一下 M / R / E 就在操作大屏了，
 * 而且 M 会把遮罩盖上（他是看不见的），等真正登录进来看到的第一眼是「已锁定」，
 * 排查起来极其费解。所以把这一项交给门禁（src/LoginGate.vue）按登录态传进来。
 * 默认 true —— 不传的老用法（含各种探针直接挂 App）行为不变。
 */
const props = defineProps({
  interactive: { type: Boolean, default: true }
})

/* ==================== 配置持久化 ==================== */
function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    /*
     * 通道列表允许为空 —— 初始化配置就是一块空大屏。
     * 早先这里要求 cameras 非空才算有效存档，会引发一个隐蔽的数据丢失：
     * 把通道全删掉（或恢复初始化）之后，同一份存档里的推送凭据、检测参数
     * 会在下次打开时被判为"没有存档"，被默认值整体覆盖掉。
     */
    if (!Array.isArray(data.cameras)) data.cameras = []
    return data
  } catch (e) {
    return null
  }
}

const saved = loadSaved()

const cameras = ref(
  saved
    ? saved.cameras.map((c) =>
        normalizeCameraSilent(
          normalizeCameraChannels({
            ...c,
            channels: c.channels ? { ...c.channels } : undefined,
            roi: c.roi ? { ...c.roi } : null,
            rect: c.rect ? { ...c.rect } : null
          })
        )
      )
    : cloneDefaultCameras()
)
const options = reactive(
  saved
    ? { ...cloneDefaultOptions(), ...JSON.parse(JSON.stringify(saved.options || {})) }
    : cloneDefaultOptions()
)
// 兼容旧版本保存的推送配置
normalizeDingTalk(options.dingtalk)
// 老版本 localStorage 里没有的新增配置项，用默认值补齐（含 alert / mask / dingtalk 的嵌套字段）
fillMissingOptions(options)
/*
 * 把老存档里的**明文遮罩密码**换算成摘要，并删掉明文字段（幂等）。
 *
 * 函数自身不依赖调用顺序（明文字段为空时也会补一个空摘要，而不是留 undefined），
 * 放这儿只是为了跟其它一次性迁移排在一起，便于阅读。
 *
 * 下面紧跟着一次 writeStorage()，纠正结果会一并落盘；少了那一步，
 * 这段迁移就只活在内存里，下次打开还得再迁一遍。
 */
migrateSecretFields(options)
const hiddenIds = ref(saved && Array.isArray(saved.hiddenIds) ? saved.hiddenIds : [])
const layoutKey = ref((saved && saved.layoutKey) || 'auto')
// 修复早期版本默认配置里无效的钉钉机器人 token（存在旧 token 时自动替换并落盘）
migrateDingTalkCredentials(options.dingtalk)
// 老版本默认截图宽度 1920 有点糊，一次性升级为「原图」（用户自己改过其它值则不动）
migrateShotWidthToOriginal(options)
// 旧版钉钉默认不带截图，这里一次性改成「复用 Telegram 的图片直链」
migrateDingShotMode(options)
// 计数推送间隔：老默认 60 秒太密，一次性升级为 4 小时
migrateCountInterval(options)

/*
 * 「渠道级监听名单」（dingtalk / wecom / telegram 的 cameras）从通道级推送配置派生。
 *
 * 老存档里那份名单很可能已经和「监控通道」页的开关脱节（隐藏配置的默认值是
 * 只有 cam-1 门口），而它以前是推送的第二道硬闸 —— 结果就是电梯/大厅 明明
 * 开了推送却一条都收不到。这里统一在载入时纠正一次，之后每次落盘都会再对齐。
 *
 * ⚠️ 必须紧跟一次 writeStorage()：这里发生在 watch(options, …) 注册**之前**，
 * 改了 options 不会触发那个监听，不主动写一次的话「纠正过的名单」只活在内存里，
 * 存档里还是旧的那份（下次打开又要再纠一遍）。
 */
syncChannelCameras(cameras.value, options)
writeStorage()

/**
 * 老版本 localStorage 里保存的配置没有新增字段（例如 alert.topNotify / alert.shotWidth），
 * 这里用默认值补齐（支持两层嵌套），避免升级后选项变成 undefined。
 */
function fillMissingOptions(opts) {
  const fresh = cloneDefaultOptions()
  Object.keys(fresh).forEach((k) => {
    const def = fresh[k]
    const isPlainObj = def && typeof def === 'object' && !Array.isArray(def)
    if (!isPlainObj) {
      if (opts[k] === undefined) opts[k] = def
      return
    }
    if (!opts[k] || typeof opts[k] !== 'object') {
      opts[k] = def
      return
    }
    Object.keys(def).forEach((ik) => {
      const idef = def[ik]
      const isNested = idef && typeof idef === 'object' && !Array.isArray(idef)
      if (isNested) {
        opts[k][ik] = { ...idef, ...(opts[k][ik] || {}) }
      } else if (opts[k][ik] === undefined) {
        opts[k][ik] = idef
      }
    })
  })
  return opts
}

/**
 * 一次性迁移：早期版本默认配置里的机器人 token 是无效的
 * （钉钉返回 errcode=300005 token is not exist）。
 * 检测到旧 token 时自动替换为有效的凭据（除非用户自己改过 webhook）。
 */
/**
 * 老版本的默认截图宽度是 1920，放大看细节会糊。
 * 如果用户没有手动改成别的值（仍是老默认 1920），一次性升级为「原图」。
 */
function migrateShotWidthToOriginal(opts) {
  if (!opts || !opts.alert) return
  const MIGRATED = 'monitor-wall-shotwidth-hd-v1'
  try {
    if (localStorage.getItem(MIGRATED)) return
    if (Number(opts.alert.shotWidth) === 1920) opts.alert.shotWidth = 0
    localStorage.setItem(MIGRATED, '1')
    writeStorage()
  } catch (e) {
    /* 存储不可用时不影响运行 */
  }
}

/**
 * 一次性迁移：旧版本钉钉默认不带截图（screenshotMode='none'），
 * 群里只有文字、看不到图。若用户从没配置过上传方式，改成复用 Telegram 的图片直链。
 */
function migrateDingShotMode(opts) {
  if (!opts || !opts.dingtalk) return
  const MIGRATED = 'monitor-wall-ding-shot-v1'
  try {
    if (localStorage.getItem(MIGRATED)) return
    const dt = opts.dingtalk
    if ((dt.screenshotMode === undefined || dt.screenshotMode === 'none') && !dt.uploadUrl) {
      dt.screenshotMode = 'tg'
    }
    if (!dt.imageHostTtl) dt.imageHostTtl = '72h'
    localStorage.setItem(MIGRATED, '1')
    writeStorage()
  } catch (e) {
    /* 存储不可用时不影响运行 */
  }
}

function migrateDingTalkCredentials(dt) {
  if (!fixLegacyDingTalk(dt)) return
  writeStorage()
}

/**
 * 一次性迁移：人员计数推送间隔的老默认是 60 秒。
 * 它本质是「定时播报」而不是报警 —— 画面里 0 个人也会照推，
 * 60 秒一条意味着一夜几百条「人员计数 · 大门外」，真报警全被淹没。
 * 统一升级为 4 小时；用户自己改过的其它值（≠60）原样保留。
 */
function migrateCountInterval(opts) {
  const FLAG = 'monitor-wall-count-interval-v1'
  try {
    if (localStorage.getItem(FLAG)) return
    if (opts && opts.zone && Number(opts.zone.countIntervalSec) === 60) {
      opts.zone.countIntervalSec = 14400
      writeStorage()
    }
    localStorage.setItem(FLAG, '1')
  } catch (e) {
    /* 存储不可用时不影响运行 */
  }
}

const settingsOpen = ref(false)
/** 打开设置时希望停留的页签（空 = 上次停留的那页） */
const settingsTab = ref('')
const eventPanelOpen = ref(false)
/**
 * 事件面板组件引用。
 * 面板一直挂着（只是内部 v-if 控制显隐），所以点右上角通知时可以直接调它的
 * openDetail() 打开详情弹窗 —— 弹窗 Teleport 到 body，不需要先展开面板。
 */
const eventPanelRef = ref(null)
const zoomIndex = ref(null)
const toast = ref('')
const statusMap = reactive({})
const tileRefs = []
const wallEl = ref(null)
/** 正在高亮定位的通道 id */
const flashId = ref('')
/** 定位高亮持续时间（毫秒） */
const LOCATE_MS = 3000

const events = ref([])

/**
 * 界面布局偏好（item 113）。
 * 老配置没有 ui 块，这里用默认值兜底，避免读到 undefined。
 */
const uiOptions = computed(() => {
  const u = options.ui || {}
  return {
    // 事件面板固定在右下角（item 117：位置可配的是左上角通知卡片，不是它）
    eventPanel: 'br',
    eventPanelGap: Number.isFinite(Number(u.eventPanelGap)) ? Math.max(0, Number(u.eventPanelGap)) : 14
  }
})
/**
 * 未读数量直接从记录里算，不再单独维护一个计数器（避免和持久化的已读状态对不上）。
 *
 * ⚠️ 刻意**不含**通道状态消息（offline / online）：它们是机器自己产生的状态流水，
 * 不是「需要人处理的事件」。混进未读红点会让角标长期亮着、点进去却全是恢复通知。
 * 这类消息在事件面板的「通道状态」标签里单独看。
 */
const isSystemEvent = (e) => e && (e.type === 'offline' || e.type === 'online')
const unreadCount = computed(() => events.value.filter((e) => !e.read && !isSystemEvent(e)).length)
const readCount = computed(() => events.value.filter((e) => !!e.read).length)
/** 当前保留的历史事件总数（受「报警记录保留条数」上限约束） */
const historyCount = computed(() => events.value.length)

/* ==================== 报警通知卡片（item 117 恢复） ====================
 * 报警瞬间弹入、带缩略图、10 秒自动消失的那摞卡片。
 * 与右下角事件面板的分工：这里是「即时提醒」，那里是「事后查阅」。
 *
 * 去重规则：同一通道 + 同一类型只保留最新一条并重置计时，
 * 避免同一个摄像头持续移动时刷出一屏卡片把画面全挡住。
 */
const NOTIFY_LIFE = 10000
const NOTIFY_MAX = 4
const notifies = ref([])
const notifyTimers = {}

function pushNotify(record) {
  if (masked.value) return
  if (!options.alert || options.alert.topNotify === false) return
  const text =
    record.type === 'person'
      ? 'AI 人形识别：检测到人员'
      : record.type === 'motion'
      ? `画面移动${record.ratio ? ` · 变动 ${(record.ratio * 100).toFixed(1)}%` : ''}`
      : record.text || '通道状态变化'

  const item = {
    key: record.key || `n-${Date.now()}`,
    id: record.id,
    name: record.name,
    type: record.type,
    thumb: record.thumb || '',
    text,
    time: record.time || Date.now()
  }
  // 同一通道同一类型短时间内只留最新一条，避免刷屏
  const dedupKey = `${item.id}-${item.type}`
  const exist = notifies.value.find((n) => `${n.id}-${n.type}` === dedupKey)
  if (exist) {
    clearTimeout(notifyTimers[exist.key])
    notifies.value = notifies.value.map((n) => (n.key === exist.key ? { ...item, key: exist.key } : n))
    notifyTimers[exist.key] = setTimeout(() => dismissNotify(exist.key), NOTIFY_LIFE)
    return
  }

  notifies.value = [item, ...notifies.value].slice(0, NOTIFY_MAX)
  // 被挤出可视区的旧通知直接清掉计时器
  Object.keys(notifyTimers).forEach((k) => {
    if (!notifies.value.some((n) => n.key === k)) {
      clearTimeout(notifyTimers[k])
      delete notifyTimers[k]
    }
  })
  notifyTimers[item.key] = setTimeout(() => dismissNotify(item.key), NOTIFY_LIFE)
}

function dismissNotify(key) {
  clearTimeout(notifyTimers[key])
  delete notifyTimers[key]
  notifies.value = notifies.value.filter((n) => n.key !== key)
}

/** 通知卡片位置（四角）与边距，可在「设置 → 外观」里改 */
const notifyPos = computed(() => {
  const p = (options.ui || {}).notifyPos
  return ['tl', 'tr', 'bl', 'br'].includes(p) ? p : 'tl'
})
const notifyGap = computed(() => {
  const n = Number((options.ui || {}).notifyGap)
  return Number.isFinite(n) ? Math.max(0, Math.min(80, n)) : 14
})

/* ==================== 历史报警记录（IndexedDB 持久化） ==================== */
/**
 * 记录 + 截图全部存 IndexedDB（几百 MB 配额），内存里只留轻量缩略图，
 * 详情弹窗打开时再按 key 取原图。上限可在设置里改（默认 200，超出循环删除最旧）。
 */

/** 当前生效的记录上限 */
const maxEvents = computed(() => Math.max(10, Math.min(2000, Number(options.maxEvents) || 200)))

async function loadHistory() {
  try {
    // 旧版本 localStorage 里的记录（最多 100 条）一次性搬进 IndexedDB
    await migrateLegacyHistory()
    // 上次退出时若推送还没收尾，记录会永远停在「正在推送」，这里统一归位
    await normalizeStuckPushes()
    const all = await getAllEvents()
    /*
     * 库级滚动清理：把「保留条数」之外的旧记录从库里删掉。
     * 上面内存里只留 maxEvents 条，但用户把保留量从 2000 调到 200 之后，
     * 库里那 1800 条带原图的老记录不会被任何逻辑碰到 —— 全靠这里收尾。
     * 删除量可能不小，放后台跑，不阻塞首屏。
     */
    pruneEvents(maxEvents.value).catch(() => {})
    return all.slice(0, maxEvents.value).map(toLightRecord)
  } catch (e) {
    return []
  }
}

/** 追加一条事件：内存里放轻量版，库里存完整版（含原图截图），并淘汰超限旧记录 */
async function appendEvent(record) {
  const next = [record, ...events.value]
  const dropped = next.length > maxEvents.value ? next.slice(maxEvents.value) : []
  events.value = next.slice(0, maxEvents.value).map((e) => (e.key === record.key ? toLightRecord(record) : e))
  // 今日报警独立计数（不受 maxEvents 淘汰影响，见 todayAlarmCount 注释）
  if (!isSystemEvent(record)) bumpTodayCount(1)
  try {
    await dbPutEvent(record)
    if (dropped.length) await dbDeleteEvents(dropped.map((d) => d.key))
  } catch (e) {
    /* 存储失败不影响页面功能 */
  }
}

/** 详情弹窗按需取原图 */
async function loadEventShot(key) {
  try {
    const rec = await dbGetEvent(key)
    return (rec && rec.shot) || ''
  } catch (e) {
    return ''
  }
}

/**
 * 今日报警次数（item 109）。
 *
 * ⚠️ 不能直接数 events.value —— 那个列表受 maxEvents（默认 200）淘汰，
 * 报警一起来就会把最早的挤掉，于是「今日报警」到 200 就再也不涨了，
 * 明明今天已经报了 500 次。这里改成一个**独立的当日累计计数**：
 * 每条新事件 +1，跨零点自动归零，与列表淘汰彻底解耦。
 */
const todayAlarmCount = ref(0)
/** todayAlarmCount 归属的日期（毫秒时间戳，每天一个），用于跨零点检测 */
let todayCountDay = startOfDayStamp()

function startOfDayStamp() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function bumpTodayCount(delta) {
  const today = startOfDayStamp()
  if (today !== todayCountDay) {
    // 跨过零点：先归零，再把新一天的第一条算进去
    todayCountDay = today
    todayAlarmCount.value = 0
  }
  todayAlarmCount.value = Math.max(0, todayAlarmCount.value + delta)
}

/**
 * 首屏 / 切回前台时用内存里已有的事件把当日计数补齐。
 * 只统计「今天零点之后、且列表里还留着的」那部分，
 * 也就是说：今天没超过 maxEvents 时是精确值；超了则至少不低于实际值。
 */
function seedTodayCount() {
  const today = startOfDayStamp()
  if (today !== todayCountDay) {
    todayCountDay = today
    todayAlarmCount.value = 0
  }
  const fromList = events.value.filter((e) => e.time >= today && !isSystemEvent(e)).length
  if (fromList > todayAlarmCount.value) todayAlarmCount.value = fromList
}

/*
 * 「今日报警」对外暴露的值。
 *
 * ⚠️ 优先读 **useDailyStats 里的持久化计数**（localStorage，每次报警 statAlarm 就写一次），
 * 而不是下面那个内存 ref：
 *   - 内存 ref 只从「当前列表里还留着的记录」补齐（见 seedTodayCount），
 *     而列表会被 maxEvents 淘汰、也会被用户「清空」——
 *     一清空就归零，等于把「今天一共报了多少次」这个事实抹掉了，
 *     顶栏和设置页的数字会一起失真。
 *   - 持久化那份与列表彻底解耦：清空事件不影响它，刷新页面也在。
 * 读不到（localStorage 被清 / 首次运行还没记过）时退回内存 ref 兜底。
 */
const todayCount = computed(() => {
  const d = dailyStats.days[dayKey()]
  const persisted = d && Number(d.alarms)
  if (Number.isFinite(persisted) && persisted > 0) return persisted
  return todayAlarmCount.value
})
const lastEventAt = computed(() => (events.value.length ? events.value[0].time : 0))
const lastEventText = computed(() => {
  const e = events.value[0]
  if (!e) return '暂无事件'
  const mins = Math.floor((Date.now() - e.time) / 60000)
  const ago = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.floor(mins / 60)} 小时前`
  const kind = e.type === 'person' ? '人形' : e.type === 'motion' ? '移动' : e.type === 'offline' ? '异常' : '恢复'
  return `${ago} · ${e.name} ${kind}`
})

let toastTimer = null
let eventSeq = 0

function showToast(text, force = false) {
  if (masked.value && !force) return
  toast.value = text
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2200)
}

/* ==================== 全局错误条 ==================== */
/** 错误条是否展开（展开看留档的栈） */
const errExpanded = ref(false)
/** 「复制」按钮的短暂反馈 */
const errCopied = ref(false)

/** 把留档的错误整段复制出来，方便直接发给开发者 */
async function copyErrorLog() {
  const text = errorLogText()
  try {
    await navigator.clipboard.writeText(text)
    errCopied.value = true
    setTimeout(() => (errCopied.value = false), 1600)
  } catch (e) {
    // 剪贴板不可用（非 https / 无权限 / 内嵌 WebView）时展开让人手动选
    errExpanded.value = true
  }
}

/** 自愈：任何写配置的时机都顺带修复旧版无效 token（返回是否修复过） */
function fixLegacyDingTalk(dt) {
  const BAD = 'YOUR_DINGTALK_LEGACY_TOKEN'
  if (!dt || typeof dt.webhook !== 'string') return false
  if (dt.webhook.includes(BAD)) {
    dt.webhook =
      'https://oapi.dingtalk.com/robot/send?access_token=YOUR_DINGTALK_ACCESS_TOKEN'
    dt.secret = 'YOUR_DINGTALK_SIGN_SECRET'
    return true
  }
  return false
}

/**
 * 真正写盘。
 * 以前这段 setItem 被复制了四份（三个一次性迁移 + 主持久化），
 * 现在统一收口，避免「改了一处漏了另一处」。
 */
function writeStorage() {
  // 写盘前自愈一次，确保 localStorage 里的凭据始终有效
  fixLegacyDingTalk(options.dingtalk)
  // 渠道级监听名单跟着通道级推送配置走（写盘 / 同步后端前再兜一次，幂等）
  syncChannelCameras(cameras.value, options)
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        cameras: cameras.value,
        options: { ...options },
        hiddenIds: hiddenIds.value,
        layoutKey: layoutKey.value
      })
    )
  } catch (e) {
    /* 存储不可用时忽略 */
  }
}

/*
 * 持久化节流。
 * ⚠️ 下面两个 watch 都是**深度**监听 —— `watch(响应式对象, ...)` 在 Vue 3 里会
 * 自动进入 deep 模式。也就是说「自定义摆放」里拖动一次画面，每个 pointermove
 * 都会命中一次写盘，而每次都要把整个 options + cameras 序列化后同步写进
 * localStorage（主线程阻塞）。拖起来掉帧就是这么来的，所以统一节流成 300ms 一次。
 */
const PERSIST_DELAY = 300
let persistTimer = null

/** 节流写盘：日常的配置变更都走这里 */
function schedulePersist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeStorage()
  }, PERSIST_DELAY)
}

/** 立即写盘：页面要走了、或关键操作之后 */
function persistNow() {
  clearTimeout(persistTimer)
  persistTimer = null
  writeStorage()
}

watch([cameras, hiddenIds, layoutKey], schedulePersist, { deep: true })
watch(options, schedulePersist)

/*
 * 「渠道级监听名单」的重算点全部集中在三处显式调用，**不额外挂监听**：
 *   1) writeStorage()   —— 上面两个监听最终都会走到它（且带 300ms 防抖），覆盖
 *                          一切 cameras / options 改动；
 *   2) applyConfig()    —— 保存并应用时立即对齐，不用等防抖；
 *   3) 载入配置那一次    —— 纠正老存档里跟通道级开关脱节的那份名单。
 * 不挂监听的原因：设置抽屉里改的是「本地副本 + 共享 options」两种东西，
 * 保存前并不一致；如果这里挂个监听跟着重算，会和抽屉里的即时预览互相覆盖。
 */

/*
 * 节流带来一个风险：刚改完配置就关页面，最后 300ms 的改动可能没落盘。
 * 所以在页面隐藏 / 卸载时立刻补一次。
 * pagehide 是 iOS Safari 上最可靠的那个（beforeunload 经常根本不触发）。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', persistNow)
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow()
  })
}

/* ==================== 页面可见性：省电暂停 + 僵尸播放器清理 ==================== */
/*
 * 「切后台时暂停画面」（options.pauseWhenHidden，默认关）。
 * 监控大屏要的是人不在场也持续记录 —— 暂停解码等于把运动检测、AI 识别、
 * 报警推送全部一起停了，所以这是个**显式开启**的省电选项，不是默认行为。
 *
 * 恢复时只 resume 隐藏那一刻「确实在播」的几路：用户手动暂停过的
 * （getStatus 返回 paused）不会被这里强行拉起来。
 */
let hiddenPlayingIdx = []

function onVisChangeForTiles() {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'hidden') {
    if (!options.pauseWhenHidden) return
    hiddenPlayingIdx = []
    tileRefs.forEach((t, i) => {
      if (t && t.getStatus && t.getStatus() === 'playing') {
        hiddenPlayingIdx.push(i)
        t.pause()
      }
    })
  } else if (hiddenPlayingIdx.length) {
    const toResume = hiddenPlayingIdx
    hiddenPlayingIdx = []
    nextTick(() => toResume.forEach((i) => tileRefs[i] && tileRefs[i].resume()))
  }
}

/**
 * pagehide：iOS Safari 从后台回来常走 bfcache（页面不重新加载），
 * 但那时播放器的 WebSocket 早就死了 —— 表现就是「回到页面画面不动、
 * 状态却还显示在线」的僵尸画面。主动销毁，pageshow 再统一重连。
 */
function onPageHideTiles() {
  tileRefs.forEach((t) => t && t.destroy && t.destroy())
}

function onPageShowTiles(e) {
  if (e && e.persisted) {
    // 从往返缓存恢复：播放器刚被销毁，全部重建
    setTimeout(() => tileRefs.forEach((t) => t && t.reconnect && t.reconnect()), 80)
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisChangeForTiles)
  window.addEventListener('pagehide', onPageHideTiles)
  window.addEventListener('pageshow', onPageShowTiles)
}
watch(
  () => options.mask && options.mask.autoMaskMinutes,
  () => scheduleAutoMask()
)
watch(
  () => [
    options.dingtalk && options.dingtalk.patrol && options.dingtalk.patrol.enabled,
    options.dingtalk && options.dingtalk.patrol && options.dingtalk.patrol.intervalMinutes
  ],
  () => schedulePatrol()
)

/* ==================== 后端检测服务（headless，手动开关） ==================== */
/**
 * 开启后端检测时，把传给画面的 options 里 aiEnabled 临时置 false：
 * 各通道的本地人形检测链（抽帧 + ONNX 推理）随之停掉，省下解码/推理算力；
 * 运动检测照旧（帧差几乎不占资源，且只对当前在看的画面有意义）。
 * 事件改由 server/headless-monitor.mjs 轮询拉取，从 onAlarm 原入口进 ——
 * 事件面板、推送调度、系统通知、声音、手表同步全部无需改动。
 * 关闭开关后 effectiveOptions 回到原对象引用，一切照旧。
 */
const backendActive = computed(() => backendOn(options))
const effectiveOptions = computed(() =>
  backendActive.value ? { ...options, aiEnabled: false } : options
)

function onBackendEvent(payload) {
  onAlarm(payload)
}

/* ---------- 配置同步：后端不需要手改 config.json ---------- */
/**
 * 打包要发给后端的那一份配置。
 * 人脸库存在 IndexedDB 里，必须异步读；流地址 / 区域 / 推送凭据全在内存里，随手可取。
 */
async function backendPayload() {
  const faces = await getAllFaces().catch(() => [])
  return {
    options: { ...options },
    cameras: cameras.value,
    faces: faces.map((f) => ({
      name: f.name,
      vector: f.vector,
      thumb: f.thumb || '',
      createdAt: f.createdAt || 0
    }))
  }
}

/** 配置里所有会影响后端检测/推送的字段（用于判断要不要重新同步） */
const backendSyncSignature = computed(() =>
  JSON.stringify({
    backend: options.backend,
    zone: options.zone,
    face: options.face,
    pose: options.pose,
    alert: options.alert,
    cooldownSec: options.cooldownSec,
    aiScore: options.aiScore,
    aiModel: options.aiModel,
    dingtalk: options.dingtalk,
    wecom: options.wecom,
    telegram: options.telegram,
    cameras: cameras.value.map((c) => ({
      id: c.id,
      name: c.name,
      url: c.url,
      urlSub: c.urlSub,
      ai: c.ai,
      aiExt: c.aiExt,
      push: c.push,
      channels: c.channels,
      zones: c.zones,
      roi: c.roi
    }))
  })
)
void backendSyncSignature

/*
 * 「后端手上已经是这一份配置了」的指纹。
 * ----------------------------------------------------------------------------
 * 拉取采用、推送成功、以及"确认已对齐"这三处各记一次；推送之前比一下 ——
 * 一致就说明后端手上就是这一份，再推一次只会把 rev 空涨一格：
 * 别的机器立刻从"已对齐"变成"后端有更新"，那条提示就成了常驻噪音。
 *
 * 为什么不能只靠 applyingRemote 那个瞬时标志来拦回推：
 * 自动推送是 900ms 节流（scheduleConfigSync 收的是**取 payload 的函数**），
 * 「正在采用远端配置」期间排上的那个定时器，醒来时标志早就复位了 ——
 * payload 现算一份、原样推回去，rev +1。本项目真踩过：探针里一个从没发过
 * POST 的页面，后端 rev 却涨了（服务日志"配置已应用（rev 8）"）。
 *
 * 用「指纹」而不是「有没有改动过」的布尔量：用户改完又改回来 = 后端那份没变，
 * 这一发同样不该发出去。
 */
const syncedPushSig = ref('')
const pushSignature = computed(
  () =>
    backendSyncSignature.value +
    '|' +
    faceList.value.map((f) => `${f.id}:${f.name}:${f.updatedAt || 0}`).join(',')
)

/** 取一份"要推给后端"的配置；跟后端手上那份一致时返回 null（同步层会跳过） */
async function pushPayload() {
  if (pushSignature.value === syncedPushSig.value) return null
  return await backendPayload()
}

/** 统一的推送入口：成功之后把指纹记上（所有推送点都走这里，别直接调 syncConfigNow） */
async function pushConfigNow({ silent = true } = {}) {
  if (!options.backend || !options.backend.url) return { ok: false, error: '未配置服务地址' }
  // 先记下"送出去的是哪一份"：请求在飞时用户又改了配置的话，
  // 那一次改动不该被当成已同步（宁可多发一次，也不能漏发）
  const sig = pushSignature.value
  const r = await syncConfigNow(pushPayload, { url: options.backend.url, silent })
  if (r && r.ok) syncedPushSig.value = sig
  return r
}

/** 记下"后端手上就是这一份"（不推送时用：刚采用完远端配置 / 确认已对齐） */
function markPushSynced() {
  syncedPushSig.value = pushSignature.value
}

/*
 * 「正在采用远端拉下来的配置」标志。
 * 采用过程会整体改写 cameras / options / 人脸库 —— 那三处都挂着**自动回推**的监听，
 * 不拦住就会立刻把刚拉下来的东西原样推回去（rev 空涨一格），
 * 更糟的是如果中间还掺着本机残留，推回去的就未必是拉下来的那一份了。
 * 置位 → 改写 → nextTick（Vue 的 watch 在这之前跑完）→ 复位。
 *
 * ⚠️ 必须声明在下面那个 `{ immediate: true }` 的监听**之前**：
 * 它的回调会在 setup() 里同步跑一次，而 alignWithBackend() 会读这个标志 ——
 * 声明在后就是 TDZ（`Cannot access '…' before initialization`），
 * 那一抛会把「开机对齐」整条链路带走：本机明明该拉配置，结果原地不动（空大屏）。
 */
let applyingRemote = false

/*
 * ⚠️ 监听源是**拼好的一个字符串**，不是 `() => [enabled, url, pollMs]`。
 *
 * 返回数组的 getter 在 Vue 里"永远变了"：每次求值都是新数组实例，
 * 浅比较（hasChanged）恒不等 —— 于是**任何一次 options 改写**都会把它抖起来，
 * 包括"采用后端配置"时那次整体重写（先 delete 掉所有键再铺新的）。
 * 后果很隐蔽：那一刻 cameras 已经换成后端那份、而"本机版本号"还没记上
 * （localRev 仍是 0），于是 alignWithBackend() 判定"本机从没跟这个后端交换过"
 * → 把刚拉下来的配置原样推回去，rev 空涨一格。
 * 本项目真踩过，探针里抓到的那一发 POST 就是 `baseRev: 0, cams: 2`（采用完的配置）。
 *
 * 拼成字符串之后，只有这三个值**真的**变了才会进回调 —— 正好是下面注释里写的时机。
 */
watch(
  () =>
    `${options.backend && options.backend.enabled}|${(options.backend && options.backend.url) || ''}|` +
    `${(options.backend && options.backend.pollMs) || ''}`,
  () => {
    if (backendActive.value) {
      startBackendPolling(options, onBackendEvent)
      /*
       * 「与后端对齐」——注意**不是**无条件把本机配置推过去。
       *
       * 原来的写法是开关一打开就 syncConfigNow()，于是局域网里另一台机器
       * （本机没有存档，跑的是空的初始化配置）只要把开关一打开，就会把
       * 那份空白配置整体推给后端，把常驻设备上配好的通道与凭据一起清掉 ——
       * 这是「先推后问」的必然结果。现在统一走 alignWithBackend()：
       * 本机是空大屏就先**拉**、本机落后就只提示、已对齐就不重复推。
       */
      alignWithBackend()
      refreshBackendWatchdog(options)
    } else {
      stopBackendPolling()
      stopConfigSync()
    }
    // 巡检定时器归属会跟着模式切换（本地 ↔ 服务端），这里重排一次。
    // 延到下一个 tick 再排：这个 watch 是 immediate 的，比 patrolTimer 的声明还早执行
    setTimeout(() => schedulePatrol(), 0)
  },
  { immediate: true }
)

/**
 * 开着后端检测时，配置一有变化就同步过去（节流合并）。
 * 深监听整份配置开销大，所以只看「签名」——它精确覆盖了后端关心的字段。
 */
watch(
  () => [backendActive.value, backendSyncSignature.value],
  () => {
    if (!backendActive.value) return
    if (applyingRemote) return
    scheduleConfigSync(pushPayload, { url: options.backend.url })
  }
)

/** 人脸库变动后立即同步一份（录完人马上生效，不等下一个周期） */
async function pushFacesToBackend() {
  if (!backendActive.value) return
  if (applyingRemote) return
  await pushConfigNow({ silent: true })
}

/** 设置页「立即同步」按钮 */
async function onBackendSyncNow() {
  if (!options.backend || !options.backend.url) return
  await pushConfigNow({ silent: false })
  await refreshRemoteStatus(options.backend.url)
}

/**
 * 人脸库变动（录人 / 改名 / 删除）后自动同步到后端。
 * 只盯「名单」不盯向量：向量在 IndexedDB 里读一次要开事务，
 * 而名单变化就一定意味着底库变了，逐个改动都覆盖得到。
 */
watch(
  () => faceList.value.map((f) => `${f.id}:${f.name}`).join(','),
  () => {
    if (backendActive.value) pushFacesToBackend()
  }
)

/* ==================== 配置反向同步（从后端拉取） ==================== */
/*
 * 为什么需要这一段：
 * 配置原本只存在**配它的那个浏览器**的 localStorage 里（外加后端手上那一份）。
 * 于是局域网里另一台机器打开同一个地址，看到的是它自己的初始化配置 ——
 * 一块空大屏、什么通道都没有，而后端明明有 7 路在跑。
 *
 * 三个入口共用同一套「拉取 → 采用」：
 *   ① 本机一路通道都没有、而后端那边有 → 页面载入 / 打开后端开关时自动拉（先拉后推）
 *   ② 设置页「从后端拉取配置」按钮
 *   ③ 本机落后于后端时的提示（也走 ②）
 * （"本页是不是后端发出来的"那一步在门禁里做，见 src/LoginGate.vue ——
 *   前端模式下 App 根本不挂载，写在这儿的自动发现永远跑不到。）
 *
 * ⚠️ 方向相反的那条路（推）保留原样：本机有配置、且没落后，仍然由本机说了算。
 *    两边都改 = 两台机器互相覆盖，谁也不服谁。
 */

/**
 * 与后端做一次对齐（三种时机共用：页面载入 / 开关打开 / 地址变更）。
 *
 * 决策表：
 *   本机一路通道都没有        → 只拉不推（把后端那份整体取回来）
 *   本机落后（localRev < 后端 rev）→ 不推、不覆盖，只把"后端有更新"标出来给用户看
 *   本机从没跟这个后端交换过  → 推（这是"配好之后第一次开开关"的正常路径）
 *   已对齐                    → 什么都不做（避免每次打开页面都把 rev 推高一格，
 *                              那会让"落后"提示对所有机器都变成噪音）
 */
async function alignWithBackend() {
  if (!backendActive.value) return
  /*
   * 正在采用远端配置时**不参与对齐**：那一刻本机状态是半新半旧的
   * （cameras 已换成后端那份，而 localRev 还没记上），任何判定都会得出
   * "本机从没对齐过 → 推上去"的错误结论。等这次采用结束自然会有下一次触发。
   */
  if (applyingRemote) return
  const url = options.backend.url
  // 先问一次后端当前状态：既是"连得上吗"，也是"后端是哪个版本"
  const st = await refreshRemoteStatus(url)
  if (!st) {
    // 连不上：不拉也不推（推了也是白推，只会把 syncState 弄成 error）
    return
  }

  if (cameras.value.length === 0) {
    await pullFromBackend({ confirm: false, reason: 'empty' })
    return
  }

  if (localRev.value > 0 && syncRev.value > localRev.value) {
    /*
     * 后端比本机新 —— 说明**别的设备**改过后端。
     * 这里刻意不静默覆盖本机：本机可能也有还没推上去的改动，
     * 直接以后端为准会把它悄悄抹掉；反过来直接推翻后端则会抹掉别人刚做的修改。
     * 所以只把事实摆出来（设置页的「配置同步」区），由用户点一下决定。
     */
    console.warn(`⚠️  后端配置（rev ${syncRev.value}）比本机（rev ${localRev.value}）新，请在设置页选择以哪边为准`)
    return
  }

  if (localRev.value > 0 && localRev.value === syncRev.value) {
    // 本机这份配置就是后端手上那一份，不用重复推
    // （把指纹记上：之后任何一次"改了又改回来"也不会白发一发出去）
    markPushSynced()
    return
  }

  // 走到这里说明本机配置确实需要推上去（首次接触 / 后端那份丢了）——给个可见反馈
  await pushConfigNow({ silent: false })
}

/**
 * 从后端拉取整份配置并**采用**。
 * @param {{confirm?:boolean, reason?:string}} opts confirm=true 时先弹确认（覆盖本机配置是有代价的）
 * @returns {Promise<boolean>} 是否真的采用了
 */
async function pullFromBackend({ confirm = true, reason = 'manual' } = {}) {
  if (!options.backend || !options.backend.url) return false
  const r = await pullConfig(options.backend.url)
  if (!r.ok) {
    if (reason === 'manual') showToast(`拉取失败：${r.error}`)
    return false
  }
  const data = r.data
  const remoteCams = Array.isArray(data.cameras) ? data.cameras.length : 0

  if (confirm) {
    const local = cameras.value.length
    const msg =
      `用后端配置覆盖本机？\n\n` +
      `后端：${remoteCams} 路通道 · ${(data.faces || []).length} 人底库 · rev ${data.configRev}\n` +
      `本机：${local} 路通道\n\n` +
      `本机的通道 / 区域 / 推送凭据 / 人脸库会被后端那份整体替换（可撤销：改完再点「立即同步」推回去）。`
    if (typeof window !== 'undefined' && !window.confirm(msg)) return false
  }

  await applyPulledConfig(data, reason)
  return true
}

/**
 * 采用一份从后端拉下来的配置。
 *
 * 与设置页「保存配置」(applyConfig) 的区别只有一处：**人脸库也要重建**
 * （后端有向量，前端本地库得跟着换，否则设置页显示的人脸与后端认识的人会对不上）。
 *
 * 顺序上先停掉一切不该再跑的东西，再整体换配置，最后落盘 ——
 * 换到一半被定时器读到旧配置是最难查的一类问题。
 */
async function applyPulledConfig(data, reason = 'manual') {
  applyingRemote = true
  try {
    // 通道：与载入存档时走同一条归一化链路（少了它，老字段形态会让画面出不来）
    cameras.value = (Array.isArray(data.cameras) ? data.cameras : []).map((c) =>
      normalizeCameraSilent(
        normalizeCameraChannels({
          ...c,
          channels: c.channels ? { ...c.channels } : undefined,
          roi: c.roi ? { ...c.roi } : null,
          rect: c.rect ? { ...c.rect } : null
        })
      )
    )

    /*
     * options：整体换成后端那一份 —— 不能只 Object.assign，本机可能留着后端没有的
     * 旧键（例如已经删掉的配置项），只覆盖同名键的话那些残留会一直跟着本机，
     * 下次推上去又回到后端。
     *
     * ⚠️ 但**不能**把 `options.backend` 也一起清掉再补：那会让它在中间有一瞬间是
     *    undefined，`backendActive` 跟着闪一下 false —— 够把正在跑的轮询停掉，
     *    也够把**排队中的一次自动推送取消掉**（那个 watch 的 else 支路会 stopConfigSync）。
     *    于是"采用完还会不会回推"这件事就变成了"取决于有没有恰好闪一下"，
     *    谁也说不清（本项目真踩过：探针里那条断言一直是绿的，因为推送是被这个
     *    副作用挡住的，而不是被守卫挡住的）。这里改成：清掉**除 backend 以外**的键，
     *    backend 段最后单独合并 —— 全程不出现半成品状态。
     */
    const localBackend = { ...(options.backend || {}) }
    const defOpts = cloneDefaultOptions()
    const defaultBackend = { ...(defOpts.backend || {}) }
    delete defOpts.backend
    const incoming = JSON.parse(JSON.stringify(data.options || {}))
    const pulledBackend = { ...(incoming.backend || {}) }
    delete incoming.backend
    Object.keys(options).forEach((k) => {
      if (k !== 'backend') delete options[k]
    })
    Object.assign(options, defOpts, incoming)
    normalizeDingTalk(options.dingtalk)
    fillMissingOptions(options)
    migrateSecretFields(options)

    /*
     * `options.backend` 里混着两类字段，必须分开对待：
     *   · 本机的  —— enabled（这台机器当不当客户端）、url（连哪个地址）、pollMs（本机轮询节奏）
     *   · 后端的  —— ffmpegPath（后端解码用哪个 ffmpeg，得以后端为准）
     * 整体替换会把「本机是不是客户端」也按后端手上那一份改掉 —— 而那份里的 enabled
     * 其实是当初**某个客户端**推上去的（完全可能是 false），于是刚拉完配置就把自己的
     * 后端模式关掉了：画面当场切回前端模式，这台机器开始自己拉流、自己检测、
     * 自己推送（同一路流被两台机器各推一遍）。
     *
     * 本项目真踩过这个：探针里拉完以后 `options.backend.enabled` 变成 false，
     * 「同源接管」那条断言就红了 —— 而且真机上不会报任何错，只会"拉完反而更乱"。
     */
    options.backend = {
      ...defaultBackend,
      enabled: !!localBackend.enabled,
      // 本机那份地址优先（拉回来那份可能是**别的机器**的地址），空了才用后端的
      url: backendBase(localBackend.url) || pulledBackend.url || '',
      pollMs: localBackend.pollMs || pulledBackend.pollMs,
      ffmpegPath: pulledBackend.ffmpegPath || ''
    }

    // 后端地址：本机连不上的话这份配置等于废的（见 resolveBackendUrl）
    const fixedUrl = await resolveBackendUrl(options.backend.url)
    if (fixedUrl) options.backend.url = fixedUrl

    hiddenIds.value = []
    zoomIndex.value = null
    if (layoutKey.value === 'free') ensureFreeRects()

    // 渠道级监听名单跟着通道级开关走（后端那份可能来自更老的版本）
    syncChannelCameras(cameras.value, options)

    /*
     * 人脸库整体替换（失败不阻断：通道与凭据已经可用，人要另说的是另一件事）。
     *
     * ⚠️ 注意 `skipped`：后端那份底库是**空的**、而本机有人的时候，
     *    replaceFaces 会**保住本机**（见 useFaceLib.replaceFaces 的说明）——
     *    「以后端为准」不等于"以后端的空为准"。这时候必须让用户知道，
     *    否则界面显示 3 人、后端认为 0 人，两边对同一件事各说一套。
     */
    let facesSkippedLocal = 0
    try {
      const n = (data.faces || []).length
      const r = await replaceFaces(data.faces || [])
      if (r && r.skipped) {
        facesSkippedLocal = Number(r.count) || 0
        console.warn(`⚠️  后端人脸库是空的，本机 ${facesSkippedLocal} 人已保留（没被清空）`)
      } else if (n) {
        console.log(`👤 人脸库已从后端拉取：${n} 人`)
      }
    } catch (e) {
      console.warn('⚠️  人脸库拉取失败：', (e && e.message) || e)
    }

    /*
     * 记下"本机这份配置对应后端的哪个版本"。
     * 必须在**采用之后**才记：拉了但没采用（用户取消）时记上，
     * 落后判定就永久失效了 —— 本机明明还是旧配置，却显示"已对齐"。
     */
    markSynced(data.configRev)
    /*
     * 同时记下"后端手上就是这一份" —— 否则自动推送那个 900ms 节流定时器
     * 醒来时（applyingRemote 早已复位）会把刚拉下来的配置原样推回去，
     * rev 空涨一格，别的机器立刻显示"后端有更新"。
     */
    markPushSynced()

    persistNow()
    settingsOpen.value = false
    await nextTick()
    // 画面按新配置重连（与 applyConfig 一致：80ms 后让播放器重来一次）
    setTimeout(() => tileRefs.forEach((t) => t && t.reconnect()), 80)

    const label = reason === 'empty' || reason === 'auto' ? '已接管后端配置' : '已从后端拉取配置'
    showToast(
      `${label}（${cameras.value.length} 路通道）` +
        // 人脸库被保住时要说清楚：否则"拉完人还在"看起来像没生效
        (facesSkippedLocal ? ` · 后端人脸库为空，本机 ${facesSkippedLocal} 人已保留` : '')
    )
  } finally {
    applyingRemote = false
  }
}

/**
 * 校正后端地址：**本机能连上的优先**。
 *
 * 起因：A 机器上那个地址很可能是 `http://127.0.0.1:8787`（自己连自己）。
 * B 机器把配置拉过去之后，这个地址指向的是 **B 自己**，于是"拉到了配置却
 * 一路都连不上"。规则按顺序试：
 *   ① 拉回来那个地址本机连得上 → 原样保留（不动正常工作着的配置）
 *   ② 本页面的同源地址是监测后端 → 用它
 *   ③ 都不行 → 原样返回（让用户自己去设置页改，别擅自改成别的机器）
 *
 * 认领判据用 `/api/auth/info` 的 service 字段 —— 与 useAuth.detectBackend()、
 * 与门禁判断"本页是不是后端发出来的"是**同一份判据**。
 * 别改成"请求成功就算"：任何一个静态服务器都可能对这个路径回 200
 * （SPA 落回 index.html 还会给你一坨 HTML），那样会把普通网页服务器当后端。
 */
async function resolveBackendUrl(url) {
  const cur = backendBase(url)
  const origin = typeof location !== 'undefined' ? location.origin : ''
  const sameOriginOk = (u) => backendBase(u) === backendBase(origin)
  const reachable = async (u) => {
    if (!u) return false
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 4000)
      try {
        const res = await fetch(`${backendBase(u)}/api/auth/info`, { signal: ctrl.signal })
        if (!res.ok) return false
        const d = await res.json()
        return !!(d && d.ok && d.service === 'BossMonitor')
      } finally {
        clearTimeout(t)
      }
    } catch (e) {
      return false
    }
  }
  if (!cur) return origin || url
  if (sameOriginOk(cur)) return cur
  if (await reachable(cur)) return cur
  if (await reachable(origin)) {
    console.warn(`🔀 后端地址已按当前页面地址校正：${cur} → ${origin}（原地址在本机连不上）`)
    return origin
  }
  return cur
}

/** 设置页「从后端拉取配置」按钮 */
async function onBackendPull() {
  await pullFromBackend({ confirm: true, reason: 'manual' })
}

/* ==================== 可见列表与布局 ==================== */
const visibleCameras = computed(() => cameras.value.filter((c) => !hiddenIds.value.includes(c.id)))

/* ==================== 性能保护：同时解码上限 ==================== */
/** 用户手动点播的省流通道（按点击顺序，FIFO 淘汰） */
const manualIds = ref([])
/** 用户是否已经手动点播过（点播后互斥逻辑生效） */
const userPicked = ref(false)
/** 是否处于「全部暂停」状态（点「全部播放」恢复） */
const allPaused = ref(false)

const maxDecodeCount = computed(() => {
  const v = Number(options.maxDecode)
  return v > 0 ? v : Infinity
})
const autoPlayCount = computed(() => Math.max(0, Number(options.autoPlayCount)))
/** 自定义同时播放通道（留空 = 走「前 N 路」规则） */
const autoPlayIds = computed(() => (Array.isArray(options.autoPlayIds) ? options.autoPlayIds : []))
const capOf = () => (maxDecodeCount.value === Infinity ? 99 : maxDecodeCount.value)

/** 参与解码的通道 id 集合：手动点播优先，再按自定义列表 / 前 N 路规则补足 */
const decodeIds = computed(() => {
  const visible = visibleCameras.value
  const cap = capOf()
  const has = (id) => visible.some((c) => c.id === id)

  // 互斥点播：用户点过之后，只播他点的那几路（+保留的监听通道）
  const base = manualIds.value.filter(has).slice(0, cap)
  if (userPicked.value && options.exclusivePlay !== false) return base

  const set = [...base]

  // 自定义同时播放通道：只播选中的那几路（顺序即优先级）
  const picked = autoPlayIds.value.filter(has)
  if (picked.length) {
    for (const id of picked) {
      if (set.length >= cap) break
      if (!set.includes(id)) set.push(id)
    }
    return set
  }

  const want = Math.min(cap, Math.max(autoPlayCount.value, set.length))
  for (const c of visible) {
    if (set.length >= want) break
    if (!set.includes(c.id)) set.push(c.id)
  }
  return set
})

/** 钉钉监听通道（这些通道要保证一直在解码，报警检测才不会中断） */
function watchedIds() {
  return options.dingtalk && Array.isArray(options.dingtalk.cameras) ? options.dingtalk.cameras : []
}

/** 某个通道当前会推送到哪些渠道（用于巡检 / 通知里展示开关状态） */
function activeChannelNames(cam) {
  const out = []
  ;[
    ['钉钉', options.dingtalk],
    ['企微', options.wecom],
    ['TG', options.telegram]
  ].forEach(([name, cfg]) => {
    if (cfg && cfg.enabled && Array.isArray(cfg.cameras) && cfg.cameras.includes(cam.id)) out.push(name)
  })
  return out
}

/**
 * 事件详情用：这一路在三个渠道上的推送开关状态 + 未推送的原因。
 * 名称与消息里的渠道名保持一致（钉钉 / 企微 / TG），方便和 pushChannels 对上。
 */
function pushStateOf(ev) {
  if (!ev) return []
  const camCh = ev.channels || null
  const masterOff = ev.push === 'off'
  const silenced = ev.push === 'silent'
  const pushed = String(ev.pushChannels || '')

  /*
   * ⚠️ 三层状态，别再拿配置反推：
   *   1. pushChannels —— 本次**调用过**哪些渠道。推送一发起就写回，不等回调
   *      （截图上传 + 图床 + 三家接口最长要 60s，等回调期间界面会一直空白）。
   *   2. pushResults  —— 各渠道的最终结果：ok / fail:原因 / timeout。
   *   3. 配置          —— 只在前两项都没有时用来解释「为什么没推」。
   * 用户诉求：只要调用了就显示「已推送」，有回调再额外标注成功/失败/超时。
   */
  const sentNames = pushed
    .split(/[+、,，\/]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1)
  const results = ev.pushResults && typeof ev.pushResults === 'object' ? ev.pushResults : null

  const defs = [
    ['ding', '钉钉', options.dingtalk],
    ['wecom', '企微', options.wecom],
    ['tg', 'TG', options.telegram]
  ]
  // 静默时段收存的事件：三个渠道都不实时推，结束时刻统一汇总。单独标一种状态。
  if (silenced) {
    return defs.map(([id, label, cfg]) => ({
      id,
      label,
      sent: false,
      called: false,
      on: false,
      silenced: true,
      why: '静默时段已收存，结束时刻推送结束提醒 + 汇总'
    }))
  }
  return defs.map(([id, label, cfg]) => {
    const c = cfg || {}
    const called = sentNames.some((n) => n.includes(label) || label.includes(n))
    const base = { id, label, sent: called, called }

    // 1) 本次调用过：先认「已推送」，再按回调结果补充最终状态
    if (called) {
      const r = results ? results[label] || results[label.toLowerCase()] : null
      if (r === 'ok') return { ...base, on: true, state: 'ok', why: '已推送成功' }
      if (r === 'timeout') return { ...base, on: true, state: 'timeout', why: '已推送，结果未知（超时）' }
      if (typeof r === 'string' && r.startsWith('fail:'))
        return { ...base, on: true, state: 'fail', why: `已推送但失败：${r.slice(5)}` }
      // 还在推送中，或没有结果：按用户要求直接显示"已推送"
      return { ...base, on: true, state: 'sending', why: '已推送（等待回执）' }
    }

    // 2) 没调用到这个渠道：能解释就解释清楚
    if (masterOff) return { ...base, on: false, why: '该通道已关闭「推送总开关」' }
    /*
     * 后端推送是异步的（截图上传 + 图床 + 三家接口最长 60s），前端轮询到这条事件时，
     * 后端可能**还没回写**逐渠道状态 —— 此时 push 有值但 pushChannels 是空的。
     * 这属于「结果未知」，不是「没推这个渠道」，不能报成"本次推送未包含该渠道"。
     */
    if (ev.source === 'backend' && ev.push && !pushed) {
      // state 给 'sending'：渠道标签显示「推送中」而不是干巴巴的 off，与上方「正在推送…」一致
      return { ...base, on: false, state: 'sending', why: '由后端推送 · 渠道回执尚未回写' }
    }
    if (ev.push === 'ok' || ev.push === 'merged' || ev.push === 'fail' || ev.push === 'sending') {
      return { ...base, on: false, why: '本次推送未包含该渠道' }
    }
    const cfgReason = cfgBlockReason(id, c, ev, camCh)
    return cfgReason
      ? { ...base, on: false, why: cfgReason }
      : { ...base, on: true, why: '已开启' }
  })
}

/** 按当前配置算「这个渠道为什么推不了」，能推就返回空串 */
function cfgBlockReason(id, c, ev, camCh) {
  if (!c || !c.enabled) return '渠道未启用'
  const ready =
    id === 'tg'
      ? !!String(c.token || '').trim() && !!String(c.chatId || '').trim()
      : !!String(c.webhook || '').trim()
  if (!ready) return '凭据未配置完整'
  if (camCh && camCh[id] === false) return '该通道未勾选此渠道'
  /*
   * ⚠️ 这里原来还要看渠道配置里的 cameras（渠道页的「需要监听的监控」），
   * 于是电梯/大厅明明在「监控通道」页开了推送，详情里也会被解释成
   * 「该通道未在渠道里勾选」，与 useAlertPush.checkChannel 的真实行为对不上。
   * 那份名单现在只是通道级配置的派生镜像，不参与放行，这里也不再看它。
   * 只有 record 完全没带通道级信息时（老事件）才回落到它。
   */
  if (!camCh && Array.isArray(c.cameras) && c.cameras.length && !c.cameras.includes(ev.id)) {
    return '该通道未在渠道里勾选'
  }
  return ''
}

function onRequestPlay(id) {
  userPicked.value = true
  const cap = capOf()
  const keepWatched = options.exclusivePlay !== false && options.keepWatchedOnPlay !== false
  const before = [...decodeIds.value]
  if (options.exclusivePlay !== false) {
    // 互斥：只保留刚点播的（以及可选的监听通道）
    const ids = [id]
    if (keepWatched) {
      watchedIds().forEach((wid) => {
        if (wid !== id && visibleCameras.value.some((c) => c.id === wid)) ids.push(wid)
      })
    }
    manualIds.value = ids.slice(0, cap)
    const stopped = before.filter((x) => !decodeIds.value.includes(x))
    const kept = ids.filter((x) => x !== id)
    if (stopped.length) {
      showToast(`已切换到「${nameOf(id)}」，${stopped.length} 路画面已停止以节省资源`)
    } else if (kept.length) {
      showToast(`已切换到「${nameOf(id)}」，${kept.map(nameOf).join('、')} 作为监听通道仍在播放`)
    }
    return
  }
  // 非互斥：受解码上限约束，超出则淘汰最早点播的
  let list = manualIds.value.filter((x) => x !== id)
  list = [id, ...list]
  while (list.length > cap) list.pop()
  manualIds.value = list
}

function nameOf(id) {
  const c = cameras.value.find((x) => x.id === id)
  return c ? c.name : id
}

watch(visibleCameras, (list) => {
  const ids = new Set(list.map((c) => c.id))
  if (manualIds.value.some((id) => !ids.has(id))) {
    manualIds.value = manualIds.value.filter((id) => ids.has(id))
  }
})

const onlineCount = computed(
  () => Object.values(statusMap).filter((s) => s.status === 'playing').length
)

/** 画面区域的实时尺寸（用 ResizeObserver 跟着元素走，移动端地址栏收缩也不会算错） */
const viewport = reactive({ w: window.innerWidth, h: window.innerHeight })
/** 手机竖屏：走单列滚动布局 */
const isPhone = computed(() => viewport.w > 0 && viewport.w < 640)
/** 窄屏（手机 + 小竖屏平板）：隐藏次要文案 */
const isNarrow = computed(() => viewport.w > 0 && viewport.w < 900)

let wallObserver = null

function measureWall() {
  const el = wallEl.value
  if (!el) return
  const w = el.clientWidth
  const h = el.clientHeight
  if (w > 0) viewport.w = w
  if (h > 0) viewport.h = h
}

function observeWall() {
  if (wallObserver) wallObserver.disconnect()
  if (!wallEl.value || typeof ResizeObserver === 'undefined') return
  wallObserver = new ResizeObserver(measureWall)
  wallObserver.observe(wallEl.value)
  measureWall()
}

function onResize() {
  viewport.w = window.innerWidth
  viewport.h = window.innerHeight
  measureWall()
}

const FOCUS_AREAS = ['m', 'a', 'b', 'c', 'd', 'e', 'f']

const gridStyle = computed(() => {
  const n = visibleCameras.value.length
  if (!n) return {}

  // 自定义摆放：坐标由每路画面的 rect 决定，不用网格
  if (layoutKey.value === 'free') return {}

  if (layoutKey.value === 'focus') {
    // 手机上 6 列大网格不可用，退化成「上面 1 大 + 下面 2 列」
    if (isPhone.value) {
      return {
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gridTemplateRows: 'none',
        gridAutoRows: 'auto'
      }
    }
    return {
      gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
      gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
      gridTemplateAreas: '"m m m a b c" "m m m d e f"'
    }
  }

  // 手机竖屏：单列纵向滚动，每格 16:9，手指点得中
  if (isPhone.value) {
    return {
      gridTemplateColumns: 'minmax(0, 1fr)',
      gridTemplateRows: 'none',
      gridAutoRows: 'auto'
    }
  }

  let cols
  const preset = LAYOUTS.find((l) => l.key === layoutKey.value)
  if (preset && typeof preset.cols === 'number') {
    cols = preset.cols
  } else {
    const aspect = viewport.w / Math.max(1, viewport.h)
    cols = Math.max(1, Math.round(Math.sqrt(n * aspect)))
  }
  cols = Math.min(cols, n)
  const rows = Math.ceil(n / cols)
  return {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`
  }
})

function tileStyle(i) {
  // 放大时由 .tile.zoomed 铺满屏幕，不要被自定义坐标干扰
  if (zoomIndex.value === i) return null

  if (layoutKey.value === 'free') {
    const cam = visibleCameras.value[i]
    const r = cam && cam.rect
    if (!r) return null
    return { left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }
  }
  if (layoutKey.value !== 'focus') return null
  // 手机：没有 grid-template-areas，第一路横跨两列当作主画面
  if (isPhone.value) return i === 0 ? { gridColumn: 'span 2' } : null
  const area = FOCUS_AREAS[i]
  return area ? { gridArea: area } : null
}

function setLayout(key) {
  layoutKey.value = key
  zoomIndex.value = null
  if (key === 'free') ensureFreeRects()
}

function setTileRef(i, el) {
  if (el) tileRefs[i] = el
}

/* ==================== 自定义摆放（拖动 / 拉伸） ==================== */
const MIN_SIZE = 8 // 画面最小尺寸（百分比）
const GAP = 1 // 默认网格间距（百分比）

/** 生成默认网格中的第 i 个位置 */
function defaultFreeRect(i, n) {
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n)))))
  const rows = Math.ceil(n / cols)
  const w = (100 - GAP * (cols + 1)) / cols
  const h = (100 - GAP * (rows + 1)) / rows
  const c = i % cols
  const r = Math.floor(i / cols)
  return {
    x: round2(GAP + c * (w + GAP)),
    y: round2(GAP + r * (h + GAP)),
    w: round2(w),
    h: round2(h)
  }
}

function round2(v) {
  return Math.round(v * 100) / 100
}

/** 给还没有坐标的画面补一份默认网格坐标 */
function ensureFreeRects(force = false) {
  const list = visibleCameras.value
  const n = list.length
  let changed = false
  list.forEach((cam, i) => {
    if (force || !cam.rect || typeof cam.rect.w !== 'number') {
      cam.rect = defaultFreeRect(i, n)
      changed = true
    }
  })
  if (changed) cameras.value = [...cameras.value]
}

/** 重置为整齐网格 */
function resetFreeRects() {
  ensureFreeRects(true)
  showToast('已把画面恢复成默认网格，可继续拖动调整')
}

const freeDrag = ref(null)
const guide = reactive({ x: 0, y: 0 })

function onFreeGrab({ id, mode, ev }) {
  const cam = cameras.value.find((c) => c.id === id)
  if (!cam) return
  if (!cam.rect) {
    const i = visibleCameras.value.findIndex((c) => c.id === id)
    cam.rect = defaultFreeRect(Math.max(0, i), visibleCameras.value.length)
  }
  const host = wallEl.value
  const el = host && host.querySelector ? host.querySelector('.free-wall') : null
  const rect = (el || host) && (el || host).getBoundingClientRect()
  if (!rect || !rect.width || !rect.height) return
  freeDrag.value = {
    id,
    mode,
    startX: ev.clientX,
    startY: ev.clientY,
    wallW: rect.width,
    wallH: rect.height,
    wallLeft: rect.left,
    wallTop: rect.top,
    rect0: { ...cam.rect }
  }
  guide.x = cam.rect.x
  guide.y = cam.rect.y
  document.body.classList.add('free-dragging')
  // 用 pointer 事件：鼠标和触摸统一处理（pointerdown 已 preventDefault，触摸不会触发滚动）
  window.addEventListener('pointermove', onFreeMove, { passive: false })
  window.addEventListener('pointerup', onFreeUp)
  window.addEventListener('pointercancel', onFreeUp)
}

function onFreeMove(e) {
  const d = freeDrag.value
  if (!d) return
  // 触摸拖动时阻止页面滚动
  if (e.cancelable) e.preventDefault()
  const cam = cameras.value.find((c) => c.id === d.id)
  if (!cam) return

  const dx = ((e.clientX - d.startX) / d.wallW) * 100
  const dy = ((e.clientY - d.startY) / d.wallH) * 100
  const r0 = d.rect0

  if (d.mode === 'move') {
    cam.rect = {
      w: r0.w,
      h: r0.h,
      x: round2(clamp(r0.x + dx, 0, 100 - r0.w)),
      y: round2(clamp(r0.y + dy, 0, 100 - r0.h))
    }
  } else {
    cam.rect = {
      x: r0.x,
      y: r0.y,
      w: round2(clamp(r0.w + dx, MIN_SIZE, 100 - r0.x)),
      h: round2(clamp(r0.h + dy, MIN_SIZE, 100 - r0.y))
    }
  }
  guide.x = cam.rect.x
  guide.y = cam.rect.y
  cameras.value = [...cameras.value]
}

function onFreeUp() {
  if (freeDrag.value) {
    const cam = cameras.value.find((c) => c.id === freeDrag.value.id)
    if (cam) {
      showToast(
        `${cam.name}：位置 ${cam.rect.x}%, ${cam.rect.y}% · 大小 ${cam.rect.w}% × ${cam.rect.h}%`
      )
    }
  }
  freeDrag.value = null
  document.body.classList.remove('free-dragging')
  window.removeEventListener('pointermove', onFreeMove)
  window.removeEventListener('pointerup', onFreeUp)
  window.removeEventListener('pointercancel', onFreeUp)
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v))
}

/** 拖动时显示的坐标提示 */
const guideText = computed(() => {
  const d = freeDrag.value
  if (!d) return ''
  const cam = cameras.value.find((c) => c.id === d.id)
  if (!cam || !cam.rect) return ''
  const r = cam.rect
  return d.mode === 'move'
    ? `位置 ${r.x}% , ${r.y}%`
    : `大小 ${r.w}% × ${r.h}%`
})

/* ==================== 监控状态汇总 ==================== */
function onTileStatus(payload) {
  const prevEntry = statusMap[payload.id]
  const prev = prevEntry ? prevEntry.status : null
  statusMap[payload.id] = {
    status: payload.status,
    text: payload.text,
    info: payload.info,
    notified: prevEntry && prevEntry.notified
  }
  if (payload.status === 'error' && !statusMap[payload.id].notified) {
    statusMap[payload.id].notified = true
    showToast(`${payload.text || '播放失败'}：可点画面中央的按钮重试`)
  }
  handleStatusTransition(payload.id, prev, payload.status, payload.text)
}

function onUpdateCamera({ id, patch, notice }) {
  const cam = cameras.value.find((c) => c.id === id)
  if (!cam) return
  Object.assign(cam, patch)
  cameras.value = [...cameras.value]
  // 通道级开关点开了但总闸还关着时，提示去哪儿开总开关（否则看着像点了没反应）
  if (notice) showToast(notice)
}

function onRoiChange({ id, roi }) {
  const cam = cameras.value.find((c) => c.id === id)
  if (!cam) return
  cam.roi = roi
  cameras.value = [...cameras.value]
  showToast(roi ? '已设置检测区域' : '已清除检测区域')
}

/** 画面上新圈出的一个「进出 / 徘徊」区域 */
function onZoneAdd({ id, rect }) {
  const cam = cameras.value.find((c) => c.id === id)
  if (!cam) return
  if (!Array.isArray(cam.zones)) cam.zones = []
  const zc = options.zone || {}
  const n = cam.zones.length + 1
  cam.zones = [
    ...cam.zones,
    {
      id: `z${Date.now().toString(36)}${n}`,
      name: `区域${n}`,
      rect: { ...rect },
      /** 上报走入 / 走出 */
      enterExit: true,
      /** 开启徘徊检测 */
      loiter: true,
      /** 徘徊判定参数：直接套用全局设置里那一套，避免每个区域都要单独调 */
      loiterSec: Number(zc.loiterSec) || 20,
      loiterRadius: Number(zc.loiterRadius) || 0.08,
      /** 停留多久才算一次有效「走出」（避免贴边抖动误报），毫秒 */
      minDwellMs: 600
    }
  ]
  cameras.value = [...cameras.value]
  showToast(`已新增「区域${n}」，可在设置里改名或调整规则`)
}

/** 设置面板里改某个通道的数组型字段（目前是检测区域列表） */
function onUpdateCameras({ id, zones }) {
  const cam = cameras.value.find((c) => c.id === id)
  if (!cam) return
  if (Array.isArray(zones)) cam.zones = zones
  cameras.value = [...cameras.value]
}

function onZoneClear({ id }) {
  const cam = cameras.value.find((c) => c.id === id)
  if (!cam) return
  cam.zones = []
  cameras.value = [...cameras.value]
  showToast('已清除全部区域')
}

/* ==================== 报警事件 ==================== */
const push = useAlertPush(options, {
  onState: (key, state, error) => markPush(key, state, error),
  notify: (msg) => showToast(msg),
  // 后端模式下推送由服务端负责，免打扰提醒也交给服务端发，前端不重复发
  preSilenceEnabled: () => !backendActive.value,
  /*
   * 通道列表单独传：它不在 options 里（是另一个 ref），而推送调度器要靠它判断
   * 「这一条属于哪一路、那一路有没有在通道静默」。写成 options.cameras 会多存一份
   * 镜像，且一旦不同步就是"配了通道静默却不生效"。
   */
  getCameras: () => cameras.value
})

function markPush(key, state, error, channels, results) {
  /*
   * pushChannels 只增不减：它记录「本次调用过哪些渠道」。
   * settle 落定时会再发一次（可能只含成功渠道），这里若直接覆盖，
   * 就会把「已发出但失败/超时」的渠道抹掉，界面又变成"未包含该渠道"。
   */
  const patch = { push: state, pushError: error || '' }
  if (channels) patch.pushChannels = channels
  if (results) patch.pushResults = results
  events.value = events.value.map((e) => {
    if (e.key !== key) return e
    // 已有渠道列表 + 本次没带新的 → 保留旧的（合并去重）
    if (!channels && e.pushChannels) {
      const merged = e.pushChannels.split(/\s*\+\s*/).filter(Boolean)
      channels = merged.join(' + ')
      patch.pushChannels = channels
    }
    return { ...e, ...patch }
  })
  dbPatchEvent(key, patch).catch(() => {})
}

function onAlarm(payload) {
  eventSeq += 1
  const cam = cameras.value.find((c) => c.id === payload.id) || {}
  const info = payload.info || null

  const record = {
    ...payload,
    /**
     * 后端事件用它自己那条记录的 key（两边同一个 key），
     * 这样「已读」和推送状态在前后端能对上；本机事件仍按序号生成。
     */
    key: payload.backendKey || `${payload.id}-${payload.time}-${eventSeq}`,
    seq: eventSeq,
    url: cam.url || '',
    roi: cam.roi || null,
    resolution: info ? `${info.width}×${info.height} · ${info.encType}` : '',
    fps: payload.fps || null,
    kbps: payload.kbps || null,
    /** 该通道分别推送到哪些渠道（由通道配置决定，调度器据此过滤） */
    channels: cam.channels ? { ...cam.channels } : null,
    /**
     * 这一路此刻真正在跑的附加分析（人脸 / 姿态 / 区域 / 计数）的开关快照。
     * 推送正文里会输出成「功能状态」一行：开了的写已开启，没开的写未开启 ——
     * 用户要求「开了啥就带啥，没开也要说明它没开」。
     */
    features: featureState(cam, options),
    /** 未读状态（持久化，重启后仍能区分已读 / 未读） */
    read: false,
    /** 后端事件的推送状态直接展示（本机事件的由调度器回填） */
    push: payload.backendPush || '',
    pushError: payload.backendPushError || '',
    pushChannels: payload.backendPushChannels || '',
    pushResults: payload.backendPushResults || null
  }

  appendEvent(record)
  if (options.alarmSound) beep(payload.type)
  /*
   * ⚠️ 这里原来会 showToast(`${name}：${brief}`) —— 报警时在顶部正中弹一条
   * 「大厅：监测到画面变动」式的文字提示（item 118 已去掉）。
   * 原因：它和左上角的报警通知卡片、还有声音、标题闪烁是同一件事讲三遍，
   * 而顶部正中这条最挡画面（正好压在画面上方），且和事件面板里的文案重复。
   * 报警的呈现统一交给 NotifyStack（可配四角）+ 声音 + 标题闪烁。
   * 其它场景的 toast（保存成功、切通道、导出完成…）是"操作反馈"，全部保留。
   */

  // 报警通知卡片（带缩略图，10 秒自动消失）
  pushNotify(record)
  notifyDesktop(record)
  flashTitle()

  /*
   * 统计打点（item 111）。
   * 记在这里而不是事件面板里，是因为这是"事件产生"的唯一入口 ——
   * 前端检测、后端轮询、通道状态都走 onAlarm，一处覆盖全部。
   * 通道状态（offline/online）不计入"报警"，单列一类，否则报警数会被断线刷高。
   */
  if (isSystemEvent(record)) statChannelState(record.type, record.time)
  else {
    statAlarm(record.type, record.time)
    if (record.type === 'face' || record.faceName) statPersonHit(record.faceName, record.time)
  }

  // 报警自动放大该画面（无人值守时很有用）
  if (options.alert && options.alert.autoZoom && !masked.value) {
    const i = visibleCameras.value.findIndex((c) => c.id === payload.id)
    if (i >= 0) zoomIndex.value = i
  }

  // 通道级总开关：关掉后三个渠道都不推，只在事件里记录原因
  if (cam.push === false) {
    markPush(record.key, 'off', '该通道的推送开关已关闭')
    return
  }

  /*
   * 后端模式下，这类事件是后端检测出来、并且**已经由后端推送过**的
   * （推送调度整体在服务端跑，就是为了关掉页面也照推）。
   * 前端在这里不能再推一遍，否则同一个报警会收到两条 —— 只标状态。
   */
  if (backendActive.value && payload.source === 'backend') {
    /*
     * ⚠️ 必须用后端**真实的**逐渠道数据，不能图省事写死一个「后端」。
     *
     * 后端推送调度整体在服务端跑，它早就把「本次调用了哪些渠道、各渠道回执如何」
     * 写进事件记录了（useBackendEvents 带过来的 backendPushChannels / backendPushResults）。
     * 以前这里一律 markPush(..., '后端')，等于把那份真实数据**覆盖掉**了：
     * 详情页按渠道名匹配 pushChannels 时，「后端」跟「钉钉/企微/TG」一个都对不上，
     * 三个渠道全被判成"本次推送未包含该渠道" —— 明明三端都收到了。
     */
    markPush(
      record.key,
      payload.backendPush || 'sending',
      payload.backendPushError || '由后端服务推送（本机页面可关）',
      String(payload.backendPushChannels || '').trim(),
      payload.backendPushResults || null
    )
    /*
     * 统计打点（item 111）：后端模式下 recordPush 跑在服务端，前端收不到，
     * 于是"三端推送成功率"会一直是空。这里改从后端事件自带的 pushResults
     * 还原一次统计 —— 后端模式统计口径与前端模式一致。
     */
    const pr = record.pushResults
    if (pr && typeof pr === 'object') {
      Object.keys(pr).forEach((name) => {
        const v = pr[name]
        const id = name === '钉钉' ? 'ding' : name === '企微' ? 'wecom' : name === 'TG' ? 'tg' : ''
        if (id) statPush(id, v === 'ok', record.time)
      })
    }
    return
  }

  push.handleAlarm(record)
}

/**
 * 报警后补拍到的「完整人形」帧。
 *
 * 时序：报警（文字/首帧图）已经发出去了 → 这里再补一张人形完整的原图。
 * 做两件事：
 *   1. 把这条事件的截图换成这张（详情弹窗 / 放大 / 导出用的就是它）；
 *   2. 按同样的渠道补推一条图片消息，并把结果写进事件的备注。
 */
async function onAlarmShot(payload) {
  if (!payload || !payload.shot) return
  // 找到对应的那条报警：同通道 + 时间最接近（15 秒内）
  const near = events.value
    .filter((e) => e.id === payload.id && Math.abs((e.time || 0) - (payload.at || 0)) < 15000)
    .sort(
      (a, b) =>
        Math.abs((a.time || 0) - (payload.at || 0)) - Math.abs((b.time || 0) - (payload.at || 0))
    )
  const hit = near[0]
  if (!hit) return

  // 1) 换掉事件里的截图（存库 + 内存里的缩略图）
  const thumb = payload.thumb || hit.thumb || ''
  const meta = payload.meta || null
  events.value = events.value.map((e) =>
    e.key === hit.key
      ? {
          ...e,
          thumb,
          personShot: true,
          faceName: (meta && meta.faceName) || e.faceName || '',
          faceThumb: (meta && meta.faceThumb) || e.faceThumb || '',
          actionText: (meta && meta.actionText) || e.actionText || ''
        }
      : e
  )
  notifies.value = notifies.value.map((n) =>
    n.id === payload.id && Math.abs((n.time || 0) - (payload.at || 0)) < 15000 ? { ...n, thumb } : n
  )
  const patch = { shot: payload.shot, thumb, shotInStore: true, personShot: true }
  if (meta) {
    if (meta.faceName) {
      patch.faceName = meta.faceName
      patch.faceScore = meta.faceScore || 0
    }
    if (meta.faceThumb) patch.faceThumb = meta.faceThumb
    if (meta.actionText) patch.actionText = meta.actionText
  }
  dbPatchEvent(hit.key, patch).catch(() => {})
  // 记录如果已经被滚动删除（超出保留上限），就不再补推，避免推一条没有主记录的消息
  const stillThere = await dbGetEvent(hit.key).catch(() => null)
  if (!stillThere) return

  // 2) 补推一张完整人形（渠道跟着报警走，设置里可以整体关掉）
  const cam = cameras.value.find((c) => c.id === payload.id) || {}
  if (cam.push === false) return
  let note = ''
  try {
    const res = await push.pushExtraShot({ ...hit, thumb }, payload.shot, meta)
    note = res.ok
      ? `完整人形补图：已发送（${res.sent.join(' + ')}）`
      : `完整人形补图：未送达（${res.reason}）`
    if (meta && meta.faceName) note += ` · 人脸：${meta.faceName}`
    if (meta && meta.actionText) note += ` · 姿态：${meta.actionText}`
  } catch (e) {
    note = `完整人形补图：未送达（${(e && e.message) || '未知错误'}）`
  }
  events.value = events.value.map((e) => (e.key === hit.key ? { ...e, personShotNote: note } : e))
  dbPatchEvent(hit.key, { personShotNote: note }).catch(() => {})
}

/* ---------- 外观主题 ---------- */
/**
 * 把 options.theme 落到 <html data-theme="..."> 上，全站样式只认 CSS 变量。
 * 「auto」仅在 iOS App 里可选，按系统深色模式解析成 dark / light；
 * 系统切换时实时跟随（matchMedia change）。
 * 顺带同步 meta theme-color，让 iOS 状态栏 / 浏览器地址栏跟着换色。
 */
const themeMeta = document.querySelector('meta[name="theme-color"]')
const prefersDarkQuery =
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function applyTheme() {
  // 兼容旧值：老配置里的 'default' / 未设置 → 液态风格（现在的默认外观）
  let t = options.theme || 'liquid'
  if (t === 'default') t = 'liquid'
  if (!['liquid', 'dark', 'light', 'auto'].includes(t)) t = 'liquid'
  if (t === 'auto') t = prefersDarkQuery && prefersDarkQuery.matches ? 'dark' : 'light'

  // 液态风格的变量就在 :root 上，但玻璃质感 chrome 依赖 [data-theme='liquid']，
  // 所以始终显式落属性（index.html 里也预置了同值，避免首帧跳变）
  document.documentElement.dataset.theme = t
  if (themeMeta) themeMeta.setAttribute('content', t === 'light' ? '#eef1f6' : t === 'dark' ? '#000000' : '#0b1119')
}

function onThemeChange(v) {
  // 设置抽屉里点了主题：立即生效；options 的 watch 会自动持久化
  options.theme = v
  applyTheme()
}

watch(() => options.theme, applyTheme, { immediate: true })
if (prefersDarkQuery && typeof prefersDarkQuery.addEventListener === 'function') {
  prefersDarkQuery.addEventListener('change', () => {
    if (options.theme === 'auto') applyTheme()
  })
}

/* ---------- 屏幕常亮 ---------- */
/**
 * 设置抽屉里点了常亮开关：立即生效（与主题同款即时交互，不参与「保存」按钮）。
 * 真正的申请 / 释放交给 useWakeLock —— 它自己挑后端
 * （桌面端主进程 IPC / iOS 原生插件 / 浏览器唤醒锁），
 * 并负责处理「切到后台被系统强制释放 → 回到前台重新申请」这条最容易漏的链路。
 */
function onKeepAwakeChange(v) {
  options.keepAwake = !!v
}

watch(
  () => options.keepAwake,
  (on) => {
    void applyWakeLock(on)
  },
  // immediate：进页面就申请，别等用户去设置里点一次
  { immediate: true }
)

/* ---------- 桌面通知 & 标题闪烁 ---------- */
/**
 * 是否跑在 Capacitor 原生壳里（iOS App 内为 true）。
 * 主题的「自动（跟随系统）」档只在 iOS 移动端展示用；后续做原生相关能力也能复用。
 */
const isNativeApp = Boolean(
  typeof window !== 'undefined' &&
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform()
)

/**
 * 正常状态下的页签标题。
 * 用 computed 而不是常量：通道数会变（增删通道 / 换配置方案），写死会一直是旧数字。
 */
const BASE_TITLE = computed(() => `${BRAND.fullName} · ${cameras.value.length} 路实时预览`)
let flashTimer = null

/**
 * 桌面 / 系统通知：三端统一走 useSystemNotify ——
 *   Electron → 主进程原生通知（点击可把最小化窗口拉回前台并定位画面）
 *   iOS     → 本地原生插件（UNUserNotificationCenter，前台也会弹横幅）
 *   浏览器  → window.Notification
 * 这里的 ensureNotifyPermission 是「用户第一次点页面时的惰性授权」：
 * Web 授权框需要用户手势，iOS 弹框同理，挂在 mousedown 上最省事。
 */
function ensureNotifyPermission() {
  void requestNotifyPermission()
}

function notifyDesktop(record) {
  if (!options.alert || !options.alert.desktopNotify) return
  const typeText = alarmBrief(record) || alarmLabel(record.type)
  // 发不出去（未授权 / 平台不支持）时静默返回 —— 页面内的 NotifyStack 本来就会提示
  void sendSystemNotify({
    title: `${record.name} · ${typeText}`,
    body: `${new Date(record.time).toLocaleTimeString('zh-CN')} · 点击定位到该画面`,
    tag: `alarm-${record.key}`,
    icon: record.thumb || undefined,
    onclick: () => focusEvent(record)
  })
}

/** 点系统通知（桌面端 / iOS 原生路径）→ 定位到对应画面 */
function handleNotifyClick(tag) {
  const PREFIX = 'alarm-'
  if (!tag || !tag.startsWith(PREFIX)) return
  const key = tag.slice(PREFIX.length)
  const rec = events.value.find((e) => e.key === key)
  if (rec) focusEvent(rec)
}

function flashTitle() {
  if (!options.alert || !options.alert.flashTitle) return
  // 遮罩期间页签只许出现「在线/总数」，闪烁会把品牌名暴露出来
  if (masked.value) return
  if (document.hasFocus() || flashTimer) return
  let on = false
  flashTimer = setInterval(() => {
    on = !on
    document.title = on ? '🔴 有人活动 · 监控报警！' : BASE_TITLE.value
  }, 900)
}

function stopFlashTitle() {
  if (flashTimer) {
    clearInterval(flashTimer)
    flashTimer = null
  }
  applyDocTitle()
}

function toggleEventPanel() {
  eventPanelOpen.value = !eventPanelOpen.value
}

/**
 * 「通道状态」标签 → 「配置异常推送」：直接把人送到设置里的「状态巡检」页。
 * 那组开关（异常要不要推、恢复要不要推、多久重提醒、三个渠道各自收不收）
 * 是整个设置里最容易被漏掉的一处，藏在第三个页签里。
 */
function openStatusConfig() {
  settingsTab.value = 'status'
  settingsOpen.value = true
  eventPanelOpen.value = false
}

/**
 * 清空事件（item 12）：支持「全部 / 今日 / 昨日」三种范围。
 * 按 key 精确删除要保留的记录，前端内存与 IndexedDB 同步收敛。
 *
 * ⚠️ 清的是**事件列表**，不是「今日报警」这类当日累计计数。
 * 用户明确要求：清空后顶部的「今日报警 N 次」要留着 ——
 * 那是「今天一共报了多少次」的事实统计，清一次列表就把当日战绩抹成 0，
 * 既不合逻辑，也会让人以为监控今天一直没响过（明明刚清掉了几十条）。
 * todayAlarmCount 与列表淘汰本就解耦（见它的注释），这里保持一致。
 *
 * 「通道」的掉线/恢复记录本来就在 events 里（isSystemEvent），
 * 随列表一起清掉；「后台异常」来自 useErrorLog、不在 events 里，要单独清。
 *
 * @param {'all'|'today'|'yesterday'} scope
 */
function clearEvents(scope = 'all') {
  // 后台异常是本次运行攒下来的错误，不带日期 —— 清「全部 / 今日」时一并清掉；
  // 清「昨日」不动它（那些错误未必是昨天的，清了会误伤今天的状态）
  if (scope === 'all' || scope === 'today') clearErrorLog()

  if (scope === 'all') {
    events.value = []
    dbClearEvents().catch(() => {})
    return
  }
  // 今日 / 昨日：算出保留区间，把落在区间内的记录删掉，其余留下
  const now = new Date()
  const d0 = new Date(now)
  d0.setHours(0, 0, 0, 0)
  const t0 = d0.getTime()
  const from = scope === 'today' ? t0 : t0 - 86400000
  const to = scope === 'today' ? t0 + 86400000 : t0
  const inRange = (e) => e.time >= from && e.time < to
  const removed = events.value.filter(inRange)
  if (!removed.length) return
  events.value = events.value.filter((e) => !inRange(e))
  // todayAlarmCount 刻意不动（见上方注释）
  dbDeleteEvents(removed.map((e) => e.key)).catch(() => {})
}

/* ---------------- 已读 / 未读 ---------------- */

/** 标记单条已读（再点一次可切回未读） */
function markEventRead(record) {
  if (!record) return
  const next = !record.read
  events.value = events.value.map((e) => (e.key === record.key ? { ...e, read: next } : e))
  dbMarkRead(record.key, next).catch(() => {})
}

/** 把这一条以及它下面（更早）的全部标为已读 */
function markEventReadFrom(record) {
  if (!record) return
  const start = events.value.findIndex((e) => e.key === record.key)
  if (start < 0) return
  const targets = events.value.slice(start).filter((e) => !e.read)
  if (!targets.length) {
    showToast('这一条以下都已是已读')
    return
  }
  const keys = new Set(targets.map((e) => e.key))
  events.value = events.value.map((e) => (keys.has(e.key) ? { ...e, read: true } : e))
  dbMarkRead([...keys], true).catch(() => {})
  // 后端那条记录也标一下，两端状态才不会打架（离线时静默失败）
  markReadOnBackend(options, [...keys]).catch(() => {})
  showToast(`已将以下 ${targets.length} 条标为已读`)
}

/** 全部标为已读 */
function markAllEventsRead() {
  const targets = events.value.filter((e) => !e.read)
  if (!targets.length) {
    showToast('当前没有未读事件')
    return
  }
  events.value = events.value.map((e) => (e.read ? e : { ...e, read: true }))
  dbMarkRead(targets.map((e) => e.key), true).catch(() => {})
  markReadOnBackend(options, targets.map((e) => e.key)).catch(() => {})
  showToast(`已将 ${targets.length} 条标为已读`)
}

/**
 * 导出事件：
 *   - 支持「选择文件夹」的环境（Chrome / Edge / Electron）：真的在本地建一个
 *     BossMonitor-事件-时间/ 文件夹，里面放 events.json + screenshots/*.jpg
 *   - 其它环境（iOS / 小程序）：退化为下载一个 json 文件
 */
async function exportEvents() {
  if (!events.value.length) {
    showToast('暂无可导出的事件')
    return
  }
  showToast('正在准备导出…')
  let full = []
  try {
    full = await getAllEvents()
  } catch (e) {
    full = events.value
  }
  if (!full.length) full = events.value

  if (supportsDirectoryPicker()) {
    try {
      const res = await exportEventsToFolder(full)
      showToast(`已导出 ${res.count} 条事件（含 ${res.shots} 张截图）到 ${res.folder}`)
      return
    } catch (e) {
      if (e && e.name === 'AbortError') return
      showToast(`文件夹导出失败，改为下载 JSON：${e.message || e}`)
    }
  }
  downloadJson(
    `alarm-events-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`,
    { app: 'BossMonitor', exportedAt: new Date().toISOString(), count: full.length, events: full }
  )
  showToast(`已导出 ${full.length} 条事件（JSON）`)
}

/**
 * 定位到某个事件对应的画面：不放大，只把该画面高亮闪烁 3 秒。
 * 画面如果被关闭了，先恢复显示。
 */
/**
 * 定位到某个通道 —— 右上角通知、事件列表点「定位」都走这里。
 * 现在还会顺手打开该事件��详情弹窗（用户点通知的意图通常就是「看清这条」）。
 */
function focusEvent(ev) {
  if (!ev || !ev.id) return
  const id = ev.id

  if (hiddenIds.value.includes(id)) {
    hiddenIds.value = hiddenIds.value.filter((x) => x !== id)
  }

  /*
   * 用事件库里的完整记录而不是通知项本身：通知项只有缩略图，
   * 而完整记录带 shotInStore，详情弹窗才能去 IndexedDB 取高清原图。
   */
  const rec = (ev.key && events.value.find((e) => e.key === ev.key)) || ev
  if (rec && rec.key && eventPanelRef.value && typeof eventPanelRef.value.openDetail === 'function') {
    eventPanelRef.value.openDetail(rec)
  }

  nextTick(() => {
    flashCamera(id)
    const cam = cameras.value.find((c) => c.id === id)
    showToast(`已定位到「${(cam && cam.name) || ev.name || id}」`)
  })
}

let locateTimer = null

function flashCamera(id) {
  clearTimeout(locateTimer)
  flashId.value = id
  locateTimer = setTimeout(() => (flashId.value = ''), LOCATE_MS)
}

let audioCtx = null

function beep(kind = 'motion') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    audioCtx = audioCtx || new Ctx()
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const t = audioCtx.currentTime

    // 人形报警：更急促的三声高音；移动报警：两声低音
    const isPerson = kind === 'person' && (!options.alert || options.alert.distinctSound !== false)
    const pattern = isPerson
      ? [
          [1180, 0],
          [1180, 0.18],
          [1480, 0.36]
        ]
      : [
          [920, 0],
          [680, 0.16]
        ]

    pattern.forEach(([freq, offset]) => {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t + offset)
      gain.gain.setValueAtTime(0.0001, t + offset)
      gain.gain.exponentialRampToValueAtTime(isPerson ? 0.2 : 0.15, t + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.16)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(t + offset)
      osc.stop(t + offset + 0.18)
    })
  } catch (e) {
    /* 浏览器限制音频播放时忽略 */
  }
}

/* ==================== 大屏内拖拽排序 ==================== */
const dragFrom = ref(-1)

function onWallDragStart(i) {
  dragFrom.value = i
}

function onTileDragOver(i) {
  const from = dragFrom.value
  if (from < 0 || from === i) return
  const visible = visibleCameras.value
  const fromId = visible[from] && visible[from].id
  const toId = visible[i] && visible[i].id
  if (!fromId || !toId) return

  const list = [...cameras.value]
  const a = list.findIndex((c) => c.id === fromId)
  const b = list.findIndex((c) => c.id === toId)
  if (a < 0 || b < 0) return
  const [item] = list.splice(a, 1)
  list.splice(b, 0, item)
  cameras.value = list
  dragFrom.value = i
}

function onWallDragEnd() {
  dragFrom.value = -1
}

/* ==================== 画面操作 ==================== */
function toggleZoom(i) {
  zoomIndex.value = zoomIndex.value === i ? null : i
}

function hideCamera(i) {
  const cam = visibleCameras.value[i]
  if (!cam) return
  hiddenIds.value = [...hiddenIds.value, cam.id]
  zoomIndex.value = null
  showToast(`已关闭「${cam.name}」，可用顶部按钮恢复`)
}

function restoreHidden() {
  const count = hiddenIds.value.length
  hiddenIds.value = []
  if (count) showToast(`已恢复 ${count} 路画面`)
}

function reconnectAll() {
  allPaused.value = false
  tileRefs.forEach((t) => t && t.reconnect())
  showToast('正在重新连接全部画面')
}

function pauseAll() {
  allPaused.value = true
  tileRefs.forEach((t) => t && t.pause())
  const n = decodeIds.value.length
  showToast(n ? `已暂停全部 ${n} 路画面（连接保留，点「全部播放」即可恢复）` : '当前没有正在播放的画面')
}

function resumeAll() {
  allPaused.value = false
  userPicked.value = false
  const cap = maxDecodeCount.value
  const list = visibleCameras.value
  if (!list.length) {
    showToast('当前没有可播放的画面')
    return
  }
  const ids = (cap === Infinity ? list : list.slice(0, cap)).map((c) => c.id)
  manualIds.value = ids
  // 已存在的播放器直接续播；尚未解码的会在 decodeIds 变化后自动创建
  nextTick(() => tileRefs.forEach((t) => t && t.resume()))
  const skipped = list.length - ids.length
  if (skipped > 0) showToast(`已播放 ${ids.length} 路（受解码上限限制，另有 ${skipped} 路待播）`)
  else showToast(`已开始播放全部 ${ids.length} 路画面`)
}

async function toggleAppFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
    else await document.exitFullscreen()
  } catch (e) {
    /* ignore */
  }
}

/* ==================== 设置保存 ==================== */
function applyConfig({ cameras: cams, options: opts, hiddenIds: hidden }) {
  cameras.value = cams.map((c) => normalizeCameraSilent(normalizeCameraChannels({ ...c })))
  Object.assign(options, opts)
  // 渠道级监听名单始终跟着通道级推送开关走（用户可能只改了「监控通道」那页）
  syncChannelCameras(cameras.value, options)
  hiddenIds.value = hidden
  settingsOpen.value = false
  zoomIndex.value = null
  if (layoutKey.value === 'free') ensureFreeRects()
  setTimeout(() => tileRefs.forEach((t) => t && t.reconnect()), 80)
  showToast('配置已保存')
}

/**
 * 恢复初始化。
 *
 * ⚠️ 这里必须做到「一步到位」，否则就会出现用户报告过的怪事：
 *    明明恢复了初始化，推送还在继续。原因有两个，都已堵上：
 *      a) 推送模块里**已经排队**的报警会在下一个合并定时器到点时照发
 *         （deliver 阶段不再回头查配置）→ 所以要先 push.stopAll()；
 *      b) 恢复动作靠 300ms 防抖落盘，用户立刻杀掉 App 的话白改了
 *         → 所以要 persistNow() 立即写。
 * @param {{wipeData?: boolean}} payload 来自设置抽屉：是否连报警记录 / 人脸库一起清
 */
function onReset(payload) {
  const wipeData = !!(payload && payload.wipeData)

  // 1) 先让推送彻底安静（清待发队列 + 合并定时器 + 限流窗口）
  push.stopAll()
  // 状态异常 / 定时巡检的定时器也一并停掉 —— 空白配置下它们不该再跑
  clearInterval(patrolTimer)
  patrolTimer = null
  clearInterval(repeatTimer)
  repeatTimer = null

  // 2) 配置归零
  cameras.value = cloneDefaultCameras()
  const fresh = cloneDefaultOptions()
  Object.keys(options).forEach((k) => delete options[k])
  Object.assign(options, fresh)
  normalizeDingTalk(options.dingtalk)
  hiddenIds.value = []
  zoomIndex.value = null
  layoutKey.value = 'auto'

  // 3) 数据（可选）：报警记录 + 人脸库都是本地数据，「什么都没有」就该一起清
  const wiped = []
  if (wipeData) {
    events.value = []
    dbClearEvents().catch(() => {})
    clearFaces()
    clearPendingFaces()
    wiped.push('报警记录', '人脸库')
  }
  /*
   * 手表上那份事件列表也得一起清。
   * 不清的话会出现最难解释的一种状态：手机上明明"什么都没有"了，
   * 抬腕一看手表里还挂着几十条旧报警 —— 用户只会认为初始化没生效。
   */
  void clearWatch()
  // 4) 推送统计与「配置方案」一并清空（见设置抽屉里的 resetAll）
  try {
    localStorage.removeItem('monitor-wall-push-stats-v1')
  } catch (e) {
    /* ignore */
  }

  // 5) 立即落盘 —— 不能等 300ms 防抖，用户可能马上就杀 App
  persistNow()

  const extra = wiped.length ? `，${wiped.join('、')}已清空` : ''
  showToast(
    cameras.value.length
      ? '已恢复初始化配置' + extra
      : '已恢复初始化：通道、推送凭据与绑定全部清空' + extra
  )
}

/* ==================== 强制终结 App ==================== */
/**
 * 设置 → 配置方案 →「强制终结 App」。
 * 先把所有正在跑的东西停干净，再按平台退出：
 *   iOS → 原生 exit(0)；桌面端 → 主进程 quit + exit(0) 兜底；Web → 尽力关页 + 全屏遮罩。
 */
async function onForceExit() {
  await exitAppNow({
    cleanup: async () => {
      tileRefs.forEach((t) => t && t.destroy && t.destroy())
      push.stopAll()
      clearInterval(patrolTimer)
      clearInterval(repeatTimer)
      patrolTimer = null
      repeatTimer = null
      stopFlashTitle()
      await dropWakeLock()
      persistNow()
    }
  })
}

/** 空大屏时点「去设置里添加画面」：直接打开设置抽屉（默认就停在「监控通道」页） */
function openCameraSettings() {
  settingsOpen.value = true
}

/* ==================== 状态告警 & 定时巡检 ==================== */
const BOOT_AT = Date.now()
const GRACE_MS = 45000 // 启动宽限期：刚打开页面时的连接波动不报警

const downSince = {}
const lastStatusNotify = {}
let patrolTimer = null
let repeatTimer = null

/* 临时静默状态：只在设置抽屉打开时轮询（倒计时要走字），关掉就停 */
watch(settingsOpen, (v) => {
  if (v) scheduleTempSilentPoll()
  else {
    clearInterval(tempSilentTimer)
    tempSilentTimer = null
  }
})

/** 汇总当前所有通道的状态明细 */
function buildStatusItems() {
  const tiles = {}
  tileRefs.forEach((t) => {
    if (t && typeof t.getSnapshot === 'function') {
      const s = t.getSnapshot()
      tiles[s.id] = s
    }
  })

  return cameras.value.map((c) => {
    const hidden = hiddenIds.value.includes(c.id)
    const t = tiles[c.id]
    const st = statusMap[c.id]
    const state = hidden ? 'closed' : t ? t.status : st ? st.status : 'idle'
    return {
      id: c.id,
      name: c.name,
      url: c.url,
      state,
      text: hidden ? '' : t ? t.text : st ? st.text : '',
      resolution: t ? t.resolution : '',
      fps: t ? t.fps : null,
      kbps: t ? t.kbps : null,
      // ---- 功能开关状态（推送内容里逐通道展示） ----
      motion: !!c.motion && options.analysisEnabled !== false,
      ai: !!c.ai && options.aiEnabled !== false,
      blind: !!c.blind,
      push: c.push !== false,
      pushTo: activeChannelNames(c),
      roiText: c.roi
        ? `${Math.round(c.roi.w * 100)}×${Math.round(c.roi.h * 100)}%`
        : '全画面',
      watched: watchedIds().includes(c.id)
    }
  })
}function buildOverview(items) {
  const playing = items.filter((i) => i.state === 'playing').length
  const error = items.filter((i) => i.state === 'error').length
  const connecting = items.filter((i) => i.state === 'connecting').length
  const closed = items.filter((i) => i.state === 'closed').length
  const total = items.length - closed
  return { playing, error, connecting, closed, total, short: `${playing}/${total} 路在线` }
}

function addSystemEvent(cam, kind, text) {
  eventSeq += 1
  const record = {
    key: `${cam.id}-${Date.now()}-${eventSeq}`,
    id: cam.id,
    name: cam.name,
    type: kind, // offline | online
    ratio: 0,
    text: text || '',
    time: Date.now(),
    thumb: '',
    shot: '',
    seq: eventSeq,
    url: cam.url,
    read: false,
    push: ''
  }
  appendEvent(record)
  pushNotify(record)
  return record
}

async function handleStatusTransition(id, prev, next, text) {
  /*
   * 后端模式下这一段的判定与推送都在服务端跑（watchdog）：
   * 服务端的 ffmpeg 24 小时在拉流，判定比「这个页面有没有开播放器」更接近事实，
   * 而且关掉页面照样报警。前端在这里再判一次只会造成同一次掉线收到两条通知。
   */
  if (backendActive.value) return
  const sa = options.statusAlerts || {}
  if (!sa.enabled) return
  if (!watchedIds().includes(id)) return
  if (Date.now() - BOOT_AT < GRACE_MS) return

  const cam = cameras.value.find((c) => c.id === id)
  if (!cam) return
  const now = Date.now()

  if (next === 'error') {
    if (!downSince[id]) downSince[id] = now
    const gapMin = Math.max(0, Number(sa.repeatMinutes) || 0)
    const last = lastStatusNotify[id] || 0
    if (last && (gapMin === 0 || now - last < gapMin * 60000)) return
    lastStatusNotify[id] = now

    const items = buildStatusItems()
    const overview = buildOverview(items)
    const record = addSystemEvent(cam, 'offline', text || '画面异常')
    const payload = {
      kind: 'down',
      cam,
      state: next,
      text,
      item: items.find((i) => i.id === id),
      overview: `${overview.playing}/${overview.total} 路在线`,
      downtimeMs: now - (downSince[id] || now),
      cfg: options.dingtalk
    }
    const msg = buildStatusAlertMessage(payload)
    const res = await push.sendDirect({
      title: msg.title,
      text: msg.text,
      html: buildTelegramStatusText(payload),
      atAll: !!options.dingtalk.atAll,
      kind: 'status',
      key: record.key,
      onState: markPush
    })
    if (!res.ok) showToast(`异常通知未发送：${res.reason}`)
    else if (res.reason) showToast(res.reason)
    return
  }

  if (prev === 'error' && next === 'playing') {
    const down = downSince[id] ? Date.now() - downSince[id] : 0
    delete downSince[id]
    delete lastStatusNotify[id]
    if (!sa.notifyRecover) return

    const items = buildStatusItems()
    const overview = buildOverview(items)
    const record = addSystemEvent(cam, 'online', `中断 ${Math.round(down / 1000)} 秒`)
    const payload = {
      kind: 'up',
      cam,
      state: next,
      item: items.find((i) => i.id === id),
      overview: `${overview.playing}/${overview.total} 路在线`,
      downtimeMs: down,
      cfg: options.dingtalk
    }
    const msg = buildStatusAlertMessage(payload)
    const res = await push.sendDirect({
      title: msg.title,
      text: msg.text,
      html: buildTelegramStatusText(payload),
      kind: 'status',
      key: record.key,
      onState: markPush
    })
    if (!res.ok) showToast(`恢复通知未发送：${res.reason}`)
    else if (res.reason) showToast(res.reason)
  }
}

/** 持续异常时的重复提醒 */
function checkRepeatAlerts() {
  // 后端模式下由服务端 watchdog 负责重复提醒，前端不再插一脚
  if (backendActive.value) return
  const sa = options.statusAlerts || {}
  if (!sa.enabled) return
  const gapMin = Math.max(0, Number(sa.repeatMinutes) || 0)
  if (!gapMin) return
  const now = Date.now()
  Object.keys(downSince).forEach((id) => {
    const st = statusMap[id]
    if (!st || st.status !== 'error') {
      if (!st || st.status === 'playing') {
        delete downSince[id]
        delete lastStatusNotify[id]
      }
      return
    }
    if (now - (lastStatusNotify[id] || 0) < gapMin * 60000) return
    lastStatusNotify[id] = now
    const cam = cameras.value.find((c) => c.id === id)
    if (!cam) return
    const items = buildStatusItems()
    const overview = buildOverview(items)
    const record = addSystemEvent(cam, 'offline', `持续异常：${st.text || '画面异常'}`)
    const payload = {
      kind: 'down',
      cam,
      state: 'error',
      text: `持续异常 · ${st.text || ''}`,
      item: items.find((i) => i.id === id),
      overview: `${overview.playing}/${overview.total} 路在线`,
      downtimeMs: now - (downSince[id] || now),
      cfg: options.dingtalk
    }
    const msg = buildStatusAlertMessage(payload)
    push.sendDirect({
      title: msg.title,
      text: msg.text,
      html: buildTelegramStatusText(payload),
      atAll: !!options.dingtalk.atAll,
      kind: 'status',
      key: record.key,
      onState: markPush
    })
  })
}

/** 定时巡检推送 */
async function runPatrol(reason = 'auto') {
  /*
   * 后端模式下推送只在服务端跑（关掉页面也要能发），手动巡检同样交给它 ——
   * 前端这时候既没有播放器状态、也没有推送调度器，自己发是发不出去的。
   */
  if (backendActive.value) {
    if (reason !== 'manual') return
    const ok = await runBackendPatrol(options.backend.url)
    showToast(ok ? '巡检报告已由后端推送' : '后端巡检失败，请检查服务是否在跑')
    return
  }
  const pc = options.patrol || {}
  const items = buildStatusItems()
  const overview = buildOverview(items)
  const watched = items.filter((i) => i.watched)
  const abnormal = watched.filter((i) => i.state !== 'playing' && i.state !== 'closed' && i.state !== 'idle')

  if (reason === 'auto' && pc.onlyWhenAbnormal && !abnormal.length) return

  const list = pc.includeAll === false ? watched : items
  // 本次巡检会发到哪些渠道（渠道自身也勾选了接收巡检）
  const pushChannels = [
    ['钉钉', options.dingtalk],
    ['企微', options.wecom],
    ['TG', options.telegram]
  ]
    .filter(([, c]) => {
      if (!c || !c.enabled) return false
      return !(c.patrol && c.patrol.enabled === false)
    })
    .map(([n]) => n)

  const payload = {
    items: list,
    overview,
    cfg: options.dingtalk,
    pushChannels,
    reason: reason === 'manual' ? '本次为手动触发的巡检。' : ''
  }
  const msg = buildPatrolMessage(payload)
  const res = await push.sendDirect({
    title: msg.title,
    text: msg.text,
    html: buildTelegramPatrolText(payload),
    atAll: false,
    kind: 'patrol'
  })
  if (!res.ok) showToast(`巡检推送失败：${res.reason}`)
  else if (res.reason) showToast(res.reason)
  else if (reason === 'manual') showToast('巡检报告已推送')
}

/**
 * 免打扰提醒的「试发」走哪几个渠道。
 *
 * 用户口径：试发应该发到**静默里勾选的那几个渠道**（「静默期间暂停实时推送的渠道」）。
 * 勾了哪个就只测哪个，不用为了看一眼文案被三端同时轰炸。
 * 一个都没勾（或都还没配凭据）时返回 undefined，交给推送层退回「全部已配置渠道」——
 * 宁可多发，也不能让按钮点了等于没点。
 */
function silentTestChannels() {
  const chans = (options.silent && options.silent.channels) || []
  return Array.isArray(chans) && chans.length ? chans.slice() : undefined
}

/** 设置页「立即推送静默汇总」按钮：把当前静默时段收存的报警立刻汇总发出去 */
function onFlushSilent() {
  if (backendActive.value) {
    /*
     * 后端模式下推送在服务端跑，前端连待汇总的缓冲都没有，必须委托后端发。
     * 这是真实汇总（会掏空服务端的静默缓冲），所以不限定渠道 —— 攒下来的报警
     * 该让所有已配置渠道都看到。
     */
    sendBackendSilentNotice(options.backend.url, 'flush').then((r) =>
      showToast(r.ok ? r.reason || '静默汇总已推送' : `未推送：${r.reason || '未知原因'}`)
    )
    return
  }
  if (typeof push.flushSilentSummary === 'function') {
    push
      .flushSilentSummary({ manual: true })
      .then((summary) => showToast(summary ? '静默汇总已推送' : '当前没有待汇总的报警'))
      .catch((e) => showToast(`推送失败：${(e && e.message) || '未知错误'}`))
  }
}

/**
 * 设置页「试发一条免打扰开始提醒」按钮。
 * 走与自动提醒完全相同的文案与发送路径（pushPreSilenceNotice），
 * 改完文案可以先看一眼效果，确认没问题再等下一个时段自动触发。
 *
 * 后端模式下委托后端发（见 sendBackendSilentNotice）——以前这里只弹一句
 * 「后端模式下推送在服务端」，按钮点了等于没点。
 */
function onTestPreSilence() {
  if (backendActive.value) {
    sendBackendSilentNotice(options.backend.url, 'pre', silentTestChannels()).then((r) =>
      showToast(
        r.ok ? `开始提醒已推送（后端）${r.reason ? ' · ' + r.reason : ''}` : `未推送：${r.reason || '未知原因'}`
      )
    )
    return
  }
  if (typeof push.pushPreSilenceNotice === 'function') {
    push
      .pushPreSilenceNotice(null, { onlyIds: silentTestChannels() })
      .then((r) =>
        showToast(
          r && r.ok
            ? `开始提醒已推送${r.reason ? '（' + r.reason + '）' : ''}`
            : `未推送：${(r && (r.reason || '没有可用渠道')) || '未知原因'}`
        )
      )
      .catch((e) => showToast(`推送失败：${(e && e.message) || '未知错误'}`))
  }
}

/**
 * 设置页「试发一条免打扰结束提醒」按钮。
 * 用真实窗口（不在窗口里就取最近一个时段）造一条结束提醒，
 * 但**不动**待汇总的缓冲 —— 随便点几次都不会把事件弄丢。
 */
function onTestPostSilence() {
  if (backendActive.value) {
    sendBackendSilentNotice(options.backend.url, 'post', silentTestChannels()).then((r) =>
      showToast(r.ok ? `结束提醒已推送（后端）${r.title ? ' · ' + r.title : ''}` : `未推送：${r.reason || '未知原因'}`)
    )
    return
  }
  if (typeof push.pushPostSilenceNotice === 'function') {
    push
      .pushPostSilenceNotice({ onlyIds: silentTestChannels() })
      .then((summary) =>
        showToast(summary ? `结束提醒已推送（${summary.title}）` : '未推送：没有可用渠道')
      )
      .catch((e) => showToast(`推送失败：${(e && e.message) || '未知错误'}`))
  }
}

/**
 * 设置页「立即重启系统」按钮。
 * - 桌面客户端（Electron）：走原生桥 app.relaunch() 重启整个 App；
 * - 浏览器 / 后端模式：向后端发 POST /api/restart，由后端进程自愈式重启
 *   （重新拉起所有流与前端服务）。未配置后端地址则提示。
 */
async function onRestartSystem() {
  const native = window.__MONITOR_NATIVE__
  if (native && typeof native.restartApp === 'function') {
    showToast('正在重启桌面端…')
    native.restartApp()
    return
  }
  const url = options.backend && options.backend.url
  if (!url) {
    showToast('未配置后端地址，无法远程重启（请到检测识别 → 后端检测服务里填写）')
    return
  }
  const base = String(url).replace(/\/+$/, '')
  showToast('已请求后端重启，正在确认结果…')
  const sentAt = Date.now()
  try {
    const r = await fetch(`${base}/api/restart`, { method: 'POST' })
    const data = await r.json().catch(() => ({}))
    if (!r.ok || data.ok === false) {
      showToast('重启请求失败（HTTP ' + r.status + '）')
      return
    }
  } catch (e) {
    /* 端口可能已被释放（说明重启真的开始了），不算失败 */
  }
  /*
   * 轮询结果。后端重启会「先释放端口 → 拉起新进程 → 确认接管」，
   * 所以前几秒请求失败是**预期行为**；用 lastAt 区分「本次」与「上次」的记录。
   */
  const deadline = Date.now() + 90000
  let lastErr = ''
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    try {
      const res = await fetch(`${base}/api/restart-status`)
      const st = await res.json()
      if (Number(st.lastAt) < sentAt - 2000) continue // 还是上一次的记录，继续等
      if (st.lastResult === 'ok') {
        showToast('✅ 重启成功：新进程已接管端口')
        return
      }
      if (st.lastResult === 'rollback-ok') {
        showToast(`⚠️ 重启失败，但已自动回滚：${st.lastError || ''}`)
        return
      }
      if (st.lastResult === 'rollback-failed') {
        showToast('❌ 重启失败且回滚失败，请查看后端重启日志')
        return
      }
      if (st.lastResult) {
        showToast(`重启结果：${st.lastResult}${st.lastError ? ' · ' + st.lastError : ''}`)
        return
      }
    } catch (e) {
      lastErr = (e && e.message) || '网络错误'
    }
  }
  showToast(`未能在 90 秒内确认重启结果（${lastErr || '连接不上'}），请到后端查看 restart.log`)
}

/* ---------------- 临时静默（item 112） ---------------- */
/**
 * 开启临时静默：settings 传 { hours, channels }。
 * 后端模式下推送在服务端跑，所以要把指令发到后端去。
 */
async function onStartTempSilent({ hours, channels, label, untilAt } = {}) {
  /*
   * 渠道原样透传，**不要**在这里兜底成三端。
   *
   * 空数组是「用户把渠道勾全取消了」，得让它一路走到推送层被明确拒掉并回原因；
   * 在这里悄悄换成三端，用户会收到一句「已开启」却莫名其妙把三端全静默了 ——
   * 排查时最想不到的就是「取消勾选」这一步。
   * 只有不传（undefined → null）才是「按配置里的默认走」，由后端 / 推送层决定。
   */
  const chans = Array.isArray(channels) ? channels.slice() : null
  const payload = { hours: Number(hours) || 0, channels: chans, label: String(label || ''), untilAt: Number(untilAt) || 0 }
  if (backendActive.value) {
    const url = String((options.backend && options.backend.url) || '')
    if (!url) {
      showToast('未配置后端地址，无法远程开启（请到检测识别 → 后端检测服务里填写）')
      return
    }
    try {
      const r = await fetch(`${url}/api/temp-silent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        showToast(`开启失败：${data.reason || 'HTTP ' + r.status}`)
        return
      }
      showToast(`后端已进入临时静默（至 ${data.untilLabel || '到期'}）`)
    } catch (e) {
      showToast('开启失败：' + ((e && e.message) || '网络错误'))
    }
    return
  }
  const r = push.startTempSilent(payload.hours, chans, payload.label, payload.untilAt)
  if (!r.ok) showToast(r.reason || '开启临时静默失败')
}

/** 结束临时静默；flush=true 时立刻把已收存的报警汇总发出去 */
async function onEndTempSilent(flush) {
  if (backendActive.value) {
    const url = String((options.backend && options.backend.url) || '')
    if (!url) {
      showToast('未配置后端地址，请到后端机器操作')
      return
    }
    try {
      const r = await fetch(`${url}/api/temp-silent`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flush: !!flush })
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) showToast(`结束失败：${data.reason || 'HTTP ' + r.status}`)
      else showToast(flush ? '后端已结束静默并汇总推送' : '后端已结束临时静默')
    } catch (e) {
      showToast('结束失败：' + ((e && e.message) || '网络错误'))
    }
    return
  }
  const r = await push.endTempSilent(!!flush)
  if (!r || !r.ok) showToast((r && r.reason) || '结束临时静默失败')
  else showToast(flush ? '已结束静默并汇总推送' : '已结束临时静默')
}

/** 给设置页回传临时静默状态（后端模式下轮询后端接口） */
const tempSilentState = ref({ active: false, untilLabel: '', leftLabel: '', channels: [], reason: '' })
/** 状态轮询定时器：只在设置抽屉打开时跑，1 秒一次足够让倒计时走字 */
let tempSilentTimer = null

async function refreshTempSilentState() {
  if (backendActive.value) {
    const url = String((options.backend && options.backend.url) || '')
    if (!url) {
      tempSilentState.value = { active: false }
      return
    }
    try {
      const r = await fetch(`${url}/api/temp-silent`)
      const data = await r.json().catch(() => ({}))
      tempSilentState.value = data && data.active ? data : { active: false }
    } catch (e) {
      tempSilentState.value = { active: false }
    }
    return
  }
  if (typeof push.tempSilentInfo === 'function') {
    tempSilentState.value = push.tempSilentInfo() || { active: false }
  }
}

/** 设置抽屉开合时启停轮询：关着就不必每秒打扰后端 */
function scheduleTempSilentPoll() {
  clearInterval(tempSilentTimer)
  tempSilentTimer = null
  void refreshTempSilentState()
  tempSilentTimer = setInterval(refreshTempSilentState, 1000)
}

function schedulePatrol() {
  clearInterval(patrolTimer)
  patrolTimer = null
  // 后端模式下巡检定时器在服务端（watchdog），前端不再自己排
  if (backendActive.value) return
  const pc = options.patrol || {}
  if (!pc.enabled) return
  const minutes = Math.max(1, Math.min(240, Number(pc.intervalMinutes) || 30))
  patrolTimer = setInterval(() => runPatrol('auto'), minutes * 60000)
}

/* ==================== 隐私遮罩 ==================== */
const masked = ref(false)
const maskError = ref('')
const maskAskSignal = ref(0)
/**
 * 遮罩解锁密码的**摘要**（不是密码本身）。
 * 空串 = 没设密码 → 点击屏幕任意位置即可恢复，不做校验；
 * 非空 = 已设密码 → 只有输入能算出同一个摘要的明文才放行。
 */
const maskPasswordHash = computed(() => String((options.mask && options.mask.passwordHash) || ''))

/**
 * 遮罩期间的页签标题：只留「在线/总数」这一串数字。
 *
 * 目的很直白 —— 旁边有人瞄一眼浏览器标签栏，只看到几个数字，
 * 既不知道这是什么系统，也看不出有没有报警。所以品牌名、"N 路实时预览"、
 * "有人活动"这些一律不出现。
 *
 * 在线数跟着播放状态实时走：遮罩挂在那儿，哪一路掉线了页签会跟着掉，
 * 人不在跟前也能从标签栏看出"少了一路"。
 */
const maskTitle = computed(() => `${onlineCount.value}/${cameras.value.length}`)

/** 按当前遮罩状态写页签标题（正常态 / 遮罩态） */
function applyDocTitle() {
  document.title = masked.value ? maskTitle.value : BASE_TITLE.value
}

watch(
  [masked, maskTitle],
  () => {
    // 切进遮罩时先把报警闪烁停掉：否则它每 900ms 就把标题改回「有人活动」
    if (masked.value && flashTimer) {
      clearInterval(flashTimer)
      flashTimer = null
    }
    applyDocTitle()
  },
  { immediate: true }
)

let autoMaskTimer = null
let lastActivity = Date.now()

function maskNow() {
  maskError.value = ''
  setMask(true)
}

function setMask(v) {
  if (masked.value === v) return
  masked.value = v
  if (v) {
    clearTimeout(autoMaskTimer)
    maskError.value = ''
    // 遮罩期间可选择暂停解码以节省资源
    if (options.mask && options.mask.keepPlaying === false) tileRefs.forEach((t) => t && t.pause())
  } else {
    if (options.mask && options.mask.keepPlaying === false) tileRefs.forEach((t) => t && t.resume())
    lastActivity = Date.now()
    scheduleAutoMask()
  }
}

/**
 * 校验遮罩解锁密码。
 * 只比摘要 —— secretMatches 内部是 secretDigest(scope, 明文) 与已存摘要的定长异或，
 * 所以这条路径上**没有任何"明文对明文"的比较**，配置里也翻不出密码原文。
 *
 * 没设密码（摘要为空）时直接放行：遮罩的语义是"防旁人瞥一眼"，
 * 不是"必须解锁"，把免密码状态做成进不去才是 bug。
 */
function unlockMask(pwd) {
  if (maskPasswordHash.value && !secretMatches(SECRET_SCOPE.MASK, pwd, maskPasswordHash.value)) {
    maskError.value = '密码错误，请重试'
    return
  }
  maskError.value = ''
  setMask(false)
}

function scheduleAutoMask() {
  clearTimeout(autoMaskTimer)
  const minutes = Number((options.mask && options.mask.autoMaskMinutes) || 0)
  if (masked.value || minutes <= 0) return
  autoMaskTimer = setTimeout(() => {
    if (!masked.value) setMask(true)
  }, minutes * 60000)
}

function onUserActivity() {
  if (masked.value) return
  const now = Date.now()
  if (now - lastActivity < 3000) return
  lastActivity = now
  scheduleAutoMask()
}

/* ==================== 快捷键 ==================== */
function onKeydown(e) {
  // 被登录遮罩盖住时不响应任何快捷键（见上面 props.interactive 的说明）
  if (!props.interactive) return
  if (masked.value) {
    // 遮罩期间只响应恢复操作，屏蔽其它快捷键
    if (e.key === 'm' || e.key === 'M') {
      maskAskSignal.value += 1
      e.preventDefault()
    }
    return
  }

  const tag = (e.target && e.target.tagName) || ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (e.key === 'Escape') {
    if (zoomIndex.value !== null) zoomIndex.value = null
    else if (settingsOpen.value) settingsOpen.value = false
    else if (eventPanelOpen.value) eventPanelOpen.value = false
  }
  if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey) toggleAppFullscreen()
  if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey) reconnectAll()
  if (e.key.toLowerCase() === 'e' && !e.metaKey && !e.ctrlKey) toggleEventPanel()
  if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey) maskNow()
}

/* ==================== Apple Watch 事件同步 ==================== */
/**
 * 手表是「只读的事件查看器」，所以这里只做三件事：
 *   1. 事件有变化（新增 / 已读 / 推送结果变了）就把最新快照推过去；
 *   2. 接住手表发回的「标记已读」，落回本机记录；
 *   3. 手表主动要数据时补一份（原生侧通常会用缓存直接回，这里是兜底）。
 * 全程静默降级：没有手表、没装 App、插件不存在都不该影响主流程。
 */
function applyWatchRead(key, read) {
  if (key === '*') {
    if (read) markAllEventsRead()
    return
  }
  const hit = events.value.find((e) => e.key === key)
  if (!hit || !!hit.read === read) return
  events.value = events.value.map((e) => (e.key === key ? { ...e, read } : e))
  dbMarkRead([key], read).catch(() => {})
}

/** 事件指纹：只关心会影响手表展示的几个字段 */
function watchSignature() {
  return events.value.map((e) => `${e.key}:${e.read ? 1 : 0}:${e.push}`).join('|')
}

watch(watchSignature, () => syncWatch(events.value, 'change'))

let disposeWatch = null

function initWatchBridge() {
  void refreshWatchStatus()
  // 首屏先把历史记录推一份，免得手表打开是空的
  loadHistorySync()
  disposeWatch = onWatchCommand({
    onMarkRead: (key, read) => applyWatchRead(key, read),
    onRequestSync: () => syncWatchNow(events.value, 'manual'),
    onStateChange: () => {}
  })
}

/** 把「当前内存里的记录」立刻推一份（不重新读库） */
function loadHistorySync() {
  if (!events.value.length) return
  syncWatchNow(events.value, 'startup')
}

/** 设置页里的「立即同步」：绕过节流，马上推一份最新的 */
async function onWatchSync() {
  await refreshWatchStatus()
  if (!watchState.supported) {
    showToast('当前环境不支持 Apple Watch 同步')
    return
  }
  await syncWatchNow(events.value, 'manual')
  showToast(`已向手表同步 ${events.value.length} 条事件`)
}

/**
 * 页面即将隐藏 / 关闭时把运行时长会话的 lastSeenAt 落准。
 * 不做这一步的话，关闭到下次打开之间的"中断"会被算成「上次心跳 → 关闭」+「关闭 → 打开」，
 * 凭空多出最多一个心跳周期（60s），页面反复刷新就会攒出一堆假中断。
 */
function onPageHideUptime() {
  touchRunSession()
}

onMounted(() => {
  // 系统运行时长：开始 / 续接本次会话 + 起心跳（后端模式下页面只负责展示，
  // 但这里仍照常记录，方便在"前端模式"下拿到跨刷新的连续时长）
  beginRunSession()
  startUptimeHeartbeat()
  window.addEventListener('pagehide', onPageHideUptime)
  window.addEventListener('resize', onResize)
  window.addEventListener('orientationchange', onResize)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('focus', stopFlashTitle)
  ;['mousemove', 'mousedown', 'wheel', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, onUserActivity, { passive: true })
  )
  if (options.alert && options.alert.desktopNotify) {
    window.addEventListener('mousedown', ensureNotifyPermission, { once: true })
  }
  observeWall()
  // 屏幕常亮：绑可见性事件（浏览器唤醒锁在切后台时会被强制释放，回前台要自己补申请）
  initWakeLock()
  // 系统通知：探测平台后端 + 订阅「点通知定位画面」（桌面端 / iOS 原生路径）
  void initSystemNotify()
  onSystemNotifyClick(handleNotifyClick)
  // 历史报警从 IndexedDB 异步载入
  loadHistory().then((list) => {
    events.value = list
    // 用已载入的记录补齐当日计数（重启后「今日报警」不会从 0 开始）
    seedTodayCount()
    // 记录就位后再挂手表桥接：首屏推过去的就是完整列表，而不是空数组
    initWatchBridge()
  })
  scheduleAutoMask()
  schedulePatrol()
  if (layoutKey.value === 'free') ensureFreeRects()
  repeatTimer = setInterval(checkRepeatAlerts, 60000)
  if (hiddenIds.value.length) showToast(`有 ${hiddenIds.value.length} 路画面处于关闭状态`)
  const visibleN = visibleCameras.value.length
  const pickedN = autoPlayIds.value.filter((id) => visibleCameras.value.some((c) => c.id === id)).length
  const auto = pickedN || Math.min(autoPlayCount.value, visibleN)
  if (auto < visibleN) {
    setTimeout(
      () =>
        showToast(
          auto === 0
            ? '已启用性能保护：点击任意画面即可播放（H.265 软解很吃 CPU）'
            : `性能保护：默认只播放 ${auto} 路，点击其它画面即可加载`
        ),
      600
    )
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onPageHideUptime)
  stopUptimeHeartbeat()
  window.removeEventListener('resize', onResize)
  window.removeEventListener('orientationchange', onResize)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('focus', stopFlashTitle)
  ;['mousemove', 'mousedown', 'wheel', 'touchstart'].forEach((ev) =>
    window.removeEventListener(ev, onUserActivity)
  )
  document.removeEventListener('visibilitychange', onVisChangeForTiles)
  window.removeEventListener('pagehide', onPageHideTiles)
  window.removeEventListener('pageshow', onPageShowTiles)
  if (wallObserver) wallObserver.disconnect()
  clearTimeout(autoMaskTimer)
  clearTimeout(locateTimer)
  clearInterval(patrolTimer)
  clearInterval(repeatTimer)
  clearInterval(tempSilentTimer)
  // 通知卡片的自动消失计时器：不清的话热更新时旧计时器还会把新卡片提前收走
  Object.keys(notifyTimers).forEach((k) => clearTimeout(notifyTimers[k]))
  onFreeUp()
  stopFlashTitle()
  // 解绑可见性监听 + 释放常亮（桌面端要通知主进程停掉 powerSaveBlocker）
  void dropWakeLock()
  // 摘掉手表桥接的监听，避免热更新时重复注册
  if (disposeWatch) {
    disposeWatch()
    disposeWatch = null
  }
  // 停掉后端检测轮询
  stopBackendPolling()
})
</script>

<style scoped>
/* 强制终结后的收尾遮罩 */
.exit-mask {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 6, 10, 0.92);
  backdrop-filter: blur(6px);
}

.exit-card {
  text-align: center;
  padding: 34px 30px;
  border-radius: 16px;
  border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
  background: rgba(16, 20, 28, 0.9);
  color: var(--text, #e8edf5);
  max-width: 340px;
}

.exit-icon {
  font-size: 30px;
  margin-bottom: 10px;
}

.exit-card h3 {
  margin: 0 0 10px;
  font-size: 17px;
}

.exit-msg {
  margin: 0 0 8px;
  font-size: 13.5px;
  line-height: 1.6;
  opacity: 0.92;
}

.exit-sub {
  margin: 0;
  font-size: 12px;
  opacity: 0.55;
}

.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.wall {
  flex: 1 1 auto;
  min-height: 0;
  padding: 10px;
  position: relative;
}

.grid {
  height: 100%;
  display: grid;
  gap: 8px;
}

/* 触摸设备用触摸提示替换键盘提示 */
.tip-touch {
  display: none;
}

@media (pointer: coarse) {
  .tip-kbd {
    display: none;
  }

  .tip-touch {
    display: inline;
  }
}

/* ---------- 自定义摆放 ---------- */
.free-wall {
  position: relative;
  width: 100%;
  height: 100%;
}

.free-wall :deep(.tile):not(.zoomed) {
  position: absolute;
}

.free-guides {
  position: absolute;
  left: 10px;
  right: 10px;
  top: 10px;
  bottom: 10px;
  z-index: 86;
  pointer-events: none;
}

.free-guides .gv,
.free-guides .gh {
  position: absolute;
  background: color-mix(in srgb, var(--accent) 45%, transparent);
}

.free-guides .gv {
  top: 0;
  bottom: 0;
  width: 1px;
}

.free-guides .gh {
  left: 0;
  right: 0;
  height: 1px;
}

.guide-badge {
  position: absolute;
  transform: translate(8px, -50%);
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11px;
  white-space: nowrap;
  color: var(--accent-text-strong);
  background: color-mix(in srgb, var(--panel) 94%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  font-variant-numeric: tabular-nums;
}

.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-dim);
}

.zoom-tip {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  z-index: 100;
  padding: 7px 14px;
  border-radius: 999px;
  font-size: 12px;
  color: #b9c8dd;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  border: 1px solid var(--line);
}

.zoom-tip kbd {
  padding: 1px 5px;
  border-radius: 4px;
  background: #1c2536;
  border: 1px solid var(--line-strong);
  font-family: inherit;
  font-size: 11px;
}

/* ---------- 全局错误条 ---------- */
/* 层级压过 toast(200) 和设置抽屉(120)：出了错就该让人看见，别被盖住 */
.err-bar {
  position: fixed;
  left: 50%;
  top: 72px;
  transform: translateX(-50%);
  z-index: 220;
  width: min(760px, 94vw);
  border-radius: 10px;
  overflow: hidden;
  font-size: 12px;
  background: color-mix(in srgb, var(--err) 14%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--err) 45%, transparent);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
}

.err-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
}

.err-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--err);
}

.err-src {
  flex: 0 0 auto;
  color: var(--err-text);
}

.err-msg {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.err-btn {
  flex: 0 0 auto;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-soft);
  background: color-mix(in srgb, var(--tint) 8%, transparent);
  border: 1px solid var(--line);
}

.err-btn:active {
  background: color-mix(in srgb, var(--tint) 16%, transparent);
}

.err-body {
  padding: 8px 10px 10px;
  border-top: 1px solid color-mix(in srgb, var(--err) 25%, transparent);
}

.err-hint {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--text-dim);
}

.err-pre {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
}

.toast {
  position: fixed;
  left: 50%;
  top: 72px;
  transform: translateX(-50%);
  z-index: 200;
  padding: 9px 16px;
  border-radius: 10px;
  font-size: 13px;
  color: #d8e4f5;
  background: color-mix(in srgb, var(--panel) 96%, transparent);
  border: 1px solid var(--line);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.22s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ================================================================== */
/*                          移动端 / 触屏适配                          */
/* ================================================================== */

@media (max-width: 900px) {
  .wall {
    padding: 8px;
  }
}

/* 手机竖屏：单列纵向滚动，每格 16:9，手指点得中 */
@media (max-width: 640px) {
  .wall.is-phone {
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    padding: 8px calc(8px + var(--safe-right)) calc(10px + var(--safe-bottom))
      calc(8px + var(--safe-left));
  }

  /* 自定义摆放是一块固定画布，不滚动 */
  .wall.is-phone.is-free {
    overflow: hidden;
  }

  .wall.is-phone .grid {
    height: auto;
    align-content: start;
  }

  .wall.is-phone .grid > :deep(.tile) {
    aspect-ratio: 16 / 9;
    min-height: 128px;
  }

  .zoom-tip {
    left: 50%;
    bottom: calc(12px + var(--safe-bottom));
    max-width: 92vw;
    text-align: center;
    font-size: 11px;
    padding: 6px 12px;
  }

  .toast {
    top: auto;
    bottom: calc(28px + var(--safe-bottom));
    max-width: 88vw;
    text-align: center;
  }

  /* 手机上顶栏是双排，错误条直接浮到最上面（盖住顶栏也没关系，出错更该被看到） */
  .err-bar {
    top: calc(6px + var(--safe-top));
    width: 94vw;
  }

  .err-msg {
    white-space: normal;
  }

  .err-pre {
    max-height: 40vh;
  }

  .guide-badge {
    font-size: 10px;
  }
}
</style>
