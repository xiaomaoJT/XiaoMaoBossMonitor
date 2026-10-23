<template>
  <header class="topbar">
    <div class="left">
      <!--
        品牌 logo：动图（public/logo/logo.gif）。
        圆角靠容器裁切：.logo 自带 border-radius + overflow: hidden，
        GIF 是白底图，不裁的话四个直角压在深色顶栏上会很难看。
        注意用 :src 动态绑定字符串而不是静态 src：静态路径会被 Vite 当作模块
        从「组件目录」去解析（build 直接报错），绑定的字符串则按 HTML 语义
        相对当前页面解析，与 index.html / defaults.js 里的 ./logo/... 约定一致。
      -->
      <div class="logo">
        <img class="logo-img" :src="LOGO_SRC" alt="BossMonitor" draggable="false" />
      </div>
      <div class="titles">
        <h1>
          BossMonitor
          <!--
            当前工作模式：一眼看出「检测/推送在哪台机器上跑」。
            排查问题时非常关键 —— 同样的界面，开着与关着后端，
            事件来源、AI 是否本机算、推送由谁发，全都不一样。
          -->
          <em class="mode-chip" :class="backend ? 'on' : 'off'" :title="modeTitle">
            {{ backend ? '后端模式' : '前端模式' }}
          </em>
        </h1>
        <p>
          <span class="ok">{{ online }}</span> / {{ total }} 路在线
          <template v-if="hiddenCount">
            <span class="sep hide-sm">·</span>
            <span class="dim hide-sm">已关闭 {{ hiddenCount }} 路</span>
          </template>
          <span class="sep">·</span>
          <span class="stat">今日报警 {{ todayCount }} 次</span>
          <!--
            「未读告警 N 条」已移除（item 110）：右上角「事件」按钮上本来就有
            未读角标，这里再写一遍是重复信息，而且窄屏下还挤掉后面的时间。
          -->
          <span class="sep hide-md">·</span>
          <span class="dim hide-md">{{ lastEvent }}</span>
        </p>
      </div>
    </div>

    <div class="right">
      <div class="actions">
        <button class="btn" title="重新连接全部画面" @click="emit('reconnect-all')">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M20 11a8 8 0 1 0-2.3 5.7M20 5.5V11h-5.5"
            />
          </svg>
          <span class="lbl">全部重连</span>
        </button>
        <button class="btn" @click="emit('pause-all')" title="暂停全部画面（保留连接，节省 CPU）">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" />
          </svg>
          <span class="lbl">全部暂停</span>
        </button>
        <button class="btn" @click="emit('resume-all')" title="播放全部画面（受解码上限约束）">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M7 4.8l12 7.2-12 7.2z" />
          </svg>
          <span class="lbl">全部播放</span>
        </button>
        <button
          v-if="hiddenCount"
          class="btn primary"
          title="把关闭的画面重新显示出来"
          @click="emit('restore-hidden')"
        >
          恢复 {{ hiddenCount }} 路
        </button>
        <button
          class="btn"
          :class="{ primary: masked }"
          @click="emit('toggle-mask')"
          :title="masked ? '恢复画面（M）' : '隐私遮罩：一键盖住整个大屏（M）'"
        >
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M3 12s3.5-6 9-6c1.3 0 2.5.3 3.5.8M21 12s-3.5 6-9 6c-1.3 0-2.5-.3-3.5-.8M4 20L20 4"
            />
          </svg>
          <span class="lbl">{{ masked ? '恢复' : '遮罩' }}</span>
        </button>
        <button class="btn" :class="{ alarming: unread > 0 }" @click="emit('toggle-events')" title="报警事件记录">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6 9a6 6 0 1 1 12 0v4.5l1.6 2.6H4.4L6 13.5zM10 18.5a2 2 0 0 0 4 0"
            />
          </svg>
          <span class="lbl">事件</span>
          <span class="badge" v-if="unread">{{ unread > 99 ? '99+' : unread }}</span>
        </button>
        <!-- 设置：齿轮按钮 + 下拉菜单（完整配置 / 系统信息两个入口） -->
        <div class="gear-wrap">
          <button
            ref="gearBtnEl"
            class="btn primary"
            :class="{ open: menuOpen }"
            title="设置菜单"
            aria-haspopup="true"
            :aria-expanded="menuOpen ? 'true' : 'false'"
            @click.stop="toggleMenu"
          >
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 13.6a7.6 7.6 0 0 0 0-3.2l1.7-1.3-1.9-3.3-2 .8a7.6 7.6 0 0 0-2.8-1.6L14 2.6h-4l-.4 2.4a7.6 7.6 0 0 0-2.8 1.6l-2-.8L2.9 9.1l1.7 1.3a7.6 7.6 0 0 0 0 3.2l-1.7 1.3 1.9 3.3 2-.8a7.6 7.6 0 0 0 2.8 1.6l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.8-1.6l2 .8 1.9-3.3z"
              />
            </svg>
            <span class="lbl">设置</span>
            <svg class="caret" viewBox="0 0 24 24" width="12" height="12">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M6 9l6 6 6-6"
              />
            </svg>
          </button>
        </div>
        <!-- 下拉菜单挂到 body：窄屏时按钮组是横向滚动容器，写在里面会被 overflow 裁掉 -->
        <Teleport to="body">
          <div
            class="gear-menu"
            v-if="menuOpen"
            :style="menuStyle"
            role="menu"
            @pointerdown.stop
          >
            <button class="gear-item" role="menuitem" @click="pickSettings">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 13.6a7.6 7.6 0 0 0 0-3.2l1.7-1.3-1.9-3.3-2 .8a7.6 7.6 0 0 0-2.8-1.6L14 2.6h-4l-.4 2.4a7.6 7.6 0 0 0-2.8 1.6l-2-.8L2.9 9.1l1.7 1.3a7.6 7.6 0 0 0 0 3.2l-1.7 1.3 1.9 3.3 2-.8a7.6 7.6 0 0 0 2.8 1.6l.4 2.4h4l.4-2.4a7.6 7.6 0 0 0 2.8-1.6l2 .8 1.9-3.3z"
                />
              </svg>
              <span class="gi-main">打开设置</span>
              <span class="gi-sub">完整配置</span>
            </button>
            <button class="gear-item" role="menuitem" @click="pickSystemInfo">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 16v-4M12 8h.01M4.6 5.2h16.8v13.6H4.6zM8.6 2.6h6.8v2.6H8.6zM9.8 21.4h4.4v-2.6H9.8z"
                />
              </svg>
              <span class="gi-main">系统信息</span>
              <span class="gi-sub">设备信息 · 数据统计</span>
            </button>
          </div>
        </Teleport>
      </div>

      <div class="clock">
        <strong>{{ time }}</strong>
        <span>{{ date }}</span>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  layouts: { type: Array, required: true },
  layoutKey: { type: String, required: true },
  total: { type: Number, default: 0 },
  online: { type: Number, default: 0 },
  hiddenCount: { type: Number, default: 0 },
  unread: { type: Number, default: 0 },
  masked: { type: Boolean, default: false },
  todayCount: { type: Number, default: 0 },
  lastEvent: { type: String, default: '暂无事件' },
  /** 是否开着后端检测（true = 检测与推送都由常驻设备做，本机只负责看画面） */
  backend: { type: Boolean, default: false }
})

