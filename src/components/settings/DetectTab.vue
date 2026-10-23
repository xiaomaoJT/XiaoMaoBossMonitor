<!-- Detect 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>实时智能分析</h3>
      <span class="state-chip" :class="aiState">{{ aiStateText }}</span>
    </div>
    <p class="hint">
      移动检测为纯本地帧差算法（几乎不占资源，默认开启）；人形识别用 YOLO11 模型
      （已随项目下载到本地 /ai/，无需联网），推理在独立线程跑，不会拖慢界面。
      圈选检测区域请在画面上点「虚线框」按钮拖拽绘制。
    </p>

    <label class="opt">
      <span>
        <strong>开启实时分析</strong>
        <em>关闭后所有画面都不再做运动检测</em>
      </span>
      <span class="switch" :class="{ on: opts.analysisEnabled }" @click="opts.analysisEnabled = !opts.analysisEnabled"></span>
    </label>

    <div class="opt col">
      <span>
        <strong>灵敏度</strong>
        <em>数值越大越容易触发（建议 4~6）</em>
      </span>
      <div class="range-row">
        <input type="range" min="1" max="10" step="1" v-model.number="opts.sensitivity" />
        <b>{{ opts.sensitivity }}</b>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>变动档次</strong>
        <em>{{ motionLevelHint }}</em>
      </span>
      <SelectField cls="mini wide" v-model.number="opts.motionMinPercent" :options="OPT_MOTION_LEVEL" />
    </div>

    <div class="opt">
      <span>
        <strong>分析频率</strong>
        <em>{{ sampleFpsHint }}</em>
      </span>
      <SelectField cls="mini" v-model.number="opts.sampleFps" :options="OPT_SAMPLE_FPS" />
    </div>

    <div class="opt">
      <span>
        <strong>连续确认帧数</strong>
        <em>连续多少帧判定为移动才报警（抗噪）</em>
      </span>
      <SelectField cls="mini" v-model.number="opts.confirmFrames" :options="OPT_CONFIRM_FRAMES" />
    </div>

    <div class="opt">
      <span>
        <strong>报警间隔</strong>
        <em>同一画面两次报警的最小间隔（秒）</em>
      </span>
      <input class="field mini" type="number" min="3" max="120" v-model.number="opts.cooldownSec" />
    </div>

    <label class="opt">
      <span>
        <strong>报警声音提醒</strong>
        <em>触发时在浏览器里发出提示音</em>
      </span>
      <span class="switch" :class="{ on: opts.alarmSound }" @click="opts.alarmSound = !opts.alarmSound"></span>
    </label>

    <label class="opt">
      <span>
        <strong>常显检测区域</strong>
        <em>把圈选的区域框一直画在画面上</em>
      </span>
      <span class="switch" :class="{ on: opts.showRoi }" @click="opts.showRoi = !opts.showRoi"></span>
    </label>

    <label class="opt">
      <span>
        <strong>人形识别（AI）</strong>
        <em>模型已随项目下载到本地（/ai/），开启后即可识别人员，无需联网</em>
      </span>
      <span class="switch" :class="{ on: opts.aiEnabled }" @click="toggleAi"></span>
    </label>

    <div class="opt col" v-if="opts.aiEnabled">
      <span>
        <strong>识别模型</strong>
        <em>{{ modelDesc }}</em>
      </span>
      <SelectField cls="mini wide" v-model="opts.aiModel" :options="AI_MODELS_AS_OPTIONS" />
    </div>

    <div class="opt" v-if="opts.aiEnabled">
      <span>
        <strong>推理后端</strong>
        <em>{{ backendDesc }}</em>
      </span>
      <span class="state-chip" :class="aiState === 'ready' ? 'ready' : aiState">
        {{ backendText }}
      </span>
    </div>

    <label class="opt" v-if="opts.aiEnabled">
      <span>
        <strong>GPU 加速（WebGPU）</strong>
        <em>
          开着走显卡推理，几乎不占 CPU。个别 Windows 显卡 / 驱动组合会让它报
          <b>memory access out of bounds</b>（推理线程直接崩、人形框全没）——
          遇到这种就关掉，改用 CPU 推理，慢一点但稳定。
        </em>
      </span>
      <span class="switch" :class="{ on: opts.aiGpu }" @click="toggleAiGpu"></span>
    </label>

    <div class="opt col" v-if="opts.aiEnabled">
      <span>
        <strong>人形置信度阈值</strong>
        <em>越高越严格，误报更少但可能漏检</em>
      </span>
      <div class="range-row">
        <input type="range" min="0.3" max="0.9" step="0.05" v-model.number="opts.aiScore" />
        <b>{{ opts.aiScore.toFixed(2) }}</b>
      </div>
    </div>

    <div class="opt" v-if="opts.aiEnabled">
      <span>
        <strong>识别间隔</strong>
        <em>越大越省 CPU</em>
      </span>
      <SelectField cls="mini" v-model.number="opts.aiIntervalMs" :options="OPT_AI_INTERVAL" />
    </div>

    <!-- ---------- 推送信息（消息页脚：这一行会写进每条推送） ---------- -->
    <div class="sub-title">
      推送信息
      <em>每条消息都会带上这一行，方便分辨是哪个端发出来的</em>
    </div>
    <div class="opt">
      <span>
        <strong>运行设备</strong>
        <em>自动识别，无需配置</em>
      </span>
      <!--
        item 107：原来是原生 title 气泡 —— 延迟一秒、样式不可控、长文案
        会被挤成窄高的一竖条。改成跟随鼠标的浮层，并把完整设备信息摊成多行。
      -->
      <InfoTip multiline :text="runtimeTipText">
        <template #trigger>
          <span class="state-chip">{{ runtimeLine(BRAND) }}</span>
        </template>
      </InfoTip>
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { AI_MODELS_AS_OPTIONS, BRAND, InfoTip, OPT_AI_INTERVAL, OPT_CONFIRM_FRAMES, OPT_MOTION_LEVEL, OPT_SAMPLE_FPS, SelectField, aiModel, aiState, aiStateText, backendDesc, backendText, emit, modelDesc, motionLevelHint, opts, props, runtimeLine, runtimeTipText, sampleFpsHint, toggleAi, toggleAiGpu } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
