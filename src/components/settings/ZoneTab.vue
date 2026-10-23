<!-- Zone 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>区域规则</h3>
      <span class="state-chip" :class="zoneAnyOn ? 'ready' : ''">
        {{ zoneAnyOn ? '已启用' : '未启用' }}
      </span>
    </div>
    <p class="hint">
      零额外模型：靠人形轨迹判断，几乎不增加算力。前提是「检测识别」页的
      <b>人形识别（AI）</b> 已开启；圈选区域请在画面上点「虚线框」按钮拖拽绘制。
      实测单次推理耗时：人脸检测 19ms、人脸特征 39ms、姿态 48ms（都走 WebGPU），
      没有 WebGPU 的设备会回退 WASM、慢 5~10 倍 —— 那种情况建议只开本页。
    </p>

    <label class="opt">
      <span>
        <strong>走入区域</strong>
        <em>有人进入圈定区域时记一条事件</em>
      </span>
      <span class="switch" :class="{ on: opts.zone.enterAlarm }" @click="opts.zone.enterAlarm = !opts.zone.enterAlarm"></span>
    </label>

    <label class="opt">
      <span>
        <strong>走出区域</strong>
        <em>离开区域时记一条事件（默认关，避免门口反复进出刷屏）</em>
      </span>
      <span class="switch" :class="{ on: opts.zone.exitAlarm }" @click="opts.zone.exitAlarm = !opts.zone.exitAlarm"></span>
    </label>

    <label class="opt">
      <span>
        <strong>区域徘徊</strong>
        <em>在区域内长时间停留且没怎么移动时报警</em>
      </span>
      <span class="switch" :class="{ on: opts.zone.loiterAlarm }" @click="opts.zone.loiterAlarm = !opts.zone.loiterAlarm"></span>
    </label>

    <div class="opt" v-if="opts.zone.loiterAlarm">
      <span>
        <strong>徘徊判定时长</strong>
        <em>停留超过这么久才可能判定为徘徊</em>
      </span>
      <div class="test-row">
        <input class="field mini" type="number" min="5" max="600" v-model.number="opts.zone.loiterSec" />
        <span class="unit">秒</span>
      </div>
    </div>

    <div class="opt" v-if="opts.zone.loiterAlarm">
      <span>
        <strong>徘徊判定范围</strong>
        <em>这段时间内人的移动范围小于该值才算「原地徘徊」（占画面比例）</em>
      </span>
      <SelectField cls="mini" v-model.number="opts.zone.loiterRadius" :options="OPT_LOITER_RADIUS" />
    </div>

    <label class="opt">
      <span>
        <strong>人员计数</strong>
        <em>统计当前画面人数与累计经过人次</em>
      </span>
      <span class="switch" :class="{ on: opts.zone.countEnabled }" @click="opts.zone.countEnabled = !opts.zone.countEnabled"></span>
    </label>

    <div class="opt" v-if="opts.zone.countEnabled">
      <span>
        <strong>计数口径</strong>
        <em>画面里显示哪一种</em>
      </span>
      <select class="field mini" v-model="opts.zone.countMode">
        <option value="current">当前人数</option>
        <option value="total">累计经过人次</option>
        <option value="both">两者都显示</option>
      </select>
    </div>

    <label class="opt" v-if="opts.zone.countEnabled">
      <span>
        <strong>画面显示人数</strong>
        <em>在画面右上角常显统计结果</em>
      </span>
      <span class="switch" :class="{ on: opts.zone.showOnScreen }" @click="opts.zone.showOnScreen = !opts.zone.showOnScreen"></span>
    </label>

    <label class="opt" v-if="opts.zone.countEnabled">
      <span>
        <strong>定期推送人数</strong>
        <em>按下面的间隔往渠道推送一条统计（默认关，避免刷屏）</em>
      </span>
      <span class="switch" :class="{ on: opts.zone.countPush }" @click="opts.zone.countPush = !opts.zone.countPush"></span>
    </label>

    <div class="opt" v-if="opts.zone.countEnabled && opts.zone.countPush">
      <span>
        <strong>统计推送间隔</strong>
        <em>每隔多久推一条。这是「定时播报」不是报警 —— 间隔太密（旧版默认 60 秒）会把真正的报警淹没</em>
      </span>
      <select class="field mini" v-model.number="countIntervalPicked">
        <option v-for="o in countIntervalChoices" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>

    <div class="opt col">
      <span>
        <strong>已圈定区域（{{ zoneRows.length }}）</strong>
        <em>在画面上点「更多操作 → 进出 / 徘徊区域」，拖拽即可新增；这里可以改名和逐项开关</em>
      </span>
      <p class="hint tight">
        通道级「走入/走」总闸在各路画面的「更多操作 → 走入/走」里 —— 关掉它即整路不再捕获进出事件（这里的「进出」是逐区域细调）。
      </p>
      <div class="zone-list" v-if="zoneRows.length">
        <div class="zone-row" v-for="r in zoneRows" :key="r.camId + ':' + r.zone.id">
          <span class="zone-cam" :title="r.camName">{{ r.camName }}</span>
          <input
            class="field mini zone-name"
            :value="r.zone.name"
            @change="zoneUpdate(r.camId, r.zone.id, { name: $event.target.value })"
          />
          <button
            class="tag"
            :class="{ on: r.zone.enterExit !== false }"
            title="这一区域是否上报进出"
            @click="zoneUpdate(r.camId, r.zone.id, { enterExit: r.zone.enterExit === false })"
          >
            进出
          </button>
          <button
            class="tag"
            :class="{ on: r.zone.loiter !== false }"
            title="这一区域是否做徘徊检测"
            @click="zoneUpdate(r.camId, r.zone.id, { loiter: r.zone.loiter === false })"
          >
            徘徊
          </button>
          <button class="mini-btn danger" title="删除该区域" @click="zoneRemove(r.camId, r.zone.id)">删除</button>
        </div>
      </div>
      <p class="hint tight" v-else>还没有圈定任何区域。区域规则加上去之后，进入 / 离开 / 徘徊才会有事件。</p>
    </div>

        
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { OPT_LOITER_RADIUS, SelectField, countIntervalChoices, countIntervalPicked, emit, opts, props, zoneAnyOn, zoneRemove, zoneRows, zoneUpdate } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
