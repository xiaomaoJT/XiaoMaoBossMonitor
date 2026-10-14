<script setup>
/**
 * 自绘「归入」下拉（替代原生 <select>）
 * --------------------------------------------------------------------------
 * 为什么不用原生 <select>：设置抽屉是 30px 毛玻璃（backdrop-filter），背后还挂着
 * 6 路直播每帧在变。原生 <select> 的弹层是 OS 级浮层，浮在这种「毛玻璃 + 高频重绘」
 * 之上时，点击后要卡很久才弹得出来（用户在录入页实测吐槽过）。自绘下拉是普通 DOM
 * 列表（fixed 定位，按触发器坐标摆放），不走 OS 原生弹窗，不受毛玻璃/重绘拖累，
 * 点击即开、体验顺滑，样式也能和页面统一。
 *
 * 入参：
 *   modelValue   当前选中值（字符串；空 = 未选 / 走 placeholder 语义）
 *   options      候选名字数组（字符串）
 *   placeholder  未选时触发器显示的文字（如「归入到…」「新建（自动编号）」）
 *   custom       是否提供「自定义…」一项（选它后展开输入框 + 确定）
 *   customPlaceholder / customConfirmText  自定义输入框的占位与按钮文案
 *   disabled
 * 出参：
 *   update:modelValue   选中（或自定义确认）后写回的值
 *   change(value)       同上，并额外通知父组件"做了一次选择"（用于立即归入）
 */
import { ref, computed, onBeforeUnmount, nextTick, onMounted } from 'vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  custom: { type: Boolean, default: false },
  customPlaceholder: { type: String, default: '自定义名字' },
  customConfirmText: { type: String, default: '确定' },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'change'])

const root = ref(null)
const open = ref(false)
const customMode = ref(false)
const customText = ref('')
const pos = ref({ top: 0, left: 0, width: 0 })

const hasValue = computed(() => !!props.modelValue)
const displayLabel = computed(() => {
  if (!props.modelValue) return props.placeholder
  return props.modelValue
})

function close() {
  open.value = false
  customMode.value = false
}
function onDocClick(e) {
  if (!open.value) return
  const t = e.target
  // 弹层用 teleport 挂到 body，不在 root 内，所以"点弹层内部"也要放行，否则选项点击会被误关
  if (root.value && root.value.contains(t)) return
  const pop = document.querySelector('.fas-pop')
  if (pop && pop.contains(t)) return
  close()
}
function onScroll() {
  if (open.value) close()
}
function onKey(e) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    close()
  }
}

function toggle() {
  if (props.disabled) return
  if (open.value) {
    close()
    return
  }
  const r = root.value.getBoundingClientRect()
  pos.value = { top: r.bottom + 4, left: r.left, width: r.width }
  open.value = true
  customMode.value = false
}

function pick(name) {
  emit('update:modelValue', name)
  emit('change', name)
  close()
}
function startCustom() {
  customMode.value = true
  nextTick(() => {
    const inp = document.querySelector('.fas-custom-input')
    if (inp) inp.focus()
  })
}
function confirmCustom() {
  const name = (customText.value || '').trim()
  if (!name) return
  customText.value = ''
  emit('update:modelValue', name)
  emit('change', name)
  close()
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll, true)
  document.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll, true)
  document.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <div class="face-assign-select" ref="root" :class="{ disabled }">
    <button
      type="button"
      class="fas-trigger field mini"
      :class="{ ph: !hasValue }"
      :disabled="disabled"
      @click.stop="toggle"
    >
      <span class="fas-label">{{ displayLabel }}</span>
      <span class="fas-caret">▾</span>
    </button>

    <teleport to="body">
      <div
        v-if="open"
        class="fas-pop"
        :style="{ top: pos.top + 'px', left: pos.left + 'px', minWidth: pos.width + 'px' }"
      >
        <div class="fas-opt" v-for="nm in options" :key="nm" :class="{ active: nm === modelValue }" @click="pick(nm)">
          {{ nm }}
        </div>
        <div v-if="custom" class="fas-opt fas-custom" @click="startCustom">{{ customPlaceholder ? '自定义…' : '自定义…' }}</div>
        <div v-if="custom && customMode" class="fas-custom-box">
          <input
            class="field mini fas-custom-input"
            v-model="customText"
            :placeholder="customPlaceholder"
            @click.stop
            @keyup.enter="confirmCustom"
          />
          <button class="mini-btn" :disabled="!customText.trim()" @click.stop="confirmCustom">
            {{ customConfirmText }}
          </button>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.face-assign-select {
  position: relative;
  width: 100%;
}
.fas-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  width: 100%;
  height: 26px;
  padding: 2px 6px;
  font-size: 11px;
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
  background: color-mix(in srgb, var(--tint) 14%, var(--card));
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
}
.fas-trigger.ph {
  color: var(--text-dim-2);
}
.fas-trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.fas-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fas-caret {
  flex: 0 0 auto;
  font-size: 9px;
  color: var(--text-dim-2);
}
.fas-pop {
  position: fixed;
  z-index: 9999;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 8px;
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
}
.fas-opt {
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fas-opt:hover {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.fas-opt.active {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent);
}
.fas-custom {
  color: var(--text-dim);
  border-top: 1px dashed var(--line-soft);
  margin-top: 2px;
  padding-top: 6px;
}
.fas-custom-box {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed var(--line-soft);
}
.fas-custom-box .field.mini {
  flex: 1 1 auto;
  width: auto;
  height: 26px;
  font-size: 11px;
}
.fas-custom-box .mini-btn {
  flex: 0 0 auto;
  padding: 0 8px;
  font-size: 11px;
}
</style>
