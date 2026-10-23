<!-- Pose 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>人形姿态</h3>
      <span class="state-chip" :class="opts.pose.enabled ? 'ready' : ''">
        {{ opts.pose.enabled ? '已启用' : '未启用' }}
      </span>
    </div>
    <p class="hint">
      YOLOv8n-pose 17 关键点，每帧每人约 48ms（WebGPU）。无 WebGPU 的设备会回退 WASM，
      慢 5~10 倍，不建议开启。前提是「检测识别」页的<b>人形识别（AI）</b>已开启。
    </p>

    <label class="opt">
      <span>
        <strong>开启姿态分析</strong>
        <em>关掉时完全不加载姿态模型；无 WebGPU 的设备不建议开启</em>
      </span>
      <span class="switch" :class="{ on: opts.pose.enabled }" @click="opts.pose.enabled = !opts.pose.enabled"></span>
    </label>

    <template v-if="opts.pose.enabled">
      <div class="opt">
        <span>
          <strong>每帧最多分析几人</strong>
          <em>取画面里面积最大的几个（离镜头近的更清楚）</em>
        </span>
        <select class="field mini" v-model.number="opts.pose.maxPersons">
          <option :value="1">1 人</option>
          <option :value="2">2 人</option>
          <option :value="3">3 人</option>
          <option :value="4">4 人</option>
        </select>
      </div>

      <div class="opt col">
        <span>
          <strong>上报哪些动作</strong>
          <em>没勾的动作仍然会算，只是不产生事件（避免刷屏）</em>
        </span>
        <div class="cam-tags">
          <button
            class="tag"
            :class="{ on: opts.pose.actions.fall }"
            @click="opts.pose.actions.fall = !opts.pose.actions.fall"
          >
            疑似跌倒
          </button>
          <button
            class="tag"
            :class="{ on: opts.pose.actions.handUp }"
            @click="opts.pose.actions.handUp = !opts.pose.actions.handUp"
          >
            举手
          </button>
          <button
            class="tag"
            :class="{ on: opts.pose.actions.crouch }"
            @click="opts.pose.actions.crouch = !opts.pose.actions.crouch"
          >
            蹲下
          </button>
          <button
            class="tag"
            :class="{ on: opts.pose.actions.stand }"
            @click="opts.pose.actions.stand = !opts.pose.actions.stand"
          >
            站立
          </button>
        </div>
      </div>
    </template>

  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { emit, opts, props } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
