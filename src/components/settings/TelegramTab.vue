<!-- Telegram 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>Telegram 推送</h3>
      <span class="state-chip" :class="tg.enabled ? 'ready' : ''">
        {{ tg.enabled ? '已启用' : '未启用' }}
      </span>
    </div>
    <p class="hint">
      报警截图统一由 Telegram 发送：机器人接口支持直接上传文件，不需要公网图床
      （钉钉的 markdown 图片必须是公网 http 地址，本地部署基本做不到）。
      <br />
      <b>Telegram 是图片与原图链接的承载通道</b>：只要钉钉或企业微信任意一个开着，
      这里就会自动保持启用——关掉它，另外两个渠道的消息里就只剩一句「已记录在本地」，
      既看不到图也点不开原图。
    </p>

    <label class="opt">
      <span>
        <strong>启用 Telegram 推送</strong>
        <em v-if="tgForced">已由钉钉 / 企业微信自动启用，无法单独关闭</em>
        <em v-else>关闭后其它渠道也会失去图片与原图链接</em>
      </span>
      <span
        class="switch"
        :class="{ on: tg.enabled, locked: tgForced }"
        :title="tgForced ? '钉钉 / 企业微信已开启，Telegram 必须同时开启' : ''"
        @click="setTgEnabled(!tg.enabled)"
      ></span>
    </label>

    <div class="opt col">
      <span>
        <strong>推送哪些事件</strong>
        <em>勾选需要推送到 Telegram 的报警类型</em>
      </span>
      <div class="cam-tags">
        <button
          v-for="g in EVENT_GROUPS"
          :key="g.key"
          class="tag"
          :class="{ on: evOn(opts.telegram, g.key) }"
          :title="g.desc"
          @click="toggleEvent('telegram', g.key)"
        >
          {{ g.label }}
        </button>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>机器人 Token</strong>
        <em>在 Telegram 里找 @BotFather → /newbot 创建，复制返回的 Token</em>
      </span>
      <div class="pw-wrap">
        <input class="field" :type="revealed.tgToken ? 'text' : 'password'" v-model.trim="tg.token" spellcheck="false" autocomplete="off" placeholder="123456789:AAxxxxxxxxxxxxxxxx" />
        <button type="button" class="pw-eye" :title="revealed.tgToken ? '隐藏' : '显示'" @click="revealed.tgToken = !revealed.tgToken">{{ revealed.tgToken ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>会话 ID（chat_id）</strong>
        <em>
          群 / 频道 / 私聊的 id。<b>超级群和频道必须带 -100 前缀</b>：
          群链接里看到的 1234567890 要写成 -1001234567890，否则会报「chat not found」
        </em>
      </span>
      <div class="pw-wrap">
        <input class="field" :type="revealed.tgChat ? 'text' : 'password'" v-model.trim="tg.chatId" spellcheck="false" autocomplete="off" placeholder="-1001234567890" />
        <button type="button" class="pw-eye" :title="revealed.tgChat ? '隐藏' : '显示'" @click="revealed.tgChat = !revealed.tgChat">{{ revealed.tgChat ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <div class="opt col">
      <span>
        <strong>群用户名（可选）</strong>
        <em>
          就是 t.me 链接里那一段，例如 <code>my_monitor_group</code>。
          填了之后钉钉 / 企业微信里附带的截图链接会是
          <code>https://t.me/my_monitor_group/消息ID</code> 这种手机点开就能跳转的形式；
          留空则只能生成仅 TG 内部可用的 t.me/c/… 链接
        </em>
      </span>
      <div class="pw-wrap">
        <input class="field" :type="revealed.tgGroup ? 'text' : 'password'" v-model.trim="tg.groupUsername" spellcheck="false" autocomplete="off" placeholder="my_monitor_group" />
        <button type="button" class="pw-eye" :title="revealed.tgGroup ? '隐藏' : '显示'" @click="revealed.tgGroup = !revealed.tgGroup">{{ revealed.tgGroup ? '🙈' : '👁' }}</button>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>机器人是否在群里</strong>
        <em :class="botState.kind ? `st-${botState.kind}` : ''">
          {{ botState.text || '点右侧按钮校验 Token 与群 id，或直接让机器人发一条测试消息' }}
        </em>
      </span>
      <div class="test-row">
        <button class="btn small" :disabled="botState.kind === 'loading'" @click="checkBot">
          {{ botState.kind === 'loading' ? '校验中…' : '校验会话' }}
        </button>
        <button class="btn small primary" :disabled="botState.kind === 'loading'" @click="testTelegram">
          发送测试
        </button>
      </div>
    </div>

    <div class="opt">
      <span>
        <strong>图片发送方式</strong>
        <em>photo：聊天里直接预览（TG 会压到 1280 宽）；document：原文件不压缩，最清晰</em>
      </span>
      <select class="field mini" v-model="tg.sendMode">
        <option value="photo">photo（直接预览）</option>
        <option value="document">document（原始不压缩）</option>
      </select>
    </div>

    <label class="opt">
      <span>
        <strong>附带报警截图</strong>
        <em>关闭后 Telegram 也只发文字</em>
      </span>
      <span class="switch" :class="{ on: tg.withPhoto }" @click="tg.withPhoto = !tg.withPhoto"></span>
    </label>

    <label class="opt" v-if="tg.withPhoto && tg.sendMode === 'photo'">
      <span>
        <strong>额外再发一份无损原图</strong>
        <em>以文件形式补发原始截图，需要无损存档时开启（每条报警会多一条消息）</em>
      </span>
      <span class="switch" :class="{ on: tg.alsoSendOriginal }" @click="tg.alsoSendOriginal = !tg.alsoSendOriginal"></span>
    </label>

    <label class="opt">
      <span>
        <strong>静默发送</strong>
        <em>照常推送但不响铃、不弹通知（夜间建议开启）</em>
      </span>
      <span class="switch" :class="{ on: tg.silent }" @click="tg.silent = !tg.silent"></span>
    </label>

    <!--
      关键事件单独提醒（私聊推送）。
      群 / 频道消息多，静默期间更是什么都收不到；但「静默开没开 / 静默期间怎么了 /
      库内的人来了」这几件事哪怕在静默里也想第一时间知道 —— 这几类事件
      除了走正常渠道，再由机器人私聊推给指定的人。
      和「远程控制」一样用 grp 卡片圈起来，视觉上区分"这是额外的一路"。
    -->
    <div class="divider"></div>
    <div class="grp" :class="{ live: tg.directPush.enabled }">
      <div class="grp-head">
        <span class="grp-ico">📨</span>
        <div class="grp-titles">
          <strong>关键事件单独提醒</strong>
          <em>
            静默提醒、静默汇总、人脸命中这类关键事件，除正常渠道外，
            再由机器人<b>私聊</b>推给指定的人（如授权用户）。
          </em>
        </div>
        <span class="switch" :class="{ on: tg.directPush.enabled }" @click="tg.directPush.enabled = !tg.directPush.enabled"></span>
      </div>

      <div class="grp-body" v-if="tg.directPush.enabled">
        <div class="sub-label">提醒哪些事件</div>
        <div class="temp-chips">
          <button
            v-for="e in DIRECT_EVENT_OPTS"
            :key="e.id"
            class="chip sm"
            :class="{ on: directEventOn(e.id) }"
            :title="e.desc"
            @click="toggleDirectEvent(e.id)"
          >
            {{ e.label }}
          </button>
        </div>

        <!-- 「静默时段也允许推送」语义与钉钉 / 企微那两处完全一致 -->
        <label class="opt">
          <span>
            <strong>静默时段也允许推送</strong>
            <em>关闭后：处于免打扰 / 通道静默时，上面勾选的这几类事件也不再私聊推送</em>
          </span>
          <span
            class="switch"
            :class="{ on: critThroughSilence('tg') }"
            @click="toggleCritThroughSilence('tg')"
          ></span>
        </label>

        <!--
          「结算汇总只走关键事件」语义与钉钉 / 企微那两处完全一致：
          免打扰结束后 TG 群（日常推送）不再发结算汇总，只由私聊这条路发。
        -->
        <label class="opt">
          <span>
            <strong>结算汇总只走关键事件</strong>
            <em>打开后：免打扰结束的结算汇总不再走 TG 日常推送，只由私聊推给接收人（没配好时日常推送仍兜底）</em>
          </span>
          <span
            class="switch"
            :class="{ on: critSummaryOnly('tg') }"
            @click="toggleCritSummaryOnly('tg')"
          ></span>
        </label>

        <div class="sub-label mt">接收人</div>
        <p class="hint tight">
          默认包含「远程控制 → 授权用户」里的所有人，下面可以再补<b>别人的用户 id</b>。
          <br />
          ⚠️ 接收人<b>必须先在 Telegram 里私聊机器人发过一条消息</b>，
          否则机器人无法主动发起会话（会报 chat not found）—— 这是 Telegram 的限制，不是配置问题。
        </p>
        <div class="id-list">
          <span class="id-chip" v-for="(id, i) in tg.directPush.chatIds" :key="'dp-' + i">
            <code>{{ id }}</code>
            <button class="id-x" title="移除" @click="tg.directPush.chatIds.splice(i, 1)">×</button>
          </span>
          <span class="id-empty" v-if="!tg.directPush.chatIds.length">未额外添加（仅用授权用户名单）</span>
        </div>
        <div class="test-row">
          <input
            class="field mini"
            v-model.trim="newDirectId"
            placeholder="输入用户 id 后回车添加"
            @keyup.enter="addDirectId"
          />
          <button class="btn tiny" :disabled="!newDirectId" @click="addDirectId">添加</button>
          <button class="btn tiny" :disabled="directState.kind === 'loading'" @click="testDirectPush">
            {{ directState.kind === 'loading' ? '发送中…' : '试发一条' }}
          </button>
        </div>
        <p class="hint err-text" v-if="directIdError">{{ directIdError }}</p>
        <p class="hint" :class="directState.kind === 'fail' ? 'err-text' : ''" v-if="directState.text">
          {{ directState.text }}
        </p>
        <p class="muted">
          当前将私聊推送给 <b>{{ directRecipients.length }}</b> 个接收人
          <template v-if="!directRecipients.length"> —— 授权用户名单为空，且未额外添加
          </template>
        </p>
      </div>
    </div>

    <!--
      远程控制（方案 C，TG 私聊指令）—— item 121 UI 美化。
      不需要公网入口：后端主动用 getUpdates 长轮询去 TG 拉指令。
      安全上做了三件事 —— 只认私聊、只认白名单、危险动作单独开关。
      同样用 grp 卡片圈起来，和上面的「免打扰」视觉一致。
    -->
    <div class="divider"></div>
    <div class="grp" :class="{ live: tg.remote.enabled && tgRemoteChip.running }">
      <div class="grp-head">
        <span class="grp-ico remote">🤖</span>
        <div class="grp-titles">
          <strong>远程控制（私聊指令）</strong>
          <em>
            在手机上<b>私聊</b>这个机器人发指令，即可远程控制推送静默与巡检，<b>无需开放公网端口</b>。
          </em>
        </div>
        <span class="switch" :class="{ on: tg.remote.enabled }" @click="tg.remote.enabled = !tg.remote.enabled"></span>
      </div>

      <div class="grp-body">
        <!-- 运行状态：用户最怕"配好了但不知道有没有生效"，所以如实显示 -->
        <div class="remote-status">
          <span class="state-chip" :class="tgRemoteChip.cls">{{ tgRemoteChip.text }}</span>
          <span class="muted">
            {{ tg.remote.enabled ? '改动后点下方「保存」同步给后端' : '开启后后端才会开始拉取指令' }}
          </span>
        </div>

        <!--
          诊断：把「为什么没响应」直接摆在这儿。
          以前只能靠翻后端日志，而这条链路恰好有六种成因，现象却都是"没反应"。
        -->
        <div class="tg-diag" v-if="tg.remote.enabled">
          <div class="diag-row">
            <span class="diag-k">机器人</span>
            <span class="diag-v">
              <template v-if="tgBotInfo">
                {{ tgBotInfo.username ? '@' + tgBotInfo.username : '已连接' }}{{ tgBotInfo.name ? ' · ' + tgBotInfo.name : '' }}
              </template>
              <span v-else class="muted">未自检（点下方「测试连接」）</span>
            </span>
          </div>
          <div class="diag-row">
            <span class="diag-k">Token</span>
            <span class="diag-v" :class="tgDiag.tokenSet ? 'ok-text' : 'err-text'">
              {{ tgDiag.tokenSet ? '已填写' : '未填写 —— 监听器起不来' }}
            </span>
          </div>
          <div class="diag-row">
            <span class="diag-k">白名单</span>
            <span class="diag-v" :class="tgDiag.allowCount ? '' : 'err-text'">
              {{ tgDiag.allowCount ? tgDiag.allowCount + ' 个用户' : '为空 —— 任何人发指令都会被静默丢弃' }}
            </span>
          </div>
          <div class="diag-row">
            <span class="diag-k">积压指令</span>
            <span class="diag-v" :class="tgPendingClass">{{ tgPendingText }}</span>
          </div>
          <div class="diag-row" v-if="tgDiag.lastRejectAt">
            <span class="diag-k">最近被拒</span>
            <span class="diag-v err-text">{{ tgDiag.lastRejectId }} · {{ tgDiag.lastRejectReason }}</span>
          </div>
          <!--
            游标落盘失败会导致「重启后重放旧指令」。Windows 上被杀软/文件锁
            挡住 rename 时会出现，必须让它可见 —— 否则这个降级是无声的。
          -->
          <div class="diag-row" v-if="tgDiag.offsetSaveError">
            <span class="diag-k">游标落盘</span>
            <span class="diag-v err-text">{{ tgDiag.offsetSaveError }}</span>
          </div>
          <p class="diag-note" v-if="tgDiag.note">💡 {{ tgDiag.note }}</p>
          <div class="test-row">
            <button class="btn tiny" :disabled="tgTesting" @click="testTgConnection">
              {{ tgTesting ? '测试中…' : '测试连接' }}
            </button>
            <button class="btn tiny danger" v-if="tgWebhookSet" :disabled="tgTesting" @click="deleteTgWebhookNow">
              删除 Webhook
            </button>
            <span class="muted" v-if="tgProbeMsg">{{ tgProbeMsg }}</span>
          </div>
        </div>

      <template v-if="tg.remote.enabled">
        <!-- ---------- 安全：授权用户 ---------- -->
        <div class="sub-label">授权用户</div>
        <p class="hint tight">
          只有这些 <b>Telegram 用户 id</b> 发的指令才会被执行，其它人一律忽略（连回执都不给）。
          群里发的一律不理会。在 Telegram 里找 <b>@userinfobot</b> 可查自己的 id。
        </p>
        <div class="id-list">
          <span class="id-chip" v-for="(id, i) in tg.remote.allowUserIds" :key="i">
            <code>{{ id }}</code>
            <button class="id-x" title="移除" @click="removeAllowId(i)">×</button>
          </span>
          <span class="id-empty" v-if="!tg.remote.allowUserIds.length">未配置 —— 任何人都无法下发指令</span>
        </div>
        <div class="test-row">
          <input
            class="field mini"
            v-model.trim="newAllowId"
            placeholder="输入用户 id 后回车添加"
            @keyup.enter="addAllowId"
          />
          <button class="btn tiny" :disabled="!newAllowId" @click="addAllowId">添加</button>
        </div>
        <p class="hint err-text" v-if="allowIdError">{{ allowIdError }}</p>

        <!-- ---------- 危险动作 ---------- -->
        <div class="sub-label mt">危险操作</div>
        <div class="opt">
          <span>
            <strong>允许远程重启（/reboot、/hardreboot）</strong>
            <em>
              /reboot 重启检测服务（先释放端口→拉起新进程→确认接管，失败自动回滚）；
              /hardreboot 重启整台电脑，另需在「系统维护」里打开开关。
              两者都还要再发一次 <code>confirm</code> 才真正执行。
            </em>
          </span>
          <span class="switch" :class="{ on: tg.remote.allowReboot }" @click="tg.remote.allowReboot = !tg.remote.allowReboot"></span>
        </div>

        <!-- ---------- 静默查岗（/duty）调参 ---------- -->
        <div class="sub-label mt">静默查岗</div>
        <p class="hint tight">
          静默期间私聊机器人发 <code>/duty</code>，会把「静默开始到现在」积压的事件汇总推过来，
          并把区间内<b>所有截图</b>逐张发过去；再发一次只看上次查岗之后的新事件。
        </p>
        <div class="opt">
          <span>
            <strong>单次截图张数上限</strong>
            <em>0 = 不限（仍受 200 张的防呆上限约束）。觉得刷屏就调小，超出的可在事件面板回看。</em>
          </span>
          <div class="time-row">
            <input class="field mini" type="number" min="0" max="200" v-model.number="tg.remote.dutyMaxImages" />
            <span class="tilde">张</span>
          </div>
        </div>
        <div class="opt">
          <span>
            <strong>截图发送间隔（毫秒）</strong>
            <em>Telegram 对同一会话连续发图有限流，串行 + 留间隔才不会被拒。网络差可调大到 1200~2000。</em>
          </span>
          <div class="time-row">
            <input class="field mini" type="number" min="0" max="5000" step="100" v-model.number="tg.remote.dutyImageGapMs" />
            <span class="tilde">ms</span>
          </div>
        </div>

        <!-- ---------- 指令清单 ---------- -->
        <div class="sub-label mt">可用指令</div>
        <p class="hint tight">
          已注册到 TG 的命令菜单 —— 在聊天框输入 <code>/</code> 就会自动弹出候选，不用背。
        </p>

        <!--
          /silent、/until 的默认静默渠道。
          故意放在「可用指令」这一块里而不是塞进静默时段：它改的就是这两条指令
          的行为，和「有哪些指令」是同一件事的两面，分开放会让人找不到。
        -->
        <div class="opt col">
          <span>
            <strong>/silent、/until 默认静默哪些渠道</strong>
            <em>
              在手机上发 <code>/silent 2</code> 时静默哪几端。默认只有钉钉 + 企微 ——
              TG 是你下发指令的通道，把它一起静默掉，连"静默开没开、还剩多久"的回执都收不到。
              想临时改不用回来改配置：<code>/silent 2 wecom</code>、<code>/silent 2 ding,tg</code>。
              <b>一个都不勾 = 拒绝开启</b>（不是"静默全部"），照样可以在指令里临时指定。
            </em>
          </span>
          <div class="temp-chips">
            <button
              v-for="c in TEMP_CHANNEL_OPTS"
              :key="c.id"
              class="chip sm"
              :class="{ on: remoteSilentChannels.includes(c.id) }"
              @click="toggleRemoteSilentChannel(c.id)"
            >
              {{ c.label }}
            </button>
            <span class="muted" v-if="!remoteSilentChannels.length">
              一个都没勾 —— 远程静默指令会直接拒绝执行
            </span>
          </div>
        </div>

        <div class="cmd-list">
          <div class="cmd" v-for="c in TG_COMMANDS" :key="c.cmd">
            <code>{{ c.usage }}</code>
            <span>{{ c.desc }}<template v-if="c.detail">：{{ c.detail }}</template></span>
          </div>
        </div>
      </template>
      </div>
    </div>

    <div class="toggle-tip">
      <strong>以下设置两个渠道共用</strong>
      <em>
        监听通道、推送哪些事件、推送频率与静默时段，都在
        <b>「钉钉推送」</b> 标签页里统一设置（那部分本质是「推送策略」，不是钉钉专属）。
        推送内容里勾选的字段，Telegram 也会同样带上。
      </em>
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { DIRECT_EVENT_OPTS, EVENT_GROUPS, TEMP_CHANNEL_OPTS, TG_COMMANDS, addAllowId, addDirectId, allowIdError, botState, checkBot, critSummaryOnly, critThroughSilence, deleteTgWebhookNow, directEventOn, directIdError, directRecipients, directState, emit, evOn, newAllowId, newDirectId, opts, props, remoteSilentChannels, removeAllowId, revealed, setTgEnabled, testDirectPush, testTelegram, testTgConnection, tg, tgBotInfo, tgDiag, tgForced, tgPendingClass, tgPendingText, tgProbeMsg, tgRemoteChip, tgTesting, tgWebhookSet, toggleCritSummaryOnly, toggleCritThroughSilence, toggleDirectEvent, toggleEvent, toggleRemoteSilentChannel } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
