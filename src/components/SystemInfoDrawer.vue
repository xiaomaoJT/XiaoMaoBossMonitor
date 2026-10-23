<!--
  系统信息抽屉：把原「关于系统」页（设备/运行信息 + 数据统计）从设置抽屉里抽出来独立成抽屉，
  从顶栏「设置」下拉菜单进入。设置抽屉因此少一个 tab、更聚焦「可调的东西」。
  内容与样式与原 about 页一致：AboutSystem（只看不改的设备信息）+ StatsPanel（图表统计），
  外层 block/divider/block-head/hint/state-chip 由 settings.css（.sd-scope 作用域）提供。
-->
<template>
  <DrawerShell title="系统信息" subtitle="设备信息 · 数据统计" @close="emit('close')">
    <section class="block">
      <AboutSystem
        :cameras="cameras"
        :events="events"
        :options="options"
        :layout-key="layoutKey"
        :hidden-ids="hiddenIds"
      />

      <div class="divider"></div>

      <!-- ---------- 数据统计 ---------- -->
      <div class="block-head">
        <h3>数据统计</h3>
        <span class="state-chip">保留 7 天</span>
      </div>
      <p class="hint">
        按天独立计数，<b>不受「报警记录保留条数」限制</b> —— 事件列表被淘汰或清空后，
        这里的数字依然完整。图表与上方系统信息同属一页：先看设备有没有问题，再看它跑得怎么样。
      </p>
      <StatsPanel @reset-done="onStatsReset" />
    </section>
  </DrawerShell>
</template>

<script setup>
import DrawerShell from './DrawerShell.vue'
import AboutSystem from './AboutSystem.vue'
import StatsPanel from './StatsPanel.vue'
import { resetPushStats } from '../composables/usePushStats'

defineProps({
  cameras: { type: Array, default: () => [] },
  options: { type: Object, default: () => ({}) },
  hiddenIds: { type: Array, default: () => [] },
  layoutKey: { type: String, default: 'auto' },
  events: { type: Array, default: () => [] }
})
const emit = defineEmits(['close'])

/* 统计清零后，累计推送数也要一起清（与原 SettingsDrawer.onStatsReset 同口径，两处数字才对得上） */
function onStatsReset() {
  resetPushStats()
}
</script>
