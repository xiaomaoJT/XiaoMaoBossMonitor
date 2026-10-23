<!-- Dingtalk 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>钉钉报警推送</h3>
      <span class="state-chip" :class="opts.dingtalk.enabled ? 'ready' : ''">
        {{ opts.dingtalk.enabled ? '已启用' : '未启用' }}
      </span>
    </div>
    <p class="hint">
      报警时通过钉钉群机器人推送消息（支持「加签」）。钉钉接口不带跨域响应头，默认经本地代理转发；
      生产部署请在 Nginx 等反向代理上做同样的转发，或改用后端中转。
      <br />
      <b>注意</b>：本页的「监听通道 / 推送事件 / 频率限制 / 静默时段 / 推送内容」只作用于钉钉，
      另外两个渠道在各自的标签页里独立配置。
      <br />
      钉钉的 markdown 图片必须是公网可访问的 http 地址，所以消息里的原图统一指向
      <b>Telegram 那条消息</b>——因此启用钉钉时会自动一起启用 TG。
    </p>

    <label class="opt">
      <span>
        <strong>启用钉钉推送</strong>
        <em>关闭后只在本页面报警，不发送消息</em>
      </span>
      <span
        class="switch"
        :class="{ on: opts.dingtalk.enabled }"
        @click="toggleChannel('dingtalk', !opts.dingtalk.enabled)"
      ></span>
    </label>

    <div class="opt col">
      <span>
        <strong>Webhook 地址</strong>
        <em>群机器人 → 自定义机器人 → Webhook 地址</em>
      </span>
      <div class="pw-wrap">
        <input class="field" :type="revealed.dtWebhook ? 'text' : 'password'" v-model.trim="opts.dingtalk.webhook" spellcheck="false" autocomplete="off" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
        <button type="button" class="pw-eye" :title="revealed.dtWebhook ? '隐藏' : '显示'" @click="revealed.dtWebhook = !revealed.dtWebhook">{{ revealed.dtWebhook ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>加签密钥</strong>
        <em>安全设置选择「加签」时填写，留空则不加签（需用关键词或 IP 白名单）</em>
      </span>
      <div class="pw-wrap">
        <input class="field" :type="revealed.dtSecret ? 'text' : 'password'" v-model.trim="opts.dingtalk.secret" spellcheck="false" autocomplete="off" placeholder="SECxxxxxxxx" />
        <button type="button" class="pw-eye" :title="revealed.dtSecret ? '隐藏' : '显示'" @click="revealed.dtSecret = !revealed.dtSecret">{{ revealed.dtSecret ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <label class="opt">
      <span>
        <strong>使用本地代理</strong>
        <em>通过 /dingtalk-robot 转发，避免浏览器跨域拦截（推荐开启）</em>
      </span>
      <span class="switch" :class="{ on: opts.dingtalk.useProxy }" @click="opts.dingtalk.useProxy = !opts.dingtalk.useProxy"></span>
    </label>

    <div class="opt" v-if="opts.dingtalk.useProxy">
      <span>
        <strong>代理地址</strong>
        <em>留空 = 用当前页面的同源前缀，后端服务（8787）已内置转发，正常不用填；Electron 桌面端这种 file:// 打开的填 http://127.0.0.1:8787</em>
      </span>
      <input class="field" v-model.trim="opts.dingtalk.proxyBase" spellcheck="false" placeholder="留空 = 同源" />
    </div>

    <div class="opt col">
      <span>
        <strong>推送哪些事件</strong>
        <em>勾选需要推送的报警类型（AI 扩展事件需要先在「实时智能分析」里开启对应功能）</em>
      </span>
      <div class="cam-tags">
        <button
          v-for="g in EVENT_GROUPS"
          :key="g.key"
          class="tag"
          :class="{ on: evOn(opts.dingtalk, g.key) }"
          :title="g.desc"
          @click="toggleEvent('dingtalk', g.key)"
        >
          {{ g.label }}
        </button>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>移动幅度门槛</strong>
        <em>画面变动幅度低于该值不推送（0 = 不限制，可减少误报）</em>
      </span>
      <div class="test-row">
        <input class="field mini" type="number" min="0" max="100" step="0.5" v-model.number="dt.minRatioPercent" />
        <span class="unit">%</span>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>推送内容（可自定义勾选）</strong>
        <em>勾选要出现在钉钉消息里的信息</em>
      </span>
      <div class="cam-tags">
        <button
          v-for="key in FIELD_KEYS"
          :key="key"
          class="tag"
          :class="{ on: dt.fields[key] }"
          @click="dt.fields[key] = !dt.fields[key]"
        >
          {{ fieldLabel(key) }}
        </button>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>消息格式</strong>
        <em>markdown 支持标题与图片；text 为纯文本</em>
      </span>
      <select class="field mini" v-model="dt.msgType">
        <option value="markdown">markdown</option>
        <option value="text">纯文本</option>
      </select>
    </div>

    <div class="opt col">
      <span>
        <strong>消息标题前缀</strong>
        <em>建议保留，同时可作为钉钉机器人的「自定义关键词」</em>
      </span>
      <input class="field" v-model.trim="dt.titlePrefix" spellcheck="false" placeholder="【监控报警】" />
    </div>

    <div class="opt">
      <span>
        <strong>附带事件原图</strong>
        <em>{{ dingShotHint }}</em>
      </span>
      <select class="field mini" v-model="dt.screenshotMode">
        <option value="tg">只带 Telegram 原图链接（推荐）</option>
        <option value="litterbox">上传图床后直接嵌图</option>
        <option value="upload">自建上传接口嵌图</option>
        <option value="none">都不带（仅本地留档）</option>
      </select>
    </div>

    <p class="hint" v-if="dt.screenshotMode === 'tg'">
      钉钉消息里不放图片，末尾固定附一条「点击查看事件原图」的链接，
      点开直接跳到 Telegram 里那条报警看原图——不需要图床、也不重复上传。
      <br />本次没推 Telegram 时，会退而给出群链接，照样能点进去看。
    </p>

    <template v-if="dt.screenshotMode === 'litterbox'">
      <p class="hint">
        把截图上传到 litterbox.catbox.moe（免费、无需注册、国内可直连）后，
        把返回的图片地址嵌进钉钉消息。上传在本机完成，一次报警只上传一张。
      </p>
      <div class="opt">
        <span>
          <strong>图片保留时长</strong>
          <em>过期后钉钉里的图片会失效（消息文字仍在），建议选最长</em>
        </span>
        <select class="field mini" v-model="dt.imageHostTtl">
          <option value="1h">1 小时</option>
          <option value="12h">12 小时</option>
          <option value="24h">24 小时</option>
          <option value="72h">72 小时（最长）</option>
        </select>
      </div>
    </template>
    <template v-if="dt.screenshotMode === 'upload'">
      <div class="opt col">
        <span>
          <strong>截图上传接口</strong>
          <em>POST multipart/form-data，需在响应中返回图片 URL（支持 {url} / {data:{url}} / {data} 等格式）</em>
        </span>
        <input class="field" v-model.trim="dt.uploadUrl" spellcheck="false" placeholder="https://your-upload-api.example.com/upload" />
      </div>
      <div class="opt col">
        <span>
          <strong>上传字段名</strong>
          <em>默认 file</em>
        </span>
        <input class="field" v-model.trim="dt.uploadField" spellcheck="false" placeholder="file" />
      </div>
    </template>

    <div class="opt col">
      <span>
        <strong>需要推送的监控</strong>
        <em>
          和「监控通道」页里每一路的「推送 / 钉钉」小勾是<b>同一份设置</b>，改哪边都一样
          （这里增删会自动写回那一路的通道级开关）。
          「监控通道」里开了推送的每一路，检测到之后都会推送出来。
        </em>
      </span>
      <div class="cam-tags">
        <button
          v-for="cam in cams"
          :key="cam.id"
          class="tag"
          :class="{ on: camPushOn(cam, 'ding') }"
          @click="togglePushCamera(cam.id)"
        >
          {{ cam.name || '未命名' }}
        </button>
        <button class="tag ghost" @click="setAllPushCameras(true)">全选</button>
        <button class="tag ghost" @click="setAllPushCameras(false)">清空</button>
        <span class="tag-text" v-if="!pushCamCount">没有通道会推送到钉钉</span>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>单通道推送间隔</strong>
        <em>同一通道两次推送之间的最小间隔（秒）</em>
      </span>
      <input class="field mini" type="number" min="3" max="600" v-model.number="dt.minIntervalSec" />
    </div>

    <div class="opt">
      <span>
        <strong>全局推送间隔</strong>
        <em>任意两批推送之间的最小间隔（秒）</em>
      </span>
      <input class="field mini" type="number" min="0" max="600" v-model.number="dt.globalMinIntervalSec" />
    </div>

    <div class="opt">
      <span>
        <strong>每分钟推送上限</strong>
        <em>钉钉自定义机器人硬限制 20 条/分钟，建议留余量</em>
      </span>
      <div class="test-row">
        <input class="field mini" type="number" min="1" max="20" v-model.number="dt.rateLimitPerMin" />
        <span class="unit">条/分钟</span>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>超出上限时</strong>
        <em>合并推送会攒成一条汇总消息，不会丢事件</em>
      </span>
      <div class="cam-tags">
        <button class="tag" :class="{ on: dt.overflowMode === 'merge' }" @click="dt.overflowMode = 'merge'">
          合并成一条汇总
        </button>
        <button class="tag" :class="{ on: dt.overflowMode === 'drop' }" @click="dt.overflowMode = 'drop'">
          直接丢弃
        </button>
      </div>
    </div>

    <label class="opt">
      <span>
        <strong>静默时段不推送</strong>
        <em>例如夜间只记录不打扰；支持跨零点时段</em>
      </span>
      <span class="switch" :class="{ on: dt.quietEnabled }" @click="dt.quietEnabled = !dt.quietEnabled"></span>
    </label>

    <div class="opt" v-if="dt.quietEnabled">
      <span>
        <strong>静默时段</strong>
        <em>该时间段内只本地报警</em>
      </span>
      <div class="test-row">
        <input class="field mini" type="time" v-model="dt.quietStart" @mousedown="openPicker" />
        <span class="unit">至</span>
        <input class="field mini" type="time" v-model="dt.quietEnd" @mousedown="openPicker" />
      </div>
    </div>

    <label class="opt">
      <span>
        <strong>@ 所有人</strong>
        <em>推送时 @ 群内所有人</em>
      </span>
      <span class="switch" :class="{ on: dt.atAll }" @click="dt.atAll = !dt.atAll"></span>
    </label>

    <div class="opt col">
      <span>
        <strong>@ 指定手机号</strong>
        <em>多个用英文逗号分隔，留空表示不 @ 指定人</em>
      </span>
      <input class="field" v-model.trim="dt.atMobiles" spellcheck="false" placeholder="13800000000,13900000000" />
    </div>

    <div class="opt">
      <span>
        <strong>连通性测试</strong>
        <em>按当前勾选的字段发送一条示例消息</em>
      </span>
      <div class="test-row">
        <span class="test-state" :class="testState.kind" v-if="testState.text">{{ testState.text }}</span>
        <button class="btn small primary" :disabled="testState.kind === 'loading'" @click="testPush">
          {{ testState.kind === 'loading' ? '发送中…' : '发送测试' }}
        </button>
      </div>
    </div>

    <!-- ==================== 关键事件独立推送（单独机器人） ==================== -->
    <div class="block-head sub">
      <h3>关键事件独立推送（单独机器人）</h3>
      <span class="state-chip" :class="dt.critical && dt.critical.enabled ? 'ready' : ''">
        {{ dt.critical && dt.critical.enabled ? '已启用' : '未启用' }}
      </span>
    </div>
    <p class="hint">
      把「静默结束 / 静默汇总 / 人脸命中 / 待录入满库」这几类<b>关键事件</b>，单独打到
      <b>另一个钉钉机器人</b>上。它和上面的日常推送是<b>两个完全独立的机器人</b>：
      这里要另配一个 Webhook 和加签密钥 —— 日常群被刷屏、或者夜间静默时，关键事件照样收得到。
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
        :class="{ on: dt.critical && dt.critical.enabled }"
        @click="dt.critical.enabled = !(dt.critical && dt.critical.enabled)"
      ></span>
    </label>

    <div class="opt col">
      <span>
        <strong>关键事件机器人 Webhook</strong>
        <em>必须与上面的日常推送 Webhook <b>不同</b>（另一个机器人 / 另一个群）</em>
      </span>
      <div class="pw-wrap">
        <input class="field" :type="revealed.dtCritWebhook ? 'text' : 'password'" v-model.trim="dt.critical.webhook" spellcheck="false" autocomplete="off" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." />
        <button type="button" class="pw-eye" :title="revealed.dtCritWebhook ? '隐藏' : '显示'" @click="revealed.dtCritWebhook = !revealed.dtCritWebhook">{{ revealed.dtCritWebhook ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>加签密钥</strong>
        <em>关键事件机器人的加签密钥，与日常推送 <b>互不相同</b>（留空=用关键词 / IP 白名单）</em>
      </span>
      <div class="pw-wrap">
        <input class="field" :type="revealed.dtCritSecret ? 'text' : 'password'" v-model.trim="dt.critical.secret" spellcheck="false" autocomplete="off" placeholder="SECxxxxxxxx" />
        <button type="button" class="pw-eye" :title="revealed.dtCritSecret ? '隐藏' : '显示'" @click="revealed.dtCritSecret = !revealed.dtCritSecret">{{ revealed.dtCritSecret ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <label class="opt">
      <span>
        <strong>使用本地代理</strong>
        <em>与日常推送同理，经 /dingtalk-robot 转发，避免跨域</em>
      </span>
      <span class="switch" :class="{ on: dt.critical && dt.critical.useProxy }" @click="dt.critical.useProxy = !(dt.critical && dt.critical.useProxy)"></span>
    </label>

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
          :class="{ on: critOn('dingtalk', g.key) }"
          :title="g.desc"
          @click="toggleCritEvent('dingtalk', g.key)"
        >
          {{ g.label }}
        </button>
      </div>
    </div>

    <!--
      「静默时段也允许推送」—— 这几类关键事件在免打扰 / 通道静默期间要不要照推。
      缺省为开：老版本这几类是**硬编码放行**的，默认必须保持原行为，
      否则升级用户的收件习惯会突然变。
    -->
    <label class="opt">
      <span>
        <strong>静默时段也允许推送</strong>
        <em>关闭后：处于免打扰 / 通道静默时，上面勾选的这几类事件也不单独推</em>
      </span>
      <span
        class="switch"
        :class="{ on: critThroughSilence('dingtalk') }"
        @click="toggleCritThroughSilence('dingtalk')"
      ></span>
    </label>

    <!--
      「结算汇总只走关键事件」—— 免打扰结束后，日常推送和这个关键事件机器人
      会各推一条**内容相同**的结算汇总。缺省关 = 两条都发（老行为）；打开后
      日常推送不再发，只由这个机器人单独发（"免打扰已结束"短提醒内容不同，
      仍照发）。这个机器人没配好时，日常推送仍会兜底发这条。
    -->
    <label class="opt">
      <span>
        <strong>结算汇总只走关键事件</strong>
        <em>打开后：免打扰结束的结算汇总不再走日常推送，只由这个关键事件机器人发（没配好时日常推送仍兜底）</em>
      </span>
      <span
        class="switch"
        :class="{ on: critSummaryOnly('dingtalk') }"
        @click="toggleCritSummaryOnly('dingtalk')"
      ></span>
    </label>

    <div class="opt">
      <span>
        <strong>消息格式</strong>
        <em>markdown 支持标题与图片；text 为纯文本</em>
      </span>
      <select class="field mini" v-model="dt.critical.msgType">
        <option value="markdown">markdown</option>
        <option value="text">纯文本</option>
      </select>
    </div>

    <div class="opt col">
      <span>
        <strong>消息标题前缀</strong>
        <em>建议保留，同时可作为该机器人的「自定义关键词」</em>
      </span>
      <input class="field" v-model.trim="dt.critical.titlePrefix" spellcheck="false" placeholder="【监控报警】" />
    </div>

    <div class="opt">
      <span>
        <strong>附带事件截图</strong>
        <em>关键事件机器人独立于 TG，默认不带图；要嵌图需自备图床 / 上传接口</em>
      </span>
      <select class="field mini" v-model="dt.critical.screenshotMode">
        <option value="none">都不带（仅文字）</option>
        <option value="litterbox">上传图床后直接嵌图</option>
        <option value="upload">自建上传接口嵌图</option>
      </select>
    </div>

    <label class="opt">
      <span>
        <strong>@ 所有人</strong>
        <em>关键事件推送时 @ 该群所有人</em>
      </span>
      <span class="switch" :class="{ on: dt.critical && dt.critical.atAll }" @click="dt.critical.atAll = !(dt.critical && dt.critical.atAll)"></span>
    </label>

    <div class="opt col">
      <span>
        <strong>@ 指定手机号</strong>
        <em>多个用英文逗号分隔，留空表示不 @ 指定人</em>
      </span>
      <input class="field" v-model.trim="dt.critical.atMobiles" spellcheck="false" placeholder="13800000000,13900000000" />
    </div>

    <div class="opt">
      <span>
        <strong>连通性测试</strong>
        <em>向这个关键事件机器人发一条测试消息</em>
      </span>
      <div class="test-row">
        <span class="test-state" :class="dtCritState.kind" v-if="dtCritState.text">{{ dtCritState.text }}</span>
        <button class="btn small primary" :disabled="dtCritState.kind === 'loading'" @click="testDingCritical">
          {{ dtCritState.kind === 'loading' ? '发送中…' : '发送测试' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { CRIT_EVENTS, EVENT_GROUPS, FIELD_KEYS, camPushOn, cams, critOn, critSummaryOnly, critThroughSilence, dingShotHint, dt, dtCritState, emit, evOn, fieldLabel, openPicker, opts, props, pushCamCount, revealed, setAllPushCameras, testDingCritical, testPush, testState, tg, toggleChannel, toggleCritEvent, toggleCritSummaryOnly, toggleCritThroughSilence, toggleEvent, togglePushCamera } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
