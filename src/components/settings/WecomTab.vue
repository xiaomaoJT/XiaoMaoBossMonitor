<!-- Wecom 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>企业微信推送</h3>
      <span class="state-chip" :class="wc.enabled && wc.webhook ? 'ready' : ''">
        {{ wc.enabled ? (wc.webhook ? '已启用' : '缺 Webhook') : '未启用' }}
      </span>
    </div>
    <p class="hint">
      企业微信群机器人支持 <b>image</b> 消息直接收 base64 + md5，所以<b>报警截图可以直接发进群里，不需要任何图床</b>。
      可以和钉钉 / Telegram 同时开启，事件会同时推到三个渠道。
      <br />
      开启后会一并启用 TG：消息末尾附上 <b>Telegram 那条消息的链接</b>，
      点开就能看到未压缩的原图。
    </p>

    <label class="opt">
      <span>
        <strong>启用企业微信推送</strong>
        <em>关闭后报警只走其它渠道</em>
      </span>
      <span
        class="switch"
        :class="{ on: wc.enabled }"
        @click="toggleChannel('wecom', !wc.enabled)"
      ></span>
    </label>

    <div class="opt col">
      <span>
        <strong>推送哪些事件</strong>
        <em>勾选需要推送到企业微信的报警类型</em>
      </span>
      <div class="cam-tags">
        <button
          v-for="g in EVENT_GROUPS"
          :key="g.key"
          class="tag"
          :class="{ on: evOn(opts.wecom, g.key) }"
          :title="g.desc"
          @click="toggleEvent('wecom', g.key)"
        >
          {{ g.label }}
        </button>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>群机器人 Webhook</strong>
        <em>群设置 → 群机器人 → 添加 → 复制 Webhook 地址；只粘贴 key 那一串也可以</em>
      </span>
      <div class="pw-wrap">
        <input
          class="field"
          :type="revealed.wcWebhook ? 'text' : 'password'"
          v-model.trim="wc.webhook"
          spellcheck="false"
          autocomplete="off"
          placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx"
        />
        <button type="button" class="pw-eye" :title="revealed.wcWebhook ? '隐藏' : '显示'" @click="revealed.wcWebhook = !revealed.wcWebhook">{{ revealed.wcWebhook ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>附带报警截图</strong>
        <em>{{ wcShotHint }}</em>
      </span>
      <select class="field mini" v-model="wc.screenshotMode">
        <option value="image">直接发一张图片（推荐）</option>
        <option value="tg">附 Telegram 原图链接</option>
        <option value="litterbox">上传图床后附链接</option>
        <option value="none">不附带</option>
      </select>
    </div>

    <template v-if="wc.screenshotMode === 'tg' || wc.screenshotMode === 'litterbox'">
      <p class="hint">
        企业微信的 markdown 不支持图片语法，所以这里只能在文字消息里放一条
        「点击查看截图」的链接。
        <template v-if="wc.screenshotMode === 'tg'">
          链接指向 Telegram 里那条报警消息，点开就能看原图。
        </template>
        <template v-else>
          链接由 litterbox 图床上传后返回（国内可直连，最长 72 小时有效）。
        </template>
      </p>
      <div class="opt" v-if="wc.screenshotMode === 'litterbox'">
        <span>
          <strong>图片保留时长</strong>
          <em>过期后链接里的图片会失效</em>
        </span>
        <select class="field mini" v-model="wc.imageHostTtl">
          <option value="1h">1 小时</option>
          <option value="12h">12 小时</option>
          <option value="24h">24 小时</option>
          <option value="72h">72 小时（最长）</option>
        </select>
      </div>
    </template>

    <div class="opt col">
      <span>
        <strong>消息样式</strong>
        <em>markdown 支持标题 / 加粗 / 引用，排版更好看</em>
      </span>
      <div class="seg-row">
        <button class="btn small" :class="{ primary: wc.msgType === 'markdown' }" @click="wc.msgType = 'markdown'">markdown</button>
        <button class="btn small" :class="{ primary: wc.msgType === 'text' }" @click="wc.msgType = 'text'">纯文本</button>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>消息标题前缀</strong>
        <em>也可兼作企业微信机器人的关键词过滤规则</em>
      </span>
      <input class="field mini" v-model.trim="wc.titlePrefix" placeholder="【监控报警】" />
    </div>

    <label class="opt">
      <span>
        <strong>@所有人</strong>
        <em>仅纯文本消息支持（markdown 消息不支持 @）</em>
      </span>
      <span class="switch" :class="{ on: wc.atAll }" @click="wc.atAll = !wc.atAll"></span>
    </label>

    <div class="opt col">
      <span>
        <strong>@指定成员</strong>
        <em>手机号，多个用英文逗号分隔（仅纯文本消息支持）</em>
      </span>
      <input class="field" v-model.trim="wc.atMobiles" placeholder="13800000000,13900000000" />
    </div>

    <div class="opt col">
      <span>
        <strong>代理地址（一般不用填）</strong>
        <em>桌面端 / 浏览器已内置代理；iOS 端走原生网络栈直连</em>
      </span>
      <input class="field" v-model.trim="wc.proxyBase" placeholder="留空 = 自动判断" />
    </div>

    <div class="opt">
      <span>
        <strong>连通性测试</strong>
        <em>{{ wcState.text || '向这个群机器人发一条测试消息' }}</em>
      </span>
      <div class="test-row">
        <button class="btn small" :disabled="wcState.kind === 'loading'" @click="checkWecom">检查配置</button>
        <button class="btn small primary" :disabled="wcState.kind === 'loading'" @click="testWecom">
          {{ wcState.kind === 'loading' ? '发送中…' : '发送测试' }}
        </button>
      </div>
    </div>

    <!-- ==================== 关键事件独立推送（单独机器人） ==================== -->
    <div class="block-head sub">
      <h3>关键事件独立推送（单独机器人）</h3>
      <span class="state-chip" :class="wc.critical && wc.critical.enabled ? 'ready' : ''">
        {{ wc.critical && wc.critical.enabled ? '已启用' : '未启用' }}
      </span>
    </div>
    <p class="hint">
      把「静默结束 / 静默汇总 / 人脸命中 / 待录入满库」这几类<b>关键事件</b>，单独打到
      <b>另一个企业微信机器人</b>上。它和上面的日常推送是<b>两个完全独立的机器人</b>。
      <br />
      企业微信机器人没有独立的「加签密钥」——它的<b>加密密钥就是 Webhook 地址里 key= 那一串</b>，
      所以这里只要再粘一个<b>不同的 Webhook</b>（指向另一个机器人 / 另一个群）即可。
      <br />
      这几类关键事件<b>同时也仍会走上面的日常推送</b>；这里只是"再单独发一份到另一个群"。
    </p>

    <label class="opt">
      <span>
        <strong>启用关键事件独立推送</strong>
        <em>关闭则关键事件只走上面的日常推送</em>
      </span>
      <span
        class="switch"
        :class="{ on: wc.critical && wc.critical.enabled }"
        @click="wc.critical.enabled = !(wc.critical && wc.critical.enabled)"
      ></span>
    </label>

    <div class="opt col">
      <span>
        <strong>关键事件机器人 Webhook</strong>
        <em>必须与上面的日常推送 Webhook <b>不同</b>；只粘贴 key 那一串也可以</em>
      </span>
      <div class="pw-wrap">
        <input
          class="field"
          :type="revealed.wcCritWebhook ? 'text' : 'password'"
          v-model.trim="wc.critical.webhook"
          spellcheck="false"
          autocomplete="off"
          placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx"
        />
        <button type="button" class="pw-eye" :title="revealed.wcCritWebhook ? '隐藏' : '显示'" @click="revealed.wcCritWebhook = !revealed.wcCritWebhook">{{ revealed.wcCritWebhook ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>推送哪几类关键事件</strong>
        <em>缺省即开：不勾的类别不会单独推到这个机器人</em>
      </span>
      <div class="cam-tags">
        <button
          v-for="g in CRIT_EVENTS"
          :key="g.key"
          class="tag"
          :class="{ on: critOn('wecom', g.key) }"
          :title="g.desc"
          @click="toggleCritEvent('wecom', g.key)"
        >
          {{ g.label }}
        </button>
      </div>
    </div>

    <!-- 「静默时段也允许推送」语义与钉钉那处完全一致 -->
    <label class="opt">
      <span>
        <strong>静默时段也允许推送</strong>
        <em>关闭后：处于免打扰 / 通道静默时，上面勾选的这几类事件也不单独推</em>
      </span>
      <span
        class="switch"
        :class="{ on: critThroughSilence('wecom') }"
        @click="toggleCritThroughSilence('wecom')"
      ></span>
    </label>

    <!-- 「结算汇总只走关键事件」语义与钉钉那处完全一致 -->
    <label class="opt">
      <span>
        <strong>结算汇总只走关键事件</strong>
        <em>打开后：免打扰结束的结算汇总不再走日常推送，只由这个关键事件机器人发（没配好时日常推送仍兜底）</em>
      </span>
      <span
        class="switch"
        :class="{ on: critSummaryOnly('wecom') }"
        @click="toggleCritSummaryOnly('wecom')"
      ></span>
    </label>

    <div class="opt col">
      <span>
        <strong>消息样式</strong>
        <em>markdown 排版更好看；需要 @ 时会自动改用纯文本（markdown 不支持 @）</em>
      </span>
      <div class="seg-row">
        <button class="btn small" :class="{ primary: wc.critical && wc.critical.msgType === 'markdown' }" @click="wc.critical.msgType = 'markdown'">markdown</button>
        <button class="btn small" :class="{ primary: wc.critical && wc.critical.msgType === 'text' }" @click="wc.critical.msgType = 'text'">纯文本</button>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>消息标题前缀</strong>
        <em>也可兼作该机器人的关键词过滤规则</em>
      </span>
      <input class="field mini" v-model.trim="wc.critical.titlePrefix" placeholder="【监控报警】" />
    </div>

    <div class="opt">
      <span>
        <strong>附带事件截图</strong>
        <em>关键事件机器人独立于 TG；image 模式可直接发图，无需图床</em>
      </span>
      <select class="field mini" v-model="wc.critical.screenshotMode">
        <option value="image">直接发一张图片（推荐）</option>
        <option value="litterbox">上传图床后附链接</option>
        <option value="none">都不带（仅文字）</option>
      </select>
    </div>

    <label class="opt">
      <span>
        <strong>@所有人</strong>
        <em>关键事件推送时 @ 群内所有人（会自动改用纯文本消息）</em>
      </span>
      <span class="switch" :class="{ on: wc.critical && wc.critical.atAll }" @click="wc.critical.atAll = !(wc.critical && wc.critical.atAll)"></span>
    </label>

    <div class="opt col">
      <span>
        <strong>@指定成员</strong>
        <em>手机号，多个用英文逗号分隔（会自动改用纯文本消息）</em>
      </span>
      <input class="field" v-model.trim="wc.critical.atMobiles" placeholder="13800000000,13900000000" />
    </div>

    <div class="opt">
      <span>
        <strong>连通性测试</strong>
        <em>{{ wcCritState.text || '向这个关键事件机器人发一条测试消息' }}</em>
      </span>
      <div class="test-row">
        <button class="btn small primary" :disabled="wcCritState.kind === 'loading'" @click="testWecomCritical">
          {{ wcCritState.kind === 'loading' ? '发送中…' : '发送测试' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { CRIT_EVENTS, EVENT_GROUPS, checkWecom, critOn, critSummaryOnly, critThroughSilence, emit, evOn, opts, props, revealed, testWecom, testWecomCritical, tg, toggleChannel, toggleCritEvent, toggleCritSummaryOnly, toggleCritThroughSilence, toggleEvent, wc, wcCritState, wcShotHint, wcState } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
