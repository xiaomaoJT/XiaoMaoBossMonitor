<!-- Play 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <h3>播放设置</h3>
    <!--
      ⚠️ 这里原本是「事件面板位置」的四角选择器（item 113 加的），已删除（item 117）：
      事件面板固定在右下角，不该跟着用户改来改去 ——
      它是常驻的历史查阅入口，位置固定才不会和拖动的画面抢地方。
      可配位置的是**左上角报警通知卡片**，已挪到「设置 → 外观 → 报警通知位置」。
    -->

    <label class="opt">
      <span>
        <strong>解码音频</strong>
        <em>枪机通常没有音轨，关闭可降低 CPU 占用</em>
      </span>
      <span class="switch" :class="{ on: opts.hasAudio }" @click="opts.hasAudio = !opts.hasAudio"></span>
    </label>
    <label class="opt">
      <span>
        <strong>优先硬件解码</strong>
        <em>仅 H.264 有效，H.265 会自动回退到 WASM 软解</em>
      </span>
      <span class="switch" :class="{ on: opts.useHardDecode }" @click="opts.useHardDecode = !opts.useHardDecode"></span>
    </label>
    <label class="opt">
      <span>
        <strong>显示码率 / 帧率</strong>
        <em>鼠标移到画面上时，在角落显示实时数据</em>
      </span>
      <span class="switch" :class="{ on: opts.showStats }" @click="opts.showStats = !opts.showStats"></span>
    </label>
    <label class="opt">
      <span>
        <strong>切后台时暂停画面</strong>
        <em>最小化 / 切走时停止拉流省电。⚠️ 检测和报警推送也会一并暂停，值守大屏慎开</em>
      </span>
      <span
        class="switch"
        :class="{ on: opts.pauseWhenHidden }"
        @click="opts.pauseWhenHidden = !opts.pauseWhenHidden"
      ></span>
    </label>
    <label class="opt">
      <span>
        <strong>屏幕常亮</strong>
        <em>
          长时间不动键鼠时不让系统自动息屏 —— 值守大屏建议开。
          <b class="wake-state" :class="wakeCls">{{ wakeLine }}</b>
        </em>
      </span>
      <span class="switch" :class="{ on: opts.keepAwake }" @click="toggleKeepAwake"></span>
    </label>

    <div class="opt">
      <span>
        <strong>打开时自动播放</strong>
        <em>不自动播放的话，每路都要点击画面才加载（最省资源）；选了精确路数后用右侧数字框自己填</em>
      </span>
      <div class="num-field">
        <SelectField cls="mini" :model-value="autoCountCustom ? 'custom' : opts.autoPlayCount" :options="OPT_AUTO_PLAY" @update:model-value="onAutoCountSelect" />
        <input
          v-if="autoCountCustom"
          class="field mini num"
          type="number"
          min="0"
          max="99"
          v-model.number="opts.autoPlayCount"
          title="自定义自动播放路数"
        />
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>同时解码路数上限</strong>
        <em>H.265 软解极吃 CPU，超限画面进入省流模式（0 = 不限制）</em>
      </span>
      <div class="num-field">
        <SelectField cls="mini" :model-value="maxDecodeCustom ? 'custom' : opts.maxDecode" :options="OPT_MAX_DECODE" @update:model-value="onMaxDecodeSelect" />
        <input
          v-if="maxDecodeCustom"
          class="field mini num"
          type="number"
          min="0"
          max="32"
          v-model.number="opts.maxDecode"
          title="自定义同时解码路数（0 = 不限制）"
        />
      </div>
    </div>

    <label class="opt">
      <span>
        <strong>点播时自动关闭其它画面</strong>
        <em>点击某一路播放时，自动停掉其它画面（最省资源，避免卡顿）</em>
      </span>
      <span
        class="switch"
        :class="{ on: opts.exclusivePlay }"
        @click="opts.exclusivePlay = !opts.exclusivePlay"
      ></span>
    </label>
    <label class="opt" v-if="opts.exclusivePlay">
      <span>
        <strong>互斥时保留监听通道</strong>
        <em>推荐开启，否则切到别的画面时，监听通道会停止检测与推送</em>
      </span>
      <span
        class="switch"
        :class="{ on: opts.keepWatchedOnPlay }"
        @click="opts.keepWatchedOnPlay = !opts.keepWatchedOnPlay"
      ></span>
    </label>

    <div class="block-head spaced">
      <h3>同时播放通道</h3>
      <span class="state-chip" :class="autoPlayIds.length ? 'ready' : ''">
        {{ autoPlayIds.length ? `已指定 ${autoPlayIds.length} 路` : '按前 N 路' }}
      </span>
    </div>
    <p class="hint">
      默认按上面「打开时自动播放」的路数，从第一路往后依次取。
      这里可以<b>手动指定哪几路同时播放</b>：勾选后打开页面就只播这几路，顺序就是播放优先级；
      仍然受「同时解码路数上限」约束，超过上限的会自动顺延到下次。
      <br />
      清空选择即恢复成「按前 N 路」的规则。
    </p>
    <div class="pick-grid">
      <button
        v-for="cam in cams"
        :key="cam.id"
        class="tag mini ch pick"
        :class="{ on: autoPlayIds.includes(cam.id) }"
        :disabled="hidden.includes(cam.id)"
        :title="hidden.includes(cam.id) ? '该画面当前是隐藏状态' : '点一下加入 / 移出同时播放'"
        @click="toggleAutoPlay(cam.id)"
      >
        <span class="pick-no">{{ autoPlayIds.includes(cam.id) ? autoPlayIds.indexOf(cam.id) + 1 : '·' }}</span>
        <span class="pick-name">{{ cam.name }}</span>
      </button>
    </div>
    <div class="pick-ops">
      <button class="btn small" @click="autoPlayIds = cams.slice(0, 4).map((c) => c.id)">前 4 路</button>
      <button class="btn small" @click="autoPlayIds = cams.filter((c) => !hidden.includes(c.id)).map((c) => c.id)">
        全部
      </button>
      <button class="btn small" :disabled="!autoPlayIds.length" @click="autoPlayIds = []">
        清空（改回按前 N 路）
      </button>
      <span class="cp-hint">共 {{ cams.length }} 路 · 已选 {{ autoPlayIds.length }} 路</span>
    </div>
        
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { OPT_AUTO_PLAY, OPT_MAX_DECODE, SelectField, autoCountCustom, autoPlayIds, cams, emit, hidden, maxDecodeCustom, onAutoCountSelect, onMaxDecodeSelect, opts, props, toggleAutoPlay, toggleKeepAwake, wakeCls, wakeLine } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
