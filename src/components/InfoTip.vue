<template>
  <!--
    跟随鼠标的信息浮层（item 107）

    为什么不用原生 title：
      1. 原生 tooltip 有 1 秒左右的延迟、样式完全不可控；
      2. 原生是纯文本，无法换行、无法加粗重点；
      3. 长文案（比如设备信息这一整行）在窄屏里会撑出一个很窄很高的黄框；
      4. 移动端 / 触屏上根本不触发。

    这里用 fixed 定位 + 挂在 body 下的 Teleport，鼠标怎么动都贴着，
    并且会自动判断上下空间往哪边翻，避免超出视口。
  -->
  <Teleport to="body">
    <div
      v-if="show"
      class="wb-tip"
      :class="{ 'wb-tip-multiline': multiline }"
      :style="tipStyle"
    >
      <slot>{{ text }}</slot>
    </div>
  </Teleport>

  <!--
    透明跟随层：面积盖住触发元素，这样鼠标在元素内移动不会反复进出，
    浮层不会一闪一闪。pointer-events:none 保证不影响下层点击。
  -->
  <span
    class="wb-tip-anchor"
    :class="{ active: show }"
    @mouseenter="open"
    @mousemove="move"
    @mouseleave="close"
    @touchstart.prevent="toggleTap"
  >
    <slot name="trigger" />
  </span>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  /** 浮层文本（也可用默认插槽放富内容） */
  text: { type: String, default: '' },
  /** 多行模式：按原样换行显示（长文案用） */
  multiline: { type: Boolean, default: false },
  /** 相对鼠标的偏移 */
  offset: { type: Number, default: 12 }
})

const show = ref(false)
const pos = ref({ x: 0, y: 0 })
/** 触屏：没有 hover，点一下切换显示 */
const tapMode = ref(false)

function place(x, y) {
  // 先按「右下」摆放，稍后按视口边界纠正
  pos.value = { x: x + props.offset, y: y + props.offset }
}

function open(e) {
  if (tapMode.value) return
  show.value = true
  if (e && typeof e.clientX === 'number') place(e.clientX, e.clientY)
}

function move(e) {
  if (tapMode.value || !show.value) return
  if (typeof e.clientX === 'number') place(e.clientX, e.clientY)
}

function close() {
  if (tapMode.value) return
  show.value = false
}

function toggleTap() {
  tapMode.value = true
  show.value = !show.value
  if (show.value) {
    // 触屏没有鼠标坐标，用视口中心偏上作为落点
    place(window.innerWidth / 2 - 40, window.innerHeight / 2 - 60)
  }
  // 轻触外部关闭
  setTimeout(() => {
    const off = () => {
      show.value = false
      tapMode.value = false
      window.removeEventListener('touchstart', off, true)
    }
    window.addEventListener('touchstart', off, true)
  }, 10)
}

const tipStyle = computed(() => {
  const w = typeof window === 'undefined' ? 1024 : window.innerWidth
  const h = typeof window === 'undefined' ? 768 : window.innerHeight
  // 粗略估算：多行文案更宽更长，超出就翻到另一侧
  const width = props.multiline ? Math.min(360, w - 32) : undefined
  const flipX = pos.value.x + (width || 220) > w - 12
  const flipY = pos.value.y + 80 > h - 12
  return {
    left: `${flipX ? Math.max(8, pos.value.x - (width || 220) - props.offset * 2) : pos.value.x}px`,
    top: `${flipY ? Math.max(8, pos.value.y - props.offset * 3) : pos.value.y}px`,
    ...(width ? { width: `${width}px` } : {})
  }
})
</script>

<style>
/*
 * 用 unscoped：这是 Teleport 到 body 的浮层，
 * scoped 的属性选择器在这个子树里匹配不到，样式会完全失效。
 */
.wb-tip-anchor {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.wb-tip {
  position: fixed;
  z-index: 9999;
  max-width: 340px;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.55;
  color: #e6eefb;
  background: rgba(16, 24, 36, 0.97);
  border: 1px solid rgba(120, 160, 210, 0.35);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
  pointer-events: none;
  white-space: nowrap;
}

.wb-tip-multiline {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
