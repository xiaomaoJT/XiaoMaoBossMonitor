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
                <!--
                  人脸命中：与上面三项不同的**推送收窄**开关（缺省关）。
                  开启后这一路只有命中已录入人脸时才推，故依赖「人脸」；
                  「人脸」又依赖「人形识别」，所以不可用时置灰。
                -->
                <button
                  class="tag mini hit"
                  :class="{ on: camHitOn(cam) }"
                  :disabled="!cam.ai || !camExtOn(cam, 'face')"
                  :title="camHitTitle(cam)"
                  @click="toggleCamHit(cam)"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12">
                    <path
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M9.2 12.2l2 2 3.6-4.2"
                    />
                  </svg>
                  人脸命中
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

          <h3>系统级硬重启（最后手段）</h3>
          <div class="opt col">
            <span>
              <strong>允许重启整台电脑</strong>
              <em>
                ⚠️ 这不是重启 BossMonitor 进程，而是<strong>重启整台机器</strong>：会下线几分钟，
                且<strong>重启后服务不会自己回来</strong>——除非你另配了开机自启
                （Windows 任务计划程序 / NSSM、macOS launchd、Linux systemd）。
                另外需要管理员 / root 权限（Windows 走 shutdown、Linux 走 systemctl、
                macOS 走 osascript 需「辅助功能」授权）。
                <template v-if="restartInfo && restartInfo.hardReboot">
                  <br />本机将执行：<code>{{ restartInfo.hardReboot.command }}</code>
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
              <em>每秒取样分析的帧数，越高越灵敏但更耗 CPU</em>
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

            <!-- 待录入（前端 / 后端检测到的都会列进来） -->
            <div class="opt col" v-if="allPendingFaces.length">
              <span>
                <strong>待录入人脸（{{ allPendingFaces.length }}）</strong>
                <em>点「录入」建档并自动编号，之后可以在人脸库里改名</em>
              </span>
              <div class="face-grid" ref="pendingGridEl">
                <div class="face-card pending" v-for="pf in pagedPending" :key="pf.id">
                  <img :src="pf.thumb" alt="待录入人脸" />
                  <span class="face-meta">{{ pf.camName || '未知通道' }}</span>
                  <div class="face-acts">
                    <button class="mini-btn" @click="doAddPending(pf)">录入</button>
                    <button class="mini-btn ghost" @click="doIgnorePending(pf)">忽略</button>
                  </div>
                </div>
              </div>
              <div class="face-pager" v-if="pendingPageCount > 1">
                <button class="mini-btn ghost" :disabled="pendingPage <= 1" @click="pendingPage -= 1">上一页</button>
                <span class="face-page-text">{{ pendingPage }} / {{ pendingPageCount }}</span>
                <button class="mini-btn ghost" :disabled="pendingPage >= pendingPageCount" @click="pendingPage += 1">下一页</button>
              </div>
              <div class="face-acts">
                <button class="mini-btn danger" @click="doIgnoreAllPending">全部忽略</button>
                <button class="mini-btn ghost" v-if="faceBackendOn" @click="refreshBackendPending">刷新待录入</button>
                <span class="muted" v-if="faceBackendOn">来自后端检测服务</span>
              </div>
            </div>

            <!-- 人脸库 -->
            <div class="opt col">
              <span>
                <strong>
                  人脸库（{{ faceLib.length }} / {{ opts.face.libMax }}）
                  <button class="mini-btn ghost" @click="faceLibOpen = !faceLibOpen">
                    {{ faceLibOpen ? '收起' : '管理' }}
                  </button>
                </strong>
                <em>报警推送里显示的就是这里的名字</em>
              </span>
              <div class="face-grid" v-if="faceLibOpen" ref="libGridEl">
                <div class="face-card" v-for="f in pagedFaceLib" :key="f.id">
                  <img v-if="f.thumb" :src="f.thumb" alt="人脸" />
                  <div class="face-meta" v-if="faceRenameId === f.id">
                    <input
                      class="field mini"
                      v-model.trim="faceRenameText"
                      @keyup.enter="commitRenameFace"
                      @blur="commitRenameFace"
                    />
                  </div>
                  <span class="face-meta" v-else>{{ f.name }}</span>
                  <div class="face-acts">
                    <button class="mini-btn ghost" @click="startRenameFace(f)">改名</button>
                    <button class="mini-btn danger" @click="doDeleteFace(f)">删除</button>
                  </div>
                </div>
                <p class="hint tight" v-if="!faceLib.length">人脸库还是空的：先让摄像头拍到人，出现的脸会进「待录入」。</p>
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

          <!-- ---------- 后端检测服务（headless） ---------- -->
          <div class="sub-title">
            后端检测服务
            <em>人形 / 人脸 / 姿态监听与推送整体搬到常驻设备，本机页面关了也在盯</em>
          </div>
          <label class="opt">
            <span>
              <strong>启用后端检测</strong>
              <em>
                开启后本机 AI 检测全部停掉（省算力、不发烫），检测与推送都交给后端服务 ——
                关掉本机页面，服务端照旧检测、照旧往钉钉 / 企微 / Telegram 推送。
                当前配置（流地址 / 区域 / 推送凭据 / 人脸库）会自动同步过去，
                <b>不需要手改 server/config.json</b>。
                <b class="state-chip" :class="backendState">{{ backendStateText }}</b>
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

          <!-- ---------- 推送与设备 ---------- -->
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

              <!-- ---------- 静默查岗（/check duty）调参 ---------- -->
              <div class="sub-label mt">静默查岗</div>
              <p class="hint tight">
                静默期间私聊机器人发 <code>/check duty</code>，会把「静默开始到现在」积压的事件汇总推过来，
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
                  <span>{{ c.desc }}</span>
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
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  BRAND,
  camSilentState,
  cloneDefaultCameras,
  cloneDefaultOptions,
  cloneHiddenConfig,
  DEFAULT_BACKEND_URL,
  DEFAULT_CAM_SILENT_CHANNELS,
  DEFAULT_SILENT_CHANNELS,
  defaultCamSilent,
  HIDDEN_PASSCODE_HASH,
  syncChannelCameras
} from '../config/defaults'
import { SECRET_SCOPE } from '../config/auth'
import { secretDigest, secretMatches } from '../composables/sha256'
import { resetPushStats } from '../composables/usePushStats'
import {
  backendState,
  backendStateText,
  backendStatus,
  backendWatchdog,
  deleteBackendTgWebhook,
  refreshBackendStatus,
  refreshBackendWatchdog,
  testBackendTgRemote
} from '../composables/useBackendEvents'
import { syncState, syncStateText, localRev, syncRev, pullState, pullError, pushOverwrote, pushFacesSkipped } from '../composables/useBackendSync'
import { refreshWatchStatus, watchState, watchStatusText } from '../composables/useWatchBridge'
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
import { estimateUsage, formatBytes } from '../composables/useEventStore'
import { EVENT_DEFAULTS, EVENT_GROUPS } from '../composables/useAlarmText'
import { aiSlotBackend, aiSlotState } from '../composables/useAiDetector'
import { camExtOn, camHitOn } from '../composables/useAiExtras'
import {
  addFace,
  backendPendingFaces,
  clearFaces,
  clearPendingFaces,
  deleteFace,
  dropBackendPendingFace,
  faceLibOpen,
  faces as faceLib,
  loadBackendPendingFaces,
  pendingFaces,
  refreshFaces,
  removePendingFace,
  renameFace
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
    key: 'detect',
    label: '检测识别',
    desc: '移动检测与人形识别参数',
    icon: 'M4 18a9 9 0 0 1 16 0M7.5 18a5.5 5.5 0 0 1 9 0M12 18h.01'
  },
  {
    key: 'alert',
    label: '报警提醒',
    desc: '通知、声音、自动放大',
    icon: 'M6 9a6 6 0 1 1 12 0v4.5l1.6 2.6H4.4L6 13.5zM10 18.5a2 2 0 0 0 4 0'
  },
  {
    key: 'templates',
    label: '推送模板',
    desc: '三端报警消息的自定义排版与实时预览',
    icon: 'M4 5h16v11H8l-4 4zM8 9h8M8 12h5'
  },
  {
    key: 'dingtalk',
    label: '钉钉推送',
    desc: '机器人凭据、推送内容与频率限制',
    icon: 'M21 4L3 11l7 2.5L12.5 21z'
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
  /* 状态巡检紧跟三个推送渠道：它本质上是"推送什么"的一部分 */
  {
    key: 'status',
    label: '状态巡检',
    desc: '通道异常推送与定时巡检报告',
    icon: 'M3 12h4l2.5-6 4 12 2.5-6h5'
  },
  {
    key: 'maintain',
    label: '系统维护',
    desc: '流自愈（持续异常自动恢复）与定时重启系统',
    icon: 'M12 4v3M12 17v3M4 12H1M23 12h-3M5.6 5.6 3.5 3.5M20.5 20.5l-2.1-2.1M18.4 5.6l2.1-2.1M3.5 20.5l2.1-2.1M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'
  },
  {
    key: 'profiles',
    label: '配置方案',
    desc: '多套配置保存 / 切换 / 导入导出',
    icon: 'M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 4v5h5M8 13h8M8 17h5'
  },
  {
    key: 'mask',
    label: '隐私遮罩',
    desc: '一键盖住大屏、解锁密码',
    icon: 'M3 12s3.5-6 9-6c1.3 0 2.5.3 3.5.8M21 12s-3.5 6-9 6c-1.3 0-2.5-.3-3.5-.8M4 20L20 4'
  },
  /* 外观（画面布局 + 主题 + 报警通知位置）放最后：低频操作不挡在前面 */
  {
    key: 'appearance',
    label: '外观',
    desc: '画面布局 · 报警通知位置 · 界面主题',
    icon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36A5.4 5.4 0 0 1 12 3zM12 21a9 9 0 0 1 0-18'
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

/** 拉一次后端待录入队列（后端模式下人脸是在服务端抓的） */
async function refreshBackendPending() {
  if (!faceBackendOn.value) return
  await loadBackendPendingFaces(opts.backend.url)
}

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
    if (faceBackendOn.value) refreshBackendPending()
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
    // 保留「人脸命中」：它不走这个函数（缺省关，判据与上面三条相反），别在这儿弄丢
    hit: cur.hit === true,
    [key]: cur[key] === false
  }
}

