<!-- Mask 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>隐私遮罩</h3>
      <span class="state-chip" :class="opts.mask.passwordHash ? 'ready' : ''">
        {{ opts.mask.passwordHash ? '已设密码' : '免密码' }}
      </span>
    </div>
    <p class="hint">
      点击顶部「遮罩」按钮或按 <b>M</b> 键，可一键把整个大屏盖住，避免旁人看到监控画面；报警推送与检测仍在后台运行。
    </p>

    <!--
      解锁密码：**只写不回显**。
      配置里存的是摘要，系统自己也反推不出原文，所以这里没有"显示已有密码"这回事 ——
      输入框永远从空白开始，填了就是"设一个新的"。
      改完按回车或点到别处即生效（@change），不用等「保存并应用」。
    -->
    <div class="opt col">
      <span>
        <strong>解锁密码</strong>
        <em>
          留空表示点击屏幕任意位置即可恢复。已设的密码不回显 —— 存的只是摘要，
          系统也读不出原文；想换就直接输新的，输入后按回车或点到别处即生效
        </em>
      </span>
      <div class="pw-wrap">
        <input
          class="field"
          :type="revealed.maskPwd ? 'text' : 'password'"
          v-model.trim="maskPwdNew"
          spellcheck="false"
          autocomplete="new-password"
          :placeholder="opts.mask.passwordHash ? '输入新密码以替换（留空 = 不改）' : '设置解锁密码（留空 = 免密码）'"
          @change="applyMaskPwd"
          @keyup.enter="applyMaskPwd"
        />
        <button type="button" class="pw-eye" :title="revealed.maskPwd ? '隐藏' : '显示'" @click="revealed.maskPwd = !revealed.maskPwd">{{ revealed.maskPwd ? '🙈' : '👁' }}</button>
      </div>
      <div class="test-row">
        <span class="test-state" :class="maskPwdState.kind" v-if="maskPwdState.text">{{ maskPwdState.text }}</span>
        <button class="btn small danger" v-if="opts.mask.passwordHash" @click="clearMaskPwd">清除密码（改为免密码）</button>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>无操作自动遮罩</strong>
        <em>多少分钟没有鼠标 / 键盘操作就自动盖住（0 = 关闭）</em>
      </span>
      <div class="test-row">
        <input class="field mini" type="number" min="0" max="240" v-model.number="opts.mask.autoMaskMinutes" />
        <span class="unit">分钟</span>
      </div>
    </div>

    <label class="opt">
      <span>
        <strong>遮罩时保持播放</strong>
        <em>关闭可节省资源，恢复时需要重新连接画面</em>
      </span>
      <span class="switch" :class="{ on: opts.mask.keepPlaying }" @click="opts.mask.keepPlaying = !opts.mask.keepPlaying"></span>
    </label>
        
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { applyMaskPwd, clearMaskPwd, emit, maskPwdNew, maskPwdState, opts, props, revealed } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
