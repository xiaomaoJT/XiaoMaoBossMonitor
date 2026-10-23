<!-- Alert 设置页：自 SettingsDrawer.vue 拆出，模板/逻辑零改动；状态·函数·emit 经父级 provide('sd') 注入 -->
<template>
  <section class="block">
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
          <SilentSlotRow
            v-for="(s, i) in slotsOf"
            :key="i"
            :slot="s"
            :index="i"
            :can-remove="slotsOf.length > 1"
            :open-picker="openPicker"
            @remove="removeSlot(i)"
          />
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

        <!-- ---------- 工作日历（决定工作日 / 放假日，供时段作用域分流） ---------- -->
        <div class="sub-label mt">工作日历（时段作用域按「工作日 / 放假日」分流）</div>
        <p class="hint tight">
          给上面的每个时段选「仅工作日 / 仅放假日」，就能让工作日和休息日用不同的免打扰时段
          （例如工作日夜里静默、周末全天静默）。放假日 = 周末 + 法定假日；调休补班日算工作日。
        </p>
        <div class="cal-block">
          <div class="cal-row">
            <span class="cal-k">周模式</span>
            <div class="seg">
              <button
                v-for="wm in WEEK_MODES"
                :key="wm.id"
                class="seg-btn"
                :class="{ on: cal.weekMode === wm.id }"
                @click="cal.weekMode = wm.id"
              >{{ wm.label }}</button>
            </div>
          </div>

          <div class="cal-row" v-if="cal.weekMode === 'custom'">
            <span class="cal-k">自定义休息日</span>
            <div class="ch-pick">
              <label class="chip" v-for="d in WEEKDAYS" :key="d.id" :class="{ on: cal.customRestDays.includes(d.id) }">
                <input type="checkbox" :value="d.id" v-model="cal.customRestDays" /> {{ d.label }}
              </label>
            </div>
          </div>

          <div class="cal-row" v-if="cal.weekMode === 'alternate'">
            <span class="cal-k">大小周锚点</span>
            <input class="field mini" type="date" v-model="cal.alternateAnchor" />
            <span class="muted">该周（含周一）为大周（双休），之后单双周交替</span>
          </div>

          <div class="cal-row">
            <span class="cal-k">法定假日</span>
            <div class="date-edit">
              <div class="date-add">
                <input class="field mini" type="date" v-model="holidayInput" />
                <button class="btn tiny" @click="addHoliday">+ 加入</button>
              </div>
              <div class="date-chips">
                <span class="d-chip" v-for="(d, i) in cal.holidays" :key="d">
                  {{ d }}<button class="d-x" @click="removeHoliday(i)">×</button>
                </span>
                <span class="muted" v-if="!cal.holidays.length">未配置（仅按周模式判断）</span>
              </div>
            </div>
          </div>

          <div class="cal-row">
            <span class="cal-k">调休补班</span>
            <div class="date-edit">
              <div class="date-add">
                <input class="field mini" type="date" v-model="makeupInput" />
                <button class="btn tiny" @click="addMakeup">+ 加入</button>
              </div>
              <div class="date-chips">
                <span class="d-chip" v-for="(d, i) in cal.makeups" :key="d">
                  {{ d }}<button class="d-x" @click="removeMakeup(i)">×</button>
                </span>
                <span class="muted" v-if="!cal.makeups.length">未配置</span>
              </div>
            </div>
          </div>

          <div class="cal-row today">
            <span class="cal-k">今天</span>
            <span class="cal-today" :class="todayDayType.type">
              {{ todayDayType.label }}
            </span>
            <span class="muted">（用于预览时段作用域是否会命中今天）</span>
          </div>
        </div>

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
</template>

<script setup>
import { inject } from 'vue'

/* 设置抽屉上下文（父级 SettingsDrawer 用 provide('sd', …) 暴露全部状态 / 函数 / emit / props） */
const sd = inject('sd')
const { OPT_SHOT_WIDTH, SelectField, SilentSlotRow, TEMP_CHANNEL_OPTS, TEMP_HOURS, WEEKDAYS, WEEK_MODES, activeSlotLabel, addHoliday, addMakeup, addSlot, cal, emit, endTempNow, flushSilentNow, holidayInput, makeupInput, notifyCls, notifyLine, openPicker, opts, props, refreshWatch, remove, removeHoliday, removeMakeup, removeSlot, silentStatusText, slotsOf, startTempNow, tempActive, tempChannels, tempHours, tempInfo, tempLabel, tempMode, tempPreview, tempUntilLocal, testPostSilence, testPreSilence, tg, todayDayType, toggleDesktopNotify, toggleTempChannel, tomorrowMorning, tonightMidnight, watch, watchChip, watchState, watchStatusText } = sd
const { cameras, options, hiddenIds, layouts, layoutKey, native, events, openTab, tempSilent } = props
</script>
