<!-- Cams 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
    <div class="block-head">
      <h3>摄像头（{{ cams.length }} 路）</h3>
      <button class="btn small" @click="addCamera">+ 新增一路</button>
    </div>
    <p class="hint">
      拖动每行左侧手柄可调整顺序；关掉「显示」开关可临时隐藏该画面。
      每行里的「人脸 / 姿态 / 区域」是这一路的附加分析开关 —— 它们都要在左侧
      「人脸识别 / 人形姿态 / 区域规则」页开过对应总开关才会真正生效，把不看的通道关掉最省算力。
      每路下方可以单独设置「这一路推送到哪些渠道」（钉钉 / 企业微信 / Telegram），
      关掉总开关则三个渠道都不推。渠道本身的凭据与频率限制在对应的推送标签页里配置。
    </p>

    <div class="block-head digest-all-head">
      <h3>日常事件静默（总开关）</h3>
      <span
        class="switch"
        :class="{ on: allDigestOn, mid: someDigestOn && !allDigestOn }"
        @click="toggleAllCamDigest"
        title="一键开启 / 关闭所有通道的日常事件静默"
      ></span>
    </div>
    <div class="cs-row">
      <span class="cs-label">汇总间隔</span>
      <select
        class="field mini"
        :value="clampDigestMinutes(opts.digestIntervalMinutes)"
        @change="setMasterDigestInterval($event.target.value)"
      >
        <option v-for="m in DIGEST_INTERVAL_CHOICES" :key="'mdi-' + m" :value="m">
          {{ digestIntervalLabel(m) }}
        </option>
      </select>
      <span class="cs-state">总开关开启时，所有通道按此间隔汇总（每路仍可单独微调）</span>
    </div>
    <p class="hint">
      总开关一键开启后，所有通道都按各自的「日常事件静默」把非关键事件摊平成定期播报
      （默认每 30 分钟汇总一次、推送到已配置的渠道）。设备离线/上线与定时巡检也一并收入汇总，不再实时打扰。
      各通道卡片下方仍可单独微调开关、渠道与间隔；关闭总开关会把每一路的开关一并关掉。
    </p>
    <p
      class="hint warn"
      v-if="allDigestOn && silentYieldSlots(opts.silent).length"
    >
      ⚠️ 日常事件静默与免打扰时段存在交集（{{ silentYieldSlots(opts.silent).join('、') }}）：
      重叠期间日常静默会暂停收存，相关事件改由「免打扰汇总」单独推送，不计入日常汇总
      （总开关全开时这些通道会合并成<b>一条</b>日常汇总推送）。
    </p>

    <div class="cam-list" v-if="cams.length">
      <div
        v-for="(cam, i) in cams"
        :key="cam.id"
        class="cam-item"
        :class="{ off: hidden.includes(cam.id) }"
        :draggable="dragArmedIndex === i"
        @dragstart="onDragStart(i, $event)"
        @dragend="onDragEnd"
        @dragover.prevent="onDragOver(i)"
      >
        <div class="cam-head">
          <span class="row-handle" title="按住拖拽排序" @mousedown="armRowDrag(i)">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="currentColor" d="M9 5.5h2v2H9zM13 5.5h2v2h-2zM9 11h2v2H9zM13 11h2v2h-2zM9 16.5h2v2H9zM13 16.5h2v2h-2z" />
            </svg>
          </span>
          <span class="index">{{ i + 1 }}</span>
          <input class="field name-input" v-model.trim="cam.name" placeholder="画面名称" />
          <span class="switch" :class="{ on: !hidden.includes(cam.id) }" @click="toggleVisible(cam.id)" title="显示 / 隐藏"></span>
          <button class="icon-btn" title="上移" :disabled="i === 0" @click="move(i, -1)">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M6 14l6-6 6 6" />
            </svg>
          </button>
          <button class="icon-btn" title="下移" :disabled="i === cams.length - 1" @click="move(i, 1)">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M6 10l6 6 6-6" />
            </svg>
          </button>
          <button class="icon-btn del" title="删除" @click="remove(i)">
            <svg viewBox="0 0 24 24" width="15" height="15">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M7 7l1 12h8l1-12"
              />
            </svg>
          </button>
        </div>
        <textarea class="field url-input" v-model.trim="cam.url" rows="2" spellcheck="false" placeholder="ws:// 或 wss:// 流地址（主码流）"></textarea>
        <!--
          子码流（选填）：网格里多路同看时拉它，软解压力小一个量级；
          点开放大单路时自动切回上面的主码流。留空 = 永远拉主码流。
        -->
        <input
          class="field url-sub"
          v-model.trim="cam.urlSub"
          spellcheck="false"
          placeholder="子码流地址（选填）· 网格默认拉它，放大时自动切主码流"
        />
        <!--
          后端专用流地址（选填）：浏览器只能播 ws/wss-flv，后端却能直接吃
          rtsp:// 或 https://…live.mp4（实测这类平台的 rtsp:554 与 https mp4 都通）。
          走这些协议由 ffmpeg 原生拉取，不必先经 WebSocket 转一道，多路并发时更稳。
          留空 = 后端与页面共用上面那个地址。
        -->
        <input
          class="field url-sub"
          v-model.trim="cam.urlBackend"
          spellcheck="false"
          placeholder="后端流地址（选填）· 可填 rtsp:// 或 https://…live.mp4，留空 = 与上面相同"
        />
        <div class="cam-tags">
          <button
            class="tag mini master"
            :class="{ on: cam.motion !== false }"
            title="这一路的画面变动检测总开关"
            @click="cam.motion = cam.motion === false"
          >
            <svg viewBox="0 0 24 24" width="12" height="12">
              <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M4 18a9 9 0 0 1 16 0M7.5 18a5.5 5.5 0 0 1 9 0" />
            </svg>
            画面变动
          </button>
          <button
            class="tag mini master"
            :class="{ on: !!cam.ai }"
            title="这一路的人形识别总开关"
            @click="cam.ai = !cam.ai"
          >
            <svg viewBox="0 0 24 24" width="12" height="12">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                d="M12 4.5a3 3 0 0 0-3 3v.6A2.6 2.6 0 0 0 7 10.5v.6a2.6 2.6 0 0 0 1 2.1v1.3A2.5 2.5 0 0 0 10.5 17h.5M12 4.5a3 3 0 0 1 3 3v.6a2.6 2.6 0 0 1 2 2.4v.6a2.6 2.6 0 0 1-1 2.1v1.3A2.5 2.5 0 0 1 13.5 17H13M12 4.5V17"
              />
            </svg>
            人形识别
          </button>
          <span class="tag-sep"></span>
          <!--
            人形识别之上的附加能力（通道级分流开关）。
            与「人脸识别 / 人形姿态 / 区域规则」页的全局开关是两层：全局开 + 这里开 才真正生效。
            三项都建立在人形检测之上，所以本路人形识别关着时这里置灰不可点。
          -->
          <button
            v-for="e in EXT_ITEMS"
            :key="e.key"
            class="tag mini ext"
            :class="{
              on: camExtOn(cam, e.key) && extGlobalOn(e.key, cam),
              preset: camExtOn(cam, e.key) && !extGlobalOn(e.key, cam)
            }"
            :disabled="!cam.ai"
            :title="camExtTitle(cam, e)"
            @click="toggleCamExt(cam, e.key)"
          >
            {{ e.label }}
          </button>
          <span class="tag-text" v-if="cam.roi">已设置检测区域</span>
          <button class="tag ghost" v-if="cam.roi" @click="cam.roi = null">清除区域</button>
        </div>

        <!-- 这一路推送到哪些渠道（通道级，总开关在下面） -->
        <div class="cam-push">
          <button
            class="tag mini master"
            :class="{ on: cam.push !== false }"
            title="这一路的推送总开关"
            @click="togglePushCam(cam)"
          >
            <svg viewBox="0 0 24 24" width="12" height="12">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M4 11l16-7-6.5 16-2.6-6.4zM10.9 13.6L20 4"
              />
            </svg>
            推送
          </button>
          <span class="cp-sep"></span>
          <button
            v-for="ch in CAM_CHANNELS"
            :key="ch.key"
            class="tag mini ch"
            :class="{ on: cam.push !== false && channelOn(cam, ch.key) }"
            :disabled="cam.push === false"
            :title="`这一路是否推送到${ch.label}`"
            @click="toggleCamChannel(cam, ch.key)"
          >
            {{ ch.label }}
          </button>
          <span class="cp-hint">（推送关闭时三个渠道都不推）</span>
        </div>

        <!--
          通道静默：只让**这一路**在指定时段对指定渠道不推送。
          与上面「免打扰（静默推送）」是并集关系（任一命中就静默该渠道），
          但范围只限这一路 —— 那一份是所有通道一起静默。
        -->
        <div class="cam-silent" :class="{ on: camSilActive(cam) }">
          <div class="cs-row">
            <button
              class="tag mini"
              :class="{ on: camSilCfg(cam).enabled }"
              title="开启这一路的定时静默（配合下面的时段生效）"
              @click="toggleCamSilent(cam)"
            >
              <svg viewBox="0 0 24 24" width="12" height="12">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"
                />
              </svg>
              通道静默
            </button>
            <span class="live-tag" v-if="camSilActive(cam)">
              静默中 · {{ camSilInfo(cam).rangeLabel }}
            </span>
            <span class="cs-state" v-else-if="camSilCfg(cam).enabled">
              已开启（当前不在时段内）
            </span>
            <span class="cs-state off" v-else>未开启</span>
            <span class="cs-flex"></span>
            <span class="cs-label">静默渠道</span>
            <button
              v-for="ch in CAM_CHANNELS"
              :key="'csz-' + ch.key"
              class="tag mini ch"
              :class="{ on: camSilChannels(cam).includes(ch.key) }"
              :title="`这一路的通道静默是否覆盖${ch.label}`"
              @click="toggleCamSilChannel(cam, ch.key)"
            >
              {{ ch.label }}
            </button>
          </div>

          <template v-if="camSilCfg(cam).enabled">
            <div class="slot-list">
              <SilentSlotRow
                v-for="(s, si) in camSilCfg(cam).slots"
                :key="'csl-' + si"
                :slot="s"
                :index="si"
                :can-remove="true"
                :open-picker="openPicker"
                @remove="removeCamSilSlot(cam, si)"
              />
            </div>
            <div class="slot-actions">
              <button class="btn tiny" @click="addCamSilSlot(cam)">+ 添加时段</button>
              <span class="cs-state">结束时间早于开始时间 = 跨零点（如 19:00 ~ 08:00）</span>
            </div>
          </template>
          <p class="hint tight">
            只影响<b>这一路</b>：命中时段时，所选渠道不再实时推送、改为收存，
            时段结束后单独推送<b>本通道汇总</b>（期间没有事件就不打扰）。
            与上面「免打扰（静默推送）」是<b>并集</b> —— 任一命中就静默该渠道；
            两处同时命中时，事件归整体汇总，不会重复。
            临时静默可在手机上发 <code>/csilent {{ cam.name || cam.id }} 2</code>。
          </p>
        </div>

        <!--
          日常事件静默：非关键事件不再逐条推，改为按所选间隔合并成一条汇总。
          ⚠️ 只在**非静默时段**工作 —— 只要有静默窗口在生效就让位（否则同一条事件
          会同时进「静默汇总」和「日常汇总」两份）。已攒下的那批不丢，恢复后补发。
        -->
        <div class="cam-silent cam-digest" :class="{ on: camDigestInfo(cam).active }">
          <div class="cs-row">
            <button
              class="tag mini"
              :class="{ on: camDigestCfg(cam).enabled }"
              title="把这一路的日常事件攒起来，按间隔合并推送"
              @click="toggleCamDigest(cam)"
            >
              <svg viewBox="0 0 24 24" width="12" height="12">
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M4 6.5h16M4 12h11M4 17.5h14"
                />
              </svg>
              日常事件静默
            </button>
            <span class="live-tag" v-if="camDigestInfo(cam).active">
              汇总中 · 每 {{ digestIntervalLabel(camDigestCfg(cam).intervalMinutes) }}一条
            </span>
            <span class="cs-state" v-else-if="camDigestInfo(cam).pausedBySilent">
              已开启（静默时段中 · 暂不汇总）
            </span>
            <span class="cs-state" v-else-if="camDigestCfg(cam).enabled">已开启（未选渠道，暂不生效）</span>
            <span class="cs-state off" v-else>未开启</span>
            <span class="cs-flex"></span>
            <span class="cs-label">汇总渠道</span>
            <button
              v-for="ch in CAM_CHANNELS"
              :key="'cdg-' + ch.key"
              class="tag mini ch"
              :class="{ on: camDigestCfg(cam).channels.includes(ch.key) }"
              :title="`这一路的日常汇总推送到${ch.label}`"
              @click="toggleCamDigestChannel(cam, ch.key)"
            >
              {{ ch.label }}
            </button>
          </div>

          <div class="cs-row" v-if="camDigestCfg(cam).enabled">
            <span class="cs-label">汇总间隔</span>
            <select
              class="field mini"
              :value="camDigestCfg(cam).intervalMinutes"
              @change="setCamDigestInterval(cam, $event.target.value)"
            >
              <option v-for="m in DIGEST_INTERVAL_CHOICES" :key="'cdi-' + m" :value="m">
                {{ digestIntervalLabel(m) }}
              </option>
            </select>
            <span class="cs-state">
              每 {{ digestIntervalLabel(camDigestCfg(cam).intervalMinutes) }}最多一条汇总；期间没有事件就不打扰
            </span>
          </div>

          <p class="hint tight">
            只影响<b>这一路</b>的<b>日常事件</b>（移动 / 人形 / 计数等）：不再逐条推，
            改为把这段时间的事件合并成<b>一条汇总</b>推到所选渠道。
            <b>关键事件不受影响</b>（人脸命中、静默提醒、满库提醒该推就推）。
            <br />
            与「通道静默」「免打扰」是<b>让位</b>关系：只要有静默窗口在生效，本功能就暂停吸收
            —— 那些事件归静默汇总，不会重复；窗口结束后自动恢复，已攒下的那批立刻补发。
            间隔可选 {{ DIGEST_INTERVAL_MIN }} ~ {{ DIGEST_INTERVAL_MAX }} 分钟。
          </p>
        </div>
      </div>
    </div>
    <div class="empty-tip" v-else>
      还没有任何画面。点右上角「+ 新增一路」开始添加，或者到「配置方案」页载入一份本地配置文件。
    </div>
  </section>
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { CAM_CHANNELS, DIGEST_INTERVAL_CHOICES, DIGEST_INTERVAL_MAX, DIGEST_INTERVAL_MIN, EXT_ITEMS, SilentSlotRow, addCamSilSlot, addCamera, allDigestOn, armRowDrag, camDigestCfg, camDigestInfo, camExtOn, camExtTitle, camSilActive, camSilCfg, camSilChannels, camSilInfo, cams, channelOn, clampDigestMinutes, digestIntervalLabel, dragArmedIndex, emit, extGlobalOn, hidden, move, onDragEnd, onDragOver, onDragStart, openPicker, opts, props, remove, removeCamSilSlot, setCamDigestInterval, setMasterDigestInterval, silentYieldSlots, someDigestOn, toggleAllCamDigest, toggleCamChannel, toggleCamDigest, toggleCamDigestChannel, toggleCamExt, toggleCamSilChannel, toggleCamSilent, togglePushCam, toggleVisible } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
