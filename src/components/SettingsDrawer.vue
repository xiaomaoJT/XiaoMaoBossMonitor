<template>
  <!--
    点遮罩空白处关闭。判定逻辑见 onMaskClick()：触屏上一次触摸可能产生不止一次 click，
    直接绑 @click.self 会让抽屉「闪一下就关」（iOS 必现），所以加了静默期 + 按下配对两道闸。
  -->
  <div class="mask" @pointerdown.self="onMaskDown" @click.self="onMaskClick">
    <aside class="drawer">
      <header class="drawer-head">
        <h2>监控配置</h2>
        <span class="head-sub">{{ currentTab.label }}</span>
        <span class="spacer"></span>
        <button class="icon-btn" title="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M7 7l10 10M17 7L7 17" />
          </svg>
        </button>
      </header>

      <div class="drawer-main">
        <nav class="tabs">
          <button
            v-for="t in TABS"
            :key="t.key"
            class="tab"
            :class="{ on: tab === t.key }"
            :title="t.desc"
            @click="tab = t.key"
          >
            <svg viewBox="0 0 24 24" width="16" height="16">
              <path
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                :d="t.icon"
              />
            </svg>
            <span>{{ t.label }}</span>
            <em v-if="t.key === 'cams'">{{ cams.length }}</em>
            <em v-else-if="t.key === 'dingtalk'" :class="dt.enabled ? 'ok' : 'muted'">
              {{ dt.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'telegram'" :class="tg.enabled ? 'ok' : 'muted'">
              {{ tg.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'wecom'" :class="wc.enabled ? 'ok' : 'muted'">
              {{ wc.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'play'" :class="playBadgeClass">{{ playBadgeText }}</em>
            <!--
              ⚠️ 这个徽标必须读**全局**总开关（opts.statusAlerts / opts.patrol）。
              以前这里写的是 dt.statusAlerts / dt.patrol —— 那是「钉钉渠道是否接收」
              的子开关，于是出现「正文芯片写着未启用、页签却亮着 on」的自相矛盾：
              全局关着，渠道级却因为内置/初始化默认值是 true 而点亮。
            -->
            <em v-else-if="t.key === 'status'" :class="statusBadgeOn ? 'ok' : 'muted'">
              {{ statusBadgeOn ? 'on' : 'off' }}
            </em>
            <!--
              检测识别 / 后端检测两页也上 on/off 徽标：
              前者读本机「开启实时分析」（opts.analysisEnabled），后者读常驻服务开关
              （opts.backend.enabled）—— 这是**两件事**（本机跑 vs 服务端跑），
              必须各读各的，绝不共用同一个判据，否则会出现「本机页说 on、后端页也说 on」
              却只有一个在真正检测的假象。
            -->
            <em v-else-if="t.key === 'detect'" :class="opts.analysisEnabled ? 'ok' : 'muted'">
              {{ opts.analysisEnabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'backend'" :class="opts.backend && opts.backend.enabled ? 'ok' : 'muted'">
              {{ opts.backend && opts.backend.enabled ? 'on' : 'off' }}
            </em>
            <em v-else-if="t.key === 'flow'" :class="flowTabOn ? 'ok' : 'muted'">
              {{ flowTabOn ? 'on' : 'off' }}
            </em>
          </button>
        </nav>

        <div class="drawer-body">
          <!-- ==================== 摄像头 ==================== -->
          <section class="block" v-show="tab === 'cams'">
          <div class="block-head">
            <h3>摄像头（{{ cams.length }} 路）</h3>
            <button class="btn small" @click="addCamera">+ 新增一路</button>
          </div>
          <p class="hint">
            拖动每行左侧手柄可调整顺序；关掉「显示」开关可临时隐藏该画面。
            每行里的「人脸 / 姿态 / 区域」是这一路的附加分析开关 —— 它们都要在
            「检测识别」页开过对应总开关才会真正生效，把不看的通道关掉最省算力。
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
                  与「检测识别」页的全局总开关是两层：全局开 + 这里开 才真正生效。
                  三项都建立在人形检测之上，所以本路人形识别关着时这里置灰不可点。
                -->
                <button
                  v-for="e in EXT_ITEMS"
                  :key="e.key"
                  class="tag mini ext"
                  :class="{
                    on: camExtOn(cam, e.key) && extGlobalOn(e.key),
                    preset: camExtOn(cam, e.key) && !extGlobalOn(e.key)
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
                    <div class="slot-row" v-for="(s, si) in camSilCfg(cam).slots" :key="'csl-' + si">
                      <span class="slot-idx">{{ si + 1 }}</span>
                      <input class="field mini" type="time" v-model="s.start" @mousedown="openPicker" />
                      <span class="tilde">~</span>
                      <input class="field mini" type="time" v-model="s.end" @mousedown="openPicker" />
                      <span class="slot-tag invalid" v-if="s.start === s.end">起止相同，不生效</span>
                      <span class="slot-tag cross" v-else-if="s.end < s.start">跨零点</span>
                      <button class="btn tiny danger slot-del" title="删除这个时段" @click="removeCamSilSlot(cam, si)">
                        删除
                      </button>
                    </div>
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
            还没有任何画面。点右上角「+ 新增一路」开始添加，或者到「配置方案」页用访问密码载入内置配置。
          </div>
        </section>

        <!-- ==================== 外观（画面布局 + 主题 + 通知位置，item 116 合并） ====================
             原来是两个标签页：「画面布局」和「外观」。两者都是"长什么样、摆在哪"，
             拆开反而要来回切。现在合成一个「外观」，内部按三段分组：
               ① 画面布局（预设网格 / 自定义摆放）
               ② 报警通知位置（item 117：四角可配）
               ③ 界面主题
        -->
        <section class="block" v-show="tab === 'appearance'">
          <!-- ---------- ① 画面布局 ---------- -->
          <div class="block-head">
            <h3>画面布局</h3>
            <span class="state-chip" :class="layoutKey === 'free' ? 'ready' : ''">
              {{ currentLayoutLabel }}
            </span>
          </div>
          <p class="hint">
            顶部工具栏只显示当前布局名称，切换布局都在这里。选一个预设网格，或切到「自定义摆放」后自己拖动、拉伸每一路画面（位置与大小会自动记住）。
          </p>

          <div class="layout-grid">
            <button
              v-for="l in layouts"
              :key="l.key"
              class="layout-item"
              :class="{ on: layoutKey === l.key }"
              @click="emit('update:layoutKey', l.key)"
            >
              <span class="layout-preview" :class="`pv-${l.key}`">
                <i v-for="k in previewCells(l.key)" :key="k"></i>
              </span>
              <span class="layout-label">{{ l.label }}</span>
            </button>
          </div>

          <template v-if="layoutKey === 'free'">
            <div class="toggle-tip">
              <strong>怎么调整？</strong>
              <em>
                ① 鼠标移到画面上，按住左上角 <b>十字手柄</b> 拖动可移动位置；<br />
                ② 按住右下角 <b>角标</b> 拖动可放大 / 缩小；<br />
                ③ 在画面上双击可临时放大查看，按 Esc 退出。
              </em>
            </div>
            <div class="opt">
              <span>
                <strong>重置摆放</strong>
                <em>把所有画面恢复成默认的整齐网格</em>
              </span>
              <button class="btn small" @click="resetFreeLayout">重置为网格</button>
            </div>
          </template>
          <p class="hint" v-else>
            提示：切到「自定义摆放」后，每一路画面都可以单独拖动和拉伸，适合主次分明的大屏。
          </p>

          <div class="divider"></div>

          <!-- ---------- ② 报警通知位置（item 117） ---------- -->
          <div class="block-head">
            <h3>报警通知位置</h3>
            <span class="state-chip" :class="opts.alert && opts.alert.topNotify !== false ? 'ready' : ''">
              {{ opts.alert && opts.alert.topNotify !== false ? '已开启' : '已关闭' }}
            </span>
          </div>
          <p class="hint">
            报警瞬间弹出的那张带缩略图的卡片停靠在哪个角。默认左上角 —— 顶栏下方不压画面。
            靠上的位置会自动让开顶栏。
          </p>

          <div class="opt">
            <span>
              <strong>显示报警通知卡片</strong>
              <em>关掉后报警只记入右下角事件面板与推送，不再弹卡片</em>
            </span>
            <span
              class="switch"
              :class="{ on: opts.alert && opts.alert.topNotify !== false }"
              @click="toggleTopNotify"
            ></span>
          </div>

          <div class="opt col" v-if="opts.alert && opts.alert.topNotify !== false">
            <span>
              <strong>停靠位置</strong>
              <em>报警卡片弹出的角落</em>
            </span>
            <div class="pos-picker">
              <button
                v-for="p in NOTIFY_POSITIONS"
                :key="p.key"
                class="pos-btn"
                :class="[p.key, { on: notifyPos === p.key }]"
                :title="p.label"
                @click="setNotifyPos(p.key)"
              >
                <span class="pos-dot"></span>
                <em>{{ p.label }}</em>
              </button>
            </div>
            <div class="opt-inline">
              <span class="muted">边距</span>
              <input
                class="field mini"
                type="number"
                min="0"
                max="80"
                v-model.number="notifyGap"
                @change="setNotifyGap(notifyGap)"
              />
              <span class="muted">px</span>
            </div>
          </div>

          <div class="toggle-tip">
            <strong>事件面板的位置是固定的</strong>
            <em>
              右下角那个可点开的报警记录列表始终在<b>右下角</b>，不随上面的设置变动 ——
              它是常驻的历史查阅入口，位置固定才不会和拖动的画面抢地方。
            </em>
          </div>

          <div class="divider"></div>

          <!-- ---------- ③ 界面主题 ---------- -->
          <div class="block-head">
            <h3>界面主题</h3>
          </div>
          <p class="hint">
            点击立即生效并自动保存。
            <template v-if="native">「自动」会跟随 iOS 系统的深色模式，在亮色 / 暗黑之间自动切换。</template>
            <template v-else>「自动」跟随系统仅在 iOS App 内提供。</template>
          </p>

          <div class="opt col">
            <span>
              <strong>界面主题</strong>
              <em>当前：{{ themeLabel }}</em>
            </span>
            <div class="theme-row">
              <button
                v-for="t in THEME_OPTIONS"
                :key="t.value"
                class="btn theme-btn"
                :class="{ primary: opts.theme === t.value }"
                :title="t.desc"
                @click="setTheme(t.value)"
              >
                <i class="swatch" :class="'sw-' + t.value"></i>
                {{ t.label }}
              </button>
            </div>
          </div>

          <p class="hint">
            「液态风格」是默认的玻璃质感界面，面板半透明、带毛玻璃与光晕；「暗黑风格」是去蓝调的中性纯黑，OLED 屏幕更省电；「亮色风格」适合白天 / 强光环境。
          </p>
        </section>

        <!-- ==================== 系统维护 ==================== -->
        <section class="block" v-show="tab === 'maintain'">
          <h3>流自愈（持续异常自动恢复）</h3>
          <div class="opt col">
            <span>
              <strong>持续异常自动升级为系统重启</strong>
              <em>被监控通道「解码中断 / 网络断连」后后端会先无限退避重连；若仍长时间起不来，超过阈值即自动重启系统彻底恢复（对应「持续异常 · 解码中断」这类告警）</em>
            </span>
            <label class="opt-inline">
              <span class="switch" :class="{ on: opts.streamRecovery.enabled }" @click="opts.streamRecovery.enabled = !opts.streamRecovery.enabled"></span>
              <span class="muted">{{ opts.streamRecovery.enabled ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
          <div class="opt" v-if="opts.streamRecovery.enabled">
            <span>
              <strong>触发阈值</strong>
              <em>被监控通道持续异常多少分钟后触发系统重启（默认 30 分钟）</em>
            </span>
            <div class="time-row">
              <input class="field mini" type="number" min="1" max="1440" step="1" v-model.number="opts.streamRecovery.restartSystemAfterMin" />
              <span class="tilde">分钟</span>
            </div>
          </div>

          <div class="divider"></div>

          <h3>定时重启系统</h3>
          <div class="opt col">
            <span>
              <strong>按「天 + 小时」定时重启</strong>
              <em>7x24 值守容易积累内存泄漏 / 解码器卡死，到间隔在后端点自愈式重启（重新拉起所有流与前端服务）。重启前会先推送一条通知</em>
            </span>
            <label class="opt-inline">
              <span class="switch" :class="{ on: opts.autoRestart.enabled }" @click="opts.autoRestart.enabled = !opts.autoRestart.enabled"></span>
              <span class="muted">{{ opts.autoRestart.enabled ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
          <div class="opt" v-if="opts.autoRestart.enabled">
            <span>
              <strong>重启间隔</strong>
              <em>每过「N 天 + M 小时」重启一次（例如 1 天 0 小时 = 每天重启；0 天 6 小时 = 每 6 小时重启）</em>
            </span>
            <div class="time-row">
              <input class="field mini" type="number" min="0" max="365" step="1" v-model.number="opts.autoRestart.days" />
              <span class="tilde">天</span>
              <input class="field mini" type="number" min="0" max="23" step="1" v-model.number="opts.autoRestart.hours" />
              <span class="tilde">小时</span>
            </div>
          </div>

          <div class="divider"></div>

          <div class="opt col">
            <span>
              <strong>立即重启系统</strong>
              <em>
                桌面端走原生重启；浏览器 / 后端模式下向后端发重启请求。
                后端重启的流程是「先释放端口 → 拉起新进程 → 确认新进程真的接管端口才退出」，
                失败会自动回滚，不会把服务重启成停机。
              </em>
            </span>
            <button class="btn tiny danger" @click="restartSystemNow">立即重启</button>
          </div>

          <!-- 重启诊断：把「上一次重启到底怎么样了」摆出来。
               用户报过「自动重启没成功、直接停机」，根子就是以前没有可观测性 ——
               失败在日志里完全看不出来。 -->
          <div class="opt col restart-diag">
            <span>
              <strong>重启诊断</strong>
              <em v-if="!restartInfo">点右侧「刷新」查看后端上一次重启的结果与日志位置</em>
              <em v-else-if="!restartInfo.ok">
                未配置后端地址（浏览器 / 桌面端本地模式），或后端未响应；本地模式不需要看这个
              </em>
              <em v-else>
                {{
                  restartInfo.lastAt
                    ? `上次：${fmtRestartTime(restartInfo.lastAt)} · ${restartResultText(restartInfo.lastResult)}`
                    : '还没有重启记录'
                }}
              </em>
            </span>
            <button class="btn tiny" @click="refreshRestartInfo">刷新</button>
          </div>
          <div class="restart-detail" v-if="restartInfo && restartInfo.ok && restartInfo.lastAt">
            <div class="kv"><span>结果</span><b>{{ restartResultText(restartInfo.lastResult) }}</b></div>
            <div class="kv" v-if="restartInfo.lastReason"><span>原因</span><b>{{ restartInfo.lastReason }}</b></div>
            <div class="kv" v-if="restartInfo.lastError"><span>详情</span><b>{{ restartInfo.lastError }}</b></div>
            <div class="kv" v-if="restartInfo.consecFailures">
              <span>连续失败</span><b class="warn">{{ restartInfo.consecFailures }} 次（连续失败会自动暂停自动重启）</b>
            </div>
            <div class="kv" v-if="restartInfo.logFile"><span>日志</span><b class="mono">{{ restartInfo.logFile }}</b></div>
            <div class="kv" v-if="restartInfo.restartedBy">
              <span>本进程</span><b>由自愈重启拉起（上游 pid={{ restartInfo.restartedBy }}）</b>
            </div>
            <div class="restart-history" v-if="restartInfo.history && restartInfo.history.length > 1">
              <div class="sub-label">最近几次</div>
              <div class="hrow" v-for="(h, i) in restartInfo.history.slice().reverse()" :key="i">
                <span class="mono">{{ fmtRestartTime(h.at) }}</span>
                <span>{{ restartResultText(h.result) }}</span>
                <span class="muted ellip">{{ h.reason }}</span>
              </div>
            </div>
          </div>

          <div class="divider"></div>

          <h3>系统级电源操作（重启 / 关机，最后手段）</h3>
          <div class="opt col">
            <span>
              <strong>允许控制整台电脑的电源</strong>
              <em>
                ⚠️ 这不是重启 BossMonitor 进程，而是<strong>动整台机器的电</strong>，会下线几分钟，
                且<strong>之后服务不会自己回来</strong>——除非你另配了开机自启
                （Windows 任务计划程序 / NSSM、macOS launchd、Linux systemd）。
                另外需要管理员 / root 权限（Windows 走 shutdown、Linux 走 systemctl、
                macOS 走 osascript 需「辅助功能」授权）。
                本开关同时解锁远程指令 <code>/hardreboot</code>（重启）与 <code>/shutdown</code>（关闭，比重启更彻底——断电后需人工开机或主板通电自启），两条都需二次确认。
                <template v-if="restartInfo && restartInfo.hardReboot">
                  <br />本机重启将执行：<code>{{ restartInfo.hardReboot.command }}</code>
                </template>
                <template v-if="restartInfo && restartInfo.systemShutdown">
                  <br />本机关机将执行：<code>{{ restartInfo.systemShutdown.command }}</code>
                </template>
              </em>
            </span>
            <label class="opt-inline">
              <span
                class="switch"
                :class="{ on: opts.systemReboot && opts.systemReboot.enabled }"
                @click="opts.systemReboot.enabled = !(opts.systemReboot && opts.systemReboot.enabled)"
              ></span>
              <span class="muted">{{ opts.systemReboot && opts.systemReboot.enabled ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
          <div class="opt col" v-if="opts.systemReboot && opts.systemReboot.enabled">
            <span>
              <strong>自愈重启失败时自动兜底</strong>
              <em>
                只有当「拉起新进程失败 <b>且</b> 回滚也失败」（服务确实已经停机）时才会执行。
                默认关：因为硬重启会把整台机器带走，误触代价大。
              </em>
            </span>
            <label class="opt-inline">
              <span
                class="switch"
                :class="{ on: opts.systemReboot.onFailure }"
                @click="opts.systemReboot.onFailure = !opts.systemReboot.onFailure"
              ></span>
              <span class="muted">{{ opts.systemReboot.onFailure ? '已开启' : '已关闭' }}</span>
            </label>
          </div>
        </section>

        <!-- ==================== 关于系统（+ 数据统计，item 119 合并） ====================
             统计原来单独占一个「统计」标签，但它回答的也是"这台设备跑得怎么样"，
             和系统信息、能力检测是同一类问题。合到一页里，上半部分是设备与能力，
             下半部分是运行统计，按"先看有没有问题、再看跑得怎么样"的顺序排。
        -->
        <section class="block" v-show="tab === 'about'">
          <AboutSystem
            :cameras="cameras"
            :events="events"
            :options="opts"
            :layout-key="layoutKey"
            :hidden-ids="hiddenIds"
          />

          <div class="divider"></div>

          <!-- ---------- 数据统计（item 111 + 119） ---------- -->
          <div class="block-head">
            <h3>数据统计</h3>
            <span class="state-chip">保留 7 天</span>
          </div>
          <p class="hint">
            按天独立计数，<b>不受「报警记录保留条数」限制</b> —— 事件列表被淘汰或清空后，
            这里的数字依然完整。图表与上方系统信息同属一页：先看设备有没有问题，再看它跑得怎么样。
          </p>
          <StatsPanel @reset-done="onStatsReset" />
        </section>

        <!-- ==================== 播放与性能 ==================== -->
        <section class="block" v-show="tab === 'play'">
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

        <section class="block" v-show="tab === 'alert'">
          <div class="block-head">
            <h3>报警提醒方式</h3>
          </div>
          <p class="hint">
            检测到有人活动时，用这些方式第一时间提醒你（网页可以直接放在后台，切到别的窗口也能收到通知）。
          </p>

          <label class="opt">
            <span>
              <strong>左上角弹出通知</strong>
              <em>报警时在大屏左上角弹出简要通知卡片，10 秒后自动消失，点击可定位到该画面</em>
            </span>
            <span class="switch" :class="{ on: opts.alert.topNotify }" @click="opts.alert.topNotify = !opts.alert.topNotify"></span>
          </label>

          <label class="opt">
            <span>
              <strong>系统通知</strong>
              <em>
                报警时弹系统级通知（桌面端 / iOS 原生通知中心，浏览器走网页通知），点击可定位到该画面。
                <b class="wake-state" :class="notifyCls">{{ notifyLine }}</b>
              </em>
            </span>
            <span class="switch" :class="{ on: opts.alert.desktopNotify }" @click="toggleDesktopNotify"></span>
          </label>

          <label class="opt">
            <span>
              <strong>闪烁页面标题</strong>
              <em>页面不在前台时，标签栏会闪「有人活动」，回到页面自动停止</em>
            </span>
            <span class="switch" :class="{ on: opts.alert.flashTitle }" @click="opts.alert.flashTitle = !opts.alert.flashTitle"></span>
          </label>

          <div class="opt">
            <span>
              <strong>事件截图清晰度</strong>
              <em>详情窗与放大查看用的就是这个尺寸；直接从播放器原始画布截取，推荐「原图」</em>
            </span>
            <SelectField cls="mini" v-model.number="opts.alert.shotWidth" :options="OPT_SHOT_WIDTH" />
          </div>

          <label class="opt">
            <span>
              <strong>报警自动放大画面</strong>
              <em>触发时把该通道铺满大屏，方便立刻看清是谁</em>
            </span>
            <span class="switch" :class="{ on: opts.alert.autoZoom }" @click="opts.alert.autoZoom = !opts.alert.autoZoom"></span>
          </label>

          <label class="opt">
            <span>
              <strong>补推完整人形原图</strong>
              <em>报警先按最快的推出去，几秒内再补一张人形完整的原图（通道需开启人形识别）</em>
            </span>
            <span
              class="switch"
              :class="{ on: opts.alert.extraPersonShot !== false }"
              @click="opts.alert.extraPersonShot = opts.alert.extraPersonShot === false"
            ></span>
          </label>

          <label class="opt">
            <span>
              <strong>区分报警音</strong>
              <em>人形报警用三声急促高音，移动报警用两声低音</em>
            </span>
            <span class="switch" :class="{ on: opts.alert.distinctSound }" @click="opts.alert.distinctSound = !opts.alert.distinctSound"></span>
          </label>

          <label class="opt">
            <span>
              <strong>报警声音提醒</strong>
              <em>需要先在页面上点一下（浏览器音频策略）</em>
            </span>
            <span class="switch" :class="{ on: opts.alarmSound }" @click="opts.alarmSound = !opts.alarmSound"></span>
          </label>

          <!--
            免打扰（静默推送）—— item 121 UI 美化。
            原来这几块平铺在页面上，和上下的"检测识别""画面截图"选项混在一起，
            看不出「这是一整套免打扰机制」。现在用一张带标题的卡片把它们圈起来，
            内部再分「① 定时静默（夜间/午休…）」和「② 临时静默（接下来几小时）」，
            状态一目了然，也不会让下面的选项被推得太远。
          -->
          <div class="divider"></div>
          <div class="grp">
            <div class="grp-head">
              <span class="grp-ico quiet">🔕</span>
              <div class="grp-titles">
                <strong>免打扰（静默推送）</strong>
                <em>
                  静默时段内{{ '' }}
                  <b>不再逐条实时推送</b>，改为在结束时刻发一条汇总；
                  时段<b>开始前与结束后各推一条提醒</b>到已配置的三端；
                  临时静默则用来「接下来几小时别吵我」，优先级更高。
                </em>
              </div>
              <span class="switch" :class="{ on: opts.silent.enabled }" @click="opts.silent.enabled = !opts.silent.enabled"></span>
            </div>

            <!-- ---------- ① 定时静默（可多个时段） ---------- -->
            <div class="grp-body" v-if="opts.silent.enabled">
              <div class="sub-label">
                定时静默时段
                <em v-if="activeSlotLabel" class="live-tag">当前生效 {{ activeSlotLabel }}</em>
              </div>
              <p class="hint tight">
                可配多个时段（如夜里 + 午休），每个时段在结束时刻各发一条汇总。
                结束时间早于开始时间视为跨零点（例如 19:00 ~ 08:00）。
              </p>

              <div class="slot-list">
                <div class="slot-row" v-for="(s, i) in slotsOf" :key="i">
                  <span class="slot-idx">{{ i + 1 }}</span>
                  <input class="field mini" type="time" v-model="s.start" @mousedown="openPicker" />
                  <span class="tilde">~</span>
                  <input class="field mini" type="time" v-model="s.end" @mousedown="openPicker" />
                  <span class="slot-tag invalid" v-if="s.start === s.end">起止相同，不生效</span>
                  <span class="slot-tag cross" v-else-if="s.end < s.start">跨零点</span>
                  <button
                    class="btn tiny danger slot-del"
                    title="删除这个时段"
                    :disabled="slotsOf.length <= 1"
                    @click="removeSlot(i)"
                  >
                    删除
                  </button>
                </div>
              </div>

              <div class="slot-actions">
                <button class="btn tiny" @click="addSlot">+ 添加时段</button>
              </div>

              <div class="sub-label mt">静默期间暂停实时推送的渠道</div>
              <div class="ch-pick">
                <label class="chip" :class="{ on: opts.silent.channels.includes('ding') }">
                  <input type="checkbox" value="ding" v-model="opts.silent.channels" /> 钉钉
                </label>
                <label class="chip" :class="{ on: opts.silent.channels.includes('wecom') }">
                  <input type="checkbox" value="wecom" v-model="opts.silent.channels" /> 企业微信
                </label>
                <label class="chip" :class="{ on: opts.silent.channels.includes('tg') }">
                  <input type="checkbox" value="tg" v-model="opts.silent.channels" /> TG
                </label>
              </div>
              <p class="hint tight">
                这一排只管<b>上面的定时时段</b>（夜间 / 午休那一场）。
                从手机远程下发 <code>/silent</code>、<code>/until</code> 默认静默哪几端，
                在「Telegram 推送 → 远程控制 → 可用指令」里单独配 —— 两者互不影响，
                默认值也不一样（那边默认只静默钉钉 + 企微）。
              </p>

              <!-- 免打扰「开始 / 结束」提醒推送（preNotify，默认开） -->
              <div class="opt pre-notify">
                <span>
                  <strong>免打扰开始 / 结束时都推送提醒</strong>
                  <em>
                    进入每个免打扰时段的瞬间推一条「已开启」（时长、期间仍持续统计、结束时间）；
                    时段结束时再推一条「已结束」，并附上本时段捕获的报警汇总 ——
                    即使这段时间一条报警都没有，也会推一条结束提醒。
                    提醒一律发到<b>已配置好的钉钉 / 企业微信 / TG</b>（不受上面「暂停推送的渠道」勾选影响）；
                    下面两个「试发」按钮则只发到<b>上面勾选的渠道</b>，方便单独验证某一个。
                  </em>
                </span>
                <label class="opt-inline">
                  <span
                    class="switch"
                    :class="{ on: opts.silent.preNotify !== false }"
                    @click="opts.silent.preNotify = opts.silent.preNotify === false"
                  ></span>
                  <span class="muted">{{ opts.silent.preNotify !== false ? '已开启' : '已关闭' }}</span>
                </label>
              </div>
              <div class="test-row">
                <template v-if="opts.silent.preNotify !== false">
                  <button class="btn tiny" @click="testPreSilence">试发开始提醒</button>
                  <button class="btn tiny" @click="testPostSilence">试发结束提醒</button>
                  <span class="muted">立即发一条到上方勾选的渠道，看看文案效果（后端模式下由服务端发）</span>
                </template>
                <span class="muted" v-else>关闭后只保留「静默期间有报警才发汇总」，开始 / 结束都不再通知</span>
              </div>

              <p class="silent-state">
                <b>当前状态：</b>{{ silentStatusText }}
                <button class="btn tiny" @click="flushSilentNow">立即推送静默汇总</button>
              </p>
            </div>

            <!-- ---------- ② 临时静默 ---------- -->
            <div class="grp-body temp-silent" :class="{ active: tempActive }">
              <div class="sub-label">
                临时静默
                <em class="live-tag" v-if="tempActive">静默中 · 至 {{ tempInfo.untilLabel }}</em>
              </div>
              <p class="hint tight">
                会议 / 演示 / 临时排查时用：选一个时长或直接指定"静默到几点"，立刻生效，到点自动汇总。
                <b>优先级高于上面的定时静默</b>。
              </p>

              <template v-if="!tempActive">
                <!-- 两种结束方式：按小时 / 指定到几点（含跨天，如"明天 08:00"） -->
                <div class="seg temp-mode">
                  <button class="seg-btn" :class="{ on: tempMode === 'hours' }" @click="tempMode = 'hours'">
                    按小时
                  </button>
                  <button class="seg-btn" :class="{ on: tempMode === 'until' }" @click="tempMode = 'until'">
                    静默到几点
                  </button>
                </div>

              <!-- 时长选择：常用时长铺一行（网格整齐），自定义时长单独一行，不再和 chips 挤在一行 -->
              <div class="temp-dur" v-if="tempMode === 'hours'">
                <div class="temp-quick">
                  <button
                    v-for="h in TEMP_HOURS"
                    :key="h"
                    class="chip sm"
                    :class="{ on: tempHours === h }"
                    @click="tempHours = h"
                  >
                    {{ h }} 小时
                  </button>
                </div>
                <label class="temp-custom">
                  <span class="muted">自定义</span>
                  <input
                    class="field mini"
                    type="number"
                    min="0.5"
                    max="168"
                    step="0.5"
                    v-model.number="tempHours"
                    title="自定义小时数（0.5 ~ 168）"
                  />
                  <span class="muted">小时</span>
                </label>
              </div>

              <div class="temp-until" v-else>
                <input class="field" type="datetime-local" v-model="tempUntilLocal" @mousedown="openPicker" />
                <button class="btn tiny" @click="tempUntilLocal = tomorrowMorning">明天早上 08:00</button>
                <button class="btn tiny" @click="tempUntilLocal = tonightMidnight">今晚 24:00</button>
              </div>

              <div class="temp-chips">
                <span class="muted">静默渠道：</span>
                <button
                  v-for="c in TEMP_CHANNEL_OPTS"
                  :key="c.id"
                  class="chip sm"
                  :class="{ on: tempChannels.includes(c.id) }"
                  @click="toggleTempChannel(c.id)"
                >
                  {{ c.label }}
                </button>
              </div>

              <div class="opt-inline">
                <span class="muted">用途备注（可选）</span>
                <input class="field" type="text" v-model="tempLabel" placeholder="例如：开会 / 临时排查" maxlength="40" />
              </div>

              <div class="test-row">
                <button class="btn small primary" @click="startTempNow">开启临时静默</button>
                <span class="muted" v-if="tempPreview">{{ tempPreview }}</span>
              </div>
              </template>

              <div class="test-row" v-else>
                <span class="state-chip ready">静默中 · 至 {{ tempInfo.untilLabel }}（{{ tempInfo.leftLabel }}）</span>
                <button class="btn small" @click="endTempNow(false)">结束但不推送</button>
                <button class="btn small primary" @click="endTempNow(true)">结束并立即汇总</button>
              </div>
              <p class="hint tight" v-if="tempActive && tempInfo.reason">用途备注：{{ tempInfo.reason }}</p>
            </div>
          </div>

          <!--
            Apple Watch：手腕上的事件查看器。
            手表端是原生 SwiftUI（watchOS 根本没有 WKWebView，复用不了这套界面），
            只做「看事件 + 标已读」。这里不给配置项 —— 配对且安装了手表 App 就自动同步，
            只把连接状态讲清楚，并给一个手动同步入口。
          -->
          <div class="opt col">
            <span>
              <strong>Apple Watch</strong>
              <em>只同步「事件」：抬腕就能看报警，可在手表上标已读。配对后自动同步，无需配置</em>
            </span>
            <div class="test-row">
              <span class="state-chip">{{ watchChip }}</span>
              <button class="btn small" @click="refreshWatch">刷新状态</button>
              <button class="btn small primary" :disabled="!watchState.supported" @click="emit('watch-sync')">
                立即同步
              </button>
            </div>
            <span class="hint">{{ watchStatusText() }}</span>
          </div>
        </section>

        <section class="block" v-show="tab === 'detect'">
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

          <!-- ==================== AI 扩展分析 ==================== -->
          <div class="block-head sub">
            <h3>AI 扩展分析</h3>
            <span class="state-chip" :class="gpuReady ? 'ready' : ''">{{ gpuText }}</span>
          </div>
          <p class="hint">
            以下三项都建立在人形检测之上，<b>默认全部关闭</b>，可以按需单独开启。
            实测单次推理耗时：人脸检测 19ms、人脸特征 39ms、姿态 48ms（都走 WebGPU）；
            没有 WebGPU 的设备会回退 WASM，慢 5~10 倍 —— 那种情况下建议只开「区域规则」。
          </p>

          <!-- ---------- 区域规则 ---------- -->
          <div class="sub-title">
            区域规则
            <em>零额外模型：靠人形轨迹判断，几乎不增加算力</em>
          </div>

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

          <!-- ---------- 人脸识别 ---------- -->
          <div class="sub-title">
            人脸识别
            <em>SCRFD 人脸检测 + MobileFaceNet 特征 · 本地人脸库</em>
          </div>

          <label class="opt">
            <span>
              <strong>开启人脸识别</strong>
              <em>识别到已录入的人会用姓名播报与推送；此时才会加载人脸模型</em>
            </span>
            <span class="switch" :class="{ on: opts.face.enabled }" @click="opts.face.enabled = !opts.face.enabled"></span>
          </label>

          <template v-if="opts.face.enabled">
            <div class="opt">
              <span>
                <strong>人脸检测阈值</strong>
                <em>越高越严格</em>
              </span>
              <div class="range-row">
                <input type="range" min="0.3" max="0.9" step="0.05" v-model.number="opts.face.score" />
                <b>{{ Number(opts.face.score).toFixed(2) }}</b>
              </div>
            </div>

            <div class="opt">
              <span>
                <strong>同一个人判定阈值</strong>
                <em>相似度高于该值才算同一个人（越高越不容易认错，但可能认不出）</em>
              </span>
              <div class="range-row">
                <input type="range" min="0.25" max="0.6" step="0.01" v-model.number="opts.face.matchThreshold" />
                <b>{{ Number(opts.face.matchThreshold).toFixed(2) }}</b>
              </div>
            </div>

            <label class="opt">
              <span>
                <strong>识别到已录入的人时报警</strong>
                <em>关闭后只做人脸库比对，不产生事件</em>
              </span>
              <span class="switch" :class="{ on: opts.face.eventOnKnown }" @click="opts.face.eventOnKnown = !opts.face.eventOnKnown"></span>
            </label>

            <label class="opt">
              <span>
                <strong>陌生人脸也记事件</strong>
                <em>默认关：未录入的人脸会出现在下面「待录入」里，但不会刷报警</em>
              </span>
              <span class="switch" :class="{ on: opts.face.eventOnUnknown }" @click="opts.face.eventOnUnknown = !opts.face.eventOnUnknown"></span>
            </label>

            <label class="opt">
              <span>
                <strong>收集陌生人脸</strong>
                <em>把没录入的人脸暂存到「待录入」，方便事后一键建档</em>
              </span>
              <span class="switch" :class="{ on: opts.face.collectUnknown }" @click="opts.face.collectUnknown = !opts.face.collectUnknown"></span>
            </label>

            <label class="opt">
              <span>
                <strong>画面上显示人脸框</strong>
                <em>识别到的人脸框上会标出姓名</em>
              </span>
              <span class="switch" :class="{ on: opts.face.drawBox }" @click="opts.face.drawBox = !opts.face.drawBox"></span>
            </label>

            <div class="opt">
              <span>
                <strong>同一个人报警间隔</strong>
                <em>同一个人两次人脸事件的最小间隔</em>
              </span>
              <div class="test-row">
                <input class="field mini" type="number" min="3" max="600" v-model.number="opts.face.cooldownSec" />
                <span class="unit">秒</span>
              </div>
            </div>

            <div class="opt">
              <span>
                <strong>人脸库容量</strong>
                <em>上限，满了必须先删人才能继续录入</em>
              </span>
              <div class="test-row">
                <input class="field mini" type="number" min="1" max="500" v-model.number="opts.face.libMax" />
                <span class="unit">人</span>
              </div>
            </div>

            <!-- 采集调优（高级）：三个原本写死在代码里的旋钮。
                 缺省值 = 原常量，所以不动它就与升级前完全一致。 -->
            <div class="opt">
              <span>
                <strong>采集调优（高级）</strong>
                <em>抓不到人脸时再动这里；改动会影响识别开销</em>
              </span>
              <div class="test-row">
                <button class="mini-btn ghost" @click="faceTuneOpen = !faceTuneOpen">
                  {{ faceTuneOpen ? '收起' : '展开' }}
                </button>
              </div>
            </div>

            <template v-if="faceTuneOpen">
              <div class="opt">
                <span>
                  <strong>失败重试间隔</strong>
                  <em>提特征失败后多久允许再试；越小越能抓住「人站着但那一帧没提成功」</em>
                </span>
                <div class="test-row">
                  <input class="field mini" type="number" min="100" max="5000" step="50" v-model.number="opts.face.retryMs" />
                  <span class="unit">毫秒</span>
                </div>
              </div>

              <div class="opt">
                <span>
                  <strong>同一人重提间隔</strong>
                  <em>同一个人的脸多少秒内不重复提特征（省算力）</em>
                </span>
                <div class="test-row">
                  <input class="field mini" type="number" min="2" max="60" v-model.number="opts.face.dedupeSec" />
                  <span class="unit">秒</span>
                </div>
              </div>

              <div class="opt">
                <span>
                  <strong>头部补检范围</strong>
                  <em>按人形框顶部多大比例裁剪放大再检（救远处漏检的脸）；越大越费算力</em>
                </span>
                <div class="range-row">
                  <input type="range" min="0.2" max="0.9" step="0.05" v-model.number="opts.face.headRatio" />
                  <b>{{ Number(opts.face.headRatio).toFixed(2) }}</b>
                </div>
              </div>

              <div class="opt">
                <span>
                  <strong>检测输入边长</strong>
                  <em>调大能救更远的脸，代价是每帧推理更慢。非 640 时后端日志会打 ONNX 形状告警（无害，模型是动态导出的）</em>
                </span>
                <div class="test-row">
                  <select class="field mini" v-model.number="opts.face.detSize">
                    <option v-for="s in FACE_DET_SIZES" :key="s" :value="s">{{ s }}</option>
                  </select>
                  <span class="unit">像素</span>
                </div>
              </div>

              <div class="opt">
                <span>
                  <strong>待录入队列容量</strong>
                  <em>
                    攒满这么多张未录入人脸就滚动删最旧的（新的照收）；同时是「满库」提醒阈值。
                    0 = 自动（后端 100 / 纯前端 24）
                  </em>
                </span>
                <div class="test-row">
                  <input class="field mini" type="number" min="0" max="500" v-model.number="opts.face.pendingFullAt" />
                  <span class="unit">张</span>
                </div>
              </div>

              <div class="opt">
                <span>
                  <strong>重复捕获合并间隔</strong>
                  <em>
                    同一个人在间隔内被反复采到，只刷新已有那条（不新增）；间隔外再来才给一条新鲜样本。
                    0 = 关闭去重（每张都单独保留）。默认 300 秒
                  </em>
                </span>
                <div class="test-row">
                  <input class="field mini" type="number" min="0" max="86400" v-model.number="opts.face.pendingDedupeSec" />
                  <span class="unit">秒</span>
                </div>
              </div>

              <div class="opt">
                <span>
                  <strong>满库预警线</strong>
                  <em>到容量的这个比例先提醒一次（默认 0.8）；再涨到满会再提醒一次</em>
                </span>
                <div class="range-row">
                  <input type="range" min="0.5" max="0.99" step="0.05" v-model.number="opts.face.pendingWarnRatio" />
                  <b>{{ Math.round((Number(opts.face.pendingWarnRatio) || 0.8) * 100) }}%</b>
                </div>
              </div>

              <div class="opt">
                <span>
                  <em>这几个值会随配置同步到后端检测服务；改完记得点右下角「保存并应用」</em>
                </span>
                <div class="test-row">
                  <button class="mini-btn ghost" @click="resetFaceTune">恢复默认</button>
                </div>
              </div>
            </template>

            <!-- 待录入（前端 / 后端检测到的都会列进来）
                 ⚠️ 这一块**刻意不挂 v-if**。
                 以前是 v-if="allPendingFaces.length"，空的时候整块直接消失 ——
                 于是「后端没连上」「没开收集陌生人脸」「确实没人来过」三种情况
                 在界面上长得一模一样：都是一片空白。用户只能反复点刷新，
                 或者以为「抓到的脸没进库」。空态必须自己开口说话。 -->
            <div class="opt col">
              <span>
                <strong>
                  待录入人脸（{{ allPendingFaces.length }}）
                  <button class="mini-btn ghost" @click="pendingLibOpen = !pendingLibOpen">
                    {{ pendingLibOpen ? '收起' : '管理' }}
                  </button>
                </strong>
                <em>点「录入」建档并自动编号，之后可以在人脸库里改名</em>
              </span>

                <div class="face-grid" ref="pendingGridEl" v-if="pendingLibOpen && allPendingFaces.length">
                <div class="face-card pending" v-for="pf in pagedPending" :key="pf.id">
                  <img
                    :src="pf.thumb"
                    alt="待录入人脸"
                    class="pending-thumb"
                    :class="{ clickable: pf.full }"
                    :title="pf.full ? '点击查看捕获时的原图' : ''"
                    @click="pf.full && openPendingShot(pf)"
                  />
                  <span class="face-meta">{{ pf.camName || '未知通道' }}</span>
                  <span class="face-time" v-if="pf.at">{{ fmtPendingAt(pf.at) }}</span>
                  <!-- 录入时手动归入：选已知的人（同名归到他那一堆）或自定义名字；留空=自动编号，保持旧行为 -->
                  <div class="face-assign" v-if="faceNameOptions.length">
                    <FaceAssignSelect
                      v-model="pendingAssign[pf.id]"
                      :options="faceNameOptions"
                      placeholder="新建（自动编号）"
                      :custom="true"
                      custom-placeholder="自定义名字"
                      :disabled="enrollingPending[pf.id]"
                    />
                  </div>
                  <div class="face-acts">
                    <button class="mini-btn" :disabled="enrollingPending[pf.id]" @click="doAddPending(pf)">
                      {{ enrollingPending[pf.id] ? '录入中' : '录入' }}
                    </button>
                    <button class="mini-btn ghost" v-if="!enrollingPending[pf.id]" :disabled="enrollingPending[pf.id]" @click="doIgnorePending(pf)">忽略</button>
                  </div>
                </div>
              </div>

              <!-- 空态占位（展开且没有待录入时）：把「为什么是空的」说清楚，并给一条能立刻做的动作 -->
              <div class="pending-empty" v-else-if="pendingLibOpen">
                <span class="pe-icon" aria-hidden="true">{{ pendingEmpty.icon }}</span>
                <div class="pe-body">
                  <strong class="pe-title">{{ pendingEmpty.title }}</strong>
                  <em class="pe-hint">{{ pendingEmpty.hint }}</em>
                </div>
              </div>

              <!-- 收起状态下的「空白」摘要：默认收起不等于让空白无声无息 ——
                   数量为 0 时仍给一行，说明为什么是空的；想知道细节再点「管理」。 -->
              <p class="hint tight" v-if="!pendingLibOpen && !allPendingFaces.length">
                {{ pendingEmpty.title }} · 点「管理」查看原因
              </p>

              <div class="face-pager" v-if="pendingLibOpen && pendingPageCount > 1">
                <button class="mini-btn ghost" :disabled="pendingPage <= 1" @click="pendingPage -= 1">上一页</button>
                <span class="face-page-text">{{ pendingPage }} / {{ pendingPageCount }}</span>
                <button class="mini-btn ghost" :disabled="pendingPage >= pendingPageCount" @click="pendingPage += 1">下一页</button>
              </div>
              <div class="face-acts" v-if="pendingLibOpen">
                <button class="mini-btn ghost" v-if="allPendingFaces.length && pendingPageCount > 1" @click="doIgnorePagePending">本页忽略</button>
                <button class="mini-btn danger" v-if="allPendingFaces.length" @click="doIgnoreAllPending">全部忽略</button>
                <button
                  class="mini-btn ghost"
                  v-if="faceBackendOn"
                  :disabled="pendingRefreshing"
                  @click="refreshBackendPending"
                >
                  {{ pendingRefreshing ? '刷新中…' : '刷新待录入' }}
                </button>
                <span class="muted" v-if="faceBackendOn && !pendingRefreshNote">来自后端检测服务</span>
                <span class="muted pending-refresh-note" v-if="pendingRefreshNote">{{ pendingRefreshNote }}</span>
              </div>
            </div>

            <!-- 命中修正（仅后端模式：命中样本由后端检测服务存着）
                 已入库人脸的命中以前只发事件、不存向量 —— 想修正「认成小刘、
                 实际是大刘」这种错判时，手里只剩一张图，没有 512 维向量可重新录入。
                 后端现在每次命中都存下当帧向量 + 当时认定的名字，这里列出最近 20 条，
                 确认认错后按正确名字「修正」：这条向量会作为一条正确标签的样本
                 录进人脸库（自动同步到后端），后续同一张脸的余弦相似度就会落到
                 对的人名下 —— 识别精准度随之提升。 -->
            <div class="opt col" v-if="faceBackendOn">
              <span>
                <strong>
                  命中修正（{{ backendFaceHits.length }}）
                  <button class="mini-btn ghost" @click="hitReviewOpen = !hitReviewOpen">
                    {{ hitReviewOpen ? '收起' : '管理' }}
                  </button>
                </strong>
                <em>最近 {{ backendFaceHits.length }} 条命中样本（带原图）；认错了就按正确名字修正，提升后续识别精准度</em>
              </span>

              <div class="face-grid" v-if="hitReviewOpen && backendFaceHits.length">
                <div class="face-card hit" v-for="h in backendFaceHits" :key="h.id">
                  <img
                    :src="h.thumb"
                    alt="命中人脸"
                    class="pending-thumb"
                    :class="{ clickable: h.full }"
                    :title="h.full ? '点击查看命中时的原图' : ''"
                    @click="h.full && openPendingShot(h)"
                  />
                  <span class="hit-cur" :title="h.name || '未识别'">认成：{{ h.name || '未识别' }}</span>
                  <span class="face-meta">相似度 {{ (h.score * 100).toFixed(0) }}%</span>
                  <span class="face-meta">{{ h.camName || '未知通道' }}</span>
                  <span class="face-time" v-if="h.at">{{ fmtPendingAt(h.at) }}</span>
                  <!-- 正确名字：选库里已有的人，或选「自定义」填一个；修正 = 按这个名字把样本录进人脸库 -->
                  <div class="face-assign" v-if="faceNameOptions.length">
                    <FaceAssignSelect
                      v-model="hitAssign[h.id]"
                      :options="faceNameOptions"
                      placeholder="选正确的人"
                      :custom="true"
                      custom-placeholder="自定义正确名字"
                      :disabled="fixingHit[h.id]"
                    />
                  </div>
                  <div class="face-acts">
                    <button class="mini-btn" :disabled="fixingHit[h.id]" @click="doFixHit(h)">
                      {{ fixingHit[h.id] ? '修正中' : '修正' }}
                    </button>
                    <!-- 「不是本人」= 陌生人被误认成了库里某人：忽略只删样本不治本，
                         标记成反例后，匹配时反例更相似即判未录入，同一张脸不再冒名 -->
                    <button
                      class="mini-btn ghost"
                      :disabled="fixingHit[h.id]"
                      title="这条是陌生人被误认成了「{{ h.name || '未识别' }}」——标记后同一张脸再来会直接判未录入"
                      @click="doMarkStranger(h)"
                    >
                      不是本人
                    </button>
                    <button class="mini-btn ghost" :disabled="fixingHit[h.id]" @click="doIgnoreHit(h)">忽略</button>
                  </div>
                </div>
              </div>

              <!-- 空态占位：把「为什么是空的」说清楚，并给一条能立刻做的动作 -->
              <div class="pending-empty" v-else-if="hitReviewOpen">
                <span class="pe-icon" aria-hidden="true">{{ hitEmpty.icon }}</span>
                <div class="pe-body">
                  <strong class="pe-title">{{ hitEmpty.title }}</strong>
                  <em class="pe-hint">{{ hitEmpty.hint }}</em>
                </div>
              </div>

              <div class="face-acts" v-if="hitReviewOpen">
                <button class="mini-btn ghost" :disabled="hitRefreshing" @click="refreshBackendFaceHits">
                  {{ hitRefreshing ? '刷新中…' : '刷新命中' }}
                </button>
                <span class="muted" v-if="!hitRefreshNote">来自后端检测服务</span>
                <span class="muted pending-refresh-note" v-if="hitRefreshNote">{{ hitRefreshNote }}</span>
              </div>
            </div>

            <!-- 陌生人标记（反例）：被误认成库里某人的陌生脸
                 标记 = 把这条脸的向量存成反例；匹配时「反例分 ≥ 阈值且 ≥ 库内最像分」
                 即判未录入，之后同一张脸再来直接走待录入/陌生人路径，不再冒名。
                 库里真人本人不受影响（对自己样本 ~0.9，天然压过对陌生反例的分）。
                 与拆分声明同模式：IndexedDB 为源、随配置同步后端、重启恢复。 -->
            <div class="opt col" v-if="faceBackendOn">
              <span>
                <strong>
                  陌生人标记（{{ strangerMarks.length }}）
                  <button class="mini-btn ghost" @click="blockLibOpen = !blockLibOpen">
                    {{ blockLibOpen ? '收起' : '管理' }}
                  </button>
                </strong>
                <em>被误认成库里某人的陌生脸；标记后同一张脸再来会直接判「未录入」，不再冒名</em>
              </span>

              <div class="face-grid" v-if="blockLibOpen && strangerMarks.length">
                <div class="face-card block" v-for="b in strangerMarks" :key="b.id">
                  <img :src="b.thumb" alt="陌生人脸" class="pending-thumb" />
                  <span class="hit-cur" :title="b.name">曾被认成：{{ b.name || '未知' }}</span>
                  <span class="face-time" v-if="b.at">{{ fmtPendingAt(b.at) }}</span>
                  <div class="face-acts">
                    <button class="mini-btn ghost" @click="doUnmarkStranger(b)">解除</button>
                  </div>
                </div>
              </div>

              <div class="pending-empty" v-else-if="blockLibOpen">
                <span class="pe-icon" aria-hidden="true">🚫</span>
                <div class="pe-body">
                  <strong class="pe-title">还没有陌生人标记</strong>
                  <em class="pe-hint">
                    在「命中修正」里看到陌生人被认成了某人，点卡片上的「不是本人」即可标记；之后同一张脸再来会直接走待录入/陌生人路径。
                  </em>
                </div>
              </div>
            </div>

            <!-- 人脸库 -->
            <div class="opt col">
              <span>
                <strong>
                  人脸库（{{ faceLib.length }} / {{ opts.face.libMax }}）
                  <span class="opt-acts">
                    <button class="mini-btn ghost" @click="faceLibOpen = !faceLibOpen">
                      {{ faceLibOpen ? '收起' : '管理' }}
                    </button>
                    <button class="mini-btn" @click="triggerEnrollFile" :disabled="enrollState === 'loading'">
                      {{ enrollState === 'loading' ? '录入中…' : '上传照片录入' }}
                    </button>
                  </span>
                </strong>
                <em>报警推送里显示的就是这里的名字；同一个人的多个角度会归到一张卡片，共用一个名字</em>
              </span>
              <input
                ref="enrollFileEl"
                type="file"
                accept="image/*"
                class="hidden-file"
                @change="onEnrollFile"
              />
              <!-- 上传录入的反馈：明确告诉用户「在干嘛 / 成没成」，不靠静默或 alert -->
              <p class="enroll-status" v-if="enrollState !== 'idle'" :class="enrollState === 'error' ? 'err' : (enrollState === 'done' ? 'ok' : 'busy')">
                {{ enrollMsg }}
              </p>

              <!-- 同一人归类：只在"确实有人占了多条"时才出现（没重复就没什么可归的） -->
              <div class="face-group-toggle" v-if="faceLibOpen && groupedExtra > 0">
                <span class="switch" :class="{ on: groupBySim }" @click="toggleGroupBySim"></span>
                <span>
                  <strong>同一人归类显示</strong>
                  <em>
                    已把同一人的多角度样本并到一张卡片：{{ faceGroups.length }} 人 · {{ faceLib.length }} 条样本。
                    判据是「相同名字」或「相似度 ≥ {{ Number(groupThreshold).toFixed(2) }}」（与上面的识别阈值同一个数）。
                    觉得并错了就关掉，立刻恢复一张一条。
                  </em>
                </span>
              </div>

              <!-- 手动拆分管理：已生效的「这两个不是同一人」声明，可随时解除。
                   默认收起（占位置）；标题行常显带数量，点「展开」才铺开。 -->
              <div class="face-splits" v-if="faceLibOpen && activeSplits.length">
                <div class="face-splits-head">
                  <strong>手动拆分（{{ activeSplits.length }}）</strong>
                  <button class="mini-btn ghost" @click="faceSplitsOpen = !faceSplitsOpen">
                    {{ faceSplitsOpen ? '收起' : '展开' }}
                  </button>
                </div>
                <template v-if="faceSplitsOpen">
                  <em>
                    以下两组被显式声明为<b>不同的人</b>：不会因相似度被并到一起，推送也各叫各的名。
                    解除后立即恢复自动归类。
                  </em>
                  <div class="face-split-row" v-for="s in activeSplits" :key="s.id">
                    <span class="face-split-pair">{{ splitLabel(s) }}</span>
                    <button class="mini-btn ghost" :disabled="!!removingSplit[s.id]" @click="doRemoveSplit(s)">
                      {{ removingSplit[s.id] ? '解除中…' : '解除' }}
                    </button>
                  </div>
                </template>
              </div>

              <div class="face-grid" v-if="faceLibOpen" ref="libGridEl">
                <div
                  class="face-card"
                  :class="{ grouped: g.count > 1, selected: selectedGroupKey === g.key }"
                  v-for="g in pagedFaceGroups"
                  :key="g.key"
                >
                  <!-- 缩略图 = 这个人最早录入的那张（代表样本）；多条时可点开看全部角度 -->
                  <div
                    class="face-thumb"
                    :class="{ clickable: g.count > 1 }"
                    :title="g.count > 1 ? '点开看这个人的全部角度样本' : ''"
                    @click="toggleGroupPanel(g)"
                  >
                    <img v-if="g.thumb" :src="g.thumb" alt="人脸" />
                    <span class="face-count" v-if="g.count > 1">{{ g.count }}</span>
                    <span
                      class="face-warn"
                      v-if="g.count > 1 && g.sameName === false"
                      title="这一组里有多个名字，推送时会各按各的名字 —— 改名可统一"
                      >!</span
                    >
                  </div>
                  <div class="face-rename" v-if="faceRenameKey === g.key">
                    <input
                      class="field mini"
                      v-model.trim="faceRenameText"
                      :disabled="renamingFace[g.key]"
                      :placeholder="g.name"
                      @keyup.enter="commitRenameGroup"
                      @blur="commitRenameGroup"
                    />
                  </div>
                  <span class="face-meta" v-else :title="g.name">{{ g.name }}</span>
                  <!-- 手动归类（卡级）：把"这个人"整体归入另一个已知的人。
                   * 修的是自动归类把同一个人拆成两张卡的情况 —— 选另一个人的名字，
                   * 这一整张卡的样本会一起改过去、重新并到那个人那一组。
                   * 只在"库里确实有其它人可并"时才出现（没别人可并就没什么可归的）。 -->
                  <div class="face-assign" v-if="otherNames(g).length">
                    <FaceAssignSelect
                      v-model="groupAssign[g.key]"
                      :options="otherNames(g)"
                      placeholder="归入到…"
                      :disabled="assigningGroup[g.key]"
                      @change="onGroupAssign(g)"
                    />
                  </div>
                  <div class="face-acts">
                    <!-- 保存中：明确的「在干活」反馈 —— 没有它就是用户嘴里的"点了没反应" -->
                    <button class="mini-btn face-busy" v-if="renamingFace[g.key]" disabled>保存中</button>
                    <template v-else>
                      <button class="mini-btn ghost" v-if="!deletingFace[g.key]" @click="startRenameGroup(g)">改名</button>
                      <button class="mini-btn danger" :disabled="deletingFace[g.key]" @click="doDeleteGroup(g)">{{ deletingFace[g.key] ? '删除中' : '删除' }}</button>
                    </template>
                  </div>
                </div>
                <p class="hint tight" v-if="!faceLib.length">人脸库还是空的：先让摄像头拍到人，出现的脸会进「待录入」。</p>
              </div>

              <!-- 点开一张「一个人」的卡片：看他的全部角度样本，可合并、可删掉拍歪的那张 -->
              <div class="face-group-panel" v-if="selectedGroup">
                <div class="fgp-head">
                  <strong>{{ selectedGroup.name }}</strong>
                  <span class="fgp-tag">{{ selectedGroup.count }} 个角度样本</span>
                  <span class="fgp-tag warn" v-if="selectedGroup.sameName === false">
                    名字不一致 · 最弱一环 {{ simPct(selectedGroup.score) }}
                  </span>
                  <span class="fgp-tag ok" v-else>同名归为一组</span>
                  <span class="fgp-acts">
                    <!-- 按名字拆分：这一组里其实是两个人（名字不同、只是长得像被并了）→ 显式拆开。
                         拆分是持久声明，优先于相似度；之后新录入的同名样本也受同一条声明保护。 -->
                    <button
                      class="mini-btn"
                      v-if="selectedGroup.sameName === false && splitNames(selectedGroup).length >= 2"
                      :disabled="!!splittingGroup"
                      @click="doSplitGroup(selectedGroup)"
                    >
                      {{ splittingGroup ? '拆分中…' : '按名字拆分' }}
                    </button>
                    <!-- 合并勾选：默认全选，取消勾选可把某些角度排除在合并之外
                         （不同角度全并成一条平均脸会丢角度覆盖，见脚本注释） -->
                    <label class="fgp-allcheck" :title="mergeAllChecked ? '全部不选' : '全部选中'">
                      <input type="checkbox" :checked="mergeAllChecked" @change="toggleMergeAll" />
                      <span>{{ mergeAllChecked ? '全不选' : '全选' }}</span>
                    </label>
                    <button
                      class="mini-btn"
                      :disabled="!!mergingGroup || mergeSelCount < 2"
                      @click="doMergeGroup(selectedGroup)"
                    >
                      {{
                        mergingGroup
                          ? '合并中…'
                          : mergeSelCount < selectedGroup.count
                            ? `合并勾选的 ${mergeSelCount} 条`
                            : '合并为一条'
                      }}
                    </button>
                    <button class="mini-btn ghost" @click="selectedGroupKey = ''">收起</button>
                  </span>
                </div>
                <div class="fgp-samples">
                  <div class="fgp-item" v-for="(it, i) in selectedGroup.items" :key="it.id">
                    <label class="fgp-check" :title="mergeSelected.includes(it.id) ? '不参与合并' : '参与合并'">
                      <input type="checkbox" :value="it.id" v-model="mergeSelected" />
                    </label>
                    <img v-if="it.thumb" :src="it.thumb" alt="样本" />
                    <span class="fgp-sim" :title="i === 0 ? '代表样本（最早录入的那张）' : '与代表样本的相似度'">{{ i === 0 ? '代表' : simPct(it.sim) }}</span>
                    <span class="fgp-name" :title="it.name">{{ it.name }}</span>
                    <!-- 手动归入：把这一条样本单独改名到某个人（修自动归类误并的问题） -->
                    <div class="fgp-assign">
                      <FaceAssignSelect
                        v-model="sampleAssign[it.id]"
                        :options="faceNameOptions"
                        placeholder="归入…"
                        :custom="true"
                        custom-placeholder="自定义名字"
                        custom-confirm-text="确定"
                        :disabled="assigningSample[it.id]"
                        @change="onSampleAssign(it)"
                      />
                    </div>
                    <button class="mini-btn danger" :disabled="deletingSample[it.id]" @click="doDeleteSample(it)">
                      {{ deletingSample[it.id] ? '删除中' : '删除' }}
                    </button>
                  </div>
                </div>
                <!-- 名字这件事必须说透：推送里叫什么，取决于这几条的**名字是否统一** -->
                <p class="hint tight" v-if="selectedGroup.sameName === false">
                  这 {{ selectedGroup.count }} 条现在各有各的名字（{{ selectedGroup.names.join(' / ') }}），
                  推送会按命中的那条来 —— 也就是同一个人的不同角度可能推出不同名字。
                  点卡片上的「改名」统一成一个名字后，不管哪个角度都推这个名字。
                  <template v-if="splitNames(selectedGroup).length >= 2">
                    <br />
                    如果这其实是**两个人**（只是长得像被并到了一起）：点上方「按名字拆分」，
                    两人会各自成卡、推送也各叫各的名；拆分后新录入的同名样本同样受保护。
                  </template>
                </p>
                <p class="hint tight" v-else>
                  这几条同名，推送里都用「{{ selectedGroup.name }}」；改名会一起改。
                  勾选想合并的角度样本，点「合并为一条」把它们的特征平均成一条：适合同一角度拍重了的去重、腾名额；
                  <b>不同角度的样本建议保持不勾选</b>——识别时是逐条取最高相似度，角度留得全更容易命中。
                </p>
              </div>

              <div class="face-pager" v-if="faceLibOpen && libPageCount > 1">
                <button class="mini-btn ghost" :disabled="libPage <= 1" @click="libPage -= 1">上一页</button>
                <span class="face-page-text">{{ libPage }} / {{ libPageCount }}</span>
                <button class="mini-btn ghost" :disabled="libPage >= libPageCount" @click="libPage += 1">下一页</button>
              </div>
              <div class="face-acts" v-if="faceLibOpen && faceLib.length">
                <button class="mini-btn danger" @click="doClearFaces">清空人脸库</button>
              </div>
            </div>
          </template>

          <!-- ---------- 人形姿态 ---------- -->
          <div class="sub-title">
            人形姿态
            <em>YOLOv8n-pose 17 关键点 · 每帧每人约 48ms（WebGPU）</em>
          </div>

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

        <!--
          ==================== 后端检测（headless 常驻服务） ====================
          从「检测识别」里拆出来单独一页：本机算法与「把算法搬到服务端」是同一件事的
          两种跑法，混在一页里，用户分不清「我关的是本机分析、还是后端服务」。

          ⚠️ 两个开关的语义必须各说各的：
            · 检测识别页的「开启实时分析」= 浏览器自己跑不跑（本页关掉页面就没了）
            · 本页的「启用后端检测」  = 常驻服务跑不跑（关掉本机页面也在盯）
        -->
        <!-- ==================== 人员流向（跨摄像头走向） ==================== -->
        <section class="block" v-show="tab === 'flow'">
          <div class="block-head">
            <h3>人员流向（跨摄像头走向）</h3>
            <span class="state-chip" :class="flowSummary.ok ? 'ready' : (flowSummary.enabled ? 'warn' : '')">{{ flowSummary.text }}</span>
          </div>
          <p class="hint">
            建立在人形轨迹 / 人脸识别之上：当<b>同一个人</b>先在某个区域<b>离场</b>，
            又在时间窗内依次出现在后续区域的<b>入场</b>，就记一次「走向」事件，推送
            「谁从哪去了哪」。支持多跳（A→B→C…）—— 点「加途经点」可串更长。
            默认靠人脸归组名判定身份（几乎零额外算力）；也可放宽到不要求人脸。
            属于轻量离散相遇判定，不是实时轨迹画线。
          </p>
          <p class="hint tight">
            保存流向会自动开启相关摄像头的「区域监测」与相关区域的「进出检测」——
            这是流向的物理前提（流向本质就是检测某人进出这些区域）。你仍可单独在区域规则里关掉
            「走出 / 走入区域」<b>报警</b>，不影响流向；但若手动关掉某个流向节点的「进出检测」，这里会标红「🔴 前提未满足」。
          </p>

          <div class="flow-head">
            <strong>已配置流向（{{ (opts.flows || []).length }} 条）</strong>
            <button class="btn small primary" @click="addFlow">＋ 新增流向</button>
          </div>

          <p class="hint tight" v-if="!(opts.flows || []).length">
            还没有任何流向。点「新增流向」创建第一条，例如「门口 → 走廊」「电梯厅 → 办公区」。
          </p>

          <div class="flow-card" v-for="(flow, i) in (opts.flows || [])" :key="flow.id || i">
            <div class="flow-card-head">
              <input
                class="field flow-name"
                type="text"
                maxlength="20"
                v-model.trim="flow.name"
                placeholder="流向名称（如：门口→走廊）"
              />
              <label class="switch-wrap" title="启用该流向">
                <span class="switch" :class="{ on: flow.enabled }" @click="flow.enabled = !flow.enabled"></span>
              </label>
              <button class="icon-btn danger" title="删除该流向" @click="removeFlow(i)">🗑</button>
            </div>

            <div class="flow-route">
              <template v-for="(node, ni) in flow.path" :key="ni">
                <div class="flow-end">
                  <div class="flow-end-label">
                    <span>{{ ni === 0 ? '起点（从）' : (ni === flow.path.length - 1 ? '终点（到）' : '途经') }}</span>
                    <button
                      v-if="flow.path.length > 2"
                      class="icon-btn danger xsm"
                      title="删除该节点"
                      @click="removeFlowNode(flow, ni)"
                    >✕</button>
                  </div>
                  <SelectField
                    cls="mini wide"
                    v-model="node.cam"
                    :options="camOptions"
                    :placeholder="`第 ${ni + 1} 个节点摄像头`"
                    @change="node.zone = ''"
                  />
                  <SelectField
                    cls="mini wide"
                    v-model="node.zone"
                    :options="zoneOptions(node.cam)"
                    :placeholder="`第 ${ni + 1} 个节点区域`"
                  />
                  <p class="hint tight" v-if="node.cam && !zoneOptions(node.cam).length">
                    该摄像头还没有区域。请到对应画面的「更多操作 → 进出 / 徘徊区域」（图标 ▤）拖拽圈选，不是「圈选检测区域」（图标 ▢）。
                  </p>
                </div>
                <div v-if="ni < flow.path.length - 1" class="flow-arrow">→</div>
              </template>
              <button
                v-if="flow.path.length < FLOW_MAX_NODES"
                class="btn small ghost"
                title="在末尾加一个途经点（支持 A→B→C 多跳走向）"
                @click="addFlowNode(flow)"
              >＋ 加途经点</button>
            </div>

            <div class="opt col">
              <span>
                <strong>匹配时间窗</strong>
                <em>出场后多久内入场才算同一次走向</em>
              </span>
              <SelectField cls="mini" v-model.number="flow.windowSec" :options="OPT_FLOW_WINDOW" />
            </div>

            <label class="opt">
              <span>
                <strong>要求人脸身份</strong>
                <em>开启：必须识别到人脸才匹配；关闭：匿名兜底——没识别到人脸时按「同一时刻一条匿名链路」匹配，一个人走完整条路径即有效，多人同窗并行可能串链</em>
              </span>
              <span class="switch" :class="{ on: flow.requireFace }" @click="flow.requireFace = !flow.requireFace"></span>
            </label>

            <label class="opt">
              <span>
                <strong>推送该流向</strong>
                <em>关闭则只记录不推送</em>
              </span>
              <span class="switch" :class="{ on: flow.push }" @click="flow.push = !flow.push"></span>
            </label>

            <label class="opt">
              <span>
                <strong>作为关键事件实时推送</strong>
                <em>开启：一旦匹配立刻单发（静默时段也推）；关闭：走普通推送 / 日常汇总</em>
              </span>
              <span class="switch" :class="{ on: flow.asCritical }" @click="flow.asCritical = !flow.asCritical"></span>
            </label>

            <p class="flow-errors" v-if="flowStateOf(flow).errors.length || flowStateOf(flow).prereq.issues.length">
              <span class="flow-err" v-for="(e, k) in flowStateOf(flow).errors" :key="'e' + k">⚠ {{ e }}</span>
              <span class="flow-err prereq" v-for="(p, k) in flowStateOf(flow).prereq.issues" :key="'p' + k">🔴 {{ p.text }}</span>
            </p>
            <p class="flow-ok" v-else-if="flow.enabled && flowStateOf(flow).prereq.met">✓ 配置有效，已生效</p>
          </div>
        </section>

        <section class="block" v-show="tab === 'backend'">
          <div class="block-head">
            <h3>后端检测服务</h3>
            <span class="state-chip" :class="backendState">{{ backendStateText }}</span>
          </div>
          <p class="hint">
            人形 / 人脸 / 姿态监听与推送整体搬到常驻设备，本机页面关了也在盯。
            开启后本机 AI 检测全部停掉（省算力、不发烫），检测与推送都交给后端服务。
          </p>
          <label class="opt">
            <span>
              <strong>启用后端检测</strong>
              <em>
                开启后本机 AI 检测全部停掉（省算力、不发烫），检测与推送都交给后端服务 ——
                关掉本机页面，服务端照旧检测、照旧往钉钉 / 企微 / Telegram 推送。
                当前配置（流地址 / 区域 / 推送凭据 / 人脸库）会自动同步过去，
                <b>不需要手改 server/config.json</b>。
              </em>
            </span>
            <span class="switch" :class="{ on: opts.backend && opts.backend.enabled }" @click="toggleBackend"></span>
          </label>
          <template v-if="opts.backend && opts.backend.enabled">
            <div class="opt col">
              <span>
                <strong>服务地址</strong>
                <em>
                  先在电脑上运行 <code>npm run server</code> 启动 headless 服务，这里填它的地址；
                  手机 / 手表端要填 Mac 的局域网 IP，不要填 localhost
                </em>
              </span>
              <input
                class="field wide"
                :value="opts.backend.url"
                placeholder="http://10.0.0.12:8787"
                @change="opts.backend.url = $event.target.value.trim()"
              />
            </div>
            <div class="opt col">
              <span>
                <strong>ffmpeg 路径（可选）</strong>
                <em>
                  后端解码用 ffmpeg。市面平台的 H.265 常用「增强型 FLV」，
                  npm 自带的 6.0 <b>解不了</b>（表现为各路「拉流失败」），需要 7 以上。
                  装好后填这里（或直接放进系统 PATH），重启后端服务生效。
                </em>
              </span>
              <input
                class="field wide"
                v-model.trim="opts.backend.ffmpegPath"
                spellcheck="false"
                placeholder="留空 = 用 npm 自带版本（仅支持普通 H.264 FLV）"
              />
            </div>
            <div class="opt">
              <span>
                <strong>配置同步</strong>
                <em>
                  通道 / 区域 / 推送凭据 / 人脸库改动后自动重发，无需操作。
                  <b :class="syncState === 'error' ? 'err-text' : 'ok-text'">{{ syncStateText }}</b>
                </em>
              </span>
              <button class="tag" @click="onBackendSync">
                {{ syncState === 'syncing' ? '同步中…' : '立即同步' }}
              </button>
            </div>
            <!--
              反方向：从后端拉回整份配置。
              存在的理由：配置只存在**配它的那个浏览器**里，局域网里另一台机器
              打开同一个地址看到的是自己的空配置（一块空大屏）。
              换机器 / 重装 / 清了浏览器数据时，用它把后端那一份整体取回来。
            -->
            <div class="opt">
              <span>
                <strong>从后端拉取</strong>
                <em>
                  把后端正在用的那份配置整体取回本机（通道 / 区域 / 凭据 / 人脸库）。
                  换一台机器打开本地址时，本机是空的 —— 点这里拿回来即可，不用重配一遍。
                  <b :class="behindBackend ? 'err-text' : 'ok-text'">本机 {{ localRevText }} · 后端 {{ syncRevText }}</b>
                </em>
                <em v-if="behindBackend" class="err-text">
                  ⚠️ 后端配置比本机新（别的设备改过）。点右边按钮以它为准，本机这份会被替换。
                </em>
                <em v-else-if="pushOverwrote" class="err-text">
                  ⚠️ 上一次同步把其它设备的改动覆盖掉了。
                </em>
                <!--
                  本机底库是空的、后端还有人时，后端会**保住自己那份**（不让人推空）。
                  这件事必须说出来并给出下一步，否则用户只会看到"同步成功"，
                  而本机与后端的人脸库其实不一致。
                -->
                <em v-if="pushFacesSkipped" class="err-text">
                  ⚠️ 本机人脸库是空的，后端已保留它自己的底库（没被推空）。点「从后端拉取」把后端的人取回来。
                </em>
                <em v-if="pullState === 'error'" class="err-text">拉取失败：{{ pullError }}</em>
              </span>
              <button class="tag" :disabled="pullState === 'pulling'" @click="onBackendPull">
                {{ pullState === 'pulling' ? '拉取中…' : '从后端拉取' }}
              </button>
            </div>
            <div class="opt">
              <span>
                <strong>拉取频率</strong>
                <em>轮询后端新事件的间隔，报警时效与流量的平衡</em>
              </span>
              <select class="field mini" v-model.number="opts.backend.pollMs">
                <option :value="2000">2 秒（最快）</option>
                <option :value="4000">4 秒（推荐）</option>
                <option :value="10000">10 秒</option>
                <option :value="30000">30 秒（最省）</option>
              </select>
            </div>
            <div class="opt">
              <span>
                <strong>服务状态</strong>
                <em>模型加载 / 人脸库 / 推送渠道 / 各通道解码情况，来自后端 /api/status</em>
              </span>
              <button class="tag" @click="onBackendTest">{{ backendTesting ? '查询中…' : '刷新' }}</button>
            </div>
            <!-- ---------- 状态哨兵：掉线提醒 + 定时巡检都由后端跑 ---------- -->
            <div v-if="backendWatchdog" class="opt col">
              <div class="backend-meta">
                <span>
                  掉线提醒
                  <b :class="backendWatchdog.statusAlerts && backendWatchdog.statusAlerts.enabled ? 'ok-text' : 'err-text'">
                    {{ backendWatchdog.statusAlerts && backendWatchdog.statusAlerts.enabled ? '后端在盯' : '已关闭' }}
                  </b>
                  <template v-if="backendWatchdog.statusAlerts && backendWatchdog.statusAlerts.repeatMinutes">
                    · 每 {{ backendWatchdog.statusAlerts.repeatMinutes }} 分钟重提醒
                  </template>
                </span>
                <span>
                  定时巡检
                  <b :class="backendWatchdog.patrol && backendWatchdog.patrol.enabled ? 'ok-text' : 'err-text'">
                    {{ backendWatchdog.patrol && backendWatchdog.patrol.enabled
                      ? `每 ${backendWatchdog.patrol.intervalMinutes} 分钟`
                      : '未启用' }}
                  </b>
                </span>
                <span v-if="backendWatchdog.patrol && backendWatchdog.patrol.nextAt">
                  下次：{{ formatCountdown(backendWatchdog.patrol.nextAt) }}
                </span>
                <span>在线：{{ (backendWatchdog.overview && backendWatchdog.overview.short) || '—' }}</span>
              </div>
              <div v-for="c in backendWatchdog.cameras || []" :key="'w-' + c.id" class="backend-cam">
                <b>{{ c.name }}</b>
                <b :class="c.state === 'playing' ? 'ok-text' : 'err-text'">{{ stateTextOf(c.state) }}</b>
                <span>
                  {{ c.watched ? '已监听' : '未监听' }}
                  <template v-if="c.fps"> · {{ c.fps }}fps</template>
                  <template v-if="c.resolution"> · {{ c.resolution }}</template>
                </span>
              </div>
              <div v-if="backendWatchdog.lastAction" class="backend-note">
                最近动作：{{ backendWatchdog.lastAction }}
              </div>
            </div>
            <div v-if="backendStatus" class="opt col">
              <div class="backend-meta">
                <span>
                  模型：
                  <b :class="backendStatus.ai && backendStatus.ai.detector ? 'ok-text' : 'err-text'">人形</b>
                  <b :class="backendStatus.ai && backendStatus.ai.face ? 'ok-text' : 'err-text'">人脸</b>
                  <b :class="backendStatus.ai && backendStatus.ai.pose ? 'ok-text' : 'err-text'">姿态</b>
                </span>
                <span>人脸库 {{ backendStatus.faces || 0 }} 人</span>
                <span>
                  ffmpeg
                  <b :class="backendStatus.ffmpegTooOld ? 'err-text' : 'ok-text'">
                    {{ backendStatus.ffmpeg || '未知' }}{{ backendStatus.ffmpegVersion ? ' · ' + backendStatus.ffmpegVersion : '' }}
                  </b>
                  <em v-if="backendStatus.ffmpegTooOld">（需 7 以上才能解 H.265 增强型 FLV）</em>
                </span>
                <span>
                  推送：
                  <b :class="backendStatus.push && backendStatus.push.ding ? 'ok-text' : 'err-text'">钉钉</b>
                  <b :class="backendStatus.push && backendStatus.push.wecom ? 'ok-text' : 'err-text'">企微</b>
                  <b :class="backendStatus.push && backendStatus.push.tg ? 'ok-text' : 'err-text'">TG</b>
                </span>
              </div>
              <div v-for="c in backendStatus.cameras || []" :key="c.id" class="backend-cam">
                <b>{{ c.name }}</b>
                <b :class="c.alive ? 'ok-text' : 'err-text'">{{ c.alive ? '解码中' : '未出帧' }}</b>
                <span>检出 {{ c.persons }} 人 · {{ c.zones }} 区域 · {{ c.frames }} 帧</span>
                <em v-if="c.error" class="err-text">{{ c.error }}</em>
              </div>
            </div>
          </template>
        </section>

        <!-- ==================== 推送模板（三端统一配置 + 实时预览） ==================== -->
        <section class="block" v-show="tab === 'templates'">
          <PushTemplatePanel :opts="opts" />
        </section>

        <section class="block" v-show="tab === 'dingtalk'">
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

        <!-- ==================== Telegram 推送 ==================== -->
        <section class="block" v-show="tab === 'telegram'">
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
                <template v-if="!directRecipients.length"> —— 授权用户名单为空，且未额外添加</template>
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

        <section class="block" v-show="tab === 'status'">
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

        <section class="block" v-show="tab === 'status'">
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

        <!-- ==================== 企业微信推送 ==================== -->
        <section class="block" v-show="tab === 'wecom'">
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

        <!-- ==================== 配置方案 ==================== -->
        <section class="block" v-show="tab === 'profiles'">
          <div class="block-head">
            <h3>配置方案</h3>
            <span class="state-chip">{{ profiles.length ? `${profiles.length} 套已保存` : '尚未保存' }}</span>
          </div>
          <p class="hint">
            把当前的通道 + 全部设置存成一套「方案」，换场景时一键切换（比如「白天值守」/「夜间布防」）。
            也可以导出成 .json 文件备份，或在别的设备上导入。
          </p>

          <div class="opt col">
            <span>
              <strong>保存当前配置为新方案</strong>
              <em>会覆盖同名方案</em>
            </span>
            <div class="test-row">
              <input class="field" v-model.trim="profileName" placeholder="方案名称，例如：夜间布防" @keyup.enter="saveProfile" />
              <button class="btn small primary" @click="saveProfile">保存</button>
            </div>
          </div>

          <div class="profile-list" v-if="profiles.length">
            <div class="profile-item" v-for="p in profiles" :key="p.id" :class="{ on: p.id === activeProfileId }">
              <div class="pi-main">
                <strong>{{ p.name }}</strong>
                <em>{{ p.count }} 路通道 · {{ formatDate(p.updatedAt) }}</em>
              </div>
              <div class="pi-ops">
                <button class="btn small" :class="{ primary: p.id !== activeProfileId }" :disabled="p.id === activeProfileId" @click="applyProfile(p)">
                  {{ p.id === activeProfileId ? '使用中' : '切换' }}
                </button>
                <button class="icon-btn" title="删除这套方案" @click="removeProfile(p.id)">
                  <svg viewBox="0 0 24 24" width="15" height="15">
                    <path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M7 7l1 12h8l1-12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <div class="empty-tip" v-else>还没有保存过方案</div>

          <div class="opt">
            <span>
              <strong>导出当前配置为文件</strong>
              <em>保存成 .json，可用于备份或迁移到其它设备</em>
            </span>
            <button class="btn small" @click="exportConfig">导出 .json</button>
          </div>

          <div class="opt">
            <span>
              <strong>从文件导入配置</strong>
              <em>导入后需要点下面的「保存」才会生效</em>
            </span>
            <button class="btn small" @click="pickFile">选择 .json 文件</button>
          </div>

          <div class="opt" v-if="backendEnabled">
            <span>
              <strong>导出运行数据库</strong>
              <em>把后端服务器上当前运行的 monitor.db（报警记录、人脸库、统计一并含 WAL 热备）下载到本机</em>
            </span>
            <button class="btn small primary" :disabled="dbExporting" @click="exportDatabase">
              {{ dbExporting ? '导出中…' : '导出 .db' }}
            </button>
          </div>
          <div class="opt" v-else>
            <span>
              <strong>导出运行数据库</strong>
              <em>数据库在后端服务器上（monitor.db）。请先在「后端检测」里开启并填写服务地址，才能导出。</em>
            </span>
            <button class="btn small" disabled>导出 .db</button>
          </div>

          <div class="opt col">
            <span>
              <strong>加载内置配置</strong>
              <em>输入访问密码，一键载入预置的通道名称、摆放与推送配置</em>
            </span>
            <div class="test-row">
              <input
                class="field"
                type="password"
                v-model.trim="hiddenPwd"
                placeholder="访问密码"
                autocomplete="off"
                @keyup.enter="loadHidden"
              />
              <button class="btn small primary" @click="loadHidden">加载</button>
            </div>
            <span class="test-state" :class="hiddenState.kind" v-if="hiddenState.text">{{ hiddenState.text }}</span>
          </div>

          <!--
            恢复初始化：和上面的「加载内置配置」正好互为反向 ——
            一个载入那份私用完整配置，一个把所有配置清回空白。
            破坏性较强，所以走一次内联二次确认（不用弹窗，免得和抽屉的层叠打架）。
          -->
          <div class="opt col">
            <span>
              <strong>恢复初始化</strong>
              <em>把全部配置还原到空白：通道清空，三个推送渠道的凭据与绑定一并清空</em>
            </span>
            <button class="btn small danger" @click="askResetInit" v-if="!resetAsk">恢复初始化</button>
            <template v-else>
              <span class="reset-warn">
                会立即清空 <b>{{ cams.length }} 路通道</b>，以及钉钉 / 企业微信 / Telegram 的凭据与绑定通道；
                检测识别、报警提醒、播放性能、遮罩密码等全部回到默认。
                <b>已保存的配置方案与推送统计也会一并清空</b>。
              </span>
              <label class="reset-wipe" @click.prevent="resetWipeData = !resetWipeData">
                <span class="switch" :class="{ on: resetWipeData }"></span>
                <span class="rw-text">
                  同时清空<b>报警记录</b>与<b>人脸库</b>
                  <em>默认勾选 —— 「初始化」就该是什么都没有；想保留历史数据就取消勾选</em>
                </span>
              </label>
              <div class="test-row">
                <button class="btn small" @click="resetAsk = false">取消</button>
                <button class="btn small danger" @click="doResetInit">确认恢复</button>
              </div>
            </template>
          </div>

          <!--
            强制终结 App：点下去停止一切（播放 / 检测 / 推送 / 常亮）然后退出进程。
            iOS / 桌面端会真的杀掉进程；浏览器页面受安全策略限制关不掉，
            会停在一层「已终止」遮罩上，明说"请手动关页"，不假装退干净了。
          -->
          <div class="opt col">
            <span>
              <strong>强制终结 App</strong>
              <em>立即结束应用进程：停止播放、检测、推送与全部后台任务，然后自动退出</em>
            </span>
            <button class="btn small danger" @click="askExitApp" v-if="!exitAsk">强制终结 App</button>
            <template v-else>
              <span class="reset-warn">
                将<b>立即结束应用</b>：所有画面停止播放、检测与推送全部停止、后台不留任何任务，
                然后应用自动退出。这个操作不可撤销。
              </span>
              <div class="test-row">
                <button class="btn small" @click="exitAsk = false">取消</button>
                <button class="btn small danger" @click="doExitApp">确认终结</button>
              </div>
            </template>
          </div>

          <div class="opt col">
            <span>
              <strong>报警记录保留条数</strong>
              <em>记录与截图存在 IndexedDB，容量充足；超出会循环删除最旧的</em>
            </span>
            <div class="test-row">
              <input class="field mini" type="number" min="10" max="2000" step="10" v-model.number="opts.maxEvents" />
              <span class="unit">条</span>
            </div>
          </div>

          <div class="opt" v-if="storageInfo">
            <span>
              <strong>本地存储占用</strong>
              <em>报警记录 + 截图（IndexedDB）</em>
            </span>
            <span class="state-chip">{{ storageText }}</span>
          </div>
        </section>


        <section class="block" v-show="tab === 'mask'">
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
        </div>
      </div>

      <footer class="drawer-foot">
        <button class="btn" @click="exportConfig">导出配置</button>
        <button class="btn" @click="pickFile">导入配置</button>
        <span class="spacer"></span>
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" @click="save">保存并应用</button>
        <input ref="fileEl" type="file" accept="application/json,.json" hidden @change="importConfig" />
      </footer>
    </aside>

    <!-- 待录入：点缩略图看捕获时的整帧原图（灯箱） -->
    <transition name="lb-fade">
      <div class="pending-shot-mask" v-if="pendingShot" @click.self="closePendingShot">
        <div class="pending-shot-box">
          <button class="pending-shot-close" @click="closePendingShot" title="关闭（Esc）">×</button>
          <img class="pending-shot-img" :src="pendingShot.full || pendingShot.thumb" alt="捕获时的原图" />
          <div class="pending-shot-cap">
            <span>{{ pendingShot.camName || '未知通道' }}</span>
            <span v-if="pendingShot.at"> · {{ fmtPendingAt(pendingShot.at) }}</span>
            <span v-if="pendingShot.name"> · 认成「{{ pendingShot.name }}」</span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  BRAND,
  camDigestState,
  camSilentState,
  clampDigestMinutes,
  cloneDefaultCameras,
  cloneDefaultOptions,
  cloneHiddenConfig,
  DEFAULT_BACKEND_URL,
  DEFAULT_CAM_DIGEST_CHANNELS,
  DEFAULT_CAM_SILENT_CHANNELS,
  DEFAULT_SILENT_CHANNELS,
  defaultCamDigest,
  defaultCamSilent,
  DIGEST_INTERVAL_CHOICES,
  DIGEST_INTERVAL_MAX,
  DIGEST_INTERVAL_MIN,
  digestCfgOf,
  digestIntervalLabel,
  silentYieldSlots,
  HIDDEN_PASSCODE_HASH,
  syncChannelCameras,
  defaultFlow,
  flowValid,
  clampFlowWindowSec,
  FLOW_WINDOW_MIN,
  FLOW_WINDOW_MAX,
  FLOW_WINDOW_DEFAULT,
  FLOW_MAX_NODES
} from '../config/defaults'
import { SECRET_SCOPE } from '../config/auth'
import { secretDigest, secretMatches } from '../composables/sha256'
import { resetPushStats } from '../composables/usePushStats'
import {
  backendState,
  backendStateText,
  backendOn,
  backendStatus,
  backendWatchdog,
  deleteBackendTgWebhook,
  refreshBackendStatus,
  refreshBackendWatchdog,
  testBackendTgRemote
} from '../composables/useBackendEvents'
import { syncState, syncStateText, localRev, syncRev, pullState, pullError, pushOverwrote, pushFacesSkipped } from '../composables/useBackendSync'
import { refreshWatchStatus, watchState, watchStatusText } from '../composables/useWatchBridge'
import { confirmDialog, alertDialog } from '../composables/confirm.js'
import FaceAssignSelect from './FaceAssignSelect.vue'
import {
  AI_MODELS,
  aiBackend,
  aiCost,
  aiError,
  aiModel,
  aiState,
  loadPersonModel,
  releaseModel,
  setGpuPref
} from '../composables/useAiDetector'
import { FIELD_KEYS, buildAlarmMessage, fieldLabel, normalizeDingTalk, sendDingTalk } from '../composables/useDingTalk'
import {
  directPushEventOn as tgDirectEventOn,
  directPushRecipients as tgDirectRecipients,
  getBotInfo,
  getChatInfo,
  normalizeTelegram,
  sendTelegramText
} from '../composables/useTelegram'
import {
  normalizeWeCom,
  normalizeWeComWebhook,
  sendWeCom
} from '../composables/useWeCom'
import { parseMobiles } from '../composables/useAlertPush'
import { estimateUsage, formatBytes } from '../composables/useEventStore'
import { EVENT_DEFAULTS, EVENT_GROUPS } from '../composables/useAlarmText'
import { aiSlotBackend, aiSlotState } from '../composables/useAiDetector'
import { camExtOn } from '../composables/useAiExtras'
import {
  DEFAULT_FACE_THRESHOLD,
  addFace,
  addFaceBlock,
  backendFaceHits,
  backendFaceHitsError,
  backendFaceHitsLoadedAt,
  backendPendingError,
  backendPendingFaces,
  backendPendingLoadedAt,
  addFaceSplits,
  clearFaces,
  clearPendingFaces,
  blockLibOpen,
  currentFaceBlocks,
  currentSplits,
  deleteFaces,
  dropBackendFaceHit,
  dropBackendPendingFace,
  enrollFromImage,
  faceBlocksVersion,
  faceLibOpen,
  faceRowsVersion,
  faceSplitsOpen,
  faceSplitsVersion,
  faces as faceLib,
  groupFaces,
  GROUP_SIM_KEY,
  hitReviewOpen,
  loadBackendFaceHits,
  loadBackendPendingFaces,
  mergeFaces,
  pendingFaces,
  pendingLibOpen,
  rawFaceRows,
  readGroupSim,
  refreshFaces,
  removeFaceBlock,
  removeFaceSplit,
  removePendingFace,
  renameFace,
  renameFaces
} from '../composables/useFaceLib'
import { runtimeInfo, runtimeLine } from '../composables/useDeviceInfo'
import {
  BACKEND_LABEL as WAKE_BACKEND_LABEL,
  applyWakeLock,
  wakeLockState
} from '../composables/useWakeLock'
import {
  requestNotifyPermission,
  sysNotifyState,
  sysNotifySummary
} from '../composables/useSystemNotify'
import AboutSystem from './AboutSystem.vue'
import PushTemplatePanel from './PushTemplatePanel.vue'
import SelectField from './SelectField.vue'
import InfoTip from './InfoTip.vue'
import StatsPanel from './StatsPanel.vue'

/*
 * ---------------- 下拉选项 ----------------
 * 原来这一堆选项是写在 <option :value> 上的，换成自绘下拉后挪到这儿成常量数组：
 * 数组本身不变（避免每次渲染都新建同一个数组），value 的类型与写进配置的完全一致
 * （数字就是数字，不能 "3" 和 3 混着比）。
 */
const OPT_AUTO_PLAY = [
  { value: 0, label: '不自动播放' },
  { value: 1, label: '仅第一路' },
  { value: 2, label: '前 2 路' },
  { value: 4, label: '前 4 路' },
  { value: 99, label: '全部' },
  { value: 'custom', label: '自定义…' }
]

const OPT_MAX_DECODE = [
  { value: 1, label: '1 路' },
  { value: 2, label: '2 路' },
  { value: 4, label: '4 路' },
  { value: 6, label: '6 路' },
  { value: 9, label: '9 路' },
  { value: 0, label: '不限制' },
  { value: 'custom', label: '自定义…' }
]

const OPT_SHOT_WIDTH = [
  { value: 0, label: '原图（最清晰，推荐）' },
  { value: 2560, label: '超清 2560px' },
  { value: 1920, label: '高清 1920px' },
  { value: 1280, label: '标清 1280px' },
  { value: 960, label: '省空间 960px' }
]

const OPT_MOTION_LEVEL = [
  { value: 0.3, label: '1 档 · 极轻微（0.3%）' },
  { value: 1, label: '2 档 · 轻微（1%）' },
  { value: 2.5, label: '3 档 · 一般（2.5%）' },
  { value: 5, label: '4 档 · 明显（5%）' },
  { value: 10, label: '5 档 · 剧烈（10%）' }
]

const OPT_SAMPLE_FPS = [
  { value: 1, label: '1 帧 / 秒' },
  { value: 2, label: '2 帧 / 秒' },
  { value: 3, label: '3 帧 / 秒' },
  { value: 5, label: '5 帧 / 秒' }
]

const OPT_CONFIRM_FRAMES = [
  { value: 1, label: '1 帧' },
  { value: 2, label: '2 帧' },
  { value: 3, label: '3 帧' }
]

const OPT_AI_INTERVAL = [
  { value: 1000, label: '1 秒' },
  { value: 2000, label: '2 秒' },
  { value: 3000, label: '3 秒' },
  { value: 5000, label: '5 秒' },
  { value: 10000, label: '10 秒' }
]

const OPT_LOITER_RADIUS = [
  { value: 0.04, label: '很小（4%）· 几乎站定' },
  { value: 0.08, label: '小（8%）· 推荐' },
  { value: 0.15, label: '中（15%）· 小范围踱步' },
  { value: 0.25, label: '大（25%）· 宽松' }
]

const AI_MODELS_AS_OPTIONS = AI_MODELS.map((m) => ({ value: m.key, label: m.label }))

/* ---------------- 人员流向（跨摄像头走向）配置辅助 ---------------- */
const OPT_FLOW_WINDOW = [
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 120, label: '2 分钟（默认）' },
  { value: 300, label: '5 分钟' },
  { value: 600, label: '10 分钟' }
]

/** 摄像头下拉项：只列「已启用」（未隐藏）的摄像头，避免选到被隐藏的通道 */
const camOptions = computed(() =>
  cams.value.filter((c) => !hidden.value.includes(c.id)).map((c) => ({ value: c.id, label: c.name || c.id }))
)

/** 人员流向判定 / 区域下拉所用的摄像头清单（取 props.cameras 这个权威源，实时反映区域增删） */
const flowCams = computed(() =>
  Array.isArray(props.cameras) && props.cameras.length ? props.cameras : cams.value
)

/** 某摄像头下的区域下拉项；没选摄像头时给空数组（SelectField 显示占位文字） */
function zoneOptions(camId) {
  const cam = flowCams.value.find((c) => c.id === camId)
  if (!cam || !Array.isArray(cam.zones)) return []
  return cam.zones.map((z) => ({ value: z.id, label: z.name || z.id }))
}

/** 新增一条默认流向（默认 2 节点：起点 → 终点） */
function addFlow() {
  if (!Array.isArray(opts.flows)) opts.flows = []
  opts.flows.push(defaultFlow())
}

/** 删除第 i 条流向 */
function removeFlow(i) {
  if (Array.isArray(opts.flows)) opts.flows.splice(i, 1)
}

/** 在 path 末尾加一个途经点（支持 A→B→C 多跳），受 FLOW_MAX_NODES 上限约束 */
function addFlowNode(flow) {
  if (!Array.isArray(flow.path)) flow.path = [{ cam: '', zone: '' }, { cam: '', zone: '' }]
  if (flow.path.length >= FLOW_MAX_NODES) return
  flow.path.push({ cam: '', zone: '' })
}

/** 删除 path 第 ni 个节点（至少保留 2 个） */
function removeFlowNode(flow, ni) {
  if (Array.isArray(flow.path) && flow.path.length > 2) flow.path.splice(ni, 1)
}

/** 单条流向的有效性判定（与引擎共用一份 flowValid） */
function flowStateOf(flow) {
  return flowValid(flow, flowCams.value)
}

/** 顶部状态条：生效数 / 启用数，以及是否有启用但无效的 */
const flowSummary = computed(() => {
  const list = Array.isArray(opts.flows) ? opts.flows : []
  const enabled = list.filter((f) => f.enabled)
  const okCount = enabled.filter((f) => flowValid(f, flowCams.value).valid).length
  const hasBad = enabled.length > okCount
  return {
    text: `${okCount}/${enabled.length} 条生效`,
    enabled: enabled.length > 0,
    ok: okCount > 0 && !hasBad
  }
})

/** 页签 on/off 徽标：存在「已启用且有效」的流向才算 on */
const flowTabOn = computed(() => {
  const list = Array.isArray(opts.flows) ? opts.flows : []
  return list.some((f) => f.enabled && flowValid(f, flowCams.value).valid)
})

const props = defineProps({
  cameras: { type: Array, required: true },
  options: { type: Object, required: true },
  hiddenIds: { type: Array, default: () => [] },
  layouts: { type: Array, default: () => [] },
  layoutKey: { type: String, default: 'auto' },
  /** 是否跑在 Capacitor 原生壳里（iOS App 为 true），决定「自动」主题档是否展示 */
  native: { type: Boolean, default: false },
  /** 报警事件列表，「关于系统」页要用它统计条数与未读数 */
  events: { type: Array, default: () => [] },
  /** 打开抽屉时希望落在哪一页（如 'status' = 状态巡检）；不传则用上次停留的页 */
  openTab: { type: String, default: '' },
  /** 临时静默状态（App 每秒回传，item 112） */
  tempSilent: { type: Object, default: () => ({ active: false }) }
})

const emit = defineEmits([
  'close',
  'save',
  'reset',
  'patrol',
  'update:layoutKey',
  'reset-free',
  'update-cameras',
  'update-theme',
  'update-keepawake',
  'force-exit',
  'watch-sync',
  'backend-sync',
  'pull-backend',
  'flush-silent',
  'test-pre-silent',
  'test-post-silent',
  'restart-system',
  /* 临时静默（item 112） */
  'start-temp-silent',
  'end-temp-silent'
])

/* ---------- Apple Watch ---------- */
/**
 * 手表端只做「看事件」，所以这里不需要任何配置项 —— 配对了、装了 App 就自动同步。
 * 设置页只负责两件事：把当前连接状态说清楚（不然用户会反复怀疑"是不是没生效"），
 * 以及给一个手动同步按钮（改完配置想立刻推一次）。
 */
const watchChip = computed(() => {
  if (!watchState.supported) return '不支持'
  if (!watchState.activated) return '连接中'
  if (!watchState.paired) return '未配对'
  if (!watchState.installed) return '手表未安装'
  return watchState.reachable ? '在线' : '离线'
})

function refreshWatch() {
  void refreshWatchStatus()
}

/* ---------- 外观主题 ---------- */
/**
 * 主题不参与抽屉的「保存」按钮：点一下立刻生效并经 App 持久化
 * （emit('update-theme') → App 写 options.theme → watch 自动落盘），
 * 否则「换个配色还要按保存」会显得很怪。opts.theme 只用于本页按钮的选中态。
 */
const THEME_OPTIONS = computed(() => {
  const list = [
    { value: 'liquid', label: '液态风格', desc: '默认玻璃质感配色' },
    { value: 'dark', label: '暗黑风格', desc: '中性纯黑，OLED 省电' },
    { value: 'light', label: '亮色风格', desc: '浅色日间模式' }
  ]
  if (props.native) list.push({ value: 'auto', label: '自动', desc: '跟随 iOS 系统深色模式' })
  return list
})

const themeLabel = computed(
  () => (THEME_OPTIONS.value.find((t) => t.value === opts.theme) || THEME_OPTIONS.value[0]).label
)

function setTheme(v) {
  if (opts.theme === v) return
  opts.theme = v
  emit('update-theme', v)
}

/* ---------- 屏幕常亮 ---------- */
/**
 * 同样即时生效、不走「保存」按钮 —— 常亮是个「按下去就该立刻看到效果」的开关，
 * 让用户按保存才生效会很别扭（而且他没法立刻判断有没有生效）。
 * 真正的申请逻辑在 useWakeLock 里，这里只负责把意图转发上去 + 展示实时状态。
 */
function toggleKeepAwake() {
  opts.keepAwake = !opts.keepAwake
  emit('update-keepawake', opts.keepAwake)
}

/** 一句话状态：让用户知道「开关是开的」≠「真的生效了」 */
const wakeLine = computed(() => {
  if (!opts.keepAwake) return '已关闭'
  const s = wakeLockState
  if (s.active) return `已生效 · ${WAKE_BACKEND_LABEL[s.backend] || '未知后端'}`
  if (s.supported === false) return '⚠️ 当前环境不支持'
  if (s.error) return `⚠️ ${s.error}`
  return '待生效（切回页面后自动申请）'
})

const wakeCls = computed(() => {
  if (!opts.keepAwake) return 'off'
  if (wakeLockState.active) return 'ok'
  return 'warn'
})

/** 系统通知的状态徽标（复用 wake-state 三色样式） */
const notifyCls = computed(() => {
  if (!opts.alert.desktopNotify) return 'off'
  const p = sysNotifyState.permission
  if (p === 'granted') return 'ok'
  return 'warn'
})

/* ---------- 遮罩关闭 ---------- */
/**
 * 「点遮罩空白处关闭」在触屏上有两个坑，都表现为「抽屉闪一下就没了」：
 *   1) 一次触摸可能产生不止一次 click（触屏抖动、以及 touchend 之后浏览器合成的
 *      click）。第一次 click 把抽屉打开，第二次就落在刚刚铺满全屏的遮罩上 ——
 *      于是立刻又被关掉。桌面鼠标不抖，所以这个问题只在手机 / iPad 上必现。
 *   2) 从抽屉内部按下滑到遮罩上再抬手，也会被算成「点了遮罩」。
 *
 * 所以这里加两道闸：打开后 400ms 静默期 + 要求按下与抬手属于同一次交互。
 * 注：头部 X 按钮和底部「取消」是用户的明确意图，不走这里，不受静默期影响。
 */
const OPEN_GUARD_MS = 400
const openedAt = Date.now()
let maskDownAt = 0

function onMaskDown() {
  maskDownAt = Date.now()
}

function onMaskClick() {
  const now = Date.now()
  // 闸门 1：刚打开的一小段时间内忽略遮罩点击（挡掉触屏重复 click）
  if (now - openedAt < OPEN_GUARD_MS) return
  // 闸门 2：按下过、但离得太久 —— 说明是从抽屉里拖出来在遮罩上抬手的，
  //        不算「点遮罩」。注意这里用 `maskDownAt &&` 而不是 `!maskDownAt ||`：
  //        某些环境（触摸模拟、部分内嵌 WebView）压根不派发 pointerdown，
  //        若把「没按下」也判成非法，遮罩就永远关不掉了。
  if (maskDownAt && now - maskDownAt > 1200) return
  emit('close')
}

/* ---------- 分类导航 ---------- */
/** 通道级推送开关的三个渠道（顺序 = 展示顺序） */
const CAM_CHANNELS = [
  { key: 'ding', label: '钉钉' },
  { key: 'wecom', label: '企业微信' },
  { key: 'tg', label: 'Telegram' }
]

/*
 * 页签顺序 = 使用动线，刻意按「先画面/性能 → 再看报警链路 → 再钻进检测细节 → 收尾维护」排：
 *   ① 监控通道 / 播放性能           —— 最常动的两页（加通道、调解码），必须最先够到
 *   ② 报警提醒 / 状态巡检           —— 「什么时候响、怎么响」，接着就是它
 *   ③ 检测识别 / 后端检测           —— 「拿什么判定」；本机算法在前、搬去服务端在后，成对出现
 *   ④ 三个推送渠道 → 推送模板       —— 「发去哪、长什么样」，渠道按 TG / 企微 / 钉钉
 *   ⑤ 隐私遮罩 / 外观布局 / 配置方案 —— 低频外观与整体方案
 *   ⑥ 系统维护 / 关于系统           —— 只看不改的信息收在最后，不打断前面的操作动线
 */
const TABS = [
  {
    key: 'cams',
    label: '监控通道',
    desc: '增删通道、改名称与流地址、开关检测',
    icon: 'M3.5 7.5A2 2 0 0 1 5.5 5.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2zM14.5 10.5l6-3.2v9.4l-6-3.2z'
  },
  {
    key: 'play',
    label: '播放性能',
    desc: '解码、自动播放路数、性能保护',
    icon: 'M7 4.8l12 7.2-12 7.2zM4 4v16'
  },
  {
    key: 'alert',
    label: '报警提醒',
    desc: '通知、声音、自动放大',
    icon: 'M6 9a6 6 0 1 1 12 0v4.5l1.6 2.6H4.4L6 13.5zM10 18.5a2 2 0 0 0 4 0'
  },
  {
    key: 'status',
    label: '状态巡检',
    desc: '通道异常推送与定时巡检报告',
    icon: 'M3 12h4l2.5-6 4 12 2.5-6h5'
  },
  {
    key: 'detect',
    label: '检测识别',
    desc: '移动检测与人形识别参数',
    icon: 'M4 18a9 9 0 0 1 16 0M7.5 18a5.5 5.5 0 0 1 9 0M12 18h.01'
  },
  /* 人员流向（跨摄像头走向）紧跟检测识别：它建立在人形轨迹 / 人脸之上，依赖上面的识别能力 */
  {
    key: 'flow',
    label: '人员流向',
    desc: '跨摄像头人员走向：谁从哪路去了哪路',
    icon: 'M4 12h12M13 7l5 5-5 5M20 6v12'
  },
  /* 后端检测紧跟检测识别：两者是「同一件事跑在哪」的两种选择，必须成对出现、挨着看 */
  {
    key: 'backend',
    label: '后端检测',
    desc: '常驻后端服务：本机页面关了也在检测与推送',
    icon: 'M4 5.5h16v5H4zM4 13.5h16v5H4zM7.5 8h.01M7.5 16h.01M17 8h.01M17 16h.01'
  },
  {
    key: 'telegram',
    label: 'TG 推送',
    desc: 'Telegram 机器人：文字 + 报警截图上传',
    icon: 'M21.5 4.5L2.8 11.6c-.9.35-.86 1.6.05 1.9l4.2 1.35 1.6 4.9c.28.86 1.4.98 1.87.2l2.3-3.9 4.5 3.3c.72.53 1.75.14 1.94-.73z'
  },
  {
    key: 'wecom',
    label: '企微推送',
    desc: '企业微信群机器人：markdown + 直接发截图',
    icon: 'M4 5.5h16A1.5 1.5 0 0 1 21.5 7v8a1.5 1.5 0 0 1-1.5 1.5h-7.2L8 20.5v-4H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5zM7.5 10h9M7.5 13h5'
  },
  {
    key: 'dingtalk',
    label: '钉钉推送',
    desc: '机器人凭据、推送内容与频率限制',
    icon: 'M21 4L3 11l7 2.5L12.5 21z'
  },
  {
    key: 'templates',
    label: '推送模板',
    desc: '三端报警消息的自定义排版与实时预览',
    icon: 'M4 5h16v11H8l-4 4zM8 9h8M8 12h5'
  },
  {
    key: 'mask',
    label: '隐私遮罩',
    desc: '一键盖住大屏、解锁密码',
    icon: 'M3 12s3.5-6 9-6c1.3 0 2.5.3 3.5.8M21 12s-3.5 6-9 6c-1.3 0-2.5-.3-3.5-.8M4 20L20 4'
  },
  {
    key: 'appearance',
    label: '外观布局',
    desc: '画面布局 · 报警通知位置 · 界面主题',
    icon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.4 5.4 0 0 1 12 3zM12 21a9 9 0 0 1 0-18'
  },
  {
    key: 'profiles',
    label: '配置方案',
    desc: '多套配置保存 / 切换 / 导入导出',
    icon: 'M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 4v5h5M8 13h8M8 17h5'
  },
  {
    key: 'maintain',
    label: '系统维护',
    desc: '流自愈（持续异常自动恢复）与定时重启系统',
    icon: 'M12 4v3M12 17v3M4 12H1M23 12h-3M5.6 5.6 3.5 3.5M20.5 20.5l-2.1-2.1M18.4 5.6l2.1-2.1M3.5 20.5l2.1-2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'
  },
  {
    /*
     * 关于页放在最末：前面都是「可调的东西」，这里全是「只看不改的信息」，
     * 按「配置 → 信息」的习惯收在最后，不去打断前面的操作动线。
     */
    key: 'about',
    label: '关于系统',
    desc: '运行时长 · 推送统计 · 设备与系统信息',
    icon: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v5M12 7.6v.2'
  }
]

const tab = ref('cams')
/** 重启诊断数据（后端模式下由 /api/restart-status 拉取） */
const restartInfo = ref(null)
// 切到「报警提醒」时顺手刷一次手表状态：抽屉是常驻组件，
// 只在打开时查一次的话，用户中途配对好手表再切过来看到的还是旧状态。
watch(tab, (t) => {
  if (t === 'alert') refreshWatch()
  // 切到「系统维护」时拉一次重启诊断，「上次重启到底怎么样了」一眼可见
  if (t === 'maintain') refreshRestartInfo()
})

/*
 * 允许外部把抽屉直接切到某一页。
 * 场景：事件面板「通道状态」标签里点「配置异常推送」——
 * 那组开关（是否推异常、要不要推恢复、多久重提醒、三个渠道各自收不收）
 * 藏在「状态巡检」页里，靠用户自己翻页签找到它的概率很低。
 */
watch(
  () => props.openTab,
  (t) => {
    if (t) tab.value = t
  },
  { immediate: true }
)
const currentTab = computed(() => TABS.find((t) => t.key === tab.value) || TABS[0])
const currentLayoutLabel = computed(() => {
  const hit = props.layouts.find((l) => l.key === props.layoutKey)
  return hit ? hit.label : '自动铺满'
})

/** 布局预览里画几个小格子 */
function previewCells(key) {
  switch (key) {
    case '1':
      return 1
    case '2':
      return 4
    case '3':
      return 9
    case '4':
      return 16
    case 'focus':
      return 5
    case 'free':
      return 4
    default:
      return 6
  }
}

function resetFreeLayout() {
  emit('reset-free')
  emit('update:layoutKey', 'free')
}

const cams = ref([])
// 深拷贝一份，未点「保存」前不影响正在运行的播放器
const opts = reactive(JSON.parse(JSON.stringify({ ...cloneDefaultOptions(), ...props.options })))

/* ==================== 静默时段（免打扰推送） ==================== */
/* 本地实时时钟：让「当前状态」文案每秒刷新（距离静默结束还有多久） */
const nowTs = ref(Date.now())
let _silentTick = null
onMounted(() => {
  _silentTick = setInterval(() => (nowTs.value = Date.now()), 30000)
  /*
   * 人脸库**打开设置页就加载**，不要等用户点「管理」。
   *
   * `faces` 这个 ref 是模块级的，但只有 `refreshFaces()` 会填它，而原先只有
   * 「管理」按钮的 watch 会调 —— 于是刚打开设置页时标题写的是
   * 「人脸库（0 / 50）」、名单是空的。用户看到的是**底库丢了**，
   * 而不是"还没加载"（没有任何加载中状态，就是干干净净的 0）。
   *
   * 抽屉是 `v-if`，每次打开都会重新挂载 —— 所以这里挂一次就等价于
   * "每次打开设置页都刷一次"，正好也是我们想要的时效性。
   */
  refreshFaces().catch(() => {})
})
onUnmounted(() => {
  if (_silentTick) clearInterval(_silentTick)
})

const CH_LABELS = { ding: '钉钉', wecom: '企业微信', tg: 'TG' }
const silentActiveNow = computed(() => {
  const c = opts.silent
  if (!c || !c.enabled) return false
  const toMin = (s) => {
    const [h, m] = String(s || '0:0').split(':').map((n) => Number(n) || 0)
    return h * 60 + m
  }
  const m = new Date(nowTs.value).getHours() * 60 + new Date(nowTs.value).getMinutes()
  // 多时段（item 114）：任意一个命中即算静默中
  return slotsOf.value.some((s) => {
    const a = toMin(s.start)
    const b = toMin(s.end)
    if (a === b) return false
    return a < b ? m >= a && m < b : m >= a || m < b
  })
})
/**
 * 「运行设备」悬浮说明（item 107）。
 * runtimeLine 是一整行「网页端 · Chrome 120 · macOS 14.2 · 192.168.x.x · 2560×1440」，
 * 直接塞进原生 title 气泡会被挤成窄高一条。改成按 ' · ' 拆行展示。
 */
const runtimeTipText = computed(() => {
  const info = runtimeInfo(BRAND)
  const head = `运行环境：${info.label}`
  const parts = String(info.detail || '')
    .split(' · ')
    .map((s) => s.trim())
    .filter(Boolean)
  return [head, ...parts.map((p) => `· ${p}`), '', '这一行会写进每条推送消息，用来分辨是哪个端发出的'].join('\n')
})

/* ---------------- 静默时段列表（item 114：支持多时段） ---------------- */
/**
 * 老配置只有 silent.start / silent.end（单时段）：初次打开时**就地**把它收口成
 * slots 数组。这样下面的时间输入框 v-model 直接绑在真实配置对象上，改完
 * 「保存并应用」才会真正落盘（之前返回的是新拷贝，改了也白改、再打开还是旧的）。
 * 只在缺 slots 时补一次；之后 slots 是唯一数据源。
 */
watch(
  () => opts.silent,
  (s) => {
    if (!s) return
    if (!Array.isArray(s.slots) || s.slots.length === 0) {
      s.slots = [
        {
          start: s.start != null ? String(s.start) : '19:00',
          end: s.end != null ? String(s.end) : '08:00'
        }
      ]
    }
  },
  { immediate: true }
)

/**
 * 直接返回真实的 slots 数组（引用稳定）。
 * 时间输入框 v-model 原地改 opts.silent.slots[i].start / .end，
 * 保存即生效；也避免每次渲染都生成新对象导致输入框失焦、「点不灵敏」。
 */
const slotsOf = computed(() =>
  opts.silent && Array.isArray(opts.silent.slots) ? opts.silent.slots : []
)

/**
 * 点时间输入框任意位置都弹出原生选择器（桌面端默认只有小箭头能点开，
 * 监控大屏触屏上特别「点不灵敏」）。
 *
 * ⚠️ 必须挂在 **mousedown** 而不是 click：
 *   浏览器自己会在 mousedown 的默认动作里弹选择器，而 click 是 mouseup 之后才触发的。
 *   在 click 里再调 showPicker()，等于和浏览器「已经弹了一半」的原生流程撞车 ——
 *   要么抛 InvalidStateError 被吞掉、要么等原生流程自己收尾，表现为「点完很久才弹」。
 *   在 mousedown 里 preventDefault() 接管默认行为，再自己 showPicker()，才是即时的。
 *   （mousedown 上 preventDefault 会连带阻止自动聚焦，所以要手动 focus 一下。）
 */
function openPicker(e) {
  const el = e && e.target
  if (!el || typeof el.showPicker !== 'function') return
  // 同一次按压只弹一次：mousedown 之后再补一道 click 兜底（部分浏览器只派发 click）
  if (el.__pickerOpened) return
  try {
    e.preventDefault()
  } catch (_) {
    /* 忽略 */
  }
  el.focus()
  el.__pickerOpened = true
  // 下一个手势再允许弹（用 setTimeout 0 避开本次按压后续派发的事件）
  setTimeout(() => {
    el.__pickerOpened = false
  }, 0)
  try {
    el.showPicker()
  } catch (_) {
    /* 不支持 / 被策略拦截时退回普通聚焦，用户点小箭头仍可选 */
  }
}

/* 敏感字段（token / webhook / secret / chatId 等）默认以密码框遮罩，
 * 点眼睛图标临时显示，避免旁人瞥见凭据。每个字段独立开关。 */
const revealed = reactive({
  dtWebhook: false,
  dtSecret: false,
  // 关键事件独立机器人（钉钉 / 企微各一个独立 webhook，钉钉另含加签密钥）
  dtCritWebhook: false,
  dtCritSecret: false,
  wcCritWebhook: false,
  tgToken: false,
  tgChat: false,
  tgGroup: false,
  wcWebhook: false,
  maskPwd: false
})

/** 把 slots 写回配置；老字段 start/end 同步为首个时段，兼容旧版本读取 */
function persistSlots(list) {
  if (!opts.silent) opts.silent = {}
  opts.silent.slots = list.map((s) => ({ start: s.start, end: s.end }))
  const first = opts.silent.slots[0]
  if (first) {
    opts.silent.start = first.start
    opts.silent.end = first.end
  }
}

function addSlot() {
  const list = [...slotsOf.value]
  // 新时段默认给一个明显不同的区间（午休 12:00~13:00），避免和已有时段重叠
  list.push({ start: '12:00', end: '13:00' })
  persistSlots(list)
}

function removeSlot(i) {
  if (slotsOf.value.length <= 1) return
  const list = slotsOf.value.filter((_, x) => x !== i)
  persistSlots(list)
}

/** 当前命中的是哪个时段（用于提示"当前生效：夜里 19:00~08:00"） */
const activeSlotLabel = computed(() => {
  const c = opts.silent
  if (!c || !c.enabled) return ''
  const now = Date.now()
  const d = new Date(now)
  const m = d.getHours() * 60 + d.getMinutes()
  const toMin = (s) => {
    const [h, mm] = String(s || '0:0').split(':').map((n) => Number(n) || 0)
    return h * 60 + mm
  }
  // 与 useAlertPush.matchSlot 同一套判定（含跨零点）
  const hit = slotsOf.value.find((s) => {
    const a = toMin(s.start)
    const b = toMin(s.end)
    if (a === b) return false
    return a < b ? m >= a && m < b : m >= a || m < b
  })
  if (!hit) return ''
  const cross = hit.end < hit.start ? '（跨零点）' : ''
  return `${hit.start} ~ ${hit.end}${cross}`
})

const silentStatusText = computed(() => {
  const c = opts.silent
  if (!c || !c.enabled) return '未开启'
  const ch = (c.channels || []).map((id) => CH_LABELS[id] || id)
  // 多时段（item 114）：把所有时段都列出来，别只显示第一个
  const slots = slotsOf.value
  const slotsLabel = slots.length ? slots.map((s) => `${s.start}~${s.end}`).join('、') : '无'
  const base = `静默渠道：${ch.length ? ch.join(' / ') : '无'}（${slotsLabel}）`
  if (!silentActiveNow.value) return `未进入静默 · ${base}`

  /*
   * 静默中：算「距离最近那个结束点还有多久」。
   * 多个时段命中时取最晚的结束（免打扰按最宽窗口算），这里必须和
   * useAlertPush.matchSlot 的口径一致，否则显示的剩余时间会跟实际推送时刻对不上。
   */
  const toMin = (s) => {
    const [h, m] = String(s || '0:0').split(':').map((n) => Number(n) || 0)
    return h * 60 + m
  }
  const m = new Date(nowTs.value).getHours() * 60 + new Date(nowTs.value).getMinutes()
  let endMin = null
  slots.forEach((s) => {
    const a = toMin(s.start)
    const b = toMin(s.end)
    if (a === b) return
    const hit = a < b ? m >= a && m < b : m >= a || m < b
    if (!hit) return
    // 跨零点且当前在"结束前"那段时，实际结束时刻是明天的 end
    const cand = b <= m && m < a ? b + 1440 : b
    if (endMin === null || cand > endMin) endMin = cand
  })
  if (endMin === null) return `静默中 · ${base}`
  const diff = Math.max(0, endMin - m)
  const hh = Math.floor(diff / 60)
  const mm = diff % 60
  const dur = hh ? `${hh} 小时 ${mm} 分` : `${mm} 分`
  // 结束时刻可能落在次日，标出来更清楚
  const p2 = (n) => String(n).padStart(2, '0')
  const endText = endMin >= 1440 ? `次日 ${p2(endMin - 1440)}` : p2(endMin % 1440)
  return `静默中 · 将于 ${endText} 自动推送结束提醒 + 汇总（约 ${dur} 后）· ${base}`
})
function flushSilentNow() {
  emit('flush-silent')
}

/** 试发一条「免打扰已开启」提醒（调完文案先看一眼效果） */
function testPreSilence() {
  emit('test-pre-silent')
}

/** 试发一条「免打扰已结束」提醒（不动真实缓冲，随便点都不会丢事件） */
function testPostSilence() {
  emit('test-post-silent')
}

/* ---------------- 统计页重置回调（item 111） ---------------- */
/** 统计清零后，"关于系统"页的累计推送数也要一起清，否则两页数字对不上 */
function onStatsReset() {
  resetPushStats()
}

/* ---------------- 报警通知位置（item 117） ---------------- */
/**
 * 停靠位置四选一。默认左上角：顶栏下方不压画面主体，
 * 而右下角已经被常驻的事件面板占了。
 */
const NOTIFY_POSITIONS = [
  { key: 'tl', label: '左上' },
  { key: 'tr', label: '右上' },
  { key: 'bl', label: '左下' },
  { key: 'br', label: '右下' }
]

const notifyPos = computed(() => {
  const p = opts.ui && opts.ui.notifyPos
  return NOTIFY_POSITIONS.some((x) => x.key === p) ? p : 'tl'
})
const notifyGap = computed(() => (opts.ui ? Number(opts.ui.notifyGap) : 14) || 0)

function setNotifyPos(key) {
  if (!opts.ui) opts.ui = {}
  opts.ui.notifyPos = key
}

function setNotifyGap(v) {
  if (!opts.ui) opts.ui = {}
  const n = Number(v)
  opts.ui.notifyGap = Number.isFinite(n) ? Math.max(0, Math.min(80, n)) : 14
}

/** 报警通知卡片总开关（关掉后只记事件面板与推送，不弹卡片） */
function toggleTopNotify() {
  if (!opts.alert) opts.alert = {}
  opts.alert.topNotify = opts.alert.topNotify === false
}

/* ---------------- 临时静默（item 112） ---------------- */

/** 快捷时长（小时） */
const TEMP_HOURS = [0.5, 1, 2, 4, 8]
const TEMP_CHANNEL_OPTS = [
  { id: 'ding', label: '钉钉' },
  { id: 'wecom', label: '企微' },
  { id: 'tg', label: 'TG' }
]

/**
 * 「远程静默指令默认静默哪些渠道」（TG 推送 → 远程控制 → 可用指令）。
 *
 * 直接读配置里的 `telegram.remote.silentChannels`，不另存一份到组件状态 ——
 * 界面上勾一下、手机上发条 /silent，走的就是同一个值，
 * 不会出现「界面上勾了却不生效」这种两头不认账的情况。
 *
 * ⚠️ 这里**不**把空数组当"没配"：空 = 用户明确一个都不勾（远程指令会拒绝执行），
 * 界面上如实显示成"一个都没勾"才对。当成"没配"再填回默认值，
 * 就等于用户取消勾选反而静默了默认的两个渠道 —— 正是要避免的那种反直觉。
 */
const remoteSilentChannels = computed(() => {
  const r = opts.telegram && opts.telegram.remote
  return r && Array.isArray(r.silentChannels) ? r.silentChannels : []
})

/**
 * 读「默认渠道」的兜底值：只有字段缺失（老存档）才用内置默认；
 * 显式空数组照原样返回，不替换。
 */
function readRemoteDefaultChannels() {
  const r = opts.telegram && opts.telegram.remote
  const cfg = r && r.silentChannels
  return Array.isArray(cfg) ? cfg.slice() : [...DEFAULT_SILENT_CHANNELS]
}

function toggleRemoteSilentChannel(id) {
  const r = opts.telegram && opts.telegram.remote
  if (!r) return
  const cur = Array.isArray(r.silentChannels) ? r.silentChannels : []
  r.silentChannels = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
}

const tempHours = ref(1)
/** 'hours' 按小时 | 'until' 指定到几点 */
const tempMode = ref('hours')
/**
 * datetime-local 的值，形如 2026-10-07T08:00。
 * 初值给「明天早上 08:00」—— 空着的话用户切到这个模式还得自己挑，
 * 而"静默到明天早上"恰好是最常用的意图。
 */
const tempUntilLocal = ref('')
const tempLabel = ref('')
/**
 * 本次手动开启临时静默要静默哪几端。
 *
 * 初值 = 上面那份「远程静默默认渠道」，同一个概念不该让用户配两遍还不一致。
 * 抽屉是 v-if 挂载的（见 App.vue），每次打开都会重新取一次 ——
 * 所以这是"打开时的默认"，而不是组件生命周期里一次性定死的快照。
 */
const tempChannels = ref(readRemoteDefaultChannels())
/** 临时静默是否正在生效（由 App 通过 temp-silent prop 回传） */
const tempActive = computed(() => !!props.tempSilent.active)
const tempInfo = computed(() => props.tempSilent || { active: false })

/** 生成本地 datetime 字符串（datetime-local 控件要的就是这个格式，且不能用 toISOString——那是 UTC） */
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 快捷预设：明天早上 08:00 / 今晚 24:00 */
const tomorrowMorning = computed(() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return toLocalInput(d)
})
const tonightMidnight = computed(() => {
  const d = new Date()
  d.setHours(24, 0, 0, 0)
  // setHours(24) 会溢出到次日 00:00，正好就是"今晚 24:00"
  return toLocalInput(d)
})

// 预填「明天早上 08:00」：切到"静默到几点"时就能直接点开启
tempUntilLocal.value = tomorrowMorning.value

/** 把 datetime-local 的值转成时间戳；空值返回 0 */
function tempUntilTs() {
  if (!tempUntilLocal.value) return 0
  const t = new Date(tempUntilLocal.value).getTime()
  return Number.isFinite(t) ? t : 0
}

/** 预估结束时刻提示，让人点之前就知道会静默到什么时候 */
const tempPreview = computed(() => {
  if (tempMode.value === 'until') {
    const t = tempUntilTs()
    if (!t) return '请选择一个结束时间'
    if (t <= Date.now()) return '结束时间需要晚于当前时间'
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    const span = t - Date.now()
    // 分钟先进位到小时，否则 2h59m 会显示成 "2 小时 60 分"
    const totalMin = Math.round(span / 60000)
    const hh = Math.floor(totalMin / 60)
    const mm = totalMin % 60
    const how = hh ? `${hh} 小时 ${mm} 分` : `${mm} 分`
    return `将静默至 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
      d.getMinutes()
    )}（约 ${how} 后）`
  }
  const h = Number(tempHours.value) || 0
  if (!h) return '请选择时长'
  const d = new Date(Date.now() + h * 3600000)
  const p = (n) => String(n).padStart(2, '0')
  return `将静默至今天/明天 ${p(d.getHours())}:${p(d.getMinutes())}`
})

function toggleTempChannel(id) {
  const i = tempChannels.value.indexOf(id)
  if (i >= 0) tempChannels.value = tempChannels.value.filter((x) => x !== id)
  else tempChannels.value = [...tempChannels.value, id]
}

function startTempNow() {
  emit('start-temp-silent', {
    hours: Number(tempHours.value) || 0,
    channels: tempChannels.value.slice(),
    label: tempLabel.value.trim(),
    // 'until' 模式传绝对时间戳；'hours' 模式传 0 走时长分支
    untilAt: tempMode.value === 'until' ? tempUntilTs() : 0
  })
}

function endTempNow(flush) {
  emit('end-temp-silent', !!flush)
}

/** 设置页「立即重启系统」按钮：交给 App.vue 决定走 Electron 原生重启还是后端 API */
function restartSystemNow() {
  emit('restart-system')
  // 顺手盯一下结果：后端会先释放端口，前几秒请求失败是预期行为
  pollRestartResult()
}

/* ---------------- 重启诊断（后端模式） ---------------- */

function backendBase() {
  return String((props.options.backend && props.options.backend.url) || '').replace(/\/+$/, '')
}

/** 是否启用了后端检测服务（数据库在后端服务器上，才能导出 monitor.db） */
const backendEnabled = computed(
  () => !!(props.options.backend && props.options.backend.enabled && props.options.backend.url)
)

/** 重启结果码 → 人话 */
function restartResultText(r) {
  const map = {
    ok: '成功（新进程已接管端口）',
    'rollback-ok': '失败，但已自动回滚（服务未中断）',
    'rollback-failed': '失败且回滚失败（服务已停止）',
    storm: '被「重启风暴保护」拦下（连续失败过多次）',
    busy: '已有一次重启在进行中'
  }
  if (!r) return '暂无记录'
  return map[r] || String(r)
}

function fmtRestartTime(ts) {
  try {
    return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false })
  } catch (e) {
    return ''
  }
}

/**
 * 待录入人脸卡片底部展示的「捕获时间」。
 * 卡片只有 88px 宽，不能塞整条 toLocaleString，这里压成紧凑格式：
 *   - 今天 → 只显示 `HH:mm:ss`（最关心的是"刚抓到还是几小时前"）；
 *   - 跨天 → 补上 `M-D`，变成 `M-D HH:mm:ss`，仍能一眼分清是哪天的。
 * 入参是 ms 时间戳（前端 pushPendingFace 与后端 store.listPendingFaces 都给的是这个）。
 */
function fmtPendingAt(ts) {
  const d = new Date(Number(ts))
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const hms = d.toLocaleTimeString('zh-CN', { hour12: false })
  return sameDay ? hms : `${d.getMonth() + 1}-${d.getDate()} ${hms}`
}

async function refreshRestartInfo() {
  const base = backendBase()
  if (!base) {
    // 本地模式（浏览器直跑 / 桌面端）没有后端可问，不必显示成错误
    restartInfo.value = { ok: false }
    return null
  }
  try {
    const r = await fetch(`${base}/api/restart-status`)
    const data = await r.json()
    restartInfo.value = { ok: true, ...data }
    return restartInfo.value
  } catch (e) {
    restartInfo.value = { ok: false, error: (e && e.message) || '网络错误' }
    return null
  }
}

/**
 * 重启后轮询结果。
 * 后端重启会先释放端口，所以前几秒请求失败是**预期行为**而不是错误。
 * 用 lastAt 判断「这条记录是不是本次重启产生的」，免得读到上一次的旧结果。
 */
let restartPolling = false
async function pollRestartResult() {
  if (restartPolling || !backendBase()) return
  restartPolling = true
  const sentAt = Date.now()
  const deadline = sentAt + 90000
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const data = await refreshRestartInfo()
      if (data && Number(data.lastAt) >= sentAt - 2000) return
    }
  } finally {
    restartPolling = false
  }
}

/* ==================== 配置补齐 ==================== */
/**
 * 顶层是浅合并，后加进来的配置块（face / pose / zone）如果老存档里存在、
 * 但缺字段，就会整块带着 undefined 进来。这里按默认值补齐嵌套字段。
 */
const _DEFAULTS = cloneDefaultOptions()
;['face', 'pose', 'zone'].forEach((k) => {
  opts[k] = { ..._DEFAULTS[k], ...(opts[k] || {}) }
})
opts.pose.actions = { ..._DEFAULTS.pose.actions, ...(opts.pose.actions || {}) }
// 老存档里没有 backend 块时补齐（默认 enabled:false，行为不变）
opts.backend = { ..._DEFAULTS.backend, ...(opts.backend || {}) }

/* ==================== 后端检测服务（headless） ==================== */
const backendTesting = ref(false)

/** 切换后端检测总开关（enabled 的 watch 在 App.vue 里，这里只改配置） */
function toggleBackend() {
  if (!opts.backend) opts.backend = { ..._DEFAULTS.backend }
  opts.backend.enabled = !opts.backend.enabled
  // 刚打开时地址多半是空的（老配置里没有这个字段）→ 直接填上那台常驻设备的地址，
  // 省得用户还要去翻 IP。填错了也还能手动改。
  if (opts.backend.enabled && !String(opts.backend.url || '').trim()) {
    opts.backend.url = DEFAULT_BACKEND_URL
  }
  // 打开瞬间主动探测一次，让状态文本立刻有反馈
  if (opts.backend.enabled && opts.backend.url) onBackendTest()
}

/** 手动刷新一次服务状态快照 */
async function onBackendTest() {
  if (backendTesting.value) return
  if (!opts.backend || !opts.backend.url) return
  backendTesting.value = true
  try {
    // 一次刷新把两份快照都拿回来：服务本身（/api/status）+ 状态哨兵（/api/watchdog）
    await Promise.all([refreshBackendStatus(opts), refreshBackendWatchdog(opts)])
  } finally {
    backendTesting.value = false
  }
}

/** 后端通道状态 → 中文（与后端 STATE_LABEL 同口径，这里只取短词） */
function stateTextOf(state) {
  switch (state) {
    case 'playing':
      return '正常'
    case 'error':
      return '异常'
    case 'connecting':
      return '连接中'
    case 'closed':
      return '已关闭'
    default:
      return '未接入'
  }
}

/** 「还有多久」倒计时（下次巡检时间用） */
function formatCountdown(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000))
  if (s < 60) return `${s} 秒后`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟后`
  return `${(m / 60).toFixed(1)} 小时后`
}

/* ---------- 待录入人脸（后端链路） ----------
 * ⚠️ 这三个声明必须排在下面那个 immediate watcher 之前 ——
 * watcher 带 immediate:true 会在 setup 期间同步执行回调，
 * 引用到后面才初始化的 const 会直接抛 TDZ 错误（faceBackendOn before initialization）。 */

/** 后端检测服务是否接管（决定待录入人脸从哪来） */
const faceBackendOn = computed(() => !!(opts.backend && opts.backend.enabled && opts.backend.url))

/**
 * 「待录入」列表 = 前端自己检测到的 + 后端检测到的。
 *
 * 两种模式下来源不同，但**必须都显示**，否则会出现「抓到了人脸却没进库」：
 *   - 纯前端链路 → 前端检测写进内存队列（pendingFaces）
 *   - 后端链路   → 后端检测写进它自己的 SQLite（backendPendingFaces）
 * 之前只读前端那份，后端模式下永远是空的。
 */
const allPendingFaces = computed(() =>
  faceBackendOn.value ? [...backendPendingFaces.value, ...pendingFaces.value] : [...pendingFaces.value]
)

/** 刷新待录入：加载态 + 结果提示（以前点下去毫无反馈，用户不知道有没有生效） */
const pendingRefreshing = ref(false)
const pendingRefreshNote = ref('')

/** 拉一次后端待录入队列（后端模式下人脸是在服务端抓的） */
async function refreshBackendPending() {
  if (!faceBackendOn.value || pendingRefreshing.value) return
  pendingRefreshing.value = true
  pendingRefreshNote.value = ''
  try {
    await loadBackendPendingFaces(opts.backend.url)
    if (backendPendingError.value) {
      pendingRefreshNote.value = `刷新失败：${backendPendingError.value}`
    } else {
      const n = backendPendingFaces.value.length
      const t = new Date(backendPendingLoadedAt.value || Date.now()).toLocaleTimeString('zh-CN')
      pendingRefreshNote.value = `已刷新 · ${n} 张 · ${t}`
    }
  } finally {
    pendingRefreshing.value = false
  }
}

/**
 * 「待录入」为空时的占位文案。
 *
 * 四种"空"的原因完全不同，给的下一步动作也完全不同，所以必须分开说 ——
 * 合成一句「暂无数据」等于什么都没解释：
 *   ① 后端开着但这次没拉上 → 说清是网络/超时问题，并提示列表**没被清空**；
 *   ② 没开「收集陌生人脸」      → 这是最常见的一类，直接指到那个开关；
 *   ③ 后端开着、确实没人未录入  → 告诉他抓取在后端，稍等或点刷新；
 *   ④ 纯前端链路、确实没人      → 说明暂存规则（只留最近若干张、不落盘）。
 */
const pendingEmpty = computed(() => {
  if (faceBackendOn.value && backendPendingError.value) {
    const stale = backendPendingLoadedAt.value
      ? `（下面这份是 ${new Date(backendPendingLoadedAt.value).toLocaleTimeString('zh-CN')} 拿到的）`
      : ''
    return {
      icon: '⚠️',
      title: '待录入队列没能拉回来',
      hint: `${backendPendingError.value}${stale}。拉取失败不会清空已有列表，点下方「刷新待录入」重试即可。`
    }
  }
  if (!opts.face.collectUnknown) {
    return {
      icon: '⚪',
      title: '「收集陌生人脸」是关着的',
      hint: '打开它，检测到没录入的人就会先暂存在这里，方便事后一键建档。'
    }
  }
  if (faceBackendOn.value) {
    return {
      icon: '📭',
      title: '后端暂未抓到未录入的人脸',
      hint: '跑检测的是后端服务（人脸是在服务端抓的），抓到就会出现在这里；刚重启或刚改过配置时，稍等一会儿点「刷新待录入」。'
    }
  }
  return {
    icon: '📭',
    title: '还没有暂存任何陌生人脸',
    hint: '等摄像头拍到没录入的人，脸会先暂存在这里 —— 只留最近 24 张，且不落盘，重启后就没有了。'
  }
})

/* ---------- 命中修正（后端链路） ----------
 * 「命中修正」列表 = 后端检测服务每次认出库里的人时存下的样本
 * （向量 + 当时认定的名字 + 相似度 + 原图，store.addHitFace）。
 * 只有后端模式下有内容：前端自己跑检测时不落这份样本。 */
const hitRefreshing = ref(false)
const hitRefreshNote = ref('')
const hitAssign = reactive({}) // h.id -> '' | 已知名字 | '__custom__'
const hitCustom = reactive({}) // h.id -> 自定义正确名字文本
const fixingHit = reactive({}) // h.id -> bool（修正进行中）

/** 拉一次后端命中样本（后端模式下识别是在服务端跑的） */
async function refreshBackendFaceHits() {
  if (!faceBackendOn.value || hitRefreshing.value) return
  hitRefreshing.value = true
  hitRefreshNote.value = ''
  try {
    await loadBackendFaceHits(opts.backend.url)
    if (backendFaceHitsError.value) {
      hitRefreshNote.value = `刷新失败：${backendFaceHitsError.value}`
    } else {
      const n = backendFaceHits.value.length
      const t = new Date(backendFaceHitsLoadedAt.value || Date.now()).toLocaleTimeString('zh-CN')
      hitRefreshNote.value = `已刷新 · ${n} 条 · ${t}`
    }
  } finally {
    hitRefreshing.value = false
  }
}

/** 把下拉 + 自定义框解析成「正确名字」；'' = 还没选 */
function hitAssignName(h) {
  const a = hitAssign[h.id]
  if (a === '__custom__') return (hitCustom[h.id] || '').trim()
  return a || ''
}
/** 卡片被修正 / 忽略后清掉它占用的选择状态，别留 stale key */
function clearHitAssign(h) {
  delete hitAssign[h.id]
  delete hitCustom[h.id]
}

/**
 * 修正一条命中样本：把它的向量按**正确名字**录进人脸库。
 *
 * 为什么这能提升精准度：matchFace 是「余弦相似度找最像的样本」——
 * 同一张脸在库里同时有「小刘」「大刘」两个标签的样本时，谁分数高就报谁。
 * 按正确名字补一条同 vectors 的样本后，这张脸对正确名字的分数被抬上去，
 * 后续命中就会落到对的人名下。样本录完即从后端删除（使命完成）。
 *
 * ⚠️ 必须走前端 addFace：前端人脸库是 source of truth，会随配置推送
 *    自动同步覆盖后端；后端自己 addFace 会被下一次同步整体替换掉，白录。
 */
async function doFixHit(h) {
  if (!h || fixingHit[h.id]) return
  const name = hitAssignName(h)
  if (!name) {
    alertDialog({
      title: '还没选名字',
      message: '先在下拉里选这个人的正确名字（或选「自定义」填一个），再点「修正」。',
      variant: 'default'
    })
    return
  }
  if (name === h.name) {
    alertDialog({
      title: '名字没变',
      message: `选的名字和当前认成的「${h.name}」一样，修正它没有意义 —— 要提升精准度，请选成另一个人（或自定义成对的名字）。`,
      variant: 'default'
    })
    return
  }
  fixingHit[h.id] = true
  try {
    const res = await addFace(h.vector, h.thumb, name, Number(opts.face.libMax) || 50)
    if (!res.ok) {
      alertDialog({ title: '修正失败', message: res.reason || '录入失败', variant: 'danger' })
      return
    }
    // 与待录入同口径：落库成功后本地乐观移除卡片，后端删除放后台异步跑
    clearHitAssign(h)
    dropBackendFaceHit(opts.backend.url, h.backendId) // 故意不 await
    delete fixingHit[h.id] // 落库即解锁，不等网络
  } catch (e) {
    alertDialog({
      title: '修正失败',
      message: '写入本地人脸库时出错：' + ((e && e.message) || e) + '\n这条样本还在列表里，可以稍后重试。',
      variant: 'danger'
    })
  } finally {
    delete fixingHit[h.id]
  }
}

/** 忽略一条命中样本（不想修正也不想再看到它） */
function doIgnoreHit(h) {
  if (!h) return
  dropBackendFaceHit(opts.backend.url, h.backendId)
  clearHitAssign(h)
}

/**
 * 把一条命中样本标成「不是本人」（陌生人反例）。
 *
 * 为什么「忽略」不够：忽略只是把样本从列表删掉，库内样本与这张陌生脸的
 * 余弦依然过高，下次照认。反例把这条脸的向量存下来（addFaceBlock），
 * 匹配时「反例分 ≥ 阈值且 ≥ 库内最像分」即判未录入 —— 同一张脸再来
 * 直接走待录入/陌生人路径。库里真人本人不受影响。
 *
 * 与修正同一套规矩：必须走前端 addFaceBlock（前端 IndexedDB 是 source of
 * truth，随配置同步覆盖后端；后端直接写会被下一次同步替换掉，白标）。
 */
async function doMarkStranger(h) {
  if (!h || fixingHit[h.id]) return
  if (!h.vector || !h.vector.length) {
    alertDialog({
      title: '没法标记',
      message: '这条样本没有可用的特征向量（可能是旧版本后端存的），换个样本或先刷新命中。',
      variant: 'default'
    })
    return
  }
  fixingHit[h.id] = true
  try {
    const res = await addFaceBlock({ vector: h.vector, thumb: h.thumb, name: h.name || '' })
    if (!res.ok) {
      alertDialog({ title: '标记失败', message: res.reason || '写入反例失败', variant: 'danger' })
      return
    }
    // 与修正同口径：本地落库成功后乐观移除卡片，后端删除放后台异步跑
    clearHitAssign(h)
    dropBackendFaceHit(opts.backend.url, h.backendId) // 故意不 await
    delete fixingHit[h.id] // 落库即解锁，不等网络
  } catch (e) {
    alertDialog({
      title: '标记失败',
      message: '写入反例时出错：' + ((e && e.message) || e) + '\n这条样本还在列表里，可以稍后重试。',
      variant: 'danger'
    })
  } finally {
    delete fixingHit[h.id]
  }
}

/** 解除一条陌生人标记（之后这张脸重新参与正常匹配） */
async function doUnmarkStranger(b) {
  if (!b) return
  try {
    await removeFaceBlock(b.id)
  } catch (e) {
    alertDialog({ title: '解除失败', message: ((e && e.message) || e), variant: 'danger' })
  }
}

/**
 * 「陌生人标记」列表（轻量，去掉向量）。
 * 依赖 faceBlocksVersion：反例增删后缓存刷新会自增它，这里才会重算。
 */
const strangerMarks = computed(() => {
  void faceBlocksVersion.value
  return currentFaceBlocks().map((b) => ({
    id: b.id,
    thumb: b.thumb || '',
    name: b.name || '',
    at: b.at || 0
  }))
})

/**
 * 「命中修正」为空时的占位文案。
 * 三种"空"的原因完全不同，必须分开说：
 *   ① 后端开着但这次没拉上 → 网络/超时问题，列表**没被清空**，点刷新重试；
 *   ② 「命中已录入人脸时报警」关着 → 后端根本不发已知命中事件，也就没有样本；
 *   ③ 确实还没有命中 → 说明样本从哪来、什么时候会出现。
 */
const hitEmpty = computed(() => {
  if (backendFaceHitsError.value) {
    const stale = backendFaceHitsLoadedAt.value
      ? `（下面这份是 ${new Date(backendFaceHitsLoadedAt.value).toLocaleTimeString('zh-CN')} 拿到的）`
      : ''
    return {
      icon: '⚠️',
      title: '命中样本没能拉回来',
      hint: `${backendFaceHitsError.value}${stale}。拉取失败不会清空已有列表，点下方「刷新命中」重试即可。`
    }
  }
  if (!opts.face.eventOnKnown) {
    return {
      icon: '⚪',
      title: '「命中已录入人脸时报警」是关着的',
      hint: '打开它，识别到库里的人才会留下命中样本，也才能在这里修正「认错了人」。'
    }
  }
  return {
    icon: '📭',
    title: '后端还没有命中样本',
    hint:
      '跑检测的是后端服务，识别到库里的人后，这里会出现最近 20 条样本（带原图）。刚启动或刚录完人脸库时，稍等一会儿点「刷新命中」。' +
      '如果是陌生人被误认成了某人（而不是认错了人），点卡片上的「不是本人」把它标成反例，之后同一张脸再来会直接判未录入。'
  }
})

/**
 * 抽屉一打开（或后端刚连上）就把状态哨兵快照拉回来。
 * 后端模式下掉线监控与定时巡检都在服务端，用户打开设置最想看的就是
 * 「它到底在不在盯、下次什么时候发报告」——不该还要手动点刷新。
 */
watch(
  () => [backendState.value, opts.backend && opts.backend.enabled],
  () => {
    if (backendState.value === 'polling' && !backendWatchdog.value) refreshBackendWatchdog(opts)
    // 后端模式下未录入人脸是在服务端抓的，进「检测识别」页就把待录入队列拉回来，
    // 否则用户看到的是空列表，以为「抓到的脸没进库」
    if (faceBackendOn.value) {
      refreshBackendPending()
      // 命中样本同理：后端识别到库里的人才会留下可修正的样本，进页就拉一次
      refreshBackendFaceHits()
    }
  },
  { immediate: true }
)

/**
 * 手动把整份配置推给后端。
 * 真正的打包（options + cameras + 人脸库）在 App.vue 里 —— 那边才拿得到 cameras
 * 和 IndexedDB 里的人脸库，这里只负责发出请求，并顺手刷新一次状态显示。
 */
function onBackendSync() {
  emit('backend-sync')
  onBackendTest()
}

/** 从后端整体拉一份配置回来（覆盖本机前 App.vue 会先确认一次） */
function onBackendPull() {
  emit('pull-backend')
}

/*
 * 「本机版本 / 后端版本」两个数字，以及"本机落后了"这个结论。
 * 两个 rev 的语义完全不同，别混：
 *   localRev = 本机这份配置对应后端的哪个版本（落盘，只有真的推/拉成功才变）；
 *   syncRev  = 后端当前版本（轮询 /api/status 就会被刷新）。
 * 用 syncRev 当"本机版本"会让落后判定永远成立 —— 自己一推完就"落后"了。
 */
const localRevText = computed(() => (localRev.value > 0 ? `rev ${localRev.value}` : '未对齐'))
const syncRevText = computed(() => (syncRev.value > 0 ? `rev ${syncRev.value}` : '—'))
const behindBackend = computed(() => localRev.value > 0 && syncRev.value > localRev.value)

/* ==================== 通道级附加能力（人脸 / 姿态 / 区域） ==================== */
/**
 * 和「检测识别」页的全局总开关是**两层**控制：
 *   全局开着 + 本通道开着 → 这一路才真的跑。
 * 这里管的是"这一路要不要参与"，目的是把算力集中到真正在看的那几路上。
 */
const EXT_ITEMS = [
  { key: 'face', label: '人脸', globalLabel: '人脸识别' },
  { key: 'pose', label: '姿态', globalLabel: '人形姿态' },
  { key: 'zone', label: '区域', globalLabel: '区域规则' }
]

/** 区域规则没有单一总开关（由进出 / 徘徊 / 计数几个子项决定），只有人脸和姿态要看全局 */
function extGlobalOn(key) {
  if (key === 'zone') return true
  const g = opts[key]
  return !!(g && g.enabled)
}

function camExtTitle(cam, e) {
  if (!cam.ai) return `先开启这一路的「人形识别」——${e.globalLabel}建立在人形检测之上`
  if (!camExtOn(cam, e.key)) return `这一路目前不参与${e.globalLabel}，点击恢复`
  if (!extGlobalOn(e.key)) return `「${e.globalLabel}」的全局总开关还没开（在「检测识别」页），这里只是预设这一路是否参与`
  return `点击让这一路不再跑${e.globalLabel}（省这一路的算力）`
}

/** 翻转这一路的附加能力（cams 是直接改对象的，跟上面 motion / ai 的写法保持一致） */
function toggleCamExt(cam, key) {
  if (!cam.ai) return
  const cur = cam.aiExt || {}
  cam.aiExt = {
    face: cur.face !== false,
    pose: cur.pose !== false,
    zone: cur.zone !== false,
    // 保留历史 aiExt.hit 字段（旧存档可能有），它现在是无害的残留，不再参与推送判定
    hit: cur.hit === true,
    [key]: cur[key] === false
  }
}


/* ==================== 推送渠道联动 ==================== */
/*
 * 补齐三个渠道的旧配置字段。
 *
 * ⚠️ 这里必须在 setup 阶段一次做完，**绝不能放进 computed**：
 *    normalizeDingTalk / normalizeWeCom 内部的补齐是「无条件赋值」写法
 *    （dt.events = normalizeEvents(events)，每次都产生一个新对象）。
 *    在 computed 里做的话，求值时读了 opts.xxx、又写了 opts.xxx.events，
 *    就会变成「求值 → 自己的依赖失效 → 再求值 → 再写」的死循环。
 *    Vue 会直接抛 "Maximum recursive updates exceeded"，表现为
 *    手机端打开设置抽屉「闪一下就没了」。
 *    顺带一提：所有标签页用的是 v-show，抽屉一打开全部模板都要渲染，
 *    所以这里的任何抖动都会被放大。
 */
if (opts.dingtalk) normalizeDingTalk(opts.dingtalk)
if (opts.wecom) normalizeWeCom(opts.wecom)
if (opts.telegram) normalizeTelegram(opts.telegram)

/*
 * 兜底：确保「关键事件独立机器人」子块存在。
 * 正常路径下 App 载入时 fillMissingOptions 已经补齐，但抽屉可能拿到一份
 * 尚未迁移的老 options（或首次渲染早于迁移）；缺了它，下面的 v-model
 * 会直接写 undefined.critical.webhook 报错。默认值取自同一份 defaults.js。
 */
{
  const _def = cloneDefaultOptions()
  if (opts.dingtalk && !opts.dingtalk.critical) {
    opts.dingtalk.critical = JSON.parse(JSON.stringify(_def.dingtalk.critical))
  }
  if (opts.wecom && !opts.wecom.critical) {
    opts.wecom.critical = JSON.parse(JSON.stringify(_def.wecom.critical))
  }
}

/** 钉钉 / 企业微信只要有一个开着，Telegram 就必须开着（它承载图片与原图链接） */
const tgForced = computed(() => !!opts.dingtalk.enabled || !!opts.wecom.enabled)

function setTgEnabled(v) {
  // 被强制开启时不允许关掉，否则另外两个渠道会失去图片与原图入口
  if (tgForced.value && !v) return
  opts.telegram.enabled = v
}

function toggleChannel(key, v) {
  opts[key].enabled = v
  if (v && !opts.telegram.enabled) opts.telegram.enabled = true
}

function evOn(cfg, key) {
  if (!cfg) return false
  const e = cfg.events || {}
  return e[key] === undefined ? EVENT_DEFAULTS[key] : e[key] !== false
}

function toggleEvent(channelKey, evKey) {
  const target = opts[channelKey]
  if (!target) return
  if (!target.events) target.events = {}
  target.events[evKey] = !evOn(target, evKey)
}

/**
 * 「关键事件单独提醒」的四类事件。
 * 与上面的 EVENT_GROUPS（报警类型分组）**不是一回事**：那是"哪些类型的报警要推"，
 * 这是"哪几类关键事件要额外单独提醒"。键与执行层（TG directPush.events /
 * 钉钉、企微 critical.events）严格一一对应。
 */
const CRIT_EVENTS = [
  { key: 'silence', label: '静默开始/结束', desc: '免打扰时段开始与结束的状态提醒（各一条）' },
  { key: 'summary', label: '静默汇总', desc: '免打扰结束时，把本时段收存的报警汇总成一条' },
  { key: 'face', label: '在库人脸命中', desc: '识别到已录入（在库）的人脸时，带图单独提醒' },
  { key: 'pending', label: '待录入满库', desc: '待录入人脸库达到预警 / 满库线时提醒处理' }
]

/** 某渠道的「关键事件」子开关是否开启（缺省即开，与执行层同一语义 `!== false`） */
function critOn(channelKey, evKey) {
  const crit = (opts[channelKey] || {}).critical
  if (!crit) return false
  const e = crit.events || {}
  return e[evKey] !== false
}

function toggleCritEvent(channelKey, evKey) {
  const crit = (opts[channelKey] || {}).critical
  if (!crit) return
  if (!crit.events) crit.events = {}
  crit.events[evKey] = !critOn(channelKey, evKey)
}

/**
 * 取某个渠道的「关键事件」配置块。
 * TG 那处叫 directPush（私聊推送），钉钉 / 企微那两处叫 critical（独立机器人）。
 */
function critBlockOf(which) {
  if (which === 'tg') return opts.telegram && opts.telegram.directPush
  const ch = which === 'wecom' ? opts.wecom : opts.dingtalk
  return ch && ch.critical
}

/**
 * 「静默时段也允许推送」（关键事件）是否开启。
 *
 * ⚠️ 缺省 true —— 这几类关键事件在老版本里是**硬编码放行**的（静默期间照样推），
 * 所以默认必须保持"静默也推"，否则升级用户行为会突变：原本夜里能收到的
 * 静默汇总 / 人脸命中，升级后突然收不到了。
 * 判定与执行层（useAlertPush.criticalSilentBlocked）严格一致：**只有显式 false 才算关**。
 *
 * @param {string} which 'dingtalk' | 'wecom' | 'tg'
 */
function critThroughSilence(which) {
  const blk = critBlockOf(which)
  return !!blk && blk.throughSilence !== false
}

function toggleCritThroughSilence(which) {
  const blk = critBlockOf(which)
  if (!blk) return
  blk.throughSilence = blk.throughSilence === false
}

/**
 * 「结算汇总只走关键事件」（summaryOnly）是否开启。
 *
 * 场景：关键事件机器人与日常推送是两个机器人，免打扰结束后两边各推一条
 * **内容相同**的结算汇总（用户原话："两个机器人会各推一条结算汇总，但内容
 * 其实是一样的"）。缺省 false = 两条都发（与老版本一致）；打开后这一端的
 * 日常推送不再发，只由这个关键事件机器人单独发（"免打扰已结束"短提醒内容
 * 不同、不算重复，仍照发）。
 * ⚠️ 与执行层 takenOverSummaryChannels 同一语义：**只有显式 true 才算开**；
 *    且只有这个机器人确实发得出去（启用 + 勾了静默汇总 + 配了 Webhook）才
 *    真正让位，没配好时日常推送仍会兜底发这条。
 *
 * @param {string} which 'dingtalk' | 'wecom' | 'tg'
 */
function critSummaryOnly(which) {
  const blk = critBlockOf(which)
  return !!blk && blk.summaryOnly === true
}

function toggleCritSummaryOnly(which) {
  const blk = critBlockOf(which)
  if (!blk) return
  blk.summaryOnly = blk.summaryOnly !== true
}

/* ==================== AI 扩展分析 ==================== */
/** 运行时的推理后端（给用户一个"这台机器能不能开重模型"的判断依据） */
const gpuReady = computed(() => (aiSlotBackend.value || {}).detector === 'webgpu')

const gpuText = computed(() => {
  const b = aiSlotBackend.value || {}
  const any = Object.keys(b).length > 0
  if (!any) return '尚未运行'
  return gpuReady.value ? 'WebGPU 可用（推荐）' : 'WebGPU 不可用 · 回退 WASM'
})

/** 人脸库 */
// faceLibOpen 来自 useFaceLib（模块级）：抽屉关掉再打开时展开状态要保留，见那里的说明

/* ---------- 同一个人的多角度样本：归类显示 ----------
 * 用户在库里看到的问题是：同一个人被拍了好几次（正面 / 侧面 / 低头），
 * 每次都占一张卡片、各顶着「人脸 7」「人脸 12」这种自动编号 ——
 * 十几张卡片其实没几个人，**推送里也会按命中的那一条各叫各的名字**。
 * 所以这里按「人」显示：一「人」一张卡片，点开看他的全部角度。
 */
/** 正在改名的那张卡片 —— 存的是**一「人」的组 key**，不是某一条记录的 id */
const faceRenameKey = ref(null)
const faceRenameText = ref('')
/** 正在保存名字的组 key（按组记录：一个人在存，不影响另一个人继续改） */
const renamingFace = reactive({})
/** 正在合并的组 key / 正在删除的样本记录 id */
const mergingGroup = ref('')
const deletingSample = reactive({})
/** 当前点开看全部角度的那一组 */
const selectedGroupKey = ref('')
/**
 * 组面板里「参与合并」的样本 id 勾选。
 *
 * 展开组时默认全选（保持一键合并的旧习惯），用户取消勾选即可把某些角度
 * 排除在外。为什么必须能让用户选：合并是多向量**加权平均**成一条，
 * 把不同角度全并成一张"平均脸"会丢角度覆盖 —— 识别是逐条样本取最高
 * 相似度（matchFace），角度留得全才容易命中；合并真正适合的是
 * 同一角度拍重了的去重 / 腾 libMax 名额。
 */
const mergeSelected = ref([])
const mergeSelCount = computed(() => mergeSelected.value.length)
const mergeAllChecked = computed(
  () => !!selectedGroup.value && mergeSelected.value.length === selectedGroup.value.items.length
)
/** 全选 / 全不选当前组的合并勾选 */
function toggleMergeAll() {
  if (!selectedGroup.value) return
  mergeSelected.value = mergeAllChecked.value ? [] : selectedGroup.value.items.map((i) => i.id)
}

/**
 * 是否按相似度把「同一个人」的多角度样本归到一张卡片。
 *
 * 默认开 —— 这正是要的效果：同一个人只占一张卡片、只有一个名字。
 * 但相似度是**概率**，偶尔会把两个长得像的人并到一起，所以必须留一个关掉的开关：
 * 关掉后只按「同名」这个**确定**的判据归类，立刻恢复一张一条。
 * 这个偏好存 localStorage：它属于"我想怎么看这份名单"，不该每次打开设置都被重置。
 *
 * GROUP_SIM_KEY / readGroupSim 从 useFaceLib 导入（单一来源）——识别路径
 * （useAiExtras 的 matchFaceGroup）也读同一份偏好，才能保证"识别报的名字"
 * 和"库里归类显示"用的是同一套归类判据。
 */
const groupBySim = ref(readGroupSim())
function toggleGroupBySim() {
  groupBySim.value = !groupBySim.value
  try {
    localStorage.setItem(GROUP_SIM_KEY, groupBySim.value ? '1' : '0')
  } catch (e) {}
}

/**
 * 归类用的相似度判据 = **设置页那个「识别阈值」**（上面「识别阈值」滑块）。
 *
 * 刻意不另立一套常量：识别时判「这是同一个人」用的是它，库里归类显示也该是它。
 * 否则会出现"推送说认出是谁了、库里却把这个人分成两条"这种自相矛盾的界面。
 */
const groupThreshold = computed(() => Number(opts.face.matchThreshold) || DEFAULT_FACE_THRESHOLD)

/**
 * 人脸库按「人」分组。依赖 faceRowsVersion —— 完整记录（含向量）在 useFaceLib 里
 * 刻意不进响应式（512 维 × 人数，白花代理开销），只用一个版本号当"库变了"的信号。
 */
const faceGroups = computed(() => {
  void faceRowsVersion.value
  /*
   * 拆分声明也要当依赖：faceSplitsVersion 一变（新增 / 解除 / 从后端拉回）
   * 就重算分组 —— 否则拆完界面不刷新，用户以为"点了没用"。
   */
  void faceSplitsVersion.value
  return groupFaces(rawFaceRows(), {
    threshold: groupThreshold.value,
    bySimilarity: groupBySim.value,
    splits: currentSplits()
  })
})

/** 一个"人"占了多条、多出来的条数：>0 才展示归类开关与说明 */
const groupedExtra = computed(() => Math.max(0, faceLib.value.length - faceGroups.value.length))

/** 当前展开的那一组（没展开 / 组已不存在时为 null） */
const selectedGroup = computed(
  () => faceGroups.value.find((g) => g.key === selectedGroupKey.value && g.count > 1) || null
)
/** 组没了（被合并 / 删除 / 改名后不再同名）就自动收起面板，别留一个空壳 */
watch(faceGroups, (gs) => {
  if (selectedGroupKey.value && !gs.some((g) => g.key === selectedGroupKey.value && g.count > 1)) {
    selectedGroupKey.value = ''
  }
})
/* 展开 / 切换组时把合并勾选重置为全选；组被合并没或收起时清空 */
watch(
  () => selectedGroup.value?.key || '',
  (k) => {
    mergeSelected.value = k && selectedGroup.value ? selectedGroup.value.items.map((i) => i.id) : []
  }
)
function toggleGroupPanel(g) {
  if (!g || g.count < 2) return
  selectedGroupKey.value = selectedGroupKey.value === g.key ? '' : g.key
}
/** 相似度显示成百分比（界面与探针共用同一处格式化） */
function simPct(s) {
  return Math.round(Math.max(0, Math.min(1, Number(s) || 0)) * 100) + '%'
}

/* ---------- 手动拆分：「这两个不是同一人」 ----------
 * 归类判据是概率（相似度），用户的"这是两个人"是确定事实。这里把确定事实
 * 落成持久声明：id 对 + 名字对都记（见 useFaceLib.addFaceSplits 与
 * defaults.normalizeFaceSplits），链式合并也绕不过去（groupFaces 里是簇级检查）。
 */

/** 组里去重后的名字列表（「按名字拆分」按它两两配对） */
function splitNames(g) {
  return [...new Set((g && Array.isArray(g.names) ? g.names : []).filter((x) => String(x || '').trim()))]
}

/** 拆分声明的展示文案：「大刘 ∿ 黎」 */
function splitLabel(s) {
  const a = (s && s.aName) || `样本 ${s && s.aId}`
  const b = (s && s.bName) || `样本 ${s && s.bId}`
  return `${a} ∿ ${b}`
}

/**
 * 仍然有效的拆分声明：两侧名字都还在库里的才显示。
 * （样本被删光 / 改名后维护逻辑已退休的声明不会出现在这，库里的惰性清理也会收掉。）
 */
const activeSplits = computed(() => {
  void faceSplitsVersion.value
  const names = new Set((faceNameOptions.value || []).map((n) => String(n || '').trim()))
  return currentSplits().filter((s) => {
    if (!s) return false
    const aOk = (s.aName && names.has(String(s.aName).trim())) || !s.aName
    const bOk = (s.bName && names.has(String(s.bName).trim())) || !s.bName
    return aOk && bOk
  })
})

const splittingGroup = ref('')
const removingSplit = reactive({})

/**
 * 按名字拆分一个混合名组：组内每两个不同的名字之间都记一条声明
 *（样本取两名字簇的笛卡尔积 —— id 对管改名，名字对管新样本）。
 */
async function doSplitGroup(g) {
  if (!g || splittingGroup.value) return
  const names = splitNames(g)
  if (names.length < 2) return
  const msg =
    `把「${names.join('」「')}」拆成不同的人？\n\n` +
    '拆分后：库里各自成卡，推送也各叫各的名；之后新录入的同名样本同样受保护。\n' +
    // 后端模式（npm run server）下推送名是服务端定的，不同步过去服务端还按旧归类推
    (faceBackendOn.value
      ? '当前是后端模式：还需要点一次「同步到后端」，服务端才会按拆分后的名字推送。\n'
      : '') +
    '解除拆分（下方「手动拆分」列表）即可恢复自动归类。'
  if (!(await confirmDialog({ title: '按名字拆分', message: msg }))) return
  splittingGroup.value = g.key
  try {
    const byName = new Map()
    for (const it of g.items || []) {
      const nm = String(it.name || '').trim()
      if (!nm) continue
      if (!byName.has(nm)) byName.set(nm, [])
      byName.get(nm).push(it)
    }
    const pairs = []
    const ns = [...byName.keys()]
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        for (const a of byName.get(ns[i])) {
          for (const b of byName.get(ns[j])) {
            pairs.push({ aId: a.id, aName: ns[i], bId: b.id, bName: ns[j] })
          }
        }
      }
    }
    const r = await addFaceSplits(pairs)
    if (!r.ok) {
      alertDialog({ title: '拆分失败', message: r.reason || '拆分失败', variant: 'danger' })
      return
    }
    // 组已按名字裂开：原来展开的面板自然收起（watch 兜底，这里显式更稳）
    selectedGroupKey.value = ''
  } catch (e) {
    alertDialog({ title: '拆分失败', message: (e && e.message) || '拆分失败', variant: 'danger' })
  } finally {
    splittingGroup.value = ''
  }
}

/** 解除一条拆分声明（之后相似度会把他们并回去 —— 这正是"解除"的语义） */
async function doRemoveSplit(s) {
  if (!s || removingSplit[s.id]) return
  removingSplit[s.id] = true
  try {
    const r = await removeFaceSplit(s.id)
    if (!r.ok) {
      alertDialog({ title: '解除失败', message: r.reason || '解除失败', variant: 'danger' })
    }
  } catch (e) {
    alertDialog({ title: '解除失败', message: (e && e.message) || '解除失败', variant: 'danger' })
  } finally {
    delete removingSplit[s.id]
  }
}

/** 正在录入中的待录入卡片 id（防止「点下去没反馈 → 连点 → 同一张脸被建出多条」）。
 *  按 id 记录而不是全局一个开关：一张在录不影响其它卡片继续点。 */
const enrollingPending = reactive({})

/** 正在删除中的卡片组 key（同 enrollingPending 思路：按组记录，
 *  删除中显「删除中」、隐藏「改名」，防止连点 / 误操作）。 */
const deletingFace = reactive({})

/* ---------- 手动归入：待录入卡片录入时归入某人 / 改名 ----------
 * 用户诉求：录入待录入人脸时，不只"永远建一条新的人脸 N"，还要能
 *   - 归入一个已知的人（同名 → 归到他那一堆样本里）
 *   - 自定义一个名字（而不是让系统自动编号「人脸 N」）
 * 做法：每张待录入卡片挂一个「归入」下拉，选中值记到 pendingAssign[pf.id]，
 * 点「录入」时把这个名字传给 addFace（留空 = 自动编号，保持旧行为）。 */
const pendingAssign = reactive({}) // pf.id -> ''（新建）| 已知名字 | '__custom__'
const pendingCustom = reactive({}) // pf.id -> 自定义名字文本
/** 当前人脸库里已有的「归类名称」集合：下拉「归入某人」的选项来源。
 * 刻意取 faceGroups 的组名（而不是每条样本各自的 name）——库里归好类的人
 * 只应有一个名字出现在列表里，否则下拉会出现「人脸 1」「人脸 12」这种
 * 同一个人被拆成多个选项，与卡片显示、识别上报的归类名都不一致。 */
const faceNameOptions = computed(() => {
  const s = new Set()
  for (const g of faceGroups.value || []) if (g && g.name) s.add(g.name)
  return [...s]
})
/** 把下拉 + 自定义框解析成最终传给 addFace 的名字：'' = 自动编号 */
function pendingAssignName(pf) {
  const a = pendingAssign[pf.id]
  if (a === '__custom__') return (pendingCustom[pf.id] || '').trim()
  return a || ''
}
/** 卡片被录入 / 忽略后，清掉它占用的归入状态，别留 stale key */
function clearPendingAssign(pf) {
  delete pendingAssign[pf.id]
  delete pendingCustom[pf.id]
}

/* ---------- 手动归入：已录入样本归入某人 ----------
 * 用户诉求：人脸库里已建档的样本，也能手动归入某个已知的人（修自动归类误并的问题）。
 * 做法：展开某「人」看全部角度时，每条样本加一个「归入」下拉，
 * 选好（或自定义）后调 renameFace 把这一条单独改名到目标人。 */
const sampleAssign = reactive({}) // it.id -> '' | 已知名字 | '__custom__'
const sampleCustom = reactive({}) // it.id -> 自定义名字文本
const assigningSample = reactive({}) // it.id -> bool（改名进行中）
/** 下拉选了已知名字就直接归入；选「自定义」则等用户填完点「确定」 */
function onSampleAssign(it) {
  const v = sampleAssign[it.id]
  if (v && v !== '__custom__') commitSampleAssign(it)
}
async function commitSampleAssign(it) {
  if (!it || assigningSample[it.id]) return
  const v = sampleAssign[it.id]
  const name = v === '__custom__' ? (sampleCustom[it.id] || '').trim() : v
  if (!name) return
  assigningSample[it.id] = true
  try {
    const r = await renameFace(it.id, name)
    if (!r.ok) {
      alertDialog({ title: '归入失败', message: r.reason || '归入失败', variant: 'danger' })
      return
    }
    // 改名成功：这条样本离开了当前组（或换到别的人），selectedGroup 会因
    // faceGroups 重算而自动更新；清掉本行归入状态，别留"选了旧名字"的假象。
    sampleAssign[it.id] = ''
    sampleCustom[it.id] = ''
  } catch (e) {
    alertDialog({
      title: '归入失败',
      message: '改名时出错：' + ((e && e.message) || e) + '\n可以稍后重试；如果一直失败，试试关掉本应用的其它标签页。',
      variant: 'danger'
    })
  } finally {
    delete assigningSample[it.id]
  }
}

/* ---------- 手动归类（卡级）：把"这个人"整体归入另一个已知的人 ----------
 * 用户诉求：人脸库里已建档的「人」也要能手动归类，而不仅是单条样本。
 * 典型场景：自动归类把同一个人拆成了两张卡（不同角度 / 不同摄像头各一张），
 * 用户想手动声明"这两张卡是同一个人" —— 在源卡上选目标卡的名字，
 * 这一整张卡的样本会一起改名过去、重新并到目标那一组。
 * 做法：每张卡片挂一个「归入到…」下拉（选项 = 库里其它人的名字，排除自己），
 * 选好后调 renameFaces 把整组样本改名（保留各角度向量，只统一名字 → 重分组）。
 * 语义与单条样本归入一致：只是批量改名、不弹确认框（可逆，改名回来即可）。 */
const groupAssign = reactive({}) // g.key -> '' | 目标名字
const assigningGroup = reactive({}) // g.key -> bool（归入进行中）
/** 库里"其它人"的名字列表：下拉选项来源，排除当前这张卡自己的名字
 * （避免把自己并入自己这种无意义操作；同名的两张卡在按名分组下本就不会并存）。 */
function otherNames(g) {
  return (faceNameOptions.value || []).filter((n) => n !== (g && g.name))
}
/** 下拉选了已知名字就直接归入（自定义场景不存在于卡级：新建人用「改名」即可） */
function onGroupAssign(g) {
  const v = groupAssign[g.key]
  if (v) doGroupAssign(g, v)
}
async function doGroupAssign(g, name) {
  if (!g || !name || assigningGroup[g.key]) return
  assigningGroup[g.key] = true
  try {
    const r = await renameFaces(g.items.map((i) => i.id), name)
    if (!r.ok) {
      alertDialog({ title: '归入失败', message: r.reason || '归入失败', variant: 'danger' })
      return
    }
    // 整组样本改过去后：源卡消失、目标卡多了这些样本；清掉本卡归入状态，
    // 源卡若正展开也收起（watch 也会兜底，这里显式更稳）。
    groupAssign[g.key] = ''
    if (selectedGroupKey.value === g.key) selectedGroupKey.value = ''
  } catch (e) {
    alertDialog({
      title: '归入失败',
      message: '归入时出错：' + ((e && e.message) || e) + '\n可以稍后重试；如果一直失败，试试关掉本应用的其它标签页。',
      variant: 'danger'
    })
  } finally {
    delete assigningGroup[g.key]
  }
}

/* ---------- 待录入：点击缩略图看捕获时的整帧原图 ----------
 * 缩略图只是人脸裁剪，看不出"这人是在什么画面里被抓到的"。
 * 点缩略图打开一个轻量灯箱，显示 capture 时存的整帧（pf.full），
 * 没存到整帧（老数据 / 极早期）就退回缩略图。 */
const pendingShot = ref(null) // 当前查看的待录入对象（null = 灯箱关）
function openPendingShot(pf) {
  if (!pf || !pf.full) return
  pendingShot.value = pf
}
function closePendingShot() {
  pendingShot.value = null
}
function onPendingShotKey(e) {
  if (e && e.key === 'Escape') closePendingShot()
}
// 灯箱靠窗口级 Esc 关闭（div 上 @keydown 没焦点不会触发）
onMounted(() => window.addEventListener('keydown', onPendingShotKey))
onUnmounted(() => window.removeEventListener('keydown', onPendingShotKey))

async function doAddPending(pf) {
  // 已经在录这张了：连点直接拦掉（addFace 是 runExclusive，再点会排队，
  // 等上一张建完再建一张 → 自动编号出「人物2」，纯属重复建档）。
  if (enrollingPending[pf.id]) return
  enrollingPending[pf.id] = true
  try {
    // 把卡片上的「归入」选择解析成名字：留空=自动编号（旧行为），否则归入某人/自定义名。
    const name = pendingAssignName(pf)
    const res = await addFace(pf.vector, pf.thumb, name, Number(opts.face.libMax) || 50)
    if (!res.ok) {
      alertDialog({ title: '录入失败', message: res.reason || '录入失败', variant: 'danger' })
      return
    }
    // 优先录入、其余写入暂缓：addFace 落库成功后**立刻本地乐观移除卡片**，
    // 后端队列的删除放后台异步跑（dropBackendPendingFace 内部先同步剔掉本地镜像再 fetch 服务端，
    // 这里**不 await** 它），界面不再被网络超时拖在「录入中」。
    clearPendingAssign(pf)
    if (pf.fromBackend) dropBackendPendingFace(opts.backend.url, pf.backendId) // 故意不 await
    else removePendingFace(pf.id)
    delete enrollingPending[pf.id] // 落库即解锁，不等网络
  } catch (e) {
    /*
     * 必须接住异常：写入会超时报错（本地库卡死 / 被别的标签页占住），
     * 以前这里没有 catch —— 于是卡片就停在「录入中」，界面上一条提示都没有，
     * 用户只能反复点。宁可明确告诉他"没录上、为什么没录上"。
     */
    alertDialog({
      title: '录入失败',
      message: '写入本地人脸库时出错：' + ((e && e.message) || e) + '\n这张脸还在待录入里，可以稍后重试。',
      variant: 'danger'
    })
  } finally {
    delete enrollingPending[pf.id]
  }
}

/* ==================== 手动上传照片录入 ====================
 * 编排全在 useFaceLib.enrollFromImage 里；这里只负责「触发选择 → 拿文件 → 调它 → 把结果翻译成反馈」。
 * 三个明确诉求：① 一张一录 ② 上传要有提示 ③ 上传后反馈成功/失败。
 * 反馈用内联状态条（不是 alert）：进行中显「录入中…」，结束显成功/失败文案。 */
const enrollFileEl = ref(null)
const enrollState = ref('idle') // idle | loading | done | error
const enrollMsg = ref('')
const enrollOk = ref(false)

/* ---- 采集调优（高级）----
 * 检测输入边长的候选值：**32 的倍数**（解码按 stride 8/16/32 铺 anchor，
 * 非 32 的倍数会把 anchor 网格铺错）。默认 640 即历史值。 */
const FACE_DET_SIZES = [320, 480, 640, 800, 960, 1280]
const faceTuneOpen = ref(false)

/**
 * 恢复采集调优的旋钮。
 * 默认值从 **同一份** `cloneDefaultOptions()`（= defaults.js，其 face 默认值又取自
 * useTracker.FACE_TUNING / PENDING_FULL）读，不在这里另写字面量 —— 免得「恢复默认」恢复出另一个数。
 */
function resetFaceTune() {
  const d = _DEFAULTS.face || {}
  opts.face.retryMs = d.retryMs
  opts.face.headRatio = d.headRatio
  opts.face.detSize = d.detSize
  opts.face.dedupeSec = d.dedupeSec
  opts.face.pendingFullAt = d.pendingFullAt
  opts.face.pendingWarnRatio = d.pendingWarnRatio
  opts.face.pendingDedupeSec = d.pendingDedupeSec
}

function triggerEnrollFile() {
  // 先清掉上一条反馈，避免和上次的结论混在一起
  enrollState.value = 'idle'
  enrollMsg.value = ''
  if (enrollFileEl.value) enrollFileEl.value.click()
}

async function onEnrollFile(e) {
  const input = e && e.target
  const file = input && input.files && input.files[0]
  // 允许同一张照片重复选（change 不触发时，手动清 value）
  if (input) input.value = ''
  if (!file) return
  // 展开人脸库，让录入结果（新出现的一张）立即可见
  faceLibOpen.value = true
  enrollState.value = 'loading'
  enrollMsg.value = '正在加载人脸识别模型…'
  try {
    const r = await enrollFromImage(file, { score: 0.4, max: Number(opts.face.libMax) || 50 })
    if (r.ok) {
      enrollOk.value = true
      enrollState.value = 'done'
      enrollMsg.value =
        r.detected > 1
          ? `录入成功：${r.name}（照片里检测到 ${r.detected} 张人脸，已录入最清晰的一张；其余请分别上传）`
          : `录入成功：${r.name}（已自动同步到后端）`
    } else {
      enrollOk.value = false
      enrollState.value = 'error'
      enrollMsg.value = r.reason || '录入失败'
    }
  } catch (err) {
    enrollOk.value = false
    enrollState.value = 'error'
    enrollMsg.value = '录入过程出错：' + ((err && err.message) || err)
  }
}

function doIgnorePending(pf) {
  if (pf.fromBackend) dropBackendPendingFace(opts.backend.url, pf.backendId)
  else removePendingFace(pf.id)
  clearPendingAssign(pf)
}

/** 一键忽略所有待录入人脸（前端内存队列 + 后端 SQLite 队列都清掉） */
async function doIgnoreAllPending() {
  const n = allPendingFaces.value.length
  if (!n) return
  /*
   * 必须二次确认：这个动作**不可撤销**，而且一次清掉的是**全部** ——
   * 前端内存队列与后端 SQLite 队列都会被删，删完只能等它们再出现。
   * 「清空人脸库」「删除单个人脸」本来就有 confirm，这里没理由例外。
   */
  const scope = faceBackendOn.value ? '前端暂存和后端队列都会清掉，' : ''
  if (
    !(await confirmDialog({
      title: '忽略全部待录入',
      message: `确定忽略全部 ${n} 张待录入人脸？\n${scope}此操作不可撤销。`,
      variant: 'danger'
    }))
  )
    return
  // 前端内存队列：直接清空
  clearPendingFaces()
  // 后端队列：逐条回服务端删除，否则下次刷新又冒出来
  const list = backendPendingFaces.value
  for (const pf of list) {
    dropBackendPendingFace(opts.backend.url, pf.backendId)
  }
}

/**
 * 忽略「当前这一页」的待录入人脸（不是全部）。
 * 复用 doIgnorePending 的单一判定（前端内存队列 vs 后端 SQLite 队列分开处理），
 * 这里只是把"当前页可见的那几张"批量走一遍同样的忽略逻辑。
 * 删完列表会变短，pendingPageCount 的 watcher 会自动把越界的页码拉回最后一页。
 */
async function doIgnorePagePending() {
  const list = pagedPending.value
  if (!list.length) return
  const scope = faceBackendOn.value ? '（含来自后端的）' : ''
  if (
    !(await confirmDialog({
      title: '忽略本页待录入',
      message: `确定忽略本页 ${list.length} 张待录入人脸？${scope}此操作不可撤销。`,
      variant: 'danger'
    }))
  )
    return
  for (const pf of list) doIgnorePending(pf)
}

/**
 * 删除一张卡片 = 删除**这个人**（可能含多个角度样本）。
 *
 * 文案必须说清"是一整组几条"，因为这些记录在库里是"一个人"：
 * 只删掉其中一条，剩下的还会以这个人的样子出现在推送里。
 */
async function doDeleteGroup(g) {
  // 已经在删这张了：连点直接拦掉（确认弹窗是 modal，正常点不到，这里兜底防重入）
  if (!g || deletingFace[g.key]) return
  const n = g.count || 1
  const sameName = g.sameName !== false
  /* 名字不一致时，名字没法用「某某」指代 —— 那样会让用户以为删的是别的人 */
  const who = sameName ? `「${g.name}」` : `这一组（${g.names.join(' / ')}）`
  const msg =
    n > 1
      ? `确定删除${who}的 ${n} 条人脸记录？\n（这一组是同一个人的 ${n} 个角度样本，会一起删掉；删除后再次出现会重新当作陌生人。）`
      : `确定删除${who}的人脸记录？\n删除后再次出现会重新当作陌生人。`
  if (!(await confirmDialog({ title: '删除人脸记录', message: msg, variant: 'danger' }))) return
  deletingFace[g.key] = true
  try {
    await deleteFaces(g.items.map((i) => i.id))
    if (selectedGroupKey.value === g.key) selectedGroupKey.value = ''
  } catch (e) {
    alertDialog({
      title: '删除失败',
      message: '删除时出错：' + ((e && e.message) || e) + '\n可以稍后重试；如果一直失败，试试关掉本应用的其它标签页。',
      variant: 'danger'
    })
  } finally {
    delete deletingFace[g.key]
  }
}

/** 删掉一个人的其中一张角度样本（模糊 / 拍歪了的那张），保留这个人的其它样本 */
async function doDeleteSample(it) {
  if (!it || deletingSample[it.id]) return
  if (
    !(await confirmDialog({
      title: '删除这张样本',
      message: `确定删除「${it.name}」的这一张样本（${fmtPendingAt(it.createdAt)}）？\n该样本的人脸特征会一起删掉，其它角度的样本不受影响。`,
      variant: 'danger'
    }))
  )
    return
  deletingSample[it.id] = true
  try {
    await deleteFaces([it.id])
  } catch (e) {
    alertDialog({ title: '删除失败', message: '删除时出错：' + ((e && e.message) || e), variant: 'danger' })
  } finally {
    delete deletingSample[it.id]
    // 样本没了，勾选集合里别留 stale id（否则头部"全选"计数对不上）
    mergeSelected.value = mergeSelected.value.filter((id) => id !== it.id)
  }
}

/**
 * 把这一组的多角度样本**合并成一条**。
 *
 * 合并后特征按样本数加权平均、名字沿用这条人的名字，于是无论哪个角度被拍到，
 * 命中的都是同一条记录、推送里都是同一个名字，而且腾出人脸库名额。
 * 属于不可撤销（合并后各角度各自的缩略图不再单独保留），所以要二次确认。
 */
async function doMergeGroup(g) {
  if (!g || g.count < 2 || mergingGroup.value) return
  // 只合并**勾选**的样本；没勾选的角度原样留在库里（各自成组或继续归在人名下）
  const picked = g.items.filter((i) => mergeSelected.value.includes(i.id))
  if (picked.length < 2) {
    alertDialog({
      title: '至少勾选 2 条',
      message: '合并至少要勾选 2 个角度样本；不想合并的角度请保持不勾选，它们会原样保留。',
      variant: 'warn'
    })
    return
  }
  const partial = picked.length < g.count
  const sameName = g.sameName !== false
  if (
    !(await confirmDialog({
      title: '合并为一条人脸记录',
      message:
        `把${sameName ? `「${g.name}」` : `这一组（${g.names.join(' / ')}）`}勾选的 ${picked.length} 条样本合并成 1 条` +
        `${partial ? `，其余 ${g.count - picked.length} 条原样保留` : ''}？\n` +
        `合并后名字沿用「${g.name}」，人脸特征取加权平均${partial ? '' : `，并腾出 ${g.count - 1} 个名额`}。\n` +
        '此操作不可撤销。',
      variant: 'danger'
    }))
  )
    return
  mergingGroup.value = g.key
  try {
    // keepId 传勾选里的第一条（保序于 items）：合并后它当代表样本
    const r = await mergeFaces(
      picked.map((i) => i.id),
      picked[0].id
    )
    if (!r.ok) {
      alertDialog({ title: '合并失败', message: r.reason || '合并失败', variant: 'danger' })
      return
    }
    selectedGroupKey.value = ''
  } catch (e) {
    alertDialog({
      title: '合并失败',
      message: '合并时出错：' + ((e && e.message) || e) + '\n可以稍后重试；如果一直失败，试试关掉本应用的其它标签页。',
      variant: 'danger'
    })
  } finally {
    mergingGroup.value = ''
  }
}

function startRenameGroup(g) {
  if (!g) return
  faceRenameKey.value = g.key
  faceRenameText.value = g.name
}

/**
 * 提交改名 —— 改的是**这个人**（该组全部样本一起改）。
 *
 * 为什么要一起改：库里的名字直接决定推送内容。只改其中一条的话，
 * 同一个人的不同角度会各推各的名字（用户看到的就是"一次叫小刘、一次叫人脸 7"），
 * 而且"同名归类"的判据就是名字，改一条会让这张卡片立刻散开。
 *
 * 这里的三个细节都是踩过的坑：
 *   1. **保存中要有反馈**：写入是排队执行的（前面可能还压着别的写操作），
 *      不给反馈时用户看到的就是"点了没反应"，于是连点、以为卡住。
 *   2. **防重入**：同一张卡片保存期间再触发（回车后紧接着失焦）直接返回。
 *   3. **只收尾自己那一次**：改 A 的时候顺手去改 B，A 的 await 回来时不能把
 *      B 的编辑框关掉（以前就是这个 bug，表现为"点 B 的改名一开就没了"）。
 */
async function commitRenameGroup() {
  const key = faceRenameKey.value
  if (key == null || renamingFace[key]) return
  const g = faceGroups.value.find((x) => x.key === key)
  if (!g) {
    faceRenameKey.value = null
    return
  }
  const name = String(faceRenameText.value || '').trim()
  // 空名字 / 没改动：什么都不写（空名字会被库拒掉，白写一次还会往后端推一遍配置）
  if (!name || (name === g.name && g.sameName !== false)) {
    faceRenameKey.value = null
    return
  }
  renamingFace[key] = true
  try {
    const r = await renameFaces(g.items.map((i) => i.id), name)
    if (!r.ok) {
      faceRenameKey.value = null
      alertDialog({ title: '改名失败', message: r.reason || '改名失败', variant: 'danger' })
      return
    }
    faceRenameKey.value = null
  } catch (e) {
    /*
     * 失败必须收掉编辑态并**明说**：
     * 以前这里既不 catch 也不提示，一次写入失败（比如数据库被别的标签页占住）
     * 就是"输入框一直开着、怎么点都没反应" —— 用户说的"经常卡住"。
     * 收掉编辑态还有个副作用要避免：编辑框留着、弹窗又抢走焦点会再触发一次失焦提交，
     * 变成反复重试。
     */
    faceRenameKey.value = null
    alertDialog({
      title: '改名失败',
      message: '保存时出错：' + ((e && e.message) || e) + '\n名字没有改动。如果一直失败，试试关掉本应用的其它标签页再试。',
      variant: 'danger'
    })
  } finally {
    delete renamingFace[key]
  }
}

async function doClearFaces() {
  if (
    !(await confirmDialog({
      title: '清空人脸库',
      message: '确定清空整个人脸库？\n该操作不可撤销。',
      variant: 'danger'
    }))
  )
    return
  try {
    await clearFaces()
  } catch (e) {
    // 同 doAddPending：写库失败必须说出来，不能让按钮点下去毫无反应
    alertDialog({ title: '清空失败', message: '清空本地人脸库时出错：' + ((e && e.message) || e), variant: 'danger' })
  }
}

watch(faceLibOpen, (v) => {
  if (v) {
    refreshFaces().catch(() => {})
    libPage.value = 1
  }
})

// 待录入对称：展开时回到第一页（收起状态不留页码）
watch(pendingLibOpen, (v) => {
  if (v) pendingPage.value = 1
})

/* ---------- 人脸库分页：默认最多 4 行，超出翻页 ----------
 * 卡片宽度固定 88px，**一行能放几个随抽屉宽度变**（桌面宽、手机窄），
 * 所以每页数量必须现算：一行几张 × 4 行。
 * 已录入 / 待录入两张网格**各自独立分页**，互不影响。
 */
const FACE_ROWS = 4
/** 与 .face-card / .face-grid 的 CSS 保持一致（卡片 88px、间距 8px） */
const FACE_CARD_W = 88
const FACE_GAP = 8
const libGridEl = ref(null)
const pendingGridEl = ref(null)
/** 上次量到的列数（读不到时保留旧值；初值给 6 只是兜底，挂载后会立刻校准） */
const libCols = ref(6)
const pendingCols = ref(6)
const libPage = ref(1)
const pendingPage = ref(1)

/**
 * 一行能放下几张脸 —— 按**容器实际宽度**算。
 *
 * ⚠️ 绝对不要用 `getComputedStyle(el).gridTemplateColumns` 去数轨道。
 *    本抽屉所有标签页用的是 `v-show`（见文件里"所有标签页用的是 v-show"那段）：
 *    抽屉一打开**全部模板都渲染**，未选中的人脸 tab 只是 `display:none`。
 *    此时 Chrome 返回的是**未解析的指定值** `"repeat(auto-fill, 88px)"`，
 *    按空格切正好切成 2 段 —— 于是列数被误判成 2，每页只切 2×4=8 张：
 *    50 张待录入被分成 **7 页**，而每页实际只用真实宽度（7 列）铺出**两排**
 *    （第二排还只有 1 张），看起来就像"没铺满就翻页了"。
 *    （最小复现与对照：/tmp/face-probe/repro.html）
 *
 * 元素不可见时 clientWidth 为 0 → 返回 0 → 调用方保留上一次的值，不会被污染。
 */
function countCols(el) {
  if (!el) return 0
  const w = el.clientWidth
  if (!w) return 0
  return Math.max(1, Math.floor((w + FACE_GAP) / (FACE_CARD_W + FACE_GAP)))
}

function measureFaceCols() {
  const lc = countCols(libGridEl.value)
  if (lc) libCols.value = lc
  const pc = countCols(pendingGridEl.value)
  if (pc) pendingCols.value = pc
}

/**
 * 尺寸一变就重算列数。
 *
 * 为什么非要有它：人脸 tab 不是当前页时 grid 是 `display:none`（v-show 的后果），
 * 这时量不到宽度；用户切到人脸 tab 那一刻它才从 0 变成真实宽度。
 * ResizeObserver 正好覆盖「从隐藏变可见」「抽屉宽度变化」「首屏布局完成」三种时机，
 * 不必去猜该在哪个 watch 里补一次测量。
 */
let faceColsRO = null
function observeFaceGrids() {
  if (typeof ResizeObserver === 'undefined') return
  if (!faceColsRO) faceColsRO = new ResizeObserver(() => measureFaceCols())
  faceColsRO.disconnect()
  if (libGridEl.value) faceColsRO.observe(libGridEl.value)
  if (pendingGridEl.value) faceColsRO.observe(pendingGridEl.value)
}

const libPageSize = computed(() => Math.max(1, libCols.value * FACE_ROWS))
const pendingPageSize = computed(() => Math.max(1, pendingCols.value * FACE_ROWS))
/** 人脸库按「人」分页（不是按记录）：一「人」一张卡片，页数才不会因为多角度样本虚高 */
const libPageCount = computed(() =>
  Math.max(1, Math.ceil((faceGroups.value.length || 0) / libPageSize.value))
)
const pendingPageCount = computed(() =>
  Math.max(1, Math.ceil((allPendingFaces.value.length || 0) / pendingPageSize.value))
)
const pagedFaceGroups = computed(() => {
  const p = Math.min(Math.max(1, libPage.value), libPageCount.value)
  return faceGroups.value.slice((p - 1) * libPageSize.value, p * libPageSize.value)
})
const pagedPending = computed(() => {
  const p = Math.min(Math.max(1, pendingPage.value), pendingPageCount.value)
  return allPendingFaces.value.slice((p - 1) * pendingPageSize.value, p * pendingPageSize.value)
})

/** 数据变短（删除 / 录入后）当前页可能越界，拉回最后一页，避免停在空白页 */
watch(libPageCount, (n) => {
  if (libPage.value > n) libPage.value = n
})
watch(pendingPageCount, (n) => {
  if (pendingPage.value > n) pendingPage.value = n
})

/**
 * 这些变化后都要重量列数：展开/收起、数据增减、**切到人脸 tab**，
 * 以及两个 grid 元素本身被 `v-if` 重建（元素换了，ResizeObserver 得重新挂）。
 * 不可见时量不到 → 保留旧值，等它可见时由这里或 ResizeObserver 补上。
 */
watch(
  [faceLibOpen, pendingLibOpen, faceLib, allPendingFaces, tab, libGridEl, pendingGridEl],
  () =>
    nextTick(() => {
      observeFaceGrids()
      measureFaceCols()
    })
)

onMounted(() => {
  // 抽屉宽度会随窗口 / 横竖屏变化，列数跟着变 → 重新量一次并让分页自动纠正
  window.addEventListener('resize', measureFaceCols)
  nextTick(() => {
    observeFaceGrids()
    measureFaceCols()
  })
})
onUnmounted(() => {
  window.removeEventListener('resize', measureFaceCols)
  if (faceColsRO) {
    faceColsRO.disconnect()
    faceColsRO = null
  }
})

/** 区域归属：把各通道的区域汇总成一张列表，方便统一改名 / 开关 */
const zoneRows = computed(() =>
  (props.cameras || []).flatMap((cam) =>
    (cam.zones || []).map((z) => ({ camId: cam.id, camName: cam.name, zone: z }))
  )
)

/* ---------- 计数推送间隔：常用档位下拉 + 自定义值自动入列 ---------- */
const COUNT_INTERVAL_PRESETS = [
  { value: 600, label: '10 分钟' },
  { value: 1800, label: '30 分钟' },
  { value: 3600, label: '1 小时' },
  { value: 14400, label: '4 小时（默认）' },
  { value: 43200, label: '12 小时' },
  { value: 86400, label: '24 小时' }
]

/** 旧配置里可能是任意秒数（比如老默认 60），下拉里要能原样显示而不是被悄悄改掉 */
function formatInterval(sec) {
  if (sec % 3600 === 0) return `${sec / 3600} 小时`
  if (sec % 60 === 0) return `${sec / 60} 分钟`
  return `${sec} 秒`
}

const countIntervalPicked = computed({
  get: () => Number(opts.zone && opts.zone.countIntervalSec) || 14400,
  set: (v) => {
    opts.zone.countIntervalSec = Number(v) || 14400
  }
})

const countIntervalChoices = computed(() => {
  const cur = countIntervalPicked.value
  const list = COUNT_INTERVAL_PRESETS.slice()
  if (!list.some((p) => p.value === cur)) {
    list.push({ value: cur, label: `自定义 · ${formatInterval(cur)}` })
    list.sort((a, b) => a.value - b.value)
  }
  return list
})


function zoneUpdate(camId, zoneId, patch) {
  const cam = (props.cameras || []).find((c) => c.id === camId)
  if (!cam) return
  const next = (cam.zones || []).map((z) => (z.id === zoneId ? { ...z, ...patch } : { ...z }))
  emit('update-cameras', { id: camId, zones: next })
}

function zoneRemove(camId, zoneId) {
  const cam = (props.cameras || []).find((c) => c.id === camId)
  if (!cam) return
  emit('update-cameras', { id: camId, zones: (cam.zones || []).filter((x) => x.id !== zoneId) })
}
const hidden = ref([...props.hiddenIds])
const fileEl = ref(null)

function clone(list) {
  return list.map((c) => ({
    ...c,
    roi: c.roi ? { ...c.roi } : null,
    rect: c.rect ? { ...c.rect } : null,
    channels: c.channels ? { ...c.channels } : { ding: true, wecom: true, tg: true },
    aiExt: c.aiExt ? { ...c.aiExt } : { face: true, pose: true, zone: true },
    /*
     * 通道静默必须**深拷贝**（slots 是数组）。只靠上面的 `...c` 会与外面的
     * cam.silent 共享同一个对象 —— 在抽屉里改时段会立刻写进真实配置，
     * 点「取消」也回不去（取消只丢弃本地副本，改动早就漏出去了）。
     */
    silent: c.silent ? JSON.parse(JSON.stringify(c.silent)) : defaultCamSilent()
  }))
}

watch(
  () => props.cameras,
  (list) => {
    cams.value = clone(list)
  },
  { immediate: true }
)

watch(
  () => props.hiddenIds,
  (ids) => {
    hidden.value = [...ids]
  }
)

function uid() {
  return `cam-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/* ---------- 同时播放通道 / 自定义档位 ---------- */
/** 自定义同时播放通道（勾选哪几路就只播哪几路；空数组 = 走「前 N 路」规则） */
const autoPlayIds = computed({
  get: () => (Array.isArray(opts.autoPlayIds) ? opts.autoPlayIds : []),
  set: (v) => {
    opts.autoPlayIds = Array.isArray(v) ? v : []
  }
})

const AUTO_COUNT_PRESETS = [0, 1, 2, 4, 99]
const MAX_DECODE_PRESETS = [0, 1, 2, 4, 6, 9]
/** 当前值不在预设档位里时，下拉框自动落到「自定义…」并显示数字输入框 */
const autoCountCustom = ref(!AUTO_COUNT_PRESETS.includes(Number(opts.autoPlayCount)))
const maxDecodeCustom = ref(!MAX_DECODE_PRESETS.includes(Number(opts.maxDecode)))

function onAutoCountSelect(v) {
  if (v === 'custom') {
    autoCountCustom.value = true
    if (!Number(opts.autoPlayCount)) opts.autoPlayCount = 3
    return
  }
  autoCountCustom.value = false
  opts.autoPlayCount = Number(v)
}

function onMaxDecodeSelect(v) {
  if (v === 'custom') {
    maxDecodeCustom.value = true
    if (!Number(opts.maxDecode)) opts.maxDecode = 3
    return
  }
  maxDecodeCustom.value = false
  opts.maxDecode = Number(v)
}

/** 加入 / 移出「同时播放」，并按通道列表顺序规范化（顺序即播放优先级） */
function toggleAutoPlay(id) {
  const cur = autoPlayIds.value.filter((x) => x !== id)
  if (!autoPlayIds.value.includes(id)) cur.push(id)
  autoPlayIds.value = cams.value.filter((c) => cur.includes(c.id)).map((c) => c.id)
}

/** 删除通道时，顺手把它从同时播放列表里摘掉 */
function pruneAutoPlayIds(list) {
  const ids = new Set(list.map((c) => c.id))
  const picked = autoPlayIds.value
  if (picked.some((id) => !ids.has(id))) {
    autoPlayIds.value = picked.filter((id) => ids.has(id))
  }
  // 顺序始终跟随通道列表，保证「第 1 路先播」的直觉
  autoPlayIds.value = list.filter((c) => autoPlayIds.value.includes(c.id)).map((c) => c.id)
}

/** 导入配置后重新判定下拉框是否落在「自定义…」档位 */
function syncCustomFlags() {
  autoCountCustom.value = !AUTO_COUNT_PRESETS.includes(Number(opts.autoPlayCount))
  maxDecodeCustom.value = !MAX_DECODE_PRESETS.includes(Number(opts.maxDecode))
}

/** 「播放性能」页签上的路数徽标：优先显示自定义通道数 */
const playBadgeText = computed(() => {
  const picked = autoPlayIds.value.length
  if (picked) return `${picked} 路`
  const n = Number(opts.autoPlayCount)
  if (n >= 99) return '全部'
  if (n === 0) return '手动'
  return `${n} 路`
})

const playBadgeClass = computed(() =>
  autoPlayIds.value.length || Number(opts.autoPlayCount) > 0 ? 'ok' : 'muted'
)

/**
 * 「状态巡检」页签徽标：只反映**全局**总开关
 * （异常推送 opts.statusAlerts 或 定时巡检 opts.patrol，任一开启即算 on）。
 *
 * 为什么不把渠道级子开关算进来：正文那两枚「已启用 / 未启用」芯片读的就是全局值，
 * 徽标必须与它同源。混进渠道级字段会出现「正文写未启用、页签亮 on」的矛盾观感 ——
 * 而渠道级默认值恰好是 true，所以只要全局没开，这个矛盾就必然出现。
 * 至于「全局开了但三个渠道全关 → 其实也不会推」，那是用户自己在渠道勾选里做的取舍，
 * 不该由页签徽标来"纠正"，否则用户会找不到开关到底在哪。
 */
const statusBadgeOn = computed(() => !!(opts.statusAlerts?.enabled || opts.patrol?.enabled))

function addCamera() {
  cams.value.push({
    id: uid(),
    name: `画面 ${cams.value.length + 1}`,
    url: '',
    motion: true,
    ai: false,
    // 附加能力与区域列表要一起给，否则新通道的 cam.aiExt 是 undefined，
    // 后面按「!== false」判断时看着像开着，开关列却渲染不出正确状态
    aiExt: { face: true, pose: true, zone: true },
    blind: false,
    roi: null,
    rect: null,
    push: true,
    channels: { ding: true, wecom: true, tg: true },
    zones: [],
    // 通道静默要给默认值，否则新加的通道 cam.silent 是 undefined，
    // 卡片里的静默开关读不到字段、状态会显示成"未开启"却又点不动时段
    silent: defaultCamSilent(),
    // 日常事件静默同理：新通道也带上，别等用户点一下开关才长出这个字段
    digest: defaultCamDigest()
  })
}

const aiStateText = computed(() => {
  if (aiState.value === 'loading') return '模型加载中'
  if (aiState.value === 'ready') return 'AI 就绪'
  if (aiState.value === 'error') return 'AI 加载失败'
  return 'AI 未加载'
})

/** 变动档次的解释：说明门槛与灵敏度是「取较大者」的关系 */
const motionLevelHint = computed(() => {
  const v = Number(opts.motionMinPercent) || 0
  if (v <= 0) return '不设门槛，完全按灵敏度判断'
  return `画面变动面积达到 ${v}% 才算异常（低于它的抖动被忽略，不通知也不推送）；与灵敏度取较大者生效`
})

/**
 * 是否跑在后端检测模式（服务端推理、浏览器不加载模型）。
 * 与 App.vue 的 backendActive 同一个判据（backendOn 纯函数，单一来源）。
 */
const backendModeOn = computed(() => backendOn(opts))

const modelDesc = computed(() => {
  const m = AI_MODELS.find((x) => x.key === opts.aiModel) || AI_MODELS[1]
  const base = `${m.desc} · 模型文件 ${m.size} MB`
  // 后端模式下人形识别跑在服务端，模型也由服务端加载 —— 不说清楚的话，
  // 用户在页面上换了模型只会看到"没有变化"（浏览器压根没在推理）
  return backendModeOn.value ? `${base} · 后端模式：由服务端加载并热切换` : base
})

/**
 * 「分析频率」到底在调哪一端，取决于检测跑在哪。
 * 后端模式下浏览器不推理（aiEnabled 被临时置 false），这个值通过配置同步
 * 变成服务端的抽帧帧率；前端模式下它管浏览器自己的抽样节奏。
 * 两处是同一个概念，所以共用这一个控件，但必须说明白，否则用户改完
 * 发现"没用"——其实是作用在另一头。
 */
const sampleFpsHint = computed(() =>
  backendModeOn.value
    ? '服务端每秒抽帧分析的帧数，越高越灵敏但更费 CPU（改后自动重连拉流）'
    : '每秒取样分析的帧数，越高越灵敏但更耗 CPU'
)

const backendText = computed(() => {
  if (aiState.value === 'error') return '失败'
  if (aiState.value === 'loading') return '加载中'
  if (aiState.value !== 'ready') return '待启用'
  return aiBackend.value === 'webgpu' ? 'WebGPU 硬件加速' : 'CPU (WASM)'
})

const backendDesc = computed(() => {
  if (aiState.value === 'error') return aiError.value || '模型加载失败'
  if (aiState.value !== 'ready') return '开启后自动选择最优后端'
  return aiBackend.value === 'webgpu'
    ? `走显卡推理，几乎不占 CPU，单帧约 ${aiCost.value || '-'} ms`
    : `未启用 WebGPU，走 CPU 推理，单帧约 ${aiCost.value || '-'} ms；建议改用更小的模型`
})

function toggleAi() {
  opts.aiEnabled = !opts.aiEnabled
  if (opts.aiEnabled) {
    loadPersonModel(opts.aiModel).catch(() => {})
  } else {
    releaseModel()
  }
}

/**
 * 切换 GPU 加速。
 * 关键点：WebGPU 的 wasm trap 是「线程级」故障，只清 readyKey 不够 ——
 * 必须把旧会话真的释放掉，Worker 才会按新偏好重建 WASM 会话。
 */
function toggleAiGpu() {
  opts.aiGpu = !opts.aiGpu
  setGpuPref(opts.aiGpu)
  if (opts.aiEnabled) {
    // 先全量释放，再按当前偏好重新加载
    releaseModel()
    loadPersonModel(opts.aiModel).catch(() => {})
  }
}

/* ---------- 系统通知授权 ---------- */
/**
 * 三端统一走 useSystemNotify（Electron 原生 / iOS 本地通知 / 浏览器 Notification）。
 * 打开开关时顺手申请权限 —— iOS 首次会弹系统授权框，浏览器弹授权气泡；
 * 被拒绝过的话 iOS 再调不会弹框，只能引导用户去系统设置里手动打开。
 */
async function toggleDesktopNotify() {
  const next = !opts.alert.desktopNotify
  opts.alert.desktopNotify = next
  if (!next) return
  const granted = await requestNotifyPermission()
  if (!granted && sysNotifyState.permission === 'denied') {
    testState.kind = 'fail'
    testState.text = '通知权限已被拒绝，请到系统设置里手动允许后重试'
  } else if (!granted && sysNotifyState.permission === 'unsupported') {
    testState.kind = 'fail'
    testState.text = '当前环境不支持系统通知'
  }
}

/** 开关旁边的一句话状态（让用户知道现在到底能不能收到） */
const notifyLine = computed(() => {
  if (!opts.alert.desktopNotify) return '已关闭'
  return sysNotifySummary()
})

/* ---------- 钉钉推送 ---------- */
const dt = computed(() => opts.dingtalk)
const testState = reactive({ kind: '', text: '' })

/**
 * 这一路当前是否会推送到渠道 ch。
 * = 通道级总开关（cam.push）+ 该渠道小勾（cam.channels[ch]）—— 唯一权威口径，
 * 与 useAlertPush.checkChannel 完全一致。
 */
function camPushOn(cam, ch) {
  return cam.push !== false && channelOn(cam, ch)
}

/** 当前会推送到钉钉的通道数（用于「没有通道会推送」这句提示） */
const pushCamCount = computed(() => cams.value.filter((c) => camPushOn(c, 'ding')).length)

/**
 * 渠道页的「需要推送的监控」标签 —— 写回**通道级**开关，而不是改那份派生名单。
 * 关：只取消这一路对钉钉的勾（总开关与其他渠道不受影响）；
 * 开：把这一路对钉钉打开，并顺带抬起总开关（否则小勾是灰的、等于没开）。
 *
 * ⚠️ 这里刻意**不去改** `opts.dingtalk.cameras` ——
 * 那份名单是通道级配置的派生结果，抽屉里改的是「本地副本 + 共享 options」两样东西，
 * 保存前两者并不同步；在这里顺手写名单只会和 App 侧落盘时的重算互相覆盖。
 * 统一由 save() / 落盘 / 载入时的 syncChannelCameras 一次性对齐。
 */
function togglePushCamera(id) {
  const cam = cams.value.find((c) => c.id === id)
  if (!cam) return
  if (camPushOn(cam, 'ding')) {
    ensureChannels(cam).ding = false
  } else {
    ensureChannels(cam).ding = true
    cam.push = true
  }
}

/** 全选 / 清空：批量改通道级的钉钉小勾 */
function setAllPushCameras(on) {
  cams.value.forEach((cam) => {
    ensureChannels(cam).ding = on
    if (on) cam.push = true
  })
}

async function testPush() {
  testState.kind = 'loading'
  testState.text = '发送中…'
  try {
    const cam = cams.value[0] || {}
    const sample = {
      id: cam.id || 'cam-1',
      name: cam.name || '测试通道',
      type: 'person',
      ratio: 0.88,
      time: Date.now(),
      thumb: '',
      seq: 1,
      url: cam.url || '',
      roi: cam.roi || null,
      resolution: '1920×1080 · H265(HEVC)',
      fps: 25,
      kbps: 2860
    }
    const msg = buildAlarmMessage(sample, { ...dt.value, titlePrefix: `【测试】${dt.value.titlePrefix || ''}` }, '')
    // 钉钉 @指定人：必须把 @手机号 字面写进正文，机器人才能真正通知到人
    const atMobiles = parseMobiles(dt.value.atMobiles)
    const atAll = !!dt.value.atAll
    let body = msg
    if (atMobiles.length) {
      const tokens = atMobiles.map((m) => `@${m}`).join(' ')
      body = { ...msg, text: `${msg.text || ''}\n${tokens}` }
    }
    await sendDingTalk(
      { webhook: dt.value.webhook, secret: dt.value.secret, useProxy: dt.value.useProxy },
      { ...body, msgType: dt.value.msgType, atAll, atMobiles }
    )
    testState.kind = 'ok'
    testState.text = atAll
      ? '发送成功（已@所有人），请查看钉钉群'
      : atMobiles.length
        ? `发送成功（已@ ${atMobiles.length} 个手机号），请查看钉钉群`
        : '发送成功，请查看钉钉群'
  } catch (e) {
    testState.kind = 'fail'
    testState.text = (e && e.message) || '发送失败'
  }
}

/* ---------- 钉钉「关键事件独立机器人」连通性测试 ---------- */
const dtCritState = reactive({ kind: '', text: '' })

async function testDingCritical() {
  dtCritState.kind = 'loading'
  dtCritState.text = '发送中…'
  try {
    const c = (dt.value && dt.value.critical) || {}
    if (!String(c.webhook || '').trim()) throw new Error('还没有填写关键事件机器人的 Webhook')
    const msgType = c.msgType || 'markdown'
    // 钉钉 @指定人：必须把 @手机号 字面写进正文，机器人才能真正通知到人
    const atMobiles = parseMobiles(c.atMobiles)
    const atAll = !!c.atAll
    let bodyText =
      msgType === 'text'
        ? `【测试】关键事件独立机器人连通性测试：配置正常，关键事件会推送到本群。`
        : `**【测试】关键事件独立机器人**\n> 配置正常，关键事件（静默 / 人脸命中 / 满库）会推送到本群。`
    if (atMobiles.length) bodyText = `${bodyText}\n${atMobiles.map((m) => `@${m}`).join(' ')}`
    await sendDingTalk(
      { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy !== false, proxyBase: c.proxyBase || '' },
      { title: `【测试】${c.titlePrefix || ''}`, text: bodyText, msgType, atAll, atMobiles }
    )
    dtCritState.kind = 'ok'
    dtCritState.text = atAll
      ? '发送成功（已@所有人），请到关键事件所在的那个钉钉群确认'
      : atMobiles.length
        ? `发送成功（已@ ${atMobiles.length} 个手机号），请到关键事件所在的那个钉钉群确认`
        : '发送成功，请查看关键事件所在的那个钉钉群'
  } catch (e) {
    dtCritState.kind = 'fail'
    dtCritState.text = (e && e.message) || '发送失败'
  }
}

/* ---------- 企业微信推送 ---------- */
/*
 * 只做纯引用。旧配置字段的补齐已经在上面的 setup 阶段一次性做完了 ——
 * 这里若再调 normalizeWeCom() 会原地写 opts.wecom.events，造成渲染死循环。
 */
const wc = computed(() => opts.wecom)
const wcState = reactive({ kind: '', text: '' })

/** 钉钉 / 企业微信「截图方式」下拉框下方的说明文字 */
const dingShotHint = computed(() => {
  switch (dt.value.screenshotMode) {
    case 'tg':
      return '消息末尾附一条 Telegram 原图链接，不传图片、零额外开销'
    case 'litterbox':
      return '上传到零配置图床后直接嵌图（国内可直连，最长 72 小时），链接照旧带上'
    case 'upload':
      return '钉钉要求图片是公网 http(s) 地址，需自备上传接口'
    default:
      return '既不带图也不带链接，钉钉群里只有文字'
  }
})

const wcShotHint = computed(() => {
  switch (wc.value.screenshotMode) {
    case 'image':
      return 'image 消息直接发图，不需要图床（超过 2MB 会自动压缩）'
    case 'tg':
      return '在文字消息里附一条 Telegram 原图链接（拿不到消息链接时给群链接）'
    case 'litterbox':
      return '上传到零配置图床后在文字消息里附链接'
    default:
      return '不附带截图，仅本地留档'
  }
})

/** 本地格式校验（企业微信没有「查机器人信息」接口，只能本地校验 + 实发一条） */
function checkWecom() {
  wcState.kind = 'loading'
  wcState.text = '正在检查配置…'
  try {
    const url = normalizeWeComWebhook(wc.value.webhook)
    if (!url) throw new Error('还没有填写群机器人 Webhook')
    if (!/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send/i.test(url)) {
      if (!/\/cgi-bin\/webhook\/send/i.test(url)) {
        throw new Error('地址看起来不是群机器人 Webhook，应形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx')
      }
    }
    let key = ''
    try {
      key = new URL(url).searchParams.get('key') || ''
    } catch (e) {
      throw new Error('Webhook 地址格式不正确')
    }
    if (!key) throw new Error('地址里没有找到 key 参数')
    if (!/^[0-9a-f-]{16,}$/i.test(key)) throw new Error('key 格式看起来不对（应为一段 UUID）')
    wcState.kind = 'ok'
    wcState.text = `✓ 地址格式正确（key: ${key.slice(0, 8)}…）。点「发送测试」向群里实发一条消息验证连通性。`
  } catch (e) {
    wcState.kind = 'fail'
    wcState.text = (e && e.message) || '检查失败'
  }
}

/** 向企业微信群机器人发一条测试消息 */
async function testWecom() {
  wcState.kind = 'loading'
  wcState.text = '正在发送测试消息…'
  try {
    // 企业微信 markdown 不支持 @：配置了 @ 时自动改用 text 消息，保证测试真的能 @ 到人
    const atMobiles = parseMobiles(wc.value.atMobiles)
    const atAll = !!wc.value.atAll
    const needAt = atAll || atMobiles.length > 0
    const msgType = needAt ? 'text' : (wc.value.msgType || 'markdown')
    const mdContent = '**【监控报警】企业微信推送连通性测试**\n> 配置正常，报警事件会推送到本群。'
    const textContent = '【监控报警】企业微信推送连通性测试：配置正常，报警事件会推送到本群。'
    const content = needAt ? textContent : mdContent
    await sendWeCom(wc.value, {
      msgType,
      content,
      atAll: needAt ? atAll : false,
      atMobiles: needAt ? atMobiles : []
    })
    wcState.kind = 'ok'
    wcState.text = atAll
      ? '✓ 测试消息已发送（已@所有人），请到企业微信群里确认'
      : atMobiles.length
        ? `✓ 测试消息已发送（已@ ${atMobiles.length} 个手机号），请到企业微信群里确认`
        : '✓ 测试消息已发送，请到企业微信群里确认'
  } catch (e) {
    wcState.kind = 'fail'
    wcState.text = (e && e.message) || '发送失败'
  }
}

/* ---------- 企业微信「关键事件独立机器人」连通性测试 ---------- */
const wcCritState = reactive({ kind: '', text: '' })

async function testWecomCritical() {
  wcCritState.kind = 'loading'
  wcCritState.text = '正在发送测试消息…'
  try {
    const c = (wc.value && wc.value.critical) || {}
    if (!String(c.webhook || '').trim()) throw new Error('还没有填写关键事件机器人的 Webhook')
    // 企业微信 markdown 不支持 @：配置了 @ 时自动改用 text 消息，保证测试真的能 @ 到人
    const atMobiles = parseMobiles(c.atMobiles)
    const atAll = !!c.atAll
    const needAt = atAll || atMobiles.length > 0
    const msgType = needAt ? 'text' : (c.msgType || 'markdown')
    const mdContent = '**【测试】关键事件独立机器人**\n> 配置正常，关键事件（静默 / 人脸命中 / 满库）会推送到本群。'
    const textContent = '【测试】关键事件独立机器人连通性测试：配置正常，关键事件会推送到本群。'
    const content = needAt ? textContent : mdContent
    await sendWeCom(
      { webhook: c.webhook, proxyBase: c.proxyBase || '' },
      { msgType, content, atAll: needAt ? atAll : false, atMobiles: needAt ? atMobiles : [] }
    )
    wcCritState.kind = 'ok'
    wcCritState.text = atAll
      ? '✓ 测试消息已发送（已@所有人），请到关键事件所在的那个企业微信群确认'
      : atMobiles.length
        ? `✓ 测试消息已发送（已@ ${atMobiles.length} 个手机号），请到关键事件所在的那个企业微信群确认`
        : '✓ 测试消息已发送，请到关键事件所在的那个企业微信群确认'
  } catch (e) {
    wcCritState.kind = 'fail'
    wcCritState.text = (e && e.message) || '发送失败'
  }
}

/* ---------- 通道级推送开关（每一路单独选渠道） ---------- */
function ensureChannels(cam) {
  if (!cam.channels || typeof cam.channels !== 'object') {
    cam.channels = { ding: true, wecom: true, tg: true }
  }
  return cam.channels
}

function channelOn(cam, ch) {
  const c = ensureChannels(cam)
  return c[ch] !== false
}

function toggleCamChannel(cam, ch) {
  const c = ensureChannels(cam)
  c[ch] = c[ch] === false
}

function togglePushCam(cam) {
  cam.push = cam.push === false
}

/* ---------- 通道静默（每一路单独配时段 + 渠道） ---------- */

/**
 * 只读地取这一路的静默配置。不存在时返回一个空常量，**不在渲染期写状态** ——
 * 渲染期补字段等于边渲染边改响应式数据（本项目对此有前车之鉴）。
 * 真正要写的时候走下面的 ensureCamSil。
 */
const EMPTY_CAM_SILENT = {
  enabled: false,
  slots: [],
  channels: [],
  tempUntil: 0,
  tempSince: 0,
  tempChannels: [],
  tempLabel: ''
}
function camSilCfg(cam) {
  return cam && cam.silent && typeof cam.silent === 'object' ? cam.silent : EMPTY_CAM_SILENT
}

/** 写之前才把配置对象补齐（只在事件处理里调用） */
function ensureCamSil(cam) {
  if (!cam.silent || typeof cam.silent !== 'object') cam.silent = defaultCamSilent()
  const s = cam.silent
  if (!Array.isArray(s.slots)) s.slots = []
  if (!Array.isArray(s.channels)) s.channels = [...DEFAULT_CAM_SILENT_CHANNELS]
  return s
}

function camSilChannels(cam) {
  const c = camSilCfg(cam).channels
  return Array.isArray(c) ? c : []
}

/**
 * 这一路此刻的通道静默状态 —— 直接调调度器用的同一个纯函数（camSilentState），
 * 界面与引擎同源。各算一份的话，迟早出现「界面显示静默中、实际没静默」。
 */
function camSilInfo(cam) {
  return camSilentState(cam)
}
function camSilActive(cam) {
  return camSilInfo(cam).active === true
}

function toggleCamSilent(cam) {
  const s = ensureCamSil(cam)
  s.enabled = !s.enabled
  // 开启时补一个默认时段：开了却没有任何时段，看起来会像"没生效"
  if (s.enabled && !s.slots.length) s.slots.push({ start: '19:00', end: '08:00' })
}

function toggleCamSilChannel(cam, ch) {
  const s = ensureCamSil(cam)
  /*
   * 刻意允许取消到空（不像「远程静默默认渠道」那样"一个都不选就拒绝"）：
   * 这里是长期配置，先清空再逐个勾是很自然的操作，卡住反而别扭。
   * 空数组在 camSilentState 里就是不生效，行为明确、不会静默掉别的东西。
   */
  s.channels = s.channels.includes(ch) ? s.channels.filter((x) => x !== ch) : [...s.channels, ch]
}

function addCamSilSlot(cam) {
  ensureCamSil(cam).slots.push({ start: '12:00', end: '13:00' })
}
function removeCamSilSlot(cam, i) {
  ensureCamSil(cam).slots.splice(i, 1)
}

/* ---------- 日常事件静默（每一路单独配间隔 + 渠道） ---------- */

/**
 * 只读地取这一路的日常静默配置 —— 直接复用 defaults 的 digestCfgOf。
 * 它返回的是**兜底后的副本**（缺字段给默认值、不往 cam 上补字段），
 * 正是渲染期该用的东西；真正要写的时候走下面的 ensureCamDigest。
 */
function camDigestCfg(cam) {
  return digestCfgOf(cam)
}

/** 写之前才把配置对象补齐（只在事件处理里调用） */
function ensureCamDigest(cam) {
  if (!cam.digest || typeof cam.digest !== 'object') cam.digest = defaultCamDigest()
  const d = cam.digest
  d.intervalMinutes = clampDigestMinutes(d.intervalMinutes)
  if (!Array.isArray(d.channels)) d.channels = [...DEFAULT_CAM_DIGEST_CHANNELS]
  return d
}

/**
 * 这一路此刻的日常静默状态 —— 与引擎（useAlertPush.digestStateOf）用的是
 * **同一个纯函数** camDigestState，只是喂进去的「此刻有没有静默窗口」由界面这边的
 * 三份状态拼出来：
 *   ① 全局免打扰时段（silentActiveNow）
 *   ② 全局临时静默（tempActive）
 *   ③ 这一路的通道静默（camSilActive）
 * 各算一份的话，迟早出现「界面说在汇总、实际没汇总」。
 */
function camDigestInfo(cam) {
  return camDigestState(cam, {
    silentActive: silentActiveNow.value || tempActive.value || camSilActive(cam)
  })
}

function toggleCamDigest(cam) {
  const d = ensureCamDigest(cam)
  d.enabled = !d.enabled
}

function toggleCamDigestChannel(cam, ch) {
  const d = ensureCamDigest(cam)
  // 与通道静默一致：刻意允许清空（空数组即不生效，行为明确，不会静默掉别的东西）
  d.channels = d.channels.includes(ch) ? d.channels.filter((x) => x !== ch) : [...d.channels, ch]
}

function setCamDigestInterval(cam, v) {
  ensureCamDigest(cam).intervalMinutes = clampDigestMinutes(v)
}

/** 总开关：是否所有通道都开了日常事件静默 */
const allDigestOn = computed(() =>
  cams.value.length > 0 && cams.value.every((c) => !!(c.digest && c.digest.enabled === true))
)
/** 部分通道开了（用于总开关显示中间态） */
const someDigestOn = computed(() =>
  cams.value.some((c) => !!(c.digest && c.digest.enabled === true))
)

/** 总开关旁的「汇总间隔」选择器：把已开启的通道对齐到该间隔；关闭的通道保留各自缓存的间隔 */
function setMasterDigestInterval(v) {
  const iv = clampDigestMinutes(v)
  opts.digestIntervalMinutes = iv
  // 仅对齐当前已开启的通道；关闭的通道不动，使其缓存的间隔在再次开启时回显原值
  cams.value.forEach((cam) => {
    const d = ensureCamDigest(cam)
    if (d.enabled) d.intervalMinutes = iv
  })
}

/** 一键开启 / 关闭所有通道的日常事件静默（保留各通道独立的渠道与间隔设置） */
function toggleAllCamDigest() {
  const turnOn = !allDigestOn.value
  // 保留各通道已配置的间隔，不强行套用总开关间隔（关闭再开应回显原值）；
  // 仅当开启时该路没选渠道才补默认渠道（camDigestState 要求 channels 非空，否则开了也不生效）
  cams.value.forEach((cam) => {
    const d = ensureCamDigest(cam)
    d.enabled = turnOn
    if (turnOn && !d.channels.length) d.channels = [...DEFAULT_CAM_DIGEST_CHANNELS]
  })
}

/* ---------- 配置方案（多套配置保存 / 切换 / 导入导出） ---------- */
const PROFILE_KEY = 'monitor-wall-profiles-v1'
const profileName = ref('')
const activeProfileId = ref('')

const profiles = ref(loadProfiles())

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch (e) {
    return []
  }
}

function persistProfiles() {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles.value))
  } catch (e) {
    alertDialog({ title: '保存失败', message: '方案保存失败（本地存储不可用）：' + ((e && e.message) || e), variant: 'danger' })
  }
}

function snapshot() {
  return {
    cameras: JSON.parse(JSON.stringify(cams.value)),
    options: JSON.parse(JSON.stringify(opts)),
    hiddenIds: [...hidden.value],
    layoutKey: props.layoutKey
  }
}

function saveProfile() {
  const name = String(profileName.value || '').trim()
  if (!name) {
    alertDialog({ title: '请填写名称', message: '请先填一个方案名称' })
    return
  }
  const snap = snapshot()
  const hit = profiles.value.find((p) => p.name === name)
  const id = hit ? hit.id : `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const item = {
    id,
    name,
    count: cams.value.length,
    updatedAt: Date.now(),
    data: snap
  }
  if (hit) profiles.value = profiles.value.map((p) => (p.id === hit.id ? item : p))
  else profiles.value = [...profiles.value, item]
  persistProfiles()
  activeProfileId.value = id
  profileName.value = ''
  testState.kind = 'ok'
  testState.text = `方案「${name}」已保存`
}

function applyProfile(p) {
  const d = p && p.data
  if (!d) return
  cams.value = JSON.parse(JSON.stringify(d.cameras || []))
  const merged = { ...cloneDefaultOptions(), ...(d.options || {}) }
  Object.keys(opts).forEach((k) => delete opts[k])
  Object.assign(opts, merged)
  hidden.value = Array.isArray(d.hiddenIds) ? [...d.hiddenIds] : []
  activeProfileId.value = p.id
  if (d.layoutKey) emit('update:layoutKey', d.layoutKey)
  testState.kind = 'ok'
  testState.text = `已切换到方案「${p.name}」，记得点右下角「保存并应用」生效`
}

async function removeProfile(id) {
  const hit = profiles.value.find((p) => p.id === id)
  if (!hit) return
  if (!(await confirmDialog({ title: '删除方案', message: `确定删除方案「${hit.name}」？`, variant: 'danger' }))) return
  profiles.value = profiles.value.filter((p) => p.id !== id)
  persistProfiles()
  if (activeProfileId.value === id) activeProfileId.value = ''
}

function formatDate(ts) {
  if (!ts) return '-'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ---------- 本地存储占用（报警记录 + 截图） ---------- */
const storageInfo = ref(null)
const storageText = computed(() => {
  const s = storageInfo.value
  if (!s) return '统计中…'
  if (!s.quota) return '当前环境不支持容量统计'
  return `已用 ${formatBytes(s.usage || 0)} / 可用 ${formatBytes(s.quota || 0)}`
})

async function refreshStorage() {
  try {
    storageInfo.value = await estimateUsage()
  } catch (e) {
    storageInfo.value = { usage: 0, quota: 0 }
  }
}

watch(
  () => [tab.value, opts.maxEvents],
  ([t]) => {
    if (t === 'profiles') refreshStorage()
  }
)

/* ---------- Telegram 推送 ---------- */
/* 同上：补齐已在 setup 阶段做完，这里只做纯引用 */
const tg = computed(() => opts.telegram)
const botState = reactive({ kind: '', text: '' })

/** 校验 Token + 会话 id，能立刻发现 chat_id 少了 -100 前缀这类问题 */
async function checkBot() {
  botState.kind = 'loading'
  botState.text = '正在校验机器人与会话…'
  try {
    const me = await getBotInfo(tg.value.token)
    const chat = await getChatInfo(tg.value)
    botState.kind = 'ok'
    botState.text = `✓ 机器人 @${me.username} 正常；目标会话：${
      chat.title || chat.username || chat.id
    }（${chat.type}）`
  } catch (e) {
    botState.kind = 'fail'
    botState.text = (e && e.message) || '校验失败'
  }
}

/** 发一条测试消息 */
async function testTelegram() {
  botState.kind = 'loading'
  botState.text = '正在发送测试消息…'
  try {
    const me = await getBotInfo(tg.value.token)
    await sendTelegramText(
      tg.value,
      `✅ <b>连通性测试</b>\n机器人 @${me.username} 正常，监控报警会推送到这里。`
    )
    botState.kind = 'ok'
    botState.text = '✓ 测试消息已发送，请到 Telegram 里确认'
  } catch (e) {
    botState.kind = 'fail'
    botState.text = (e && e.message) || '发送失败'
  }
}

/* ---------------- 关键事件单独提醒（私聊推送） ---------------- */

/** 四类关键事件。key 与 useTelegram.directPushEventOn 的 kind 一一对应 */
const DIRECT_EVENT_OPTS = [
  { id: 'silence', label: '静默开始/结束', desc: '免打扰时段开始与结束的状态提醒（各一条）' },
  { id: 'summary', label: '静默汇总', desc: '免打扰结束时，把本时段收存的报警汇总成一条' },
  { id: 'face', label: '在库人脸命中', desc: '识别到人脸库里的人时，带图单独提醒' },
  { id: 'pending', label: '待录入满库', desc: '未建档人脸攒满收集上限时，提醒及时处理（每个填满周期只提醒一次）' }
]

const newDirectId = ref('')
const directIdError = ref('')
/** 试发结果（贴着按钮显示，不弹窗） */
const directState = reactive({ kind: '', text: '' })

/**
 * 判据与调度层同源（useTelegram 的纯函数），不在组件里再推一遍逻辑 ——
 * 否则界面"已勾选"和实际"发不发"会走偏。
 * ⚠️ 判据是 `!== false`（缺省即开）：老配置没有这个字段时照样算勾上。
 */
function directEventOn(kind) {
  return tgDirectEventOn(tg.value, kind)
}

function toggleDirectEvent(kind) {
  const dp = tg.value.directPush
  if (!dp) return
  if (!dp.events || typeof dp.events !== 'object') dp.events = {}
  dp.events[kind] = !directEventOn(kind)
}

/** 与推送调度器同一份计算（含「授权用户名单 + 额外 id，去重去主会话」） */
const directRecipients = computed(() => tgDirectRecipients(tg.value))

function addDirectId() {
  const v = String(newDirectId.value || '').trim()
  // 只收纯数字：填 @用户名 / 群 id 都发给不了私聊，早点报错比运行时静默失败好
  if (!/^\d+$/.test(v)) {
    directIdError.value = '用户 id 应为纯数字（在 Telegram 里找 @userinfobot 查询）'
    return
  }
  directIdError.value = ''
  if (!tg.value.directPush.chatIds.includes(v)) tg.value.directPush.chatIds.push(v)
  newDirectId.value = ''
}

/**
 * 试发一条私聊，逐个接收人串行发（与调度层一致，避免并发触发 TG 限流）。
 * 走的是真实 Bot API，所以能直接验证「这个人到底收不收得到」——
 * 最常见的失败原因就是对方从没私聊过机器人。
 */
async function testDirectPush() {
  const to = directRecipients.value
  if (!to.length) {
    directIdError.value = '没有可用的接收人：授权用户名单为空，且未额外添加'
    return
  }
  directIdError.value = ''
  directState.kind = 'loading'
  directState.text = '正在发送…'
  const results = []
  for (const id of to) {
    try {
      await sendTelegramText(
        { ...tg.value, chatId: id },
        '✅ <b>关键事件单独提醒 · 测试</b>\n收到这条说明机器人可以私聊推送给这个会话。'
      )
      results.push(`${id} ✅`)
    } catch (e) {
      results.push(`${id} ❌ ${(e && e.message) || '失败'}`)
    }
  }
  const allOk = results.every((r) => r.endsWith('✅'))
  directState.kind = allOk ? 'ok' : 'fail'
  directState.text = `试发结果：${results.join('；')}`
}

/* ---------------- 远程控制（方案 C，TG 私聊指令） ---------------- */
/**
 * 指令清单。与后端 server/tg-remote.mjs 的 COMMANDS 一一对应 ——
 * 那份才是真正注册到 TG 命令菜单的（`/help` 与命令菜单都由它生成），
 * 这里只是把说明也展示出来，免得用户还要去翻后端代码才知道有哪些指令。
 *
 * ⚠️ 这是**有意为之的第二份**：前端不能直接 import 那个模块（它顶层用了
 * node:fs / node:path，进不了浏览器打包）。所以**新增指令时两处都要改**。
 * 只改后端 → 指令能用但设置页看不到；只改这里 → 列表里有但发出去是「未知指令」。
 * `/tmp/hits-img-probe/parity-commands.mjs` 里有一组断言专门盯着这份列表：
 * 逐条比对 cmd 与 **usage**（用户照着设置页抄的用法串必须与后端逐字一致），
 * 并配「后端每条都在前端」「前端没有后端不认的」两条方向相反的检查。
 */
const TG_COMMANDS = [
  { cmd: 'help', usage: '/help', desc: '查看全部可用指令与用法说明（在输入框敲 / 也能唤起指令菜单）' },
  { cmd: 'start', usage: '/start', desc: '系统与机器人介绍：这套监控系统能做什么、机器人能帮你远程做什么' },
  {
    cmd: 'silent',
    usage: '/silent <小时数> [渠道]',
    desc: '临时静默 N 小时，开启/结束各推一条提醒，到点附带汇总；不写渠道就走上面那份默认'
  },
  { cmd: 'until', usage: '/until <HH:MM> [渠道]', desc: '静默到指定时刻（已过则顺延到明天），同样可以跟渠道' },
  { cmd: 'resume', usage: '/resume', desc: '立刻结束静默，并推送结束提醒 + 汇总' },
  { cmd: 'patrol', usage: '/patrol', desc: '立即推送一次巡检报告' },
  {
    cmd: 'status',
    usage: '/status',
    desc: '完整运行状态：运行时长（含中断）/ 通道出帧 / 检测能力 / 推送渠道 / 静默 / 远程控制 / 记录与登录'
  },
  {
    cmd: 'compile',
    usage: '/compile',
    desc: '统计报表：今日/昨日/近 7 天的报警类型分布、小时高峰、人脸命中榜、三端推送成功率、断线恢复、人脸库与通道状态'
  },
  {
    cmd: 'collect',
    usage: '/collect [T|Y] [起-止] [img]',
    desc: '时段内事件汇总（整天完整、不再按 1000 条截断）：T=今日、Y=昨日（省略为今日），起止按小时如 9-18（省略为全天）。人脸命中逐个列出每次记录；汇总过长分多条发送；加 img 连截图一起推'
  },
  {
    cmd: 'hits',
    usage: '/hits [T|Y] [img]',
    desc: '人脸库概览：待录入数量 + 已录入名单 + 今日/昨日的命中记录（时间 / 通道 / 是谁）。T=今日、Y=昨日，省略为今日；加 img 连命中截图一起推'
  },
  {
    cmd: 'flow',
    usage: '/flow [T|Y] [img]',
    desc: '人员走向记录：今日/昨日的跨摄像头走向事件（谁、从哪到哪、间隔多久）。T=今日、Y=昨日，省略为今日；加 img 连各节点的轨迹截图一起推'
  },
  {
    cmd: 'search',
    usage: '/search [T|Y] HH:MM [img]',
    desc: '检索某一天的某一分钟内的所有事件（加 img 连截图一起推）。仅支持 T(今日)/Y(昨日)，如 /search T 14:11 img'
  },
  {
    cmd: 'csilent',
    usage: '/csilent <通道> <小时数|HH:MM|off> [渠道]',
    desc: '通道静默：只让某一路监控在指定时段不推送。如 /csilent 门口 2（2 小时）、/csilent 门口 08:00（到 08:00）、/csilent off 门口（恢复）'
  },
  { cmd: 'cams', usage: '/cams', desc: '通道状态一览：每路在线/出帧、通道静默与日常静默', detail: '逐路显示是否在线出帧、当前画面人数、是否正处在通道静默（含到几点、静默哪些渠道），以及日常事件静默（按间隔汇总）是否开启、间隔与渠道。' },
  {
    cmd: 'digest',
    usage: '/digest <on|off> [间隔]',
    desc: '日常事件静默总开关：一键开/关全部通道的按间隔汇总',
    detail: '开启后所有通道的非关键事件不再实时推，而是按各自设置的间隔摊平成定期汇总；设备离线/上线与定时巡检也一并收入。可追加间隔，如 /digest on 30（分钟）、/digest on 2h（2 小时）。关掉后各通道恢复实时推送。各通道独立开关见 /cdigest。'
  },
  {
    cmd: 'cdigest',
    usage: '/cdigest <通道> <on|off> [间隔]',
    desc: '开/关指定通道的日常事件静默（其余不受影响）',
    detail: '只开或关某一路的日常事件静默，与总开关是同一份配置的两个入口。通道可用名称（门口）、id（cam-1）或序号（1）。可追加间隔，如 /cdigest 门口 on 30。'
  },
  /*
   * 这里**不再**有 `check` 条目：`/check duty` 已合并进 `/duty`（服务端只认
   * `/duty` 与免空格的 `/checkduty`），旧列表还留着它 → 用户照着设置页发
   * `/check duty` 会收到「未知指令」。列表跟着**真正能用的指令**走。
   */
  { cmd: 'duty', usage: '/duty', desc: '静默查岗：把静默期间积压的事件汇总推过来（含全部截图）；旧写法 /checkduty 仍可用' },
  {
    cmd: 'db',
    usage: '/db',
    desc: '导出当前运行的数据库（monitor.db，含报警/人脸/统计/待录入），热备成自包含文件发到本私聊'
  },
  {
    cmd: 'config',
    usage: '/config',
    desc: '导出当前生效的完整配置（通道 / 区域 / 推送 / 人脸库），发到本私聊'
  },
  { cmd: 'reboot', usage: '/reboot', desc: '重启检测服务（需二次确认，且要单独开启）', cat: 'system' },
  { cmd: 'stop', usage: '/stop', desc: '终止监控服务（仅退进程，机器仍开机，需手动重启；需单独开启 + 二次确认）', cat: 'system' },
  { cmd: 'hardreboot', usage: '/hardreboot', desc: '重启整台电脑（最后手段，需两次开启 + 二次确认）', cat: 'system' },
  { cmd: 'shutdown', usage: '/shutdown', desc: '关闭整台电脑（比硬重启更彻底，需开启电源操作 + 二次确认）', cat: 'system' },
  { cmd: 'system', usage: '/system', desc: '查看系统操作类指令（重启 / 终止 / 硬重启 / 关机）的完整说明与各自的二次确认方式', cat: 'system' }
]

const newAllowId = ref('')
/** 添加白名单时的行内错误提示（不弹窗，贴着输入框更直观） */
const allowIdError = ref('')

function addAllowId() {
  const v = String(newAllowId.value || '').trim()
  // 只接受纯数字：填成群 id / @用户名 / 昵称都无效，早点报错比运行时静默失败好
  if (!/^\d+$/.test(v)) {
    allowIdError.value = '用户 id 应为纯数字（在 Telegram 里找 @userinfobot 查询自己的 id）'
    return
  }
  allowIdError.value = ''
  if (!tg.value.remote.allowUserIds.includes(v)) {
    tg.value.remote.allowUserIds.push(v)
  }
  newAllowId.value = ''
}

function removeAllowId(i) {
  tg.value.remote.allowUserIds.splice(i, 1)
}

/**
 * 后端监听状态。
 * 直接读 /api/status 里的 tgRemote —— 用户最怕的是"配好了但不知道有没有生效"，
 * 所以必须把「后端到底有没有在听」如实显示出来。
 *
 * running 为 false 时不再只说一句「后端未运行」：把后端算出来的原因（note）
 * 直接拼进去（比如"没填 Token""白名单为空"），否则用户只能看到一个否定结论，
 * 不知道该去改哪儿。
 */
const tgRemoteChip = computed(() => {
  const st = backendStatus.value && backendStatus.value.tgRemote
  if (!st) return { cls: '', text: '未连接后端', running: false }
  if (!st.enabled) return { cls: '', text: '未开启', running: false }
  if (!st.running) return { cls: 'err', text: st.note ? `未运行 · ${st.note}` : '后端未运行', running: false }
  const parts = [`已监听 · 收到 ${st.received} 条`]
  if (st.executed) parts.push(`已执行 ${st.executed}`)
  if (st.rejected) parts.push(`拒绝 ${st.rejected}`)
  if (st.lastCmd) parts.push(`最近 ${st.lastCmd}`)
  return { cls: 'ready', text: parts.join(' · '), running: true }
})

/* ---------------- Telegram 远程控制：连接自检 ---------------- */

/** 后端算出的诊断快照（/api/status.tgRemote） */
const tgDiag = computed(() => (backendStatus.value && backendStatus.value.tgRemote) || {})
const tgBotInfo = computed(() => tgDiag.value.bot || null)
const tgWebhookSet = computed(() => {
  const b = tgBotInfo.value
  return !!(b && b.webhook && b.webhook.set)
})
/**
 * 「Telegram 侧还有多少条指令没被处理」—— 直接回答「是不是有积压的指令」。
 *
 * 数据来自 `getWebhookInfo.pending_update_count`（后端自检时取的），所以它是
 * **上次自检那一刻**的快照，不是实时值。判读方式：
 *   - 恒为 0          → 一切正常；
 *   - 持续不为 0      → 监听器没在消费（或刚从一大堆积压里启动），可用
 *                       `--drop-pending` 启动一次清空；
 *   - 未知（-1）      → 还没自检过 / 自检失败，点「测试连接」查一次。
 * 「确定 0 条」和「没查到」必须区分开，否则用户会把"没查到"当成"没问题"。
 */
const tgPending = computed(() => Number(tgDiag.value.pendingUpdates))
const tgPendingText = computed(() => {
  const n = tgPending.value
  if (!tgDiag.value.running) return '—（监听器未运行）'
  if (!Number.isFinite(n) || n < 0) return '未知 —— 点「测试连接」查一次'
  if (n === 0) return '0 条（正常）'
  return `${n} 条待处理 —— 长期不降可用 --drop-pending 启动一次清空`
})
const tgPendingClass = computed(() => {
  const n = tgPending.value
  if (!Number.isFinite(n) || n < 0) return 'muted'
  return n > 0 ? 'err-text' : 'ok-text'
})

const tgTesting = ref(false)
/** 自检结果文本（贴着按钮显示，不弹 toast —— 排障时更需要能反复看） */
const tgProbeMsg = ref('')

/**
 * 「测试连接」：让后端真去打一次 Telegram（getMe + getWebhookInfo）。
 * 状态片只能反映本地怎么看，连不上外网 / Token 错了 / 被 Webhook 挡着，
 * 都只有真打一次接口才知道。
 */
async function testTgConnection() {
  if (tgTesting.value) return
  const base = backendBase()
  if (!base) {
    tgProbeMsg.value = '未配置后端地址'
    return
  }
  tgTesting.value = true
  tgProbeMsg.value = ''
  try {
    const r = await testBackendTgRemote(base)
    const p = (r && r.probe) || {}
    if (r && r.ok && p.ok) {
      tgProbeMsg.value = `✅ 连接正常 · @${p.username || '?'}${p.webhook && p.webhook.set ? ' · ⚠️ 该机器人设置了 Webhook' : ''}`
    } else {
      tgProbeMsg.value = `❌ ${p.error || (r && r.reason) || '自检失败'}${p.hint ? ' · ' + p.hint : ''}`
    }
    await refreshBackendStatus(props.options)
  } catch (e) {
    tgProbeMsg.value = `❌ ${(e && e.message) || '自检失败'}`
  } finally {
    tgTesting.value = false
  }
}

/** 删除 Webhook（getUpdates 与它互斥，不清掉就永远收不到指令） */
async function deleteTgWebhookNow() {
  if (tgTesting.value) return
  const base = backendBase()
  if (!base) return
  tgTesting.value = true
  try {
    const r = await deleteBackendTgWebhook(base)
    tgProbeMsg.value = r && r.ok ? '✅ Webhook 已删除，现在应该能收到指令了' : `❌ 删除失败：${(r && r.reason) || '未知原因'}`
    await refreshBackendStatus(props.options)
  } catch (e) {
    tgProbeMsg.value = `❌ ${(e && e.message) || '删除失败'}`
  } finally {
    tgTesting.value = false
  }
}

function remove(i) {
  const id = cams.value[i].id
  cams.value.splice(i, 1)
  hidden.value = hidden.value.filter((x) => x !== id)
  pruneAutoPlayIds(cams.value)
}

function move(i, delta) {
  const target = i + delta
  if (target < 0 || target >= cams.value.length) return
  const [item] = cams.value.splice(i, 1)
  cams.value.splice(target, 0, item)
  // 同时播放列表的顺序 = 播放优先级，跟着通道排序一起走
  pruneAutoPlayIds(cams.value)
}

function toggleVisible(id) {
  hidden.value = hidden.value.includes(id)
    ? hidden.value.filter((x) => x !== id)
    : [...hidden.value, id]
}

/* ---------- 抽屉内拖拽排序 ---------- */
const dragArmedIndex = ref(-1)
const dragFrom = ref(-1)

function armRowDrag(i) {
  dragArmedIndex.value = i
  document.addEventListener('mouseup', () => (dragArmedIndex.value = -1), { once: true })
}

function onDragStart(i, e) {
  dragFrom.value = i
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(i) {
  const from = dragFrom.value
  if (from < 0 || from === i) return
  const [item] = cams.value.splice(from, 1)
  cams.value.splice(i, 0, item)
  dragFrom.value = i
}

function onDragEnd() {
  dragFrom.value = -1
  dragArmedIndex.value = -1
}

/* ---------- 保存 / 重置 / 导入导出 ---------- */
function save() {
  const cleaned = cams.value
    .filter((c) => c.url && c.url.trim())
    .map((c, i) => ({ ...c, name: c.name || `画面 ${i + 1}` }))
  /*
   * 派生名单按**保存后的**通道重算一遍 ——
   * 删掉/隐藏某一路之后，名单里不能还留着它的 id（否则后端会去盯一个不存在的通道）。
   */
  syncChannelCameras(cleaned, opts)
  emit('save', { cameras: cleaned, options: { ...opts }, hiddenIds: hidden.value })
}

/** 「恢复初始化」的二次确认状态（内联确认条，不用弹窗） */
const resetAsk = ref(false)

/** 打开确认条（入口在「配置方案」页，紧挨着「加载内置配置」） */
function askResetInit() {
  tab.value = 'profiles'
  resetAsk.value = true
}

function doResetInit() {
  resetAsk.value = false
  resetAll(resetWipeData.value)
}

/** 恢复初始化时是否连数据（报警记录 + 人脸库）一起清。确认条里的勾选项，默认「要」 */
const resetWipeData = ref(true)

/** 强制终结的二次确认状态 */
const exitAsk = ref(false)

function askExitApp() {
  tab.value = 'profiles'
  exitAsk.value = true
}

function doExitApp() {
  exitAsk.value = false
  emit('force-exit')
}

/**
 * 恢复初始化：通道全部清空、配置回到空白默认
 * （cloneDefaultCameras() 现在返回空数组，所以清完就是一块空大屏）。
 *
 * @param wipeData 是否连「数据」一起清（报警记录 + 人脸库）。确认条里有勾选项，默认勾。
 */
function resetAll(wipeData) {
  cams.value = cloneDefaultCameras()
  const fresh = cloneDefaultOptions()
  Object.keys(opts).forEach((k) => delete opts[k])
  Object.assign(opts, fresh)
  // 空白配置里没有通道，也就没有「哪几路被隐藏」这回事
  hidden.value = []
  syncCustomFlags()

  /*
   * 「配置是干净的」必须包含**配置方案本身**：
   * 已保存的方案里存着完整的通道 + 推送凭据（等于一份完整的可一键恢复的旧配置），
   * 留着它，"恢复初始化"就只是把配置藏起来了，点一下「切换」全都回来。
   */
  try {
    localStorage.removeItem(PROFILE_KEY)
  } catch (e) {
    /* ignore */
  }
  profiles.value = []
  activeProfileId.value = ''
  // 推送统计同属"这次会话的东西"，一起归零（关于系统页的三渠道战绩清零）
  try {
    localStorage.removeItem('monitor-wall-push-stats-v1')
  } catch (e) {
    /* ignore */
  }
  resetPushStats()

  emit('reset', { wipeData: !!wipeData })
}

function exportConfig() {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    cameras: cams.value,
    options: { ...opts },
    hiddenIds: hidden.value
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `monitor-config-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** 导出后端运行的数据库（monitor.db 在线热备下载） */
const dbExporting = ref(false)
async function exportDatabase() {
  const base = backendBase()
  if (!base) {
    alertDialog({
      title: '无法导出',
      message: '未配置后端检测服务地址。数据库在后端服务器上，请先在「后端检测」页开启并填写服务地址。',
      variant: 'danger'
    })
    return
  }
  dbExporting.value = true
  try {
    const res = await fetch(`${base}/api/db/export`)
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`)
    const blob = await res.blob()
    if (!blob.size) throw new Error('导出的文件为空')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // 优先用服务端给的文件名（带时间戳），否则兜底
    const cd = res.headers.get('Content-Disposition')
    const m = cd && cd.match(/filename="?([^";]+)"?/)
    a.download = m ? m[1] : `monitor-${Date.now()}.db`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    alertDialog({
      title: '导出成功',
      message: '数据库文件已下载（含 WAL 热备，是完整一致的快照）。可用于备份或迁移到其它设备。',
      variant: 'ok'
    })
  } catch (e) {
    alertDialog({
      title: '导出失败',
      message: '数据库导出失败：' + ((e && e.message) || e),
      variant: 'danger'
    })
  } finally {
    dbExporting.value = false
  }
}

function pickFile() {
  fileEl.value && fileEl.value.click()
}

function importConfig(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result))
      if (Array.isArray(data.cameras)) {
        cams.value = data.cameras.map((c, i) => ({
          id: c.id || uid(),
          name: c.name || `画面 ${i + 1}`,
          url: c.url || '',
          motion: c.motion !== false,
          ai: !!c.ai,
          blind: !!c.blind,
          roi: c.roi && typeof c.roi === 'object' ? { ...c.roi } : null,
          rect: c.rect && typeof c.rect === 'object' ? { ...c.rect } : null,
          push: c.push !== false,
          channels:
            c.channels && typeof c.channels === 'object'
              ? { ding: c.channels.ding !== false, wecom: c.channels.wecom !== false, tg: c.channels.tg !== false }
              : { ding: true, wecom: true, tg: true },
          // 附加能力（人脸 / 姿态 / 区域）与区域列表必须一起带过来，
          // 否则导入配置后"圈好的区域全没了、通道开关也回到默认"
          aiExt:
            c.aiExt && typeof c.aiExt === 'object'
              ? { face: c.aiExt.face !== false, pose: c.aiExt.pose !== false, zone: c.aiExt.zone !== false }
              : { face: true, pose: true, zone: true },
          zones: Array.isArray(c.zones)
            ? c.zones.map((z) => ({ ...z, rect: z && z.rect ? { ...z.rect } : z.rect }))
            : []
        }))
      }
      if (data.options) {
        const merged = { ...cloneDefaultOptions(), ...data.options }
        Object.keys(opts).forEach((k) => delete opts[k])
        Object.assign(opts, merged)
      }
      hidden.value = Array.isArray(data.hiddenIds) ? data.hiddenIds : []
      // 导入进来的名单可能是旧格式（跟通道级开关对不上），按通道级重算一次
      syncChannelCameras(cams.value, opts)
      syncCustomFlags()
      pruneAutoPlayIds(cams.value)
      testState.kind = 'ok'
      testState.text = '配置已导入，点右下角「保存并应用」生效'
    } catch (err) {
      alertDialog({ title: '导入失败', message: '配置文件解析失败：' + err.message, variant: 'danger' })
    }
  }
  reader.readAsText(file)
  e.target.value = ''
}

/* ---------- 遮罩解锁密码（存摘要、只写不回显） ---------- */
/*
 * 输入框里的明文只活在这个 ref 里，`applyMaskPwd` 一跑就换成摘要写进 opts，
 * 随后 ref 被清空 —— 和登录页那条链路同一个口径：明文只活到算出摘要为止。
 */
const maskPwdNew = ref('')
const maskPwdState = reactive({ kind: '', text: '' })

/**
 * 把输入框里的新密码换算成摘要写进配置。
 * 绑定在 @change（失焦 / 回车）上，避免"输入框里还留着明文就点了保存"。
 *
 * ⚠️ 这里改的是抽屉自己的**局部副本**（opts 是 props.options 的深拷贝），
 *   所以提示语要写明"点保存并应用才生效" —— 否则用户会以为没生效。
 *
 * ⚠️ 输入为空时**什么都不做**，不是"清空密码"。
 *   留空的语义是"我不改"，想真的清掉必须点旁边的「清除密码」——
 *   否则用户点进输入框又点走（其实是没打算改）就会把已设的密码悄悄抹掉。
 */
function applyMaskPwd() {
  const plain = String(maskPwdNew.value || '')
  if (!plain) return
  opts.mask.passwordHash = secretDigest(SECRET_SCOPE.MASK, plain)
  maskPwdNew.value = ''
  revealed.maskPwd = false
  maskPwdState.kind = 'ok'
  maskPwdState.text = '解锁密码已更新，点右下角「保存并应用」后生效'
}

/** 清除密码 → 回到「点击屏幕任意位置即可恢复」 */
function clearMaskPwd() {
  opts.mask.passwordHash = ''
  maskPwdNew.value = ''
  maskPwdState.kind = 'ok'
  maskPwdState.text = '已清除，改为免密码；点右下角「保存并应用」后生效'
}

/* ---------- 加载内置隐藏配置 ---------- */
const hiddenPwd = ref('')
const hiddenState = reactive({ kind: '', text: '' })

function loadHidden() {
  if (!hiddenPwd.value) {
    hiddenState.kind = 'fail'
    hiddenState.text = '请先输入访问密码'
    return
  }
  /*
   * 只比摘要（secretMatches 内部走 secretDigest + 定长异或）。
   * 这里**没有** HIDDEN_PASSCODE 这样的明文常量可对 —— 代码里那份已经换成摘要了。
   */
  if (!secretMatches(SECRET_SCOPE.HIDDEN, hiddenPwd.value, HIDDEN_PASSCODE_HASH)) {
    hiddenState.kind = 'fail'
    hiddenState.text = '访问密码不正确'
    hiddenPwd.value = ''
    return
  }
  const { cameras: hc, options: ho, hiddenIds: hh } = cloneHiddenConfig()
  cams.value = hc
  Object.keys(opts).forEach((k) => delete opts[k])
  Object.assign(opts, ho)
  // 内置配置自带「哪几路默认不显示」，一并带过来（大屏只留大门外 / 电梯 / 大门内）
  hidden.value = Array.isArray(hh) ? [...hh] : []
  hiddenPwd.value = ''
  syncCustomFlags()
  pruneAutoPlayIds(cams.value)
  hiddenState.kind = 'ok'
  hiddenState.text = `内置配置已载入（${hc.length} 路通道），点右下角「保存并应用」生效`
}
</script>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: color-mix(in srgb, var(--bg-deep) 55%, transparent);
  backdrop-filter: blur(2px);
  display: flex;
  justify-content: flex-end;
}

.drawer {
  width: 780px;
  max-width: 97vw;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-left: 1px solid var(--line);
  animation: slide 0.22s ease;
}

@keyframes slide {
  from {
    transform: translateX(24px);
    opacity: 0.4;
  }
}

.drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}

.drawer-head h2 {
  margin: 0;
  font-size: 15px;
}

.head-sub {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  color: #8fc0ff;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.drawer-main {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}

/* ---------- 左侧分类导航 ---------- */
.tabs {
  flex: 0 0 auto;
  width: 148px;
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--panel-deep);
  border-right: 1px solid var(--line);
  overflow: auto;
}

.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-dim);
  text-align: left;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.tab svg {
  flex: 0 0 auto;
  opacity: 0.85;
}

.tab span {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab em {
  font-style: normal;
  font-size: 10px;
  line-height: 15px;
  padding: 0 5px;
  border-radius: 999px;
  color: var(--text-dim-2);
  background: color-mix(in srgb, var(--tint) 6%, transparent);
}

.tab em.ok {
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok) 16%, transparent);
}

/* 渠道关闭时也明确标出 off，避免误以为在推 */
.tab em.muted {
  color: var(--text-dim);
  background: color-mix(in srgb, var(--tint) 5%, transparent);
  border: 1px solid color-mix(in srgb, var(--tint) 8%, transparent);
}

.tab:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--tint) 5%, transparent);
}

.tab.on {
  color: var(--accent-text-strong);
  background: var(--accent-soft);
}

.tab.on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.drawer-body {
  flex: 1 1 auto;
  min-width: 0;
  overflow: auto;
  padding: 16px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/* ---------- 布局选择 ---------- */
.layout-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 8px;
}

.layout-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 10px 6px;
  border-radius: 10px;
  background: var(--panel-deep);
  border: 1px solid var(--line);
  transition: all 0.15s ease;
}

.layout-item:hover {
  border-color: var(--line-strong);
  background: var(--panel-2);
}

.layout-item.on {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.layout-label {
  font-size: 12px;
  color: var(--text-dim);
}

.layout-item.on .layout-label {
  color: var(--accent-text-strong);
}

.layout-preview {
  display: grid;
  width: 54px;
  height: 34px;
  gap: 2px;
}

.layout-preview i {
  display: block;
  border-radius: 2px;
  background: #26344a;
}

.layout-item.on .layout-preview i {
  background: color-mix(in srgb, var(--accent) 70%, transparent);
}

.pv-1 {
  grid-template-columns: 1fr;
}
.pv-2 {
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, 1fr);
}
.pv-3 {
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
}
.pv-4 {
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: repeat(4, 1fr);
}
.pv-auto {
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, 1fr);
}
.pv-focus {
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: repeat(2, 1fr);
}
.pv-focus i:first-child {
  grid-column: span 2;
  grid-row: span 2;
}
.pv-free {
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: repeat(2, 1fr);
  position: relative;
}
.pv-free i:nth-child(1) {
  grid-area: 1 / 1 / 2 / 3;
}
.pv-free i:nth-child(2) {
  grid-area: 1 / 3 / 2 / 5;
}
.pv-free i:nth-child(3) {
  grid-area: 2 / 1 / 3 / 4;
}
.pv-free i:nth-child(4) {
  grid-area: 2 / 4 / 3 / 5;
}

.toggle-tip {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 12px 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
}

.toggle-tip strong {
  font-size: 12.5px;
  color: var(--accent-text-strong);
}

.toggle-tip em {
  font-style: normal;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}

.toggle-tip b {
  color: var(--accent-text-strong);
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 「恢复初始化」的二次确认说明（配置方案页） */
.reset-warn {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--err) 35%, transparent);
  background: color-mix(in srgb, var(--err) 7%, transparent);
  font-size: 12px;
  line-height: 1.75;
  color: var(--text-dim);
}

.reset-warn b {
  color: var(--err-text);
}

/* 「同时清空数据」勾选行（恢复初始化确认条里） */
.reset-wipe {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 60%, transparent);
  cursor: pointer;
  user-select: none;
}

.reset-wipe .rw-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12.5px;
  color: var(--text);
}

.reset-wipe .rw-text em {
  font-style: normal;
  font-size: 11.5px;
  color: var(--text-dim);
}

.reset-wipe .rw-text b {
  color: var(--err-text);
}

/* 同一个标签页里的小节标题（AI 扩展分析用） */
.block-head.sub {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--line-soft);
}

.sub-title {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin: 18px 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: #9fb6d6;
}

.sub-title em {
  font-style: normal;
  font-weight: 400;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-dim-2);
}

.hint.tight {
  margin-top: 6px;
  margin-bottom: 0;
}

/* ---------- 已圈定区域 ---------- */
.zone-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  margin-top: 4px;
}

.zone-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.zone-cam {
  flex: 0 0 auto;
  max-width: 82px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--text-dim-2);
}

.zone-name {
  flex: 1 1 auto;
  min-width: 0;
}

/* ---------- 人脸库 ---------- */
/* 标题右侧的「管理 / 上传照片录入」按钮组：与字数计数之间留间距，
   两个按钮之间也留间距（原来两个 button 直接相邻、零间隙）。 */
.opt-acts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  vertical-align: middle;
}

/*
 * 固定卡片宽度 88px + auto-fill 自动铺列：一行几列随抽屉宽度变。
 * 脚本据此（读 auto-fill 解析出的列数）算「每页 = 列数 × 4 行」，超出翻页。
 * 用 grid 而不是 flex-wrap，是为了让"列数"可被稳定读出（空轨道也会铺出来）。
 */
.face-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 88px);
  justify-content: start;
  gap: 8px;
  width: 100%;
  margin-top: 4px;
}

.face-card {
  width: 88px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--tint) 3%, transparent);
}

/* 空态提示要跨整行，否则在 grid 里会被塞进一个 88px 的格子 */
.face-grid > .hint {
  grid-column: 1 / -1;
}

/*
 * 「待录入」为空时的占位。
 * 用虚线框 + 弱化配色，一眼能看出"这里是个空位"，而不是"这里什么都没有"
 * （后者正是以前整块 v-if 掉之后给人的感觉）。
 */
.pending-empty {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  margin-top: 4px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px dashed var(--line-soft);
  background: color-mix(in srgb, var(--tint) 3%, transparent);
}

.pending-empty .pe-icon {
  font-size: 18px;
  line-height: 1.2;
  flex: 0 0 auto;
}

.pending-empty .pe-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.pending-empty .pe-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.pending-empty .pe-hint {
  font-size: 12px;
  font-style: normal;
  line-height: 1.55;
  color: var(--text-dim-2);
}

/* 分页条：超过 4 行时才出现 */
.face-pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}

.face-page-text {
  font-size: 12px;
  color: var(--text-dim-2);
  min-width: 44px;
  text-align: center;
}

.face-card.pending {
  border-color: color-mix(in srgb, var(--warn-text) 40%, transparent);
}

/*
 * 命中样本卡片（「命中修正」）：与待录入（warn 边框）区分开 ——
 * 这些是**已经认出是谁**的命中，列出来是为了人工复核「有没有认错」。
 */
.face-card.hit {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

/*
 * 陌生人标记卡片（反例）：与命中（accent）再区分开 ——
 * 这些是**被误认**的陌生脸，列出来是为了能看清"拦的是谁"、必要时解除。
 */
.face-card.block {
  border-color: color-mix(in srgb, var(--err) 40%, transparent);
}

/* 卡片上「当前认成的名字」：比通道名更醒目的正文色，一眼看到识别结论 */
.hit-cur {
  font-size: 11px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.face-card img {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 7px;
  object-fit: cover;
  display: block;
  background: #0a0f18;
}

.face-meta {
  font-size: 11px;
  line-height: 1.3;
  color: var(--text-soft);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 待录入卡片底部第二行：捕获时间（比通道名更弱、更小，可换行不截断） */
.face-time {
  font-size: 10px;
  line-height: 1.25;
  color: var(--text-dim-2);
  text-align: center;
  word-break: break-all;
}

/* 改名输入框：原本复用 .face-meta 会继承 overflow:hidden，而 .field.mini 宽 118px
   远超卡片内容区（88−12=76px），被裁成"截断"。这里单独成类、不裁剪，
   并把输入框收到卡片内（width:100% + border-box），既不被截断也能看清在改谁。 */
.face-rename {
  width: 100%;
  display: flex;
  justify-content: center;
}

.face-rename .field.mini {
  width: 100%;
  box-sizing: border-box;
  height: 26px;
  text-align: center;
  font-size: 12px;
}

.face-acts {
  display: flex;
  gap: 4px;
}

.face-acts .mini-btn {
  flex: 1;
}

/* 卡片里的两个按钮（已录入：改名 / 删除；待录入：录入 / 忽略）挤在 88px 卡片里：
 * 文字稍长（如「录入中」）若不放开 min-width 会被 nowrap 撑开、把另一个按钮挤出
 * 卡片边框。这里只针对「卡片内」的子按钮放开收缩 + 超出省略，既能并排又能保证不溢出
 * （全宽的操作行不在这个作用域里，不受影响）。 */
.face-card .face-acts .mini-btn {
  flex: 1 1 0;
  min-width: 0;
  padding: 0 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 待录入卡片上的「录入时归入」控件：卡片只有 88px 宽，控件必须铺满内部宽度，
 * 不能沿用 .field.mini 默认 118px（否则会撑破卡片边框）。 */
.face-assign {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
}
.face-assign .field.mini {
  width: 100%;
  height: 26px;
  flex: 1 1 auto;
  font-size: 11px;
  padding: 2px 4px;
}

/* ---------------- 同一人归类（多角度样本）----------------
 * 库里按「人」显示：一「人」一张卡片。卡片上要多带两个信息 ——
 *   ① 这个人的**几个角度**（右下角数字角标）
 *   ② 这一组里名字**是不是统一的**（右上角 ! 标记）
 * ② 是必须的：推送里叫什么名字，取决于这几条记录各自的名字。
 * 名字不一致时同一个人的不同角度会推不同的名字，用户看到只会觉得"识别乱了"，
 * 而根源在库这边没统一 —— 所以要让它在卡片上就能被发现。
 */
.face-thumb {
  position: relative;
  width: 100%;
  line-height: 0;
}

.face-thumb.clickable {
  cursor: zoom-in;
}
.face-thumb.clickable:hover img {
  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
  outline-offset: -2px;
}

.face-count {
  position: absolute;
  right: 3px;
  bottom: 3px;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 78%, #000);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
}

.face-warn {
  position: absolute;
  left: 3px;
  top: 3px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--warn-text) 88%, #000);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
}

/* 归到一组的卡片：描边稍重，提示"这不止一条记录" */
.face-card.grouped {
  border-color: color-mix(in srgb, var(--accent) 34%, var(--line-soft));
}

/* 正在展开看角度样本的那张卡片 */
.face-card.selected {
  border-color: color-mix(in srgb, var(--accent) 70%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

/* 「保存中」按钮：只是个状态位，别让人以为是可点的操作 */
.face-busy {
  opacity: 0.85;
  cursor: default;
}

/* 归类开关（带说明的那种，不是一行 switch，所以不能直接用 .opt） */
.face-group-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  margin-top: 2px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--tint) 3%, transparent);
}
.face-group-toggle > span:last-child {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.face-group-toggle strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.face-group-toggle em {
  font-size: 12px;
  font-style: normal;
  line-height: 1.5;
  color: var(--text-dim-2);
}
.face-group-toggle .switch {
  flex: 0 0 auto;
  margin-top: 1px;
}

/* ---------------- 手动拆分声明管理 ---------------- */
.face-splits {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line-soft));
  background: color-mix(in srgb, var(--accent) 4%, transparent);
}
.face-splits strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.face-splits-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.face-splits em {
  font-size: 12px;
  font-style: normal;
  line-height: 1.5;
  color: var(--text-dim-2);
}
.face-splits em b {
  color: var(--text);
}
.face-split-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--tint) 5%, transparent);
}
.face-split-pair {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

/* ---------------- 一个人的角度样本面板 ---------------- */
.face-group-panel {
  width: 100%;
  margin-top: 8px;
  padding: 10px 12px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line-soft));
  background: color-mix(in srgb, var(--tint) 4%, transparent);
}

.fgp-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.fgp-head strong {
  font-size: 13px;
  color: var(--text);
}
.fgp-tag {
  font-size: 11px;
  line-height: 18px;
  padding: 0 7px;
  border-radius: 9px;
  color: var(--text-soft);
  background: color-mix(in srgb, var(--tint) 8%, transparent);
}
.fgp-tag.ok {
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok) 14%, transparent);
}
.fgp-tag.warn {
  color: var(--warn-text);
  background: color-mix(in srgb, var(--warn) 16%, transparent);
}
.fgp-acts {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.fgp-samples {
  display: grid;
  grid-template-columns: repeat(auto-fill, 76px);
  gap: 8px;
}

.fgp-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 5px;
  border-radius: 9px;
  border: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--tint) 3%, transparent);
}
.fgp-item img {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 6px;
  object-fit: cover;
  display: block;
  background: #0a0f18;
}
.fgp-sim {
  font-size: 10px;
  color: var(--text-dim-2);
}
.fgp-name {
  max-width: 100%;
  font-size: 11px;
  color: var(--text-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fgp-item .mini-btn {
  width: 100%;
  min-width: 0;
  padding: 0 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 组面板的合并勾选：每条样本一个 checkbox（放在缩略图上方），头部一个全选 */
.fgp-check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin-bottom: 2px;
}
.fgp-check input,
.fgp-allcheck input {
  width: 14px;
  height: 14px;
  accent-color: var(--tint);
  cursor: pointer;
}
.fgp-allcheck {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-soft);
  cursor: pointer;
  user-select: none;
}

/* 样本面板里「手动归入」控件：fgp-item 也是窄列（约 76px），控件铺满列宽，
 * 选「自定义」时再露出输入框与「确定」按钮，全部纵向堆叠不溢出。 */
.fgp-assign {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.fgp-assign .field.mini {
  width: 100%;
  height: 26px;
  flex: 1 1 auto;
  font-size: 11px;
  padding: 2px 4px;
}
.fgp-assign .mini-btn {
  width: 100%;
}

/* 待录入缩略图可点击看原图（只有存到整帧时才给 pointer + 提示） */
.pending-thumb.clickable {
  cursor: zoom-in;
}
.pending-thumb.clickable:hover {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: -2px;
}

/* 看原图灯箱：遮罩 + 居中图片 + 右上关闭 + 底部说明 */
.pending-shot-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(4, 8, 14, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.pending-shot-box {
  position: relative;
  max-width: min(92vw, 1100px);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.pending-shot-img {
  max-width: 100%;
  max-height: 82vh;
  border-radius: 10px;
  background: #0a0f18;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.pending-shot-cap {
  font-size: 12px;
  color: var(--text-soft);
  text-align: center;
  word-break: break-all;
}
.pending-shot-close {
  position: absolute;
  top: -12px;
  right: -12px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: #16202e;
  color: var(--text);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.pending-shot-close:hover {
  background: #223044;
}
.lb-fade-enter-active,
.lb-fade-leave-active {
  transition: opacity 0.16s ease;
}
.lb-fade-enter-from,
.lb-fade-leave-to {
  opacity: 0;
}

/* 上传照片录入：隐藏的原生 file input + 反馈状态条 */
.hidden-file {
  display: none;
}

.enroll-status {
  margin: 6px 0 0;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  border: 1px solid transparent;
}

.enroll-status.busy {
  color: var(--text-dim, #9fb3c8);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}

.enroll-status.ok {
  color: #b6f0c8;
  background: color-mix(in srgb, #2e9e5b 18%, transparent);
  border-color: color-mix(in srgb, #2e9e5b 45%, transparent);
}

.enroll-status.err {
  color: #ffc9c9;
  background: color-mix(in srgb, #d23b3b 16%, transparent);
  border-color: color-mix(in srgb, #d23b3b 42%, transparent);
}

/* ---------- 小组件按钮 ---------- */
.mini-btn {
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: #cfe0f7;
  font-size: 11.5px;
  cursor: pointer;
  white-space: nowrap;
}

.mini-btn:hover {
  background: color-mix(in srgb, var(--accent) 28%, transparent);
}

.mini-btn.ghost {
  background: transparent;
  color: var(--text-dim-2);
}

.mini-btn.ghost:hover {
  background: color-mix(in srgb, var(--tint) 6%, transparent);
  color: var(--text-soft);
}

.mini-btn.danger {
  background: color-mix(in srgb, var(--err) 14%, transparent);
  border-color: color-mix(in srgb, var(--err) 35%, transparent);
  color: var(--err-text);
}

.mini-btn.danger:hover {
  background: color-mix(in srgb, var(--err) 26%, transparent);
}

/* 被强制保持开启的开关（钉钉/企微开着时 TG 不可关） */
.switch.locked {
  cursor: not-allowed;
}

.block {
  min-width: 0;
}

.block h3 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-soft);
}

.block-head h3 {
  margin-bottom: 0;
}

.block-head + .hint,
.block-head + .cam-list,
.block-head + .layout-grid {
  margin-top: 8px;
}

.hint {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim-2);
}

.cam-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cam-item {
  padding: 9px;
  border-radius: 10px;
  background: var(--panel-deep);
  border: 1px solid var(--line);
  transition: opacity 0.16s ease, border-color 0.16s ease;
}

.cam-item.off {
  opacity: 0.5;
}

.cam-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.row-handle {
  display: inline-flex;
  width: 22px;
  height: 26px;
  align-items: center;
  justify-content: center;
  color: var(--text-dim-2);
  cursor: grab;
  border-radius: 6px;
}

.row-handle:hover {
  color: #fff;
  background: color-mix(in srgb, var(--tint) 8%, transparent);
}

.index {
  width: 18px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim-2);
  font-variant-numeric: tabular-nums;
}

.name-input {
  flex: 1 1 auto;
  min-width: 0;
}

.url-input {
  height: auto;
  min-height: 52px;
  padding: 8px 10px;
  line-height: 1.5;
  resize: vertical;
  font-size: 12px;
  word-break: break-all;
}

.url-sub {
  margin-top: 6px;
  height: 32px;
  padding: 0 10px;
  font-size: 12px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.icon-btn:hover:not(:disabled) {
  color: #fff;
  background: color-mix(in srgb, var(--tint) 10%, transparent);
}

.icon-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.icon-btn.del:hover {
  color: #fff;
  background: color-mix(in srgb, var(--err) 80%, transparent);
}

.opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px dashed var(--line-soft);
  cursor: pointer;
}

.opt span strong {
  display: block;
  font-size: 13px;
  font-weight: 500;
}

.opt span em {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  font-style: normal;
  color: var(--text-dim-2);
}

.opt span em.st-ok {
  color: var(--ok-text);
}

.opt span em.st-fail {
  color: var(--err-text);
}

.opt span em.st-loading {
  color: var(--warn-text);
}

.opt span em b {
  color: var(--accent-text-strong);
  font-weight: 600;
}

/*
 * 屏幕常亮的实时状态徽标：绿=已生效 / 黄=待生效 / 灰=已关闭。
 * ⚠️ 必须写到 `.opt span em b.wake-state` 这一层，否则会被上面那条
 *    「em 里的 b 一律用强调色」的规则盖住，三种状态就长得一模一样了。
 */
.opt span em b.wake-state {
  display: inline-block;
  margin-left: 4px;
  padding: 0 6px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  border: 1px solid transparent;
}

.opt span em b.wake-state.ok {
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok-text) 14%, transparent);
  border-color: color-mix(in srgb, var(--ok-text) 32%, transparent);
}

.opt span em b.wake-state.warn {
  color: var(--warn-text);
  background: color-mix(in srgb, var(--warn-text) 14%, transparent);
  border-color: color-mix(in srgb, var(--warn-text) 32%, transparent);
}

.opt span em b.wake-state.off {
  color: var(--text-dim-2);
  background: var(--panel-2);
  border-color: var(--line);
}

.cam-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: 7px;
  font-size: 12px;
  /*
   * 不参与 flex 收缩 + 不换行：`.tag` 常作为 `.opt`（flex 行）里的尾部按钮，
   * 默认 flex-shrink:1 会在窄抽屉 / 手机端被挤到比文字还窄，文字折成两行后
   * 塞在固定 24px 高里就**溢出边框**（「从后端拉取」按钮踩过这个）。
   * 固定按内容宽度 + nowrap，放不下时整行换行（移动端 .opt 已是 flex-wrap）。
   */
  flex: 0 0 auto;
  white-space: nowrap;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line);
  transition: all 0.15s ease;
}

.tag:hover {
  color: var(--text-bright);
  border-color: var(--line-strong);
}

.tag.on {
  color: var(--accent-text-strong);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

.tag.ghost {
  color: var(--text-dim-2);
  background: transparent;
}

.tag-text {
  font-size: 12px;
  color: var(--text-dim-2);
}

.state-chip {
  height: 20px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 20px;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line);
}

.state-chip.ready {
  color: var(--ok-text);
  border-color: color-mix(in srgb, var(--ok) 35%, transparent);
  background: color-mix(in srgb, var(--ok) 12%, transparent);
}

.state-chip.err {
  color: var(--err-text);
  border-color: color-mix(in srgb, var(--err) 40%, transparent);
  background: color-mix(in srgb, var(--err) 12%, transparent);
}

.state-chip.loading {
  color: var(--warn-text);
  border-color: color-mix(in srgb, var(--warn) 35%, transparent);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
}

.state-chip.error {
  color: var(--err-text);
  border-color: color-mix(in srgb, var(--err) 40%, transparent);
  background: color-mix(in srgb, var(--err) 12%, transparent);
}

.opt.col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  cursor: default;
}

/* 静默时段（免打扰推送）相关样式 */
.divider {
  height: 1px;
  margin: 14px 0 4px;
  background: var(--line);
}

.opt-inline {
  display: flex;
  align-items: center;
  gap: 8px;
}

.opt-inline .muted {
  font-size: 12px;
  color: var(--text-dim-2);
}

.time-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.time-row .tilde {
  color: var(--text-dim-2);
  font-size: 13px;
}

.ch-pick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/*
 * 通用 chip 按钮（临时静默的「静默渠道 / 常用时长」等都用它）。
 *
 * ⚠️ 之前只写了 `.ch-pick .chip`（定时静默那几个渠道），
 * 而 `.chip` / `.chip.sm` / `.chip.on` 的样式定义在 CameraTile.vue 与
 * EventPanel.vue 里 —— 那两个是**别的 scoped 组件**，样式不会作用到本组件。
 * 结果「临时静默 → 静默渠道」那几个 chip 完全没有样式：没有边框、没有胶囊形状，
 * 点一下 `on` 类也**没有任何视觉变化**，看上去就像"点不动"。
 * 这里补一份本组件自己的 chip 样式（含 .on 选中态），与 .ch-pick 保持一致。
 */
.chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-dim);
  border: 1px solid var(--line);
  background: var(--field-bg);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s ease;
}

.chip:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--text);
}

/* 选中态：静默渠道 / 常用时长靠它给出"已选"的反馈 */
.chip.on {
  color: var(--accent-text-strong);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.chip.sm {
  padding: 4px 11px;
  font-size: 12px;
}

.ch-pick .chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  background: var(--field-bg);
  cursor: pointer;
  user-select: none;
  transition: all 0.15s ease;
}

.ch-pick .chip input {
  display: none;
}

.ch-pick .chip.on {
  color: var(--accent-text-strong);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.silent-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  border-left: 2px solid color-mix(in srgb, #f5a623 60%, transparent);
  padding-left: 10px;
}

/* ---------- 事件面板停靠位置（item 113） ---------- */
.pos-picker {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

/* 每个按钮就是一个缩小版的屏幕缩略图，圆点落在对应角上 */
.pos-btn {
  position: relative;
  width: 52px;
  height: 38px;
  padding: 0 0 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--panel);
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.pos-btn:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.pos-btn.on {
  border-color: color-mix(in srgb, var(--accent) 70%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, var(--panel));
}

.pos-btn .pos-dot {
  position: absolute;
  width: 12px;
  height: 8px;
  border-radius: 2px;
  background: var(--text-dim-2);
  transition: background 0.15s ease, transform 0.15s ease;
}

.pos-btn.on .pos-dot {
  background: var(--accent);
  transform: scale(1.15);
}

.pos-btn.tl .pos-dot {
  top: 4px;
  left: 4px;
}
.pos-btn.tr .pos-dot {
  top: 4px;
  right: 4px;
}
.pos-btn.bl .pos-dot {
  bottom: 15px;
  left: 4px;
}
.pos-btn.br .pos-dot {
  bottom: 15px;
  right: 4px;
}

.pos-btn em {
  position: absolute;
  bottom: 1px;
  left: 0;
  right: 0;
  font-style: normal;
  font-size: 10px;
  line-height: 1.2;
  color: var(--text-dim-2);
  text-align: center;
}

.pos-btn.on em {
  color: var(--accent-text);
}

.opt-inline {
  display: flex;
  align-items: center;
  gap: 7px;
}

.opt-inline .field.mini {
  width: 72px;
}

/* ---------- 远程控制（方案 C，TG 私聊指令） ---------- */
.remote-block {
  border-left: 2px solid color-mix(in srgb, #35c98a 55%, transparent);
}

/* 真正在监听时整块微微提亮，一眼看出"远程控制是活的" */
.grp.live .grp-head {
  background: color-mix(in srgb, var(--ok) 7%, transparent);
}

.grp-ico.remote {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
}

.remote-status {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.remote-status .muted {
  font-size: 11px;
  color: var(--text-dim-2);
}

/* ---------- Telegram 远程控制：诊断面板 ---------- */
/*
 * 排障面板而不是装饰：每条 diag-row 都是一个「可能出错的地方」，
 * 用等宽字体对齐键值，扫一眼就能看出是哪一项断了。
 */
.tg-diag {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px dashed var(--line);
  background: var(--surface-2, rgba(255, 255, 255, 0.02));
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.diag-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 11.5px;
  line-height: 1.5;
}

.diag-k {
  flex: 0 0 62px;
  color: var(--text-dim-2);
}

.diag-v {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.diag-note {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-dim);
}

.id-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.id-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
}

.id-chip code {
  font-size: 11.5px;
  background: transparent;
  border: 0;
  padding: 0;
  color: inherit;
}

.id-x {
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  font-size: 13px;
  line-height: 1;
  color: var(--text-dim-2);
  background: transparent;
  cursor: pointer;
}

.id-x:hover {
  color: var(--err-text);
  background: color-mix(in srgb, var(--err) 16%, transparent);
}

.id-empty {
  font-size: 11.5px;
  color: var(--err-text);
}

.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px 11px;
  border-radius: 8px;
  border: 1px solid var(--line-soft);
  background: var(--panel);
}

.cmd-hint {
  font-size: 11.5px;
  color: var(--text-dim-2);
  line-height: 1.6;
  margin-bottom: 2px;
}

.cmd-hint code {
  padding: 0 4px;
}

.cmd {
  display: flex;
  align-items: baseline;
  gap: 9px;
  flex-wrap: wrap;
}

.cmd code {
  flex: 0 0 138px;
  font-size: 11.5px;
  color: var(--accent-text-strong, var(--accent-text));
}

.cmd span {
  flex: 1 1 auto;
  font-size: 11.5px;
  color: var(--text-dim-2);
  min-width: 0;
}

/* ---------- 分组卡片（item 121 静默 / 远程控制 UI 美化） ----------
 * 这两块功能各自选项多、层级深，原先平铺在页面上会被上下内容淹没。
 * 用 grp 卡片圈起来：头部是「图标 + 标题 + 总开关」，下面按 sub-label 分小节。
 */
.grp {
  margin: 0 0 4px;
  border: 1px solid var(--line-soft);
  border-radius: 12px;
  background: color-mix(in srgb, var(--panel) 60%, transparent);
  overflow: hidden;
}

.grp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  border-bottom: 1px solid var(--line-soft);
}

.grp-ico {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 14px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.grp-titles {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.grp-titles strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-soft);
}

.grp-titles em {
  font-style: normal;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim-2);
}

.grp-titles b {
  color: var(--text-dim);
}

.grp-body {
  padding: 11px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

/* 临时静默生效时整块提亮，一眼看出"现在是静音状态" */
.grp-body.temp-silent.active {
  background: color-mix(in srgb, #9b6dff 6%, transparent);
}

.sub-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-dim);
  letter-spacing: 0.02em;
}

.sub-label.mt {
  margin-top: 3px;
}

/* 「当前生效 19:00~08:00」这类实时状态标签 */
.live-tag {
  font-style: normal;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--ok-text);
  background: color-mix(in srgb, var(--ok) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--ok) 32%, transparent);
  border-radius: 999px;
  padding: 1px 7px;
}

.hint.tight {
  margin: 0;
  font-size: 11px;
  line-height: 1.65;
}

.silent-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-dim);
  border-radius: 8px;
  border-left: 2px solid color-mix(in srgb, #f5a623 60%, transparent);
  background: color-mix(in srgb, #f5a623 7%, transparent);
}

.silent-state b {
  color: var(--text-soft);
}

/* 静默时段列表（item 114） ---------- */
.slot-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.slot-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--line-soft);
  background: var(--panel);
}

.slot-idx {
  flex: 0 0 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 10.5px;
  color: var(--text-dim-2);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.slot-row .field.mini {
  width: 104px;
  cursor: pointer;
}

/* 敏感字段密码框 + 眼睛切换按钮（默认遮罩，点眼睛临时显示） */
.pw-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.pw-wrap .field {
  width: 100%;
  padding-right: 38px;
}
.pw-eye {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  width: 30px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  border-radius: 6px;
  opacity: 0.78;
  transition: opacity 0.15s, background 0.15s;
}
.pw-eye:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.pw-eye:active {
  background: color-mix(in srgb, var(--accent) 24%, transparent);
}

.slot-tag {
  font-size: 10.5px;
  color: var(--text-dim-2);
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--line-soft);
}

/* 跨零点 = 正常用法，给个中性偏暖的提示 */
.slot-tag.cross {
  color: var(--warn-text);
  border-color: color-mix(in srgb, var(--warn) 30%, transparent);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
}

/* 起止相同 = 这个时段永远不会命中，必须显眼地警示 */
.slot-tag.invalid {
  color: var(--err-text);
  border-color: color-mix(in srgb, var(--err) 38%, transparent);
  background: color-mix(in srgb, var(--err) 10%, transparent);
}

/* ---------- 通道静默（监控通道卡片内） ---------- */
.cam-silent {
  margin-top: 9px;
  padding-top: 9px;
  border-top: 1px dashed var(--line-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cam-silent.on {
  border-top-color: color-mix(in srgb, var(--warn) 45%, transparent);
}
.cs-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.cs-flex {
  flex: 1 1 auto;
}
.cs-label,
.cs-state {
  font-size: 11.5px;
  color: var(--text-dim-2);
}
.cs-state.off {
  opacity: 0.72;
}

/* ---------- 日常事件静默（监控通道卡片内） ----------
   复用 .cam-silent 的骨架（同一条卡片里的第二段），只把"正在汇总"的高亮
   换成强调色，和上面"通道静默"的警示色区分开：那是"别打扰我"，这是"攒着一起发"。 */
.cam-digest.on {
  border-top-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.cam-digest select.field.mini {
  min-width: 96px;
}

.slot-del {
  margin-left: auto;
}

.slot-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.slot-actions .muted {
  font-size: 11.5px;
  color: var(--text-dim-2);
}

/* ---------- 临时静默（item 112） ---------- */
.temp-silent {
  border-left: 2px solid color-mix(in srgb, #9b6dff 55%, transparent);
}

.temp-dur,
.temp-chips,
.temp-until {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

/* 「按小时」：常用时长一行（自身成网格、自适应换行），自定义时长另起一行 */
.temp-dur {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.temp-quick {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  padding: 9px 10px;
  border-radius: 9px;
  border: 1px solid var(--line-soft);
  background: var(--panel);
}

.temp-custom {
  display: flex;
  align-items: center;
  gap: 8px;
}

.temp-dur .field.mini {
  width: 82px;
}

/* 时段开启前提醒（preNotify）—— 跟其它开关行保持一致的呼吸感 */
.pre-notify {
  margin-top: 2px;
}
/* 描述较长：左侧文案允许换行收缩，右侧开关+状态不换行、也不被挤成竖排 */
.pre-notify > span:first-child {
  flex: 1 1 auto;
  min-width: 0;
}
.pre-notify .opt-inline {
  flex: 0 0 auto;
  white-space: nowrap;
}

/* 「按小时 / 静默到几点」两个模式的切换，用 seg 按钮对，跟页面其它分段控件一致 */
.temp-mode .seg-btn {
  min-width: 92px;
  justify-content: center;
}

.temp-until .field {
  min-width: 210px;
}

.temp-silent .muted {
  font-size: 11.5px;
  color: var(--text-dim-2);
}

.btn.tiny {
  height: 24px;
  padding: 0 10px;
  font-size: 11.5px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--field-bg);
  color: var(--text);
  cursor: pointer;
}

.btn.tiny:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

.btn.tiny:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn.tiny.danger {
  border-color: color-mix(in srgb, var(--err) 40%, transparent);
  background: color-mix(in srgb, var(--err) 12%, transparent);
  color: var(--err-text);
}

.btn.tiny.danger:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--err) 70%, transparent);
  background: color-mix(in srgb, var(--err) 22%, transparent);
}

.range-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.range-row input[type='range'] {
  flex: 1 1 auto;
  accent-color: var(--accent);
}

.range-row b {
  width: 34px;
  text-align: right;
  font-size: 12px;
  color: #9fb2cc;
  font-variant-numeric: tabular-nums;
}

.field.mini {
  width: 118px;
  height: 30px;
  flex: 0 0 auto;
}

.field.mini.wide {
  width: auto;
  min-width: 210px;
  max-width: 100%;
}

.unit {
  font-size: 12px;
  color: var(--text-dim-2);
  flex: 0 0 auto;
}

.test-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
}

/* ---------- 重启诊断 ---------- */
.restart-detail {
  margin: 4px 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--line-1, rgba(128, 128, 128, 0.22));
  border-radius: 10px;
  background: var(--panel-2, rgba(128, 128, 128, 0.06));
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.restart-detail .kv {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}
.restart-detail .kv > span {
  flex: 0 0 62px;
  color: var(--text-dim-2);
}
.restart-detail .kv > b {
  font-weight: 500;
  color: var(--text-1);
  word-break: break-all;
}
.restart-detail .kv > b.warn {
  color: var(--warn-text, #d98a2b);
}
.restart-detail .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}
.restart-history {
  margin-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.restart-history .hrow {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--text-dim);
}
.restart-history .hrow .mono {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.restart-history .hrow .muted {
  color: var(--text-dim-2);
}
.restart-history .hrow .ellip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.test-state {
  max-width: 210px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  text-align: right;
  overflow: hidden;
}

.test-state.ok {
  color: var(--ok-text);
}

.test-state.fail {
  color: var(--err-text);
}

.test-state.loading {
  color: var(--warn-text);
}

.drawer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--panel-deep);
}

.spacer {
  flex: 1 1 auto;
}

/* ---------- 通道级推送开关 ---------- */
.cam-push {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}

.tag.mini {
  height: 22px;
  padding: 0 7px;
  font-size: 11px;
}

.tag.mini.master {
  font-weight: 600;
}

.tag.mini.ch:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.tag.mini.ch:disabled:hover {
  border-color: var(--line);
  color: var(--text-dim);
  background: var(--panel-2);
}

/* 通道级附加能力：与前面两个总开关之间加一条细分隔线 */
.tag-sep {
  width: 1px;
  height: 14px;
  margin: 0 2px;
  background: var(--line);
}

/* 虚线 = 「这一路参与」的通道级开关，和实线的全局总开关在视觉上区分开 */
.tag.mini.ext {
  border-style: dashed;
}

.tag.mini.ext.on {
  border-style: solid;
}

/* 通道开着但全局总开关还没开：只表示"预设参与"，用冷色和真正在跑的区分 */
.tag.mini.ext.preset {
  color: #9fb3cd;
  border-color: #33415a;
  background: #0e1522;
}

.tag.mini.ext:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.tag.mini.ext:disabled:hover {
  border-color: var(--line);
  color: var(--text-dim);
  background: var(--panel-2);
}

/*
 * 通道级「人脸命中」（推送收窄模式）：
 *   与附加能力一样用虚/实线区分开关，但打开后用强调色 —— 提醒这是一条**限制型**开关，
 *   不是"多开一项能力"，而是"把这一路的推送收窄到只剩命中"。
 *   颜色只吃主题变量，三套主题零适配。
 */
.tag.mini.hit {
  border-style: dashed;
}

.tag.mini.hit.on {
  border-style: solid;
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}

.tag.mini.hit:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.tag.mini.hit:disabled:hover {
  border-color: var(--line);
  color: var(--text-dim);
  background: var(--panel-2);
}

.cp-sep {
  width: 1px;
  height: 14px;
  background: var(--line);
  margin: 0 2px;
}

.cp-hint {
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.75;
}

/* ---------- 自定义档位（下拉 + 数字输入） ---------- */
.num-field {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.num-field .field.mini.num {
  width: 68px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* ---------- 同时播放通道多选 ---------- */
.block-head.spaced {
  margin-top: 6px;
  padding-top: 16px;
  border-top: 1px dashed var(--line);
}

.pick-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel);
}

.tag.mini.pick {
  max-width: 100%;
  gap: 5px;
}

.tag.mini.pick:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.tag.mini.pick.on {
  color: var(--panel-deep);
  border-color: var(--accent);
  background: var(--accent);
  font-weight: 600;
}

.pick-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 4px;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--tint) 8%, transparent);
}

.tag.mini.pick.on .pick-no {
  color: var(--panel-deep);
  background: rgba(0, 0, 0, 0.16);
}

.pick-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick-ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

/* ---------- 渠道勾选行 ---------- */
.check-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 18px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}

/* ---------- 分段按钮 ---------- */
.seg-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ---------- 配置方案列表 ---------- */
.profile-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0;
}

.profile-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  transition: border-color 0.15s ease, background 0.15s ease;
}

.profile-item.on {
  border-color: color-mix(in srgb, var(--ok) 40%, transparent);
  background: color-mix(in srgb, var(--ok) 7%, transparent);
}

.pi-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pi-main strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pi-main em {
  font-size: 11px;
  font-style: normal;
  color: var(--text-dim);
}

.pi-ops {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.empty-tip {
  margin: 10px 0;
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
  border: 1px dashed var(--line);
  border-radius: 10px;
}

/* ---------- 外观主题 ---------- */
.theme-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.theme-btn {
  flex: 0 0 auto;
}

/* 按钮里的小色卡：一眼看出每个主题长什么样 */
.theme-btn .swatch {
  width: 14px;
  height: 14px;
  border-radius: 5px;
  flex: 0 0 auto;
  border: 1px solid rgba(127, 127, 127, 0.4);
  /* 上半是界面底色、下半是强调色 */
  background: linear-gradient(135deg, var(--sw-bg) 55%, var(--sw-accent) 55%);
}

.sw-liquid {
  --sw-bg: #131c2b;
  --sw-accent: #2f8bff;
}

.sw-dark {
  --sw-bg: #000000;
  --sw-accent: #3b8dff;
}

.sw-light {
  --sw-bg: #f2f4f8;
  --sw-accent: #1f6fe0;
}

.sw-auto {
  /* 自动：左暗右亮，表达「跟随系统切换」 */
  --sw-bg: #0b1119;
  --sw-accent: #f2f4f8;
}

/* ================================================================== */
/*        手机端独立版式：抽屉占满全屏 + 顶部分类条 + 单列表单        */
/*        桌面端始终是「左导航 148px + 右内容」的宽屏形态，不受影响    */
/* ================================================================== */
@media (max-width: 640px) {
  /* ---------- 1. 抽屉铺满整屏，去掉右侧抽屉的观感 ---------- */
  .drawer {
    width: 100%;
    max-width: 100%;
    border-left: none;
  }

  .drawer-head {
    padding: calc(10px + var(--safe-top)) 14px 10px;
  }

  .drawer-head h2 {
    font-size: 16px;
  }

  .icon-btn {
    width: 34px;
    height: 34px;
  }

  /* ---------- 2. 左侧竖导航 → 顶部横向胶囊条（可横滑） ---------- */
  .drawer-main {
    flex-direction: column;
  }

  .tabs {
    flex: 0 0 auto;
    width: auto;
    flex-direction: row;
    align-items: center;
    gap: 7px;
    padding: 9px 12px;
    border-right: none;
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    flex: 0 0 auto;
    height: 34px;
    padding: 0 13px;
    gap: 6px;
    border-radius: 999px;
    font-size: 13px;
    background: var(--panel-2);
    border: 1px solid var(--line);
  }

  .tab span {
    flex: 0 0 auto;
    overflow: visible;
    text-overflow: clip;
  }

  .tab.on::before {
    display: none;
  }

  .tab.on {
    background: var(--accent-soft);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }

  /* ---------- 3. 内容区铺满，纵向滚动（column 布局必须放开 min-height） ---------- */
  .drawer-body {
    padding: 14px 14px calc(18px + var(--safe-bottom));
    gap: 18px;
    min-height: 0;
  }

  /* ---------- 4. 表单行：够宽就并排，装不下就整块换行、控件占满 ---------- */
  .opt {
    padding: 12px 0;
    gap: 9px 12px;
  }

  .opt:not(.col) {
    flex-wrap: wrap;
  }

  .opt:not(.col) > span:first-child {
    flex: 1 1 190px;
    min-width: 0;
  }

  /* 输入类控件：至少 170px，放不下就换行独占一行 */
  .opt:not(.col) > .field,
  .opt:not(.col) > select,
  .opt:not(.col) > input,
  .opt:not(.col) > textarea,
  .opt:not(.col) > .cam-tags,
  .opt:not(.col) > .check-row,
  .opt:not(.col) > .seg-row,
  .opt:not(.col) > .range-row,
  .opt:not(.col) > .test-row {
    flex: 1 1 170px;
    width: auto;
    min-width: 0;
  }

  .opt:not(.col) > .num-field {
    flex: 1 1 200px;
  }

  /* 固定宽度的迷你输入框在手机上不再写死宽度 */
  .field.mini,
  .field.mini.wide {
    width: auto;
    min-width: 0;
  }

  .num-field {
    width: auto;
    min-width: 0;
  }

  .num-field > .field.mini {
    flex: 1 1 auto;
    min-width: 0;
  }

  .num-field > .field.mini.num {
    flex: 0 0 72px;
    width: 72px;
  }

  /* 开关独占一行的情况交给 flex 布局，保持单行即可 */
  .opt:not(.col) > .switch {
    align-self: center;
    margin-left: auto;
  }

  /* ---------- 5. 摄像头卡：名称输入框独占一行，按钮排一行 ---------- */
  .cam-head {
    flex-wrap: wrap;
    gap: 8px;
  }

  .cam-head .name-input {
    flex: 1 1 100%;
    order: 9;
    margin-top: 2px;
  }

  .row-handle,
  .cam-head .index {
    order: 1;
  }

  .cam-head .icon-btn {
    order: 5;
  }

  .url-input {
    font-size: 13px;
  }

  /* ---------- 6. 标签 / 按钮放大到手指可点 ---------- */
  .tag {
    height: 30px;
  }

  .tag.mini {
    height: 30px;
    padding: 0 10px;
    font-size: 12px;
    border-radius: 8px;
  }

  .tag.mini.pick {
    height: 32px;
  }

  .cp-sep {
    height: 18px;
  }

  .cp-hint {
    display: none;
  }

  .check-row {
    gap: 10px 16px;
    padding: 11px 12px;
  }

  .check {
    font-size: 13px;
  }

  /* ---------- 7. 其它横向排布的小块 ---------- */
  .block-head {
    flex-wrap: wrap;
    gap: 8px;
  }

  .layout-grid {
    grid-template-columns: repeat(3, 1fr);
  }

  .profile-item {
    flex-wrap: wrap;
    gap: 8px;
  }

  .pi-ops {
    margin-left: auto;
  }

  .seg-row {
    flex-wrap: wrap;
  }

  .test-row {
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .test-state {
    max-width: 100%;
    text-align: left;
  }

  /* ---------- 8. 底部操作条：3 行 2 列 + 主按钮整行 ---------- */
  .drawer-foot {
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 14px calc(10px + var(--safe-bottom));
  }

  .drawer-foot .spacer {
    display: none;
  }

  .drawer-foot .btn {
    flex: 1 1 calc(50% - 4px);
    justify-content: center;
  }

  .drawer-foot .btn.primary {
    flex: 1 1 100%;
    order: 99;
    height: 44px;
    font-size: 15px;
  }
}

/* ==================== 后端检测服务（headless） ==================== */
.backend-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 8px 10px;
  margin-bottom: 6px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.08);
  font-size: 12px;

  b {
    font-weight: 600;
    margin-left: 2px;
  }
}

.backend-cam {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.08);
  font-size: 12px;
  width: 100%;
}

.backend-cam b {
  font-weight: 500;
}

.ok-text {
  color: var(--ok, #3b6d11);
}

.err-text {
  color: var(--danger, #a32d2d);
  font-size: 11px;
  word-break: break-all;
}

/* 状态哨兵「最近动作」一行 */
.backend-note {
  width: 100%;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.06);
  font-size: 12px;
  opacity: 0.75;
}

/* ---------------- 人员流向（跨摄像头走向）配置 ---------------- */
.flow-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 4px 0 8px;
}
.flow-head strong {
  color: var(--text);
  font-size: 13px;
}
.flow-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 12px 6px;
  margin-bottom: 12px;
  background: rgba(127, 127, 127, 0.04);
}
.flow-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.flow-name {
  flex: 1 1 auto;
  min-width: 0;
}
.switch-wrap {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}
.flow-card-head .icon-btn.danger {
  flex: 0 0 auto;
  font-size: 14px;
  opacity: 0.65;
}
.flow-card-head .icon-btn.danger:hover {
  opacity: 1;
}
.flow-route {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.flow-end {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.flow-end-label {
  font-size: 12px;
  color: var(--text-soft);
  opacity: 0.8;
}
.flow-arrow {
  flex: 0 0 auto;
  font-size: 20px;
  color: var(--accent-text-strong);
  align-self: center;
  padding-top: 14px;
}
.flow-errors {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 4px 0 8px;
}
.flow-err {
  color: var(--danger, #a32d2d);
  font-size: 12px;
}
.flow-ok {
  color: var(--ok, #2e9e5b);
  font-size: 12px;
  margin: 4px 0 8px;
}

@media (max-width: 520px) {
  .flow-route {
    flex-direction: column;
    align-items: stretch;
  }
  .flow-arrow {
    padding-top: 0;
    transform: rotate(90deg);
    align-self: center;
  }
}
</style>
