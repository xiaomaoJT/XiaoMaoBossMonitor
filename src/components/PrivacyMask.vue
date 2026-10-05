<template>
  <transition name="mask">
    <div
      class="mask-root"
      v-if="open"
      ref="rootEl"
      tabindex="-1"
      @click="onSurface"
      @dblclick="onDouble"
    >
      <!-- 未进入输入密码状态：整屏遮罩 -->
      <div class="mask-inner" v-if="!asking">
        <div class="lock" :class="{ dim: !hintOn }">
          <svg viewBox="0 0 24 24" width="30" height="30">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M7 10.5V8a5 5 0 0 1 10 0v2.5M6 10.5h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 18 20.5H6A1.5 1.5 0 0 1 4.5 19v-7A1.5 1.5 0 0 1 6 10.5z"
            />
          </svg>
        </div>
        <!--
          文字只在两个时机出现：刚盖上（10 秒）和双击唤回。
          文案刻意写得含糊 —— 只说"锁着、双击继续"，不透露这是什么系统、锁的是什么，
          其余时间整屏只有一块暗底，旁人从屏幕上看不出任何东西。
        -->
        <transition name="hint">
          <div class="hint-box" v-if="hintOn">
            <p class="title">已锁定</p>
            <p class="sub">双击屏幕继续</p>
          </div>
        </transition>
      </div>

      <!-- 密码输入 -->
      <form class="ask" v-else @submit.prevent="submit" @click.stop @dblclick.stop>
        <p class="ask-title">请输入解锁密码</p>
        <input
          ref="pwdEl"
          class="field ask-input"
          type="password"
          v-model="pwd"
          maxlength="32"
          placeholder="解锁密码"
          autocomplete="off"
        />
        <p class="err" v-if="error">{{ error }}</p>
        <div class="ask-btns">
          <button type="button" class="btn small" @click="cancel">取消</button>
          <button type="submit" class="btn small primary">解锁</button>
        </div>
      </form>
    </div>
  </transition>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/** 提示文字显示多久后自动隐藏（毫秒） */
const HINT_MS = 10000

const props = defineProps({
  open: { type: Boolean, default: false },
  hasPassword: { type: Boolean, default: false },
  error: { type: String, default: '' },
  /** 数值 +1 表示外部请求弹出密码输入框（例如按下快捷键 M） */
  askSignal: { type: Number, default: 0 }
})

const emit = defineEmits(['unlock', 'masked-click'])

const rootEl = ref(null)
const pwdEl = ref(null)
const asking = ref(false)
const pwd = ref('')
/** 含糊提示是否可见：刚盖上显示 10 秒，之后必须双击才唤回 */
const hintOn = ref(false)
let hintTimer = null

/** 显示提示，并起一个 10 秒的自动隐藏倒计时 */
function armHint() {
  clearTimeout(hintTimer)
  hintOn.value = true
  hintTimer = setTimeout(() => {
    hintOn.value = false
    hintTimer = null
  }, HINT_MS)
}

/** 立刻收起提示（单击时用） */
function hideHint() {
  clearTimeout(hintTimer)
  hintTimer = null
  hintOn.value = false
}

/**
 * 单击：不做任何解锁动作。
 * 原因很直接 —— 旁人路过随手点一下就能弹出解锁界面，遮罩就形同虚设了。
 * 这里只负责把已经显示的提示收掉，不留下任何"该怎么进来"的线索。
 */
function onSurface() {
  if (asking.value) return
  if (hintOn.value) hideHint()
}

/**
 * 双击：唯一能唤起提示与解锁的入口。
 * 只认双击是有意的 —— 误触、随手划拉都不会把解锁界面带出来。
 */
function onDouble() {
  if (asking.value) return
  armHint()
  askUnlock()
}

function askUnlock() {
  if (props.hasPassword) {
    asking.value = true
    nextTick(() => pwdEl.value && pwdEl.value.focus())
  } else {
    emit('unlock', '')
  }
}

function submit() {
  emit('unlock', pwd.value)
}

function cancel() {
  asking.value = false
  pwd.value = ''
  // 取消后回到"提示再显示一会儿就收起"的静默态，别把文字一直挂在屏幕上
  armHint()
}

watch(
  () => props.open,
  (v) => {
    asking.value = false
    pwd.value = ''
    if (v) {
      armHint()
      nextTick(() => rootEl.value && rootEl.value.focus())
    } else {
      hideHint()
    }
  },
  { immediate: true }
)

watch(
  () => props.error,
  (v) => {
    if (v) {
      pwd.value = ''
      nextTick(() => pwdEl.value && pwdEl.value.focus())
    }
  }
)

watch(
  () => props.askSignal,
  () => {
    if (!props.open) return
    armHint()
    askUnlock()
  }
)

onBeforeUnmount(() => clearTimeout(hintTimer))
</script>

<style scoped>
.mask-root {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle at 50% 45%, #101823 0%, #05070a 65%, #000 100%);
  cursor: pointer;
  outline: none;
  user-select: none;
}

.mask-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  animation: fadeIn 0.35s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

.lock {
  width: 62px;
  height: 62px;
  border-radius: 18px;
  display: grid;
  place-items: center;
  color: #6f8bab;
  background: color-mix(in srgb, var(--tint) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--tint) 7%, transparent);
  transition: opacity 0.6s ease;
}

/* 提示收起后连图标也压暗：整屏只剩一块几乎纯黑的底 */
.lock.dim {
  opacity: 0.28;
}

.hint-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.title {
  margin: 6px 0 0;
  font-size: 17px;
  letter-spacing: 1px;
  color: #93a4bd;
}

.sub {
  margin: 0;
  font-size: 13px;
  color: #5f6d84;
}

/* 提示的进出：慢慢淡出，不要"啪"一下消失 */
.hint-enter-active,
.hint-leave-active {
  transition: opacity 0.7s ease;
}

.hint-enter-from,
.hint-leave-to {
  opacity: 0;
}

.ask {
  width: 300px;
  max-width: 86vw;
  padding: 20px;
  border-radius: 14px;
  background: rgba(16, 22, 32, 0.96);
  border: 1px solid var(--line);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
  cursor: default;
}

.ask-title {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--text-soft);
  text-align: center;
}

.ask-input {
  height: 38px;
  text-align: center;
  letter-spacing: 2px;
}

.err {
  margin: 8px 0 0;
  font-size: 12px;
  color: #ff8d99;
  text-align: center;
}

.ask-btns {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
}

.mask-enter-active,
.mask-leave-active {
  transition: opacity 0.28s ease;
}

.mask-enter-from,
.mask-leave-to {
  opacity: 0;
}
</style>
