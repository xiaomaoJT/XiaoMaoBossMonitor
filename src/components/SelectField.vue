<template>
  <div ref="root" class="sf-wrap">
    <!--
      用「按钮 + 自绘弹层」替掉原生 <select>。
      原生 select 的展开列表是操作系统画的（Win/mac 各自一套），
      background / color / 圆角 / 玻璃质感一样都改不动，换主题时它也纹丝不动 ——
      这就是「下拉弹窗背景色和字体颜色不会变、也不好看」的根因。
      改成自绘后，弹层挂 body 上（避免被抽屉的 overflow 裁掉），
      颜色全部走 --pop-* 主题变量，跟着三套主题一起变。
    -->
    <button
      ref="ctl"
      type="button"
      class="sf-ctl field"
      :class="[cls, { open }]"
      :title="displayText"
      @click="toggle"
      @keydown.down.prevent="onCtlKey"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <span class="sf-val">{{ displayText || placeholder }}</span>
      <span class="sf-caret" aria-hidden="true"></span>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="pop" class="sf-pop" :style="popStyle" @click.stop>
        <div
          v-for="(o, i) in options"
          :key="String(o.value)"
          class="sf-item"
          :class="{ on: isCurrent(o), active: i === active }"
          @click="pick(o)"
          @mousemove="active = i"
        >
          <span class="sf-tick">{{ isCurrent(o) ? '✓' : '' }}</span>
          <span class="sf-label">{{ o.label }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  /** 当前值（与 options[].value 同类型即可，比较时统一转字符串） */
  modelValue: { type: [String, Number, Boolean], default: '' },
  /** [{ value, label }] */
  options: { type: Array, required: true },
  /** 附加样式类（通常是 mini / wide，用来对齐原生 select 的尺寸） */
  cls: { type: [String, Array, Object], default: '' },
  /** 没命中任何选项时显示的占位文字 */
  placeholder: { type: String, default: '' },
  /** 弹层最大高度（px） */
  maxHeight: { type: Number, default: 260 }
})

const emit = defineEmits(['update:modelValue', 'change'])

const root = ref(null)
const ctl = ref(null)
const pop = ref(null)
const open = ref(false)
const active = ref(-1)
const popStyle = ref({})

const current = computed(() => props.options.find((o) => String(o.value) === String(props.modelValue)) || null)
const displayText = computed(() => (current.value ? current.value.label : ''))

function isCurrent(o) {
  return String(o.value) === String(props.modelValue)
}

/* ---------------- 定位：挂 body 后用 fixed 贴着触发按钮 ---------------- */
const GAP = 4
const PAD = 8

async function openPop() {
  if (open.value) return
  open.value = true
  active.value = props.options.findIndex((o) => isCurrent(o))
  measure()
  bind(true)
  await nextTick()
  measure()
  if (pop.value) pop.value.scrollTop = 0
}

function closePop() {
  if (!open.value) return
  open.value = false
  bind(false)
}

function toggle() {
  open.value ? closePop() : openPop()
}

function measure() {
  const el = root.value
  if (!el || !open.value) return
  const r = el.getBoundingClientRect()
  const w = Math.max(r.width, 120)

  // 横向：贴着按钮左沿，右边放不下就往左挪
  let left = r.left
  if (left + w > window.innerWidth - PAD) left = Math.max(PAD, window.innerWidth - PAD - w)

  // 纵向：默认往下开；下面空间不够且上面更宽裕时翻到上方
  const est = Math.min(props.maxHeight, props.options.length * 32 + 10)
  let top = r.bottom + GAP
  let bottom = ''
  if (top + est > window.innerHeight - PAD) {
    const above = r.top - GAP - est
    if (above > PAD) {
      top = ''
      bottom = `${window.innerHeight - r.top + GAP}px`
    }
  }

  popStyle.value = {
    left: `${left}px`,
    top: top ? `${top}px` : '',
    bottom,
    minWidth: `${w}px`,
    maxHeight: `${props.maxHeight}px`
  }
}

/* ---------------- 交互：点外关闭 / Esc / 滚动跟随 / 键盘 ---------------- */
function onDocDown(e) {
  // 点在触发按钮自己身上时交给 @click 的 toggle 处理，别在这里抢先关掉
  if (root.value && root.value.contains(e.target)) return
  /*
   * ⚠️ 弹层是 Teleport 到 body 的，**不在 root 里面**。
   *    这里必须单独判一次 pop：否则在选项上按下鼠标时，这个捕获阶段的监听
   *    会先判定「点在组件外」→ closePop()，Vue 在 microtask 里把弹层从 DOM 摘掉，
   *    随后的 click 事件根本落不到 .sf-item 上，表现为「下拉弹出来但点不动」。
   */
  if (pop.value && pop.value.contains(e.target)) return
  closePop()
}