/** 模式徽标的悬浮说明：把两种模式各自的行为讲清楚，免得看图猜 */
const modeTitle = computed(() =>
  props.backend
    ? '后端模式：人形 / 人脸 / 区域检测与推送都在常驻设备上跑，本机页面只播放画面、不做 AI'
    : '前端模式：检测与推送都由这个页面完成，页面关掉就没有监测'
)

const emit = defineEmits([
  'reconnect-all',
  'pause-all',
  'resume-all',
  'restore-hidden',
  'toggle-events',
  'toggle-mask',
  'settings',
  'open-system-info'
])

/** 品牌 logo 动图（public/logo/logo.gif），相对页面根的写法见模板注释 */
const LOGO_SRC = './logo/logo.gif'

/**
 * layouts / layoutKey 现在不在顶栏渲染了（布局切换入口在设置的「画面布局」标签页），
 * 但保留声明：一是不想改成未声明的透传属性挂到根节点上，二来后续要加布局快捷提示也方便。
 */
const time = ref('')
const date = ref('')
let timer = null

function tick() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  time.value = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  date.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${week}`
}

onMounted(() => {
  tick()
  timer = setInterval(tick, 1000)
  document.addEventListener('pointerdown', onDocPointerDown, true)
  document.addEventListener('keydown', onDocKeyDown, true)
})

onBeforeUnmount(() => {
  clearInterval(timer)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeyDown, true)
})

/* ==================== 设置下拉菜单 ==================== */
/*
 * 顶栏「设置」现在是个下拉菜单：完整配置（SettingsDrawer，原有入口不变）
 * 和系统信息（SystemInfoDrawer，从设置里拆出来的「只看 / 低频」模块）。
 * 菜单挂到 body 并用 fixed 定位：窄屏时按钮组是横向滚动容器（overflow 裁剪），
 * 写在按钮旁边会被切掉；Teleport 之后任何宽度下都能完整显示。
 */
const menuOpen = ref(false)
const gearBtnEl = ref(null)
const menuStyle = ref({})

function toggleMenu() {
  if (menuOpen.value) {
    closeMenu()
    return
  }
  const el = gearBtnEl.value
  if (el) {
    const r = el.getBoundingClientRect()
    menuStyle.value = {
      top: `${Math.round(r.bottom) + 6}px`,
      right: `${Math.max(8, Math.round(window.innerWidth - r.right))}px`
    }
  }
  menuOpen.value = true
}

function closeMenu() {
  menuOpen.value = false
}

function pickSettings() {
  closeMenu()
  emit('settings')
}

function pickSystemInfo() {
  closeMenu()
  emit('open-system-info')
}

/** 点在按钮和菜单之外就收起（capture 阶段，先于业务点击） */
function onDocPointerDown(e) {
  if (!menuOpen.value) return
  const t = e.target
  // t 理论上可能不是 Element（极端情况），closest 不存在时按「点在菜单外」处理
  if (t && typeof t.closest === 'function' && (t.closest('.gear-menu') || t.closest('.gear-wrap'))) return
  closeMenu()
}

/** Esc 收起菜单 */
function onDocKeyDown(e) {
  if (e.key === 'Escape' && menuOpen.value) {
    closeMenu()
    e.stopPropagation()
  }
}
</script>

<style scoped>
.topbar {
  height: var(--topbar-h);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 14px;
  background: linear-gradient(180deg, var(--panel-2), var(--panel-deep));
  border-bottom: 1px solid var(--line);
}

.left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.logo {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  /* GIF 白底图靠这里裁出圆角，四角不会露出直角白块 */
  overflow: hidden;
  display: grid;
  place-items: center;
  color: var(--accent-text);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.logo-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  /* 禁掉拖拽选中，避免误触把 logo 拖出去 */
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: none;
}

.titles h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

/*
 * 模式徽标：紧跟品牌名，一眼看清「检测和推送是谁在干」。
 * 后端模式用蓝色（那是常驻设备在负责），前端模式用中性灰（就是这台机器自己）。
 */
.mode-chip {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-style: normal;
  font-weight: 500;
  letter-spacing: 0;
  vertical-align: 2px;
  cursor: default;
}

.mode-chip.on {
  color: #b6dcff;
  background: rgba(56, 138, 221, 0.22);
  box-shadow: inset 0 0 0 1px rgba(133, 183, 235, 0.45);
}

.mode-chip.off {
  color: var(--text-2);
  background: rgba(136, 135, 128, 0.16);
  box-shadow: inset 0 0 0 1px rgba(136, 135, 128, 0.32);
}

.titles p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.ok {
  color: var(--ok);
  font-weight: 600;
}

.stat {
  color: var(--warn);
}

.stat.alarming {
  color: var(--err);
}

.dim {
  color: var(--text-dim-2);
}

.sep {
  margin: 0 5px;
  color: var(--text-dim-2);
}

.right {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn.alarming {
  color: var(--err-text);
  border-color: color-mix(in srgb, var(--err) 50%, transparent);
  background: color-mix(in srgb, var(--err) 14%, transparent);
}

.badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  color: #fff;
  background: var(--err);
  font-variant-numeric: tabular-nums;
}

/* ==================== 设置下拉菜单 ==================== */
/*
 * .gear-menu  Teleport 到 body 后 scoped 依然生效（挂载时带上 data-v 属性），
 * 所以浮动层的样式也能写在组件内，不会泄漏到全局。
 */
.gear-wrap {
  display: inline-flex;
}

.btn.primary .caret {
  transition: transform 0.15s ease;
}

.btn.primary.open .caret {
  transform: rotate(180deg);
}

.gear-menu {
  position: fixed;
  z-index: 200;
  min-width: 210px;
  padding: 6px;
  border-radius: 10px;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(8px);
  animation: gear-in 0.14s ease;
}

@keyframes gear-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.gear-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-soft);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.gear-item:hover {
  color: var(--accent-text-strong);
  background: var(--accent-soft);
}

.gear-item svg {
  flex: 0 0 auto;
  color: var(--text-dim);
}

.gear-item:hover svg {
  color: var(--accent-text);
}

.gi-sub {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim-2);
  white-space: nowrap;
}

/* 手机竖屏：菜单贴右缘，别超出屏幕 */
@media (max-width: 640px) {
  .gear-menu {
    min-width: 190px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .gear-menu {
    animation: none;
  }

  .btn.primary .caret {
    transition: none;
  }
}

.clock {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 92px;
  font-variant-numeric: tabular-nums;
}

.clock strong {
  font-size: 15px;
  letter-spacing: 0.5px;
}

.clock span {
  font-size: 11px;
  color: var(--text-dim-2);
}

@media (max-width: 1200px) {
  .clock {
    display: none;
  }
}

/* ==================== 平板：按钮组换行 ==================== */
@media (max-width: 1100px) {
  .hide-md {
    display: none;
  }

  .actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
}

/* ==================== 手机竖屏：两行布局，按钮图标化并横向滚动 ==================== */
@media (max-width: 640px) {
  .topbar {
    height: auto;
    min-height: var(--topbar-h);
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: calc(8px + var(--safe-top)) calc(10px + var(--safe-right)) 8px
      calc(10px + var(--safe-left));
  }

  .left {
    gap: 8px;
  }

  .logo {
    width: 28px;
    height: 28px;
    border-radius: 8px;
  }

  .titles h1 {
    font-size: 14px;
  }

  .titles p {
    font-size: 11.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hide-sm {
    display: none;
  }

  .right {
    display: block;
  }

  .actions {
    width: 100%;
    gap: 8px;
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 2px;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .actions::-webkit-scrollbar {
    display: none;
  }

  .actions .btn {
    flex: 0 0 auto;
    min-width: 46px;
    justify-content: center;
    padding: 0 12px;
  }

  /* 图标化：文字标签隐藏，只留图标 + 角标 */
  .lbl {
    display: none;
  }

  .clock {
    display: none;
  }
}
</style>