/**
 * 人脸命中（通道级推送收窄）。缺省「关」，点击才是开 —— 与上面三条「缺省参与」相反。
 * 开之前这一路必须有人脸可识别（否则"命中"永远不发生、结果一条都不推），
 * 所以顺手把这一路的人形 + 人脸补齐。
 */
function toggleCamHit(cam) {
  if (!cam.ai) return
  const cur = cam.aiExt || {}
  const next = cur.hit !== true
  cam.aiExt = {
    face: cur.face !== false,
    pose: cur.pose !== false,
    zone: cur.zone !== false,
    hit: next
  }
  if (next && cam.aiExt.face === false) cam.aiExt.face = true
}

function camHitTitle(cam) {
  if (!cam.ai) return '先开启这一路的「人形识别」——人脸命中建立在人形 + 人脸识别之上'
  if (!camExtOn(cam, 'face')) return '先开启这一路的「人脸」——没有人脸识别就没有「命中」'
  if (!camHitOn(cam)) {
    return '开启后这一路只在「命中已录入人脸」时推送；画面变动 / 人形 / 姿态 / 区域 / 计数都不再单独推'
  }
  return '已开启：仅推送人脸命中事件。点击关闭，恢复为按上面勾选的各类事件正常推送'
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
const faceRenameId = ref(null)
const faceRenameText = ref('')

async function doAddPending(pf) {
  const res = await addFace(pf.vector, pf.thumb, '', Number(opts.face.libMax) || 50)
  if (!res.ok) {
    window.alert(res.reason || '录入失败')
    return
  }
  // 录入成功：前端队列移除；后端队列要回服务端删掉，否则刷新又冒出来。
  // 人脸库同步后端不用手动触发 —— App.vue 里盯着 faceList 变化会自动补发一份配置。
  if (pf.fromBackend) await dropBackendPendingFace(opts.backend.url, pf.backendId)
  else removePendingFace(pf.id)
}

function doIgnorePending(pf) {
  if (pf.fromBackend) dropBackendPendingFace(opts.backend.url, pf.backendId)
  else removePendingFace(pf.id)
}

/** 一键忽略所有待录入人脸（前端内存队列 + 后端 SQLite 队列都清掉） */
function doIgnoreAllPending() {
  // 前端内存队列：直接清空
  clearPendingFaces()
  // 后端队列：逐条回服务端删除，否则下次刷新又冒出来
  const list = backendPendingFaces.value
  for (const pf of list) {
    dropBackendPendingFace(opts.backend.url, pf.backendId)
  }
}

async function doDeleteFace(f) {
  if (!window.confirm(`确定删除「${f.name}」的人脸记录？删除后再次出现会重新当作陌生人。`)) return
  await deleteFace(f.id)
}

function startRenameFace(f) {
  faceRenameId.value = f.id
  faceRenameText.value = f.name
}

async function commitRenameFace() {
  if (faceRenameId.value == null) return
  await renameFace(faceRenameId.value, faceRenameText.value)
  faceRenameId.value = null
}

async function doClearFaces() {
  if (!window.confirm('确定清空整个人脸库？该操作不可撤销。')) return
  await clearFaces()
}

watch(faceLibOpen, (v) => {
  if (v) {
    refreshFaces().catch(() => {})
    libPage.value = 1
  }
})

/* ---------- 人脸库分页：默认最多 4 行，超出翻页 ----------
 * 为什么不写死"每页 N 个"：卡片宽度固定 88px，**一行能放几个随抽屉宽度变**
 * （桌面宽、手机窄），所以每页数量必须现算 —— 读 grid 实际布局出的列数
 * （`auto-fill` 会把空轨道也铺满一行，因此就算没几张脸也能量到真实列数），
 * 再乘 4 行。已录入 / 待录入两张网格**各自独立分页**，互不影响。
 */
const FACE_ROWS = 4
const libGridEl = ref(null)
const pendingGridEl = ref(null)
/** 上次量到的列数（读不到时保留旧值；初值给 6 只是兜底，挂载后会立刻校准） */
const libCols = ref(6)
const pendingCols = ref(6)
const libPage = ref(1)
const pendingPage = ref(1)

/** 读 grid 真正布局出来的列数（`gridTemplateColumns` 的已解析值就是各轨道宽度） */
function countCols(el) {
  if (!el) return 0
  try {
    const tpl = getComputedStyle(el).gridTemplateColumns || ''
    return tpl.split(' ').filter((s) => s && s !== 'none').length
  } catch (e) {
    return 0
  }
}

function measureFaceCols() {
  const lc = countCols(libGridEl.value)
  if (lc) libCols.value = lc
  const pc = countCols(pendingGridEl.value)
  if (pc) pendingCols.value = pc
}

const libPageSize = computed(() => Math.max(1, libCols.value * FACE_ROWS))
const pendingPageSize = computed(() => Math.max(1, pendingCols.value * FACE_ROWS))
const libPageCount = computed(() =>
  Math.max(1, Math.ceil((faceLib.value.length || 0) / libPageSize.value))
)
const pendingPageCount = computed(() =>
  Math.max(1, Math.ceil((allPendingFaces.value.length || 0) / pendingPageSize.value))
)
const pagedFaceLib = computed(() => {
  const p = Math.min(Math.max(1, libPage.value), libPageCount.value)
  return faceLib.value.slice((p - 1) * libPageSize.value, p * libPageSize.value)
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

/** 网格可见性或数据变化后重新量列数（不可见时量到的是 "none"） */
watch([faceLibOpen, faceLib, allPendingFaces], () => nextTick(measureFaceCols))

onMounted(() => {
  // 抽屉宽度会随窗口 / 横竖屏变化，列数跟着变 → 重新量一次并让分页自动纠正
  window.addEventListener('resize', measureFaceCols)
  nextTick(measureFaceCols)
})
onUnmounted(() => {
  window.removeEventListener('resize', measureFaceCols)
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
    silent: defaultCamSilent()
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

const modelDesc = computed(() => {
  const m = AI_MODELS.find((x) => x.key === opts.aiModel) || AI_MODELS[1]
  return `${m.desc} · 模型文件 ${m.size} MB`
})

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
    await sendDingTalk(
      { webhook: dt.value.webhook, secret: dt.value.secret, useProxy: dt.value.useProxy },
      { ...msg, msgType: dt.value.msgType, atAll: false, atMobiles: [] }
    )
    testState.kind = 'ok'
    testState.text = '发送成功，请查看钉钉群'
  } catch (e) {
    testState.kind = 'fail'
    testState.text = (e && e.message) || '发送失败'
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
    await sendWeCom(wc.value, {
      msgType: wc.value.msgType || 'markdown',
      content:
        wc.value.msgType === 'text'
          ? '【监控报警】企业微信推送连通性测试：配置正常，报警事件会推送到本群。'
          : '**【监控报警】企业微信推送连通性测试**\n> 配置正常，报警事件会推送到本群。',
      atAll: false,
      atMobiles: []
    })
    wcState.kind = 'ok'
    wcState.text = '✓ 测试消息已发送，请到企业微信群里确认'
  } catch (e) {
    wcState.kind = 'fail'
    wcState.text = (e && e.message) || '发送失败'
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
    alert('方案保存失败（本地存储不可用）：' + ((e && e.message) || e))
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
    alert('请先填一个方案名称')
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

function removeProfile(id) {
  const hit = profiles.value.find((p) => p.id === id)
  if (!hit) return
  if (!confirm(`确定删除方案「${hit.name}」？`)) return
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

/** 三类关键事件。key 与 useTelegram.directPushEventOn 的 kind 一一对应 */
const DIRECT_EVENT_OPTS = [
  { id: 'silence', label: '静默提醒', desc: '免打扰开始 / 结束的提醒' },
  { id: 'summary', label: '静默汇总', desc: '静默结束时的那条汇总（含人脸命中明细）' },
  { id: 'face', label: '人脸命中', desc: '识别到人脸库里的人时，带图单独提醒' }
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
 * `/tmp/collect-probe/ui-probe.mjs` 里有一条断言专门盯着这份列表。
 */
const TG_COMMANDS = [
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
    cmd: 'collect',
    usage: '/collect [T|Y] [起-止] [img]',
    desc: '时段内事件汇总：T=今日、Y=昨日（省略为今日），起止按小时如 9-18（省略为全天）；加 img 连截图一起推'
  },
  {
    cmd: 'csilent',
    usage: '/csilent <通道> <小时数|HH:MM|off> [渠道]',
    desc: '通道静默：只让某一路监控在指定时段不推送。如 /csilent 门口 2（2 小时）、/csilent 门口 08:00（到 08:00）、/csilent off 门口（恢复）'
  },
  { cmd: 'cams', usage: '/cams', desc: '通道状态一览：每路是否在线出帧、是否正处在通道静默（含到几点、静默哪些渠道）' },
  { cmd: 'check', usage: '/check duty', desc: '静默查岗：把静默期间积压的事件汇总推过来（含全部截图）' },
  { cmd: 'duty', usage: '/duty', desc: '静默查岗（/check duty 的短别名，两者等效）' },
  { cmd: 'reboot', usage: '/reboot', desc: '重启检测服务（需二次确认，且要单独开启）' },
  { cmd: 'hardreboot', usage: '/hardreboot', desc: '重启整台电脑（最后手段，需两次开启 + 二次确认）' }
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
      alert('配置文件解析失败：' + err.message)
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

.face-acts {
  display: flex;
  gap: 4px;
}

.face-acts .mini-btn {
  flex: 1;
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
</style>
