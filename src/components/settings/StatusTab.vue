<!-- Status 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>监控状态异常推送</h3>
      <span class="state-chip" :class="opts.statusAlerts.enabled ? 'ready' : ''">
        {{ opts.statusAlerts.enabled ? '已启用' : '未启用' }}
      </span>
    </div>
    <p class="hint">
      被勾选监听的通道如果拉流失败 / 长时间连不上（停止重试后），会立刻推送一条异常通知；恢复播放时也会通知。
      这里是总开关，下面还可以单独勾选每个渠道是否接收。
    </p>

    <label class="opt">
      <span>
        <strong>通道异常时推送</strong>
        <em>WebSocket 连接失败、拉流失败、解码失败、停止重试等</em>
      </span>
      <span class="switch" :class="{ on: opts.statusAlerts.enabled }" @click="opts.statusAlerts.enabled = !opts.statusAlerts.enabled"></span>
    </label>

    <label class="opt">
      <span>
        <strong>恢复时也通知</strong>
        <em>画面重新播放时推送一条恢复消息（含中断时长）</em>
      </span>
      <span class="switch" :class="{ on: opts.statusAlerts.notifyRecover }" @click="opts.statusAlerts.notifyRecover = !opts.statusAlerts.notifyRecover"></span>
    </label>

    <div class="opt">
      <span>
        <strong>重复提醒间隔</strong>
        <em>通道持续异常时每隔多久再提醒一次（0 = 只提醒一次）</em>
      </span>
      <div class="test-row">
        <input class="field mini" type="number" min="0" max="240" v-model.number="opts.statusAlerts.repeatMinutes" />
        <span class="unit">分钟</span>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>哪些渠道接收异常通知</strong>
        <em>勾掉的渠道不会收到这类通知（报警事件不受影响）</em>
      </span>
      <div class="check-row">
        <label class="check">
          <span class="switch" :class="{ on: dt.enabled }" @click="dt.enabled = !dt.enabled"></span> 钉钉
        </label>
        <label class="check">
          <span class="switch" :class="{ on: wc.statusAlerts.enabled }" @click="wc.statusAlerts.enabled = !wc.statusAlerts.enabled"></span> 企业微信
        </label>
        <label class="check">
          <span class="switch" :class="{ on: tg.statusAlerts.enabled }" @click="tg.statusAlerts.enabled = !tg.statusAlerts.enabled"></span> Telegram
        </label>
      </div>
    </div>
  </section>
  <section class="block">
    <div class="block-head">
      <h3>定时状态巡检</h3>
      <span class="state-chip" :class="opts.patrol.enabled ? 'ready' : ''">
        {{ opts.patrol.enabled ? `每 ${opts.patrol.intervalMinutes} 分钟` : '未启用' }}
      </span>
    </div>
    <p class="hint">
      定时把「所有监控当前状态」汇总成一条报告推送给你：哪些正常、哪些连不上，
      并逐通道展示移动检测 / 人形识别 / 盲视 / 推送这些功能开关的状态。
    </p>

    <label class="opt">
      <span>
        <strong>启用定时巡检</strong>
        <em>按下面的间隔自动推送状态报告</em>
      </span>
      <span class="switch" :class="{ on: opts.patrol.enabled }" @click="opts.patrol.enabled = !opts.patrol.enabled"></span>
    </label>

    <div class="opt">
      <span>
        <strong>巡检间隔</strong>
        <em>建议 10~30 分钟</em>
      </span>
      <div class="test-row">
        <input class="field mini" type="number" min="1" max="240" v-model.number="opts.patrol.intervalMinutes" />
        <span class="unit">分钟</span>
      </div>
    </div>

    <label class="opt">
      <span>
        <strong>仅在异常时推送</strong>
        <em>一切正常时不打扰你，只在有通道异常时发报告</em>
      </span>
      <span class="switch" :class="{ on: opts.patrol.onlyWhenAbnormal }" @click="opts.patrol.onlyWhenAbnormal = !opts.patrol.onlyWhenAbnormal"></span>
    </label>

    <label class="opt">
      <span>
        <strong>报告包含全部通道</strong>
        <em>关闭则只报告勾选监听的通道</em>
      </span>
      <span class="switch" :class="{ on: opts.patrol.includeAll }" @click="opts.patrol.includeAll = !opts.patrol.includeAll"></span>
    </label>

    <div class="opt col">
      <span>
        <strong>哪些渠道接收巡检报告</strong>
        <em>可以只让某一个渠道收，避免三个群都刷屏</em>
      </span>
      <div class="check-row">
        <label class="check">
          <span class="switch" :class="{ on: dt.patrol.enabled }" @click="dt.patrol.enabled = !dt.patrol.enabled"></span> 钉钉
        </label>
        <label class="check">
          <span class="switch" :class="{ on: wc.patrol.enabled }" @click="wc.patrol.enabled = !wc.patrol.enabled"></span> 企业微信
        </label>
        <label class="check">
          <span class="switch" :class="{ on: tg.patrol.enabled }" @click="tg.patrol.enabled = !tg.patrol.enabled"></span> Telegram
        </label>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>立即巡检一次</strong>
        <em>
          马上按当前状态生成并推送一份报告。
          <template v-if="opts.backend && opts.backend.enabled">
            后端检测开着 —— 这份报告由<b>服务端</b>生成并发送（那边才拿得到各通道解码状态）。
          </template>
        </em>
      </span>
      <button class="btn small primary" @click="emit('patrol')">立即推送巡检</button>
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { dt, emit, opts, props, tg, wc } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
