<!-- Appearance 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <!-- ---------- ① 画面布局 ---------- -->
    <div class="block-head">
      <h3>画面布局</h3>
      <span class="state-chip" :class="layoutKey === 'free' ? 'ready' : ''">
        {{ currentLayoutLabel }}
      </span>
    </div>
    <p class="hint">
      顶部工具栏只显示当前布局名称，切换布局都在这里。选一个预设网格，或切到「自定义摆放」后自己拖动、拉伸每一路画面（位置与大小会自动记住）。
    </p>

    <div class="layout-grid">
      <button
        v-for="l in layouts"
        :key="l.key"
        class="layout-item"
        :class="{ on: layoutKey === l.key }"
        @click="emit('update:layoutKey', l.key)"
      >
        <span class="layout-preview" :class="`pv-${l.key}`">
          <i v-for="k in previewCells(l.key)" :key="k"></i>
        </span>
        <span class="layout-label">{{ l.label }}</span>
      </button>
    </div>

    <template v-if="layoutKey === 'free'">
      <div class="toggle-tip">
        <strong>怎么调整？</strong>
        <em>
          ① 鼠标移到画面上，按住左上角 <b>十字手柄</b> 拖动可移动位置；<br />
          ② 按住右下角 <b>角标</b> 拖动可放大 / 缩小；<br />
          ③ 在画面上双击可临时放大查看，按 Esc 退出。
        </em>
      </div>
      <div class="opt">
        <span>
          <strong>重置摆放</strong>
          <em>把所有画面恢复成默认的整齐网格</em>
        </span>
        <button class="btn small" @click="resetFreeLayout">重置为网格</button>
      </div>
    </template>
    <p class="hint" v-else>
      提示：切到「自定义摆放」后，每一路画面都可以单独拖动和拉伸，适合主次分明的大屏。
    </p>

    <div class="divider"></div>

    <!-- ---------- ② 报警通知位置（item 117） ---------- -->
    <div class="block-head">
      <h3>报警通知位置</h3>
      <span class="state-chip" :class="opts.alert && opts.alert.topNotify !== false ? 'ready' : ''">
        {{ opts.alert && opts.alert.topNotify !== false ? '已开启' : '已关闭' }}
      </span>
    </div>
    <p class="hint">
      报警瞬间弹出的那张带缩略图的卡片停靠在哪个角。默认左上角 —— 顶栏下方不压画面。
      靠上的位置会自动让开顶栏。
    </p>

    <div class="opt">
      <span>
        <strong>显示报警通知卡片</strong>
        <em>关掉后报警只记入右下角事件面板与推送，不再弹卡片</em>
      </span>
      <span
        class="switch"
        :class="{ on: opts.alert && opts.alert.topNotify !== false }"
        @click="toggleTopNotify"
      ></span>
    </div>

    <div class="opt col" v-if="opts.alert && opts.alert.topNotify !== false">
      <span>
        <strong>停靠位置</strong>
        <em>报警卡片弹出的角落</em>
      </span>
      <div class="pos-picker">
        <button
          v-for="p in NOTIFY_POSITIONS"
          :key="p.key"
          class="pos-btn"
          :class="[p.key, { on: notifyPos === p.key }]"
          :title="p.label"
          @click="setNotifyPos(p.key)"
        >
          <span class="pos-dot"></span>
          <em>{{ p.label }}</em>
        </button>
      </div>
      <div class="opt-inline">
        <span class="muted">边距</span>
        <input
          class="field mini"
          type="number"
          min="0"
          max="80"
          v-model.number="notifyGap"
          @change="setNotifyGap(notifyGap)"
        />
        <span class="muted">px</span>
      </div>
    </div>

    <div class="toggle-tip">
      <strong>事件面板的位置是固定的</strong>
      <em>
        右下角那个可点开的报警记录列表始终在<b>右下角</b>，不随上面的设置变动 ——
        它是常驻的历史查阅入口，位置固定才不会和拖动的画面抢地方。
      </em>
    </div>

    <div class="divider"></div>

    <!-- ---------- ③ 界面主题 ---------- -->
    <div class="block-head">
      <h3>界面主题</h3>
    </div>
    <p class="hint">
      点击立即生效并自动保存。
      <template v-if="native">「自动」会跟随 iOS 系统的深色模式，在亮色 / 暗黑之间自动切换。</template>
      <template v-else>「自动」跟随系统仅在 iOS App 内提供。</template>
    </p>

    <div class="opt col">
      <span>
        <strong>界面主题</strong>
        <em>当前：{{ themeLabel }}</em>
      </span>
      <div class="theme-row">
        <button
          v-for="t in THEME_OPTIONS"
          :key="t.value"
          class="btn theme-btn"
          :class="{ primary: opts.theme === t.value }"
          :title="t.desc"
          @click="setTheme(t.value)"
        >
          <i class="swatch" :class="'sw-' + t.value"></i>
          {{ t.label }}
        </button>
      </div>
    </div>

    <p class="hint">
      「液态风格」是默认的玻璃质感界面，面板半透明、带毛玻璃与光晕；「暗黑风格」是去蓝调的中性纯黑，OLED 屏幕更省电；「亮色风格」适合白天 / 强光环境。
    </p>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { NOTIFY_POSITIONS, THEME_OPTIONS, currentLayoutLabel, emit, notifyGap, notifyPos, opts, previewCells, props, resetFreeLayout, setNotifyGap, setNotifyPos, setTheme, themeLabel, toggleTopNotify } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