function onWinScroll() {
  if (!open.value) return
  measure()
}

function onKey(e) {
  if (!open.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    closePop()
    ctl.value && ctl.value.focus()
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const n = props.options.length
    if (!n) return
    const dir = e.key === 'ArrowDown' ? 1 : -1
    active.value = (active.value + dir + n) % n
    nextTick(() => {
      const el = pop.value && pop.value.children[active.value]
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
    })
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const o = props.options[active.value]
    if (o) pick(o)
  }
}

function onCtlKey(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    openPop()
  }
}

function bind(on) {
  if (on) {
    document.addEventListener('mousedown', onDocDown, true)
    window.addEventListener('resize', measure)
    // 捕获阶段：抽屉内任何滚动容器滚了都要重新贴位（否则弹层会留在原地）
    window.addEventListener('scroll', onWinScroll, true)
    window.addEventListener('keydown', onKey, true)
  } else {
    document.removeEventListener('mousedown', onDocDown, true)
    window.removeEventListener('resize', measure)
    window.removeEventListener('scroll', onWinScroll, true)
    window.removeEventListener('keydown', onKey, true)
  }
}

function pick(o) {
  closePop()
  ctl.value && ctl.value.focus()
  emit('update:modelValue', o.value)
  emit('change', o.value)
}

watch(open, (v) => {
  if (!v) active.value = -1
})
onBeforeUnmount(() => bind(false))
</script>

<style scoped>
.sf-wrap {
  position: relative;
  /*
   * ⚠️ 必须是块级 flex（不是 inline-flex）：
   * 原生 <select> 在 .field 里是撑满一行的，换成 inline-flex 后它会按内容缩到
   * 一百来像素，弹层跟着窄成一小条，比输入框明显短一截。
   */
  display: flex;
  min-width: 0;
  /* 父级是 flex 行时（设置页的 .field）跟着一起撑满，别缩成一小条 */
  flex: 1 1 auto;
}

.sf-ctl.field {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 26px 0 10px;
  text-align: left;
  cursor: pointer;
  /* 点了就撒手：原生 select 不会留一个焦黑框，这里也别把边框一直点亮 */
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.sf-ctl.field:focus {
  border-color: var(--line);
  box-shadow: none;
}

.sf-ctl.field.open,
.sf-ctl.field:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.sf-ctl.field.open {
  border-color: color-mix(in srgb, var(--accent) 70%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 12%, transparent);
}

.sf-val {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text);
}

.sf-ctl.field.open .sf-val,
.sf-ctl:hover .sf-val {
  color: var(--text-bright);
}

.sf-caret {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  margin-top: -3px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  opacity: 0.5;
  transform: rotate(45deg);
  transition: transform 0.16s ease, opacity 0.16s ease;
}

.sf-ctl.field.open .sf-caret {
  margin-top: 3px;
  opacity: 0.95;
  transform: rotate(225deg);
}

/* ---------------- 弹层 ---------------- */
.sf-pop {
  position: fixed;
  z-index: 600;
  padding: 5px;
  border-radius: var(--radius);
  background: var(--pop-bg);
  border: 1px solid var(--pop-line);
  box-shadow:
    inset 0 1px 0 var(--pop-hi),
    0 18px 42px rgba(0, 0, 0, 0.5);
  overflow-y: auto;
  overscroll-behavior: contain;
  animation: sf-in 0.14s ease;
}

@keyframes sf-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}

.sf-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 7px;
  font-size: 13px;
  line-height: 1.3;
  color: var(--text-soft);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.sf-item.active {
  background: var(--pop-hover);
  color: var(--text-bright);
}

.sf-item.on {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent-text-strong);
}

/* 勾占住固定宽度，保证「选中/未选中」两态文字左沿对齐 */
.sf-tick {
  flex: 0 0 auto;
  width: 11px;
  font-size: 11px;
  color: var(--accent-text);
}

.sf-label {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 触屏：列表项加大到手指好点 */
@media (pointer: coarse) {
  .sf-item {
    padding: 10px 11px;
    font-size: 15px;
  }
}
</style>
