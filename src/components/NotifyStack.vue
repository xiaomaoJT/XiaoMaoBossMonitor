<template>
  <transition-group name="notify" tag="div" class="notify-stack">
    <article
      v-for="n in items"
      :key="n.key"
      class="notify"
      :class="n.type"
      @click="emit('focus', n)"
    >
      <div class="thumb" v-if="n.thumb" :style="{ backgroundImage: `url(${n.thumb})` }"></div>
      <div class="thumb blank" v-else>
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path
            v-if="n.type === 'offline' || n.type === 'online'"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M4 7.5A2 2 0 0 1 6 5.5h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM17 10.5l4-2.2v7.4l-4-2.2z"
          />
          <path
            v-else
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 12H2.5M21.5 12H19M12 5V2.5M12 21.5V19"
          />
        </svg>
      </div>

      <div class="body">
        <div class="row">
          <span class="tag" :class="n.type">{{ typeText(n.type) }}</span>
          <strong class="name" :title="n.name">{{ n.name }}</strong>
          <span class="time">{{ clock(n.time) }}</span>
        </div>
        <p class="desc">{{ n.text }}</p>
      </div>

      <button class="close" title="关闭" @click.stop="emit('dismiss', n.key)">
        <svg viewBox="0 0 24 24" width="13" height="13">
          <path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" d="M7 7l10 10M17 7L7 17" />
        </svg>
      </button>

      <!-- 存活进度条：10 秒走完 -->
      <span class="life" :style="{ animationDuration: `${life}ms` }"></span>
    </article>
  </transition-group>
</template>

<script setup>
defineProps({
  items: { type: Array, default: () => [] },
  /** 单条通知的存活时长（毫秒），用于画进度条 */
  life: { type: Number, default: 10000 }
})

const emit = defineEmits(['focus', 'dismiss'])

function typeText(type) {
  switch (type) {
    case 'person':
      return '人形'
    case 'motion':
      return '移动'
    case 'face':
      return '人脸'
    case 'enter':
      return '走入'
    case 'exit':
      return '走出'
    case 'loiter':
      return '徘徊'
    case 'pose':
      return '姿态'
    case 'count':
      return '计数'
    case 'offline':
      return '离线'
    case 'online':
      return '恢复'
    default:
      return '事件'
  }
}

function clock(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
</script>

<style scoped>
.notify-stack {
  position: fixed;
  left: 14px;
  top: calc(var(--topbar-h) + 12px);
  z-index: 210;
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 372px;
  max-width: calc(100vw - 28px);
  pointer-events: none;
}

.notify {
  position: relative;
  pointer-events: auto;
  display: flex;
  align-items: stretch;
  gap: 11px;
  padding: 11px 32px 13px 11px;
  border-radius: 12px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--panel) 98%, transparent), color-mix(in srgb, var(--panel) 98%, transparent));
  border: 1px solid var(--line);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.62);
  cursor: pointer;
  overflow: hidden;
  /* 左侧色条区分类型（中国习惯：人物/移动=红系，恢复正常=蓝） */
  border-left: 3px solid var(--warn);
  backdrop-filter: blur(6px);
}

.notify:hover {
  border-color: #33425c;
  background: linear-gradient(180deg, color-mix(in srgb, var(--panel-2) 98%, transparent), color-mix(in srgb, var(--panel) 98%, transparent));
  transform: translateY(-1px);
}

.notify:hover .thumb {
  border-color: #3a4a66;
}

.notify.person {
  border-left-color: var(--err);
}

.notify.motion {
  border-left-color: var(--warn);
}

/* 扩展分析事件：人脸 / 区域 / 徘徊 / 姿态 / 计数 */
.notify.face {
  border-left-color: var(--warn-text);
}

.notify.enter,
.notify.exit,
.notify.loiter {
  border-left-color: var(--cyan);
}

.notify.pose {
  border-left-color: #8c78ff;
}

.notify.count {
  border-left-color: #6b8299;
}

.notify.offline {
  border-left-color: var(--err);
}

.notify.online {
  border-left-color: var(--accent);
}

.thumb {
  width: 84px;
  height: 52px;
  flex: 0 0 auto;
  border-radius: 8px;
  background: var(--bg-deep) center/cover no-repeat;
  border: 1px solid var(--line-soft);
  overflow: hidden;
  transition: border-color 0.16s ease;
}

.thumb.blank {
  display: grid;
  place-items: center;
  color: var(--text-dim-2);
  background: var(--panel-deep);
}

.body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tag {
  flex: 0 0 auto;
  padding: 1.5px 7px;
  border-radius: 5px;
  font-size: 10.5px;
  line-height: 16px;
  color: color-mix(in srgb, var(--warn) 18%, var(--panel));
  background: color-mix(in srgb, var(--warn) 92%, transparent);
}

.tag.person,
.tag.offline {
  color: #fff;
  background: color-mix(in srgb, var(--err) 92%, transparent);
}

.tag.face {
  color: color-mix(in srgb, var(--warn) 22%, var(--panel));
  background: color-mix(in srgb, var(--warn-text) 94%, transparent);
}

.tag.enter,
.tag.exit,
.tag.loiter {
  color: color-mix(in srgb, var(--cyan) 18%, var(--panel));
  background: color-mix(in srgb, var(--cyan) 92%, transparent);
}

.tag.pose {
  color: #fff;
  background: color-mix(in srgb, var(--purple) 92%, transparent);
}

.tag.count {
  color: #fff;
  background: color-mix(in srgb, var(--text-dim) 92%, transparent);
}

.tag.motion {
  color: color-mix(in srgb, var(--warn) 18%, var(--panel));
  background: color-mix(in srgb, var(--warn) 92%, transparent);
}

.tag.online {
  color: color-mix(in srgb, var(--accent) 22%, var(--panel));
  background: color-mix(in srgb, var(--accent) 92%, transparent);
}

.name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
}

.desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: #9aabc5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close {
  position: absolute;
  right: 7px;
  top: 7px;
  display: grid;
  place-items: center;
  width: 21px;
  height: 21px;
  border-radius: 6px;
  color: #6c7c96;
}

.close:hover {
  color: #fff;
  background: color-mix(in srgb, var(--tint) 12%, transparent);
}

/* 存活进度条 */
.life {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  transform-origin: left center;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 85%, transparent), color-mix(in srgb, var(--accent) 25%, transparent));
  animation-name: life;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

.notify.person .life,
.notify.offline .life {
  background: linear-gradient(90deg, color-mix(in srgb, var(--err) 90%, transparent), color-mix(in srgb, var(--err) 25%, transparent));
}

.notify.motion .life {
  background: linear-gradient(90deg, color-mix(in srgb, var(--warn) 90%, transparent), color-mix(in srgb, var(--warn) 25%, transparent));
}

@keyframes life {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

.notify-enter-active {
  transition: all 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}

.notify-leave-active {
  transition: all 0.22s ease;
  position: absolute;
  width: 100%;
}

.notify-enter-from {
  opacity: 0;
  transform: translateX(-24px) scale(0.97);
}

.notify-leave-to {
  opacity: 0;
  transform: translateX(-18px);
}

.notify-move {
  transition: transform 0.24s ease;
}

/* 手机：通知占满可用宽度，缩略图略小，描述最多两行 */
@media (max-width: 560px) {
  .notify-stack {
    left: 10px;
    right: 10px;
    width: auto;
    gap: 8px;
  }

  .notify {
    padding: 10px 30px 12px 10px;
  }

  .thumb {
    width: 72px;
    height: 45px;
  }

  .desc {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}
</style>
