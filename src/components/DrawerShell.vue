<!--
  通用抽屉外壳：遮罩 + 右侧抽屉 + 头部（标题 / 副标题 / 关闭）+ 主体插槽（+ 可选导航 / 页脚插槽）。
  视觉与交互复用设置抽屉：最外层带 .sd-scope，样式来自 src/styles/settings.css（见下 import）。
  「点遮罩关闭」沿用设置抽屉的两道闸 —— 打开后 400ms 静默期 + 要求按下与抬手属于同一次交互，
  避免触屏上一次触摸产生多次 click 让抽屉「闪一下就关」（iOS 必现）。
-->
<template>
  <div class="mask sd-scope" @pointerdown.self="onMaskDown" @click.self="onMaskClick">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>{{ title }}</h2>
        <span class="head-sub" v-if="subtitle">{{ subtitle }}</span>
        <span class="spacer"></span>
        <button class="icon-btn" title="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>
      </header>

      <div class="drawer-main">
        <div class="drawer-body">
          <slot />
        </div>
      </div>

      <footer class="drawer-foot" v-if="$slots.footer">
        <slot name="footer" />
      </footer>
    </aside>
  </div>
</template>

<script setup>
import '../styles/settings.css'

defineProps({
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' }
})
const emit = defineEmits(['close'])

/* 点遮罩关闭的两道闸（与 SettingsDrawer 一致） */
const OPEN_GUARD_MS = 400
const openedAt = Date.now()
let maskDownAt = 0
function onMaskDown() {
  maskDownAt = Date.now()
}
function onMaskClick() {
  const now = Date.now()
  if (now - openedAt < OPEN_GUARD_MS) return
  if (maskDownAt && now - maskDownAt > 1200) return
  emit('close')
}
</script>
