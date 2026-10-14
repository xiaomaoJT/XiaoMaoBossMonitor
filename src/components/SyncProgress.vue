<template>
  <!--
    同步进度卡片（顶部居中、不遮挡操作）。
    只在真有同步在跑 / 刚跑完 / 跑失败时出现 —— 平时完全不占位。
  -->
  <Teleport to="body">
    <transition name="sp">
      <div v-if="flow.active" class="sp" :class="{ 'is-fail': !!flow.error, 'is-done': flow.done }">
        <div class="sp-head">
          <span class="sp-ico" aria-hidden="true">
            <span v-if="flow.error">!</span>
            <span v-else-if="flow.done">✓</span>
            <span v-else class="ring"></span>
          </span>
          <div class="sp-titles">
            <p class="sp-title">{{ flow.error ? '同步未完成' : flow.done ? '已与后端对齐' : flow.title }}</p>
            <p class="sp-sub">
              <template v-if="flow.error">{{ flow.error }}</template>
              <template v-else-if="flow.done">本机内容已与后端一致（{{ pct }}%）</template>
              <template v-else>{{ now || '准备中…' }} · {{ pct }}%</template>
            </p>
          </div>
          <button class="sp-x" @click="dismiss" :title="flow.error ? '知道了' : '收起'">
            {{ flow.error ? '知道了' : '×' }}
          </button>
        </div>

        <div class="sp-bar" aria-hidden="true">
          <i :style="{ width: pct + '%' }"></i>
        </div>

        <ul class="sp-steps">
          <li v-for="s in flow.steps" :key="s.key" :class="'st-' + s.state">
            <span class="st-dot"></span>
            <span class="st-label">{{ s.label }}</span>
            <span class="st-note" v-if="s.note">{{ s.note }}</span>
          </li>
        </ul>
      </div>
    </transition>
  </Teleport>
</template>

<script setup>
import { syncFlow, syncFlowPct, syncFlowNow, dismissSyncFlow } from '../composables/useSyncProgress.js'

const pct = syncFlowPct
const now = syncFlowNow
const flow = syncFlow

function dismiss() {
  dismissSyncFlow()
}
</script>

<style scoped>
.sp {
  position: fixed;
  top: calc(var(--safe-top, 0px) + 62px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 310; /* 高过设置抽屉(120)与事件面板(300)，低于确认框(320) */
  width: 344px;
  max-width: calc(100vw - 24px);
  padding: 14px 14px 12px;
  border-radius: 14px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--panel) 97%, transparent),
    color-mix(in srgb, var(--panel-deep) 97%, transparent)
  );
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line-strong));
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  -webkit-backdrop-filter: blur(22px) saturate(1.6);
  backdrop-filter: blur(22px) saturate(1.6);
  color: var(--text);
}

.sp.is-fail {
  border-color: color-mix(in srgb, var(--err) 45%, var(--line-strong));
}
.sp.is-done {
  border-color: color-mix(in srgb, var(--ok) 40%, var(--line-strong));
}

/* ---------- 头部 ---------- */
.sp-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.sp-ico {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--accent-text);
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
}
.is-fail .sp-ico {
  color: var(--err-text);
  background: color-mix(in srgb, var(--err) 16%, transparent);
  border-color: color-mix(in srgb, var(--err) 42%, transparent);
}
.is-done .sp-ico {
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok) 16%, transparent);
  border-color: color-mix(in srgb, var(--ok) 40%, transparent);
}

/* 转圈：只用一小段边框，避免整圈实心看着像"卡住" */
.ring {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-top-color: var(--accent);
  animation: sp-spin 0.8s linear infinite;
}
@keyframes sp-spin {
  to {
    transform: rotate(360deg);
  }
}

.sp-titles {
  flex: 1 1 auto;
  min-width: 0;
}
.sp-title {
  margin: 1px 0 2px;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text-bright);
}
.sp-sub {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-dim);
  word-break: break-word;
}

.sp-x {
  flex: none;
  height: 24px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-soft);
  background: var(--panel-2);
  border: 1px solid var(--line);
}
.sp-x:hover {
  color: var(--text-bright);
  border-color: var(--line-strong);
}

/* ---------- 进度条 ---------- */
.sp-bar {
  height: 4px;
  margin: 10px 0 9px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--text) 10%, transparent);
}
.sp-bar > i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 55%, var(--cyan)));
  transition: width 0.28s ease;
}
.is-fail .sp-bar > i {
  background: var(--err);
}
.is-done .sp-bar > i {
  background: var(--ok);
}

/* ---------- 步骤 ---------- */
.sp-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.sp-steps li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-dim);
}
.st-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text) 22%, transparent);
}
.st-label {
  flex: none;
}
.st-note {
  color: var(--text-dim-2);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 进行中：高亮 + 呼吸 */
.st-doing {
  color: var(--accent-text-strong);
}
.st-doing .st-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
  animation: sp-pulse 1s ease-in-out infinite;
}
@keyframes sp-pulse {
  50% {
    opacity: 0.45;
  }
}

.st-done {
  color: var(--text-soft);
}
.st-done .st-dot {
  background: var(--ok);
}

.st-fail {
  color: var(--err-text);
}
.st-fail .st-dot {
  background: var(--err);
}

.st-skip {
  color: var(--text-dim-2);
}
.st-skip .st-dot {
  background: color-mix(in srgb, var(--text) 16%, transparent);
}

/* ---------- 入场 / 出场 ---------- */
.sp-enter-active,
.sp-leave-active {
  transition: opacity 0.22s ease, transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.sp-enter-from,
.sp-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-10px) scale(0.98);
}

/* 手机：占满宽度，别顶到边 */
@media (max-width: 420px) {
  .sp {
    width: calc(100vw - 20px);
    top: calc(var(--safe-top, 0px) + 54px);
  }
}
</style>
