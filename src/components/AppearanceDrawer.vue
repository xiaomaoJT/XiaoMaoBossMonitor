<!--
  外观布局抽屉：把原设置里的「外观布局」页（画面布局 + 报警通知位置 + 界面主题）
  从设置抽屉里抽出来独立成抽屉，从顶栏「设置」下拉菜单进入。设置抽屉因此少一个
  tab、更聚焦「要调的东西」。

  页面本体零改动：仍是 settings/AppearanceTab.vue，它 inject('sd') 用到的
  状态 / 函数 / emit 由本组件 provide 下去（名字与它在设置抽屉里解构的完全一致）。
  外观相关逻辑（主题 / 布局预览 / 通知位置）原样从 SettingsDrawer.vue 搬来，
  同一事实仍只有一份判定；外层 block / divider / hint 样式由 settings.css
  （.sd-scope 作用域）提供，DrawerShell 负责 import。
-->
<template>
  <DrawerShell title="外观布局" subtitle="画面布局 · 通知位置 · 界面主题" @close="emit('close')">
    <AppearanceTab />

    <!--
      页脚为什么必须有「保存并应用」：本页三类设置的生效方式不同 ——
      画面布局 / 界面主题点一下就走 emit 立即生效并落盘；
      而「报警通知位置」（开不开通知卡、停靠哪个角、边距多大）只写进 opts 这份本地草稿，
      没有保存按钮的话，用户拨完开关直接关抽屉 = 白改。与设置抽屉同口径。
    -->
    <template #footer>
      <span class="spacer"></span>
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" @click="save">保存并应用</button>
    </template>
  </DrawerShell>
</template>

<script setup>
import { computed, provide, reactive } from 'vue'
import DrawerShell from './DrawerShell.vue'
import AppearanceTab from './settings/AppearanceTab.vue'
import { cloneDefaultOptions } from '../config/defaults.js'

const props = defineProps({
  cameras: { type: Array, default: () => [] },
  options: { type: Object, default: () => ({}) },
  hiddenIds: { type: Array, default: () => [] },
  layouts: { type: Array, default: () => [] },
  layoutKey: { type: String, default: 'auto' },
  native: { type: Boolean, default: false },
  events: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'save', 'update:layoutKey', 'reset-free', 'update-theme'])

/* 与设置抽屉同口径：深拷贝一份草稿，未点「保存」前不影响正在运行的界面 */
const opts = reactive(JSON.parse(JSON.stringify({ ...cloneDefaultOptions(), ...props.options })))

/* ---------- 界面主题（原 SettingsDrawer，逻辑零改动） ---------- */
/**
 * 主题不参与抽屉的「保存」按钮：点一下立刻生效并经 App 持久化
 * （emit('update-theme') → App 写 options.theme → watch 自动落盘），
 * 否则「换个配色还要按保存」会显得很怪。opts.theme 只用于本页按钮的选中态。
 */
const THEME_OPTIONS = computed(() => {
  const list = [
    { value: 'liquid', label: '液态风格', desc: '默认玻璃质感配色' },
    { value: 'dark', label: '暗黑风格', desc: '中性纯黑，OLED 省电' },
    { value: 'light', label: '亮色风格', desc: '浅色日间模式' }
  ]
  if (props.native) list.push({ value: 'auto', label: '自动', desc: '跟随 iOS 系统深色模式' })
  return list
})

const themeLabel = computed(
  () => (THEME_OPTIONS.value.find((t) => t.value === opts.theme) || THEME_OPTIONS.value[0]).label
)

function setTheme(v) {
  if (opts.theme === v) return
  opts.theme = v
  emit('update-theme', v)
}

/* ---------- 布局预览（原 SettingsDrawer，逻辑零改动） ---------- */
const currentLayoutLabel = computed(() => {
  const hit = props.layouts.find((l) => l.key === props.layoutKey)
  return hit ? hit.label : '自动铺满'
})

/** 布局预览里画几个小格子 */
function previewCells(key) {
  switch (key) {
    case '1':
      return 1
    case '2':
      return 4
    case '3':
      return 9
    case '4':
      return 16
    case 'focus':
      return 5
    case 'free':
      return 4
    default:
      return 6
  }
}

function resetFreeLayout() {
  emit('reset-free')
  emit('update:layoutKey', 'free')
}

/* ---------- 报警通知位置（原 SettingsDrawer，逻辑零改动） ---------- */
/**
 * 停靠位置四选一。默认左上角：顶栏下方不压画面主体，
 * 而右下角已经被常驻的事件面板占了。
 */
const NOTIFY_POSITIONS = [
  { key: 'tl', label: '左上' },
  { key: 'tr', label: '右上' },
  { key: 'bl', label: '左下' },
  { key: 'br', label: '右下' }
]

const notifyPos = computed(() => {
  const p = opts.ui && opts.ui.notifyPos
  return NOTIFY_POSITIONS.some((x) => x.key === p) ? p : 'tl'
})
const notifyGap = computed(() => (opts.ui ? Number(opts.ui.notifyGap) : 14) || 0)

function setNotifyPos(key) {
  if (!opts.ui) opts.ui = {}
  opts.ui.notifyPos = key
}

function setNotifyGap(v) {
  if (!opts.ui) opts.ui = {}
  const n = Number(v)
  opts.ui.notifyGap = Number.isFinite(n) ? Math.max(0, Math.min(80, n)) : 14
}

/** 报警通知卡片总开关（关掉后只记事件面板与推送，不弹卡片） */
function toggleTopNotify() {
  if (!opts.alert) opts.alert = {}
  opts.alert.topNotify = opts.alert.topNotify === false
}

/** 保存：只合选项（通知位置 / 开关 / 主题），不碰通道与隐藏名单 */
function save() {
  emit('save', { ...opts })
}

/*
 * 把 AppearanceTab 需要的绑定下发下去。⚠️ 这是**手写字段清单**——
 * 与子组件里的解构必须逐字对齐（全项目已因这类清单栽过四次：漏名字不报错，
 * 只表现为「某个功能静默失效」）。改这里务必同步改 AppearanceTab.vue 的解构行。
 */
provide('sd', {
  NOTIFY_POSITIONS,
  THEME_OPTIONS,
  currentLayoutLabel,
  emit,
  notifyGap,
  notifyPos,
  opts,
  previewCells,
  props,
  resetFreeLayout,
  setNotifyGap,
  setNotifyPos,
  setTheme,
  themeLabel,
  toggleTopNotify
})
</script>
