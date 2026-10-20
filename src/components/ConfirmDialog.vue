<template>
  <Teleport to="body">
    <transition name="cd">
      <div v-if="s.visible" class="cd-mask" @click.self="onMask">
        <div
          class="cd-box"
          :class="['cd-' + s.variant, 'cd-' + s.type]"
          role="alertdialog"
          aria-modal="true"
        >
          <div v-if="s.variant === 'danger'" class="cd-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M12 3.5 21.5 20h-19zM12 9.5v5M12 17.3v.05"
              />
            </svg>
          </div>

          <h3 class="cd-title">{{ s.title }}</h3>
          <p v-if="s.message" class="cd-msg">{{ s.message }}</p>

          <div class="cd-acts">
            <button
              v-if="s.type === 'confirm'"
              class="cd-btn cd-ghost"
              @click="onCancel"
            >{{ s.cancelText }}</button>
            <button
              ref="okEl"
              class="cd-btn"
              :class="s.variant === 'danger' ? 'cd-danger' : 'cd-primary'"
              @click="onOk"
            >{{ s.okText }}</button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup>
import { watch, nextTick, ref, onMounted, onBeforeUnmount } from 'vue'
import { useConfirmState, settleConfirm } from '../composables/confirm.js'

const s = useConfirmState()
const okEl = ref(null)

watch(
  () => s.visible,
  async (v) => {
    if (v) {
      await nextTick()
      // 自动聚焦确定按钮：键盘流（回车即确认）顺手，鼠标流也不碍事
      if (okEl.value) okEl.value.focus()
    }
  }
)

function onOk() {
  settleConfirm(true)
}
function onCancel() {
  // 提示框没有"取消"概念，Esc / 遮罩都按"已读"处理
  settleConfirm(s.type === 'alert' ? true : false)
}
function onMask() {
  // 点遮罩：确认框=取消（安全路径），提示框=关闭
  settleConfirm(s.type === 'confirm' ? false : true)
}
function onKey(e) {
  if (!s.visible) return
  if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
    return
  }
  if (e.key === 'Enter') {
    // 焦点已经在弹窗内按钮上时，交给原生 click，避免重复结算
    if (e.target && e.target.closest && e.target.closest('.cd-box')) return
    e.preventDefault()
    onOk()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.cd-mask {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(4, 7, 12, 0.55);
  -webkit-backdrop-filter: blur(8px) saturate(1.4);
  backdrop-filter: blur(8px) saturate(1.4);
}

.cd-box {
  position: relative;
  width: 364px;
  max-width: 100%;
  /*
   * 长文案（人脸库写入超时那类"原因 + 怎么做"的说明）在手机窄屏上会超过一屏，
   * 不限制高度就会被裁掉下面的按钮 —— 只能靠滚动兜住，不能靠"文案写短点"。
   * 40px = mask 上下各 20px 的 padding。
   */
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 22px 22px 18px;
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--panel) 98%, transparent),
    color-mix(in srgb, var(--panel-deep) 98%, transparent)
  );
  border: 1px solid var(--line-strong);
  box-shadow: 0 28px 72px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.07);
  -webkit-backdrop-filter: blur(28px) saturate(1.7);
  backdrop-filter: blur(28px) saturate(1.7);
}

/* 危险变体：红边 + 顶部红徽标，和「不可撤销」的语义对上 */
.cd-danger.cd-box {
  border-color: color-mix(in srgb, var(--err) 42%, var(--line-strong));
}

.cd-badge {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-bottom: 10px;
  border-radius: 10px;
  color: var(--err-text);
  background: color-mix(in srgb, var(--err) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--err) 38%, transparent);
}

.cd-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--text-bright);
}

.cd-msg {
  margin: 0 0 18px;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-soft);
  white-space: pre-line;
  word-break: break-word;
}

.cd-acts {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.cd-btn {
  height: 34px;
  min-width: 76px;
  padding: 0 16px;
  border-radius: 9px;
  font-size: 13.5px;
  font-weight: 550;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.cd-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
}

.cd-primary {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--accent-text);
}
.cd-primary:hover {
  color: var(--accent-text-strong);
  border-color: color-mix(in srgb, var(--accent) 80%, transparent);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

.cd-danger {
  background: color-mix(in srgb, var(--err) 20%, transparent);
  border-color: color-mix(in srgb, var(--err) 55%, transparent);
  color: var(--err-text);
}
.cd-danger:hover {
  background: color-mix(in srgb, var(--err) 32%, transparent);
  border-color: color-mix(in srgb, var(--err) 80%, transparent);
  color: #fff;
}

.cd-ghost {
  background: var(--panel-2);
  border-color: var(--line);
  color: var(--text-soft);
}
.cd-ghost:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--panel-3);
}

/* 入场：遮罩淡入 + 卡片轻微上浮放大 */
.cd-enter-active,
.cd-leave-active {
  transition: opacity 0.2s ease;
}
.cd-enter-active .cd-box,
.cd-leave-active .cd-box {
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
}
.cd-enter-from,
.cd-leave-to {
  opacity: 0;
}
.cd-enter-from .cd-box,
.cd-leave-to .cd-box {
  opacity: 0;
  transform: translateY(8px) scale(0.97);
}

/* 触屏：按钮放大到手指可点 */
@media (pointer: coarse) {
  .cd-btn {
    height: 42px;
    min-width: 92px;
    font-size: 15px;
    border-radius: 11px;
  }
}
</style>
