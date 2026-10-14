/**
 * 报警推送调度器：三渠道路由 + 各自独立限流 + 超限合并
 *
 * 渠道：
 *   - 钉钉群机器人（text / markdown；图片需要公网图床，一般只发文字）
 *   - 企业微信群机器人（markdown + image base64，直接发截图，不需要图床）
 *   - Telegram Bot（文字 + 直接上传截图，不需要公网图床）
 *
 * 每个渠道都有自己独立的配置（监听通道 / 事件类型 / 静默时段 / 频率限制），
 * 互不影响：钉钉被限流时，企业微信和 Telegram 照常发送。
 *
 * 频率限制（每渠道独立，均为三层）：
 *   1. 同一通道最小间隔（minIntervalSec）
 *   2. 全局最小间隔（globalMinIntervalSec）
 *   3. 每分钟总条数上限（rateLimitPerMin，硬上限 20）
 * 超限时可选「丢弃」或「合并成一条汇总消息」。
 */
import { ref } from 'vue'
import {
  buildAlarmMessage,
  buildMergedMessage,
  buildSilentEndMessages,
  buildSilentSummary,
  formatTime,
  normalizeDingTalk,
  sendDingTalk,
  uploadScreenshot
} from './useDingTalk.js'
import { normalizeWeCom, sendWeCom, sendWeComAlarm, sendWeComImage } from './useWeCom.js'
import { recordPush } from './usePushStats.js'
import { uploadToLitterbox } from './useImageHost.js'
import { EVENT_GROUPS, TYPE_GROUP, featureText, normalizeEvents } from './useAlarmText.js'
import { camHitOn } from '../config/features.js'
import { runtimeLine } from './useDeviceInfo.js'
import {
  BRAND,
  camDigestState,
  camSilentOverview,
  camSilentState,
  channelCredReady,
  digestIntervalLabel,
  isFaceHit,
  matchSilentSlotAt,
  parseSilentSlots,
  slotBoundaryAt
} from '../config/defaults.js'
import {
  buildTelegramCaption,
  buildTelegramMergedText,
  directPushEventOn,
  directPushRecipients,
  normalizeTelegram,
  sendTelegramAlarm,
  sendTelegramText,
  telegramGroupLink,
  telegramMessageLink
} from './useTelegram.js'

const HARD_LIMIT = 20
const WINDOW_MS = 60000

/**
 * 各渠道的配置读取与可用性判断。
 * 注意：必须做成工厂函数——配置对象是外面传进来的（响应式 options），
 * 写成模块级常量会在运行时报 "options is not defined"（闭包里根本没有它）。
 */
function makeChannelDefs(options) {
  return [
    {
      id: 'ding',
      name: '钉钉',
      read: () => normalizeDingTalk(options.dingtalk || {}),
      /*
       * 凭据判定走 channelCredReady（defaults.js）—— 与展示层（通道盲视面板）
       * 共用同一份定义。各自写一份 `!c.webhook.trim()` 迟早会漂移。
       */
      ready: () => channelCredReady(options, 'ding')
    },
    {
      id: 'wecom',
      name: '企微',
      read: () => normalizeWeCom(options.wecom || {}),
      ready: () => channelCredReady(options, 'wecom')
    },
    {
      id: 'tg',
      name: 'TG',
      /**
       * ⚠️ Telegram 是「图片 + 原图链接」的承载通道，必须跟着另外两个渠道一起开：
       * 钉钉 / 企业微信的 markdown 图片要么依赖公网图床、要么依赖 TG 消息链接，
       * 关掉 TG 之后这两个渠道的消息里就只剩一句「已记录在本地」，
       * 用户既看不到图也点不开原图 —— 所以这里做运行时强制兜底。
       */
      read: () => {
        const t = normalizeTelegram(options.telegram || {})
        const needTg =
          !!(options.dingtalk && options.dingtalk.enabled) || !!(options.wecom && options.wecom.enabled)
        if (needTg && !t.enabled) t.enabled = true
        return t
      },
      ready: () => channelCredReady(options, 'tg')
    }
  ]
}

export function useAlertPush(options, hooks = {}) {
  const { onState = () => {}, notify = () => {} } = hooks

  /** 每次创建实例时按当前 options 生成（read 是闭包，取的时候仍读实时配置） */
  const CHANNEL_DEFS = makeChannelDefs(options)

  /**
   * 取当前通道列表。
   *
   * ⚠️ 通道列表在**前后端都不在 options 里**：前端是独立的 cameras ref，后端是
   * config.cameras（与 config.options 平级）。所以由调用方通过 hooks.getCameras 提供；
   * 没传时回落到 options.cameras，只是给老调用方留的兼容路径。
   * 硬去读 options.cameras 的后果是「通道静默看着配好了、却永远不生效」——
   * 因为那里根本没有通道。
   */
  const camerasOf =
    typeof hooks.getCameras === 'function' ? hooks.getCameras : () => (options ? options.cameras : null)

  const pendingCount = ref(0)

  /** 每个渠道独立的限流状态 */
  const chState = {}
  CHANNEL_DEFS.forEach((d) => {
    chState[d.id] = { lastPushAt: {}, windowTs: [], lastGlobalAt: 0, pending: [] }
  })
  let flushTimers = {}

  const readCfg = (id) => {
    const def = CHANNEL_DEFS.find((x) => x.id === id)
    return def ? def.read() : {}
  }
  const isReady = (id) => {
    const def = CHANNEL_DEFS.find((x) => x.id === id)
    if (!def) return false
    const c = def.read()
    return !!(c.enabled && def.ready(c))
  }

  /** 当前可用的推送渠道（用于设置页展示） */
  function channels() {
    const out = {}
    CHANNEL_DEFS.forEach((d) => (out[d.id] = isReady(d.id)))
    return out
  }

  /**
   * 每分钟条数上限。
   * ⚠️ Telegram 不参与限流：它的官方限制是每秒 30 条，正常报警量差着数量级，
   * 而图片和原图链接全靠它承载 —— 限制 TG 等于把推送的价值砍掉一半。
   * 只有钉钉 / 企业微信需要严守 20 条/分钟。
   */
  function rateLimit(c, id) {
    if (id === 'tg') return 100000
    return Math.max(1, Math.min(HARD_LIMIT, Number(c.rateLimitPerMin) || 18))
  }

  /**
   * 钉钉 / 企业微信的「额度即将用尽」提示。
   * 用户要求：必须在**触发限制之前**就把这件事写进消息里，
   * 而不是等消息被丢弃 / 合并之后才让人发现少收了。
   */
  function quotaNote(id) {
    const c = readCfg(id)
    const limit = rateLimit(c, id)
    if (limit > 100) return ''
    const st = chState[id]
    if (!st) return ''
    const used = st.windowTs.length
    const left = limit - used
    if (left > 3) return ''
    if (left <= 0) {
      return `⚠️ 本分钟推送额度已用满（${used}/${limit}），本条可能被合并成汇总消息或延后发送`
    }
    return `⚠️ 本分钟推送额度仅剩 ${left} 条（已用 ${used}/${limit}），超出后将自动合并为汇总消息`
  }

  function prune(st, now) {
    while (st.windowTs.length && now - st.windowTs[0] >= WINDOW_MS) st.windowTs.shift()
  }

  /** 判断是否在静默时段（支持跨零点） */
  function inQuietHours(c, now) {
    if (!c.quietEnabled) return false
    const toMin = (s) => {
      const [h, m] = String(s || '0:0').split(':').map((n) => Number(n) || 0)
      return h * 60 + m
    }
    const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes()
    const start = toMin(c.quietStart)
    const end = toMin(c.quietEnd)
    if (start === end) return false
    return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end
  }

  /* ------------------------------------------------------------------ */
  /* 全局静默时段（免打扰推送）：收存报警，截止时刻统一发汇总              */
  /* ------------------------------------------------------------------ */

  /** 渠道级静默（options.<渠道>.quietStart/quietEnd）仍用这个；时段匹配见下面 readSlots */
  const toMin = (s) => {
    const [h, m] = String(s || '0:0').split(':').map((n) => Number(n) || 0)
    return h * 60 + m
  }
  const silentCfg = () => options.silent || {}

  /**
   * 读出所有定时静默时段（item 114：支持多个时段）。
   *
   * ⚠️ 实现搬到了 defaults.js 的 `parseSilentSlots` —— 通道静默要用**同一套**
   * 时段语义（同一个 slots 结构、同样兼容老配置的 start/end、同样过滤 0 长度窗口）。
   * 各写一份迟早会出现「全局静默 22-2 跨零点、通道静默却不跨」这种对不上的行为。
   */
  function readSlots() {
    return parseSilentSlots(silentCfg())
  }

  /**
   * 找出当前命中的那个时段，并算出它的起止时间戳。
   * 实现同样在 defaults.js（`matchSilentSlotAt`）—— 与通道静默共用同一份。
   */
  function matchSlot(now) {
    return matchSilentSlotAt(readSlots(), now)
  }

  /**
   * 临时静默是否生效（item 112）。
   *
   * 与夜间定时静默并存、且**优先级更高**：用户手动点了「临时静默 2 小时」，
   * 哪怕现在是白天（定时窗口没开）也照样免打扰；反过来夜里到了定时窗口，
   * 也不会缩短用户手动设的临时窗口 —— 取两者中更晚的结束时刻。
   *
   * 配置字段：
   *   tempUntil    临时静默截止时间戳（毫秒），0 / 缺省 = 未开启
   *   tempSince    临时静默的**开始时刻**（毫秒）。只用来回答「这段静默是从什么时候算起」
   *                （远程 /check duty 查岗要按它划查询区间），参与静默判定的仍是 tempUntil。
   *   tempChannels 临时静默覆盖的渠道；为空则沿用 channels（三端）
   *   tempLabel    可选的用途备注，会写进状态文案
   */
  function tempSilentState(now) {
    const c = silentCfg()
    const until = Number(c.tempUntil) || 0
    if (!until) return { active: false }
    if (until <= now) return { active: false, expired: true, endMs: until }
    const chans = Array.isArray(c.tempChannels) && c.tempChannels.length
      ? c.tempChannels
      : (c.channels || [])
    if (!chans.length) return { active: false, expired: true, endMs: until }
    return {
      active: true,
      startMs: tempStartMs(c, now),
      endMs: until,
      channels: chans,
      reason: String(c.tempLabel || '').trim()
    }
  }

  /**
   * 临时静默的**真实开始时刻**。
   *
   * 以前这里恒返回 `now`（调用时刻），对「还剩多久」这种展示没影响，
   * 但「静默查岗」要按开始时刻划区间 —— 恒返回 now 就永远查不到任何积压事件。
   *
   * 取不到 tempSince 的情况只有一种：这条静默是**本版本之前**开启的（那时还没这个字段）。
   * 这时退而求其次用「静默缓冲里最早的那条报警」当作开始时刻；缓冲也是空的话，
   * 就只能退回 now —— 即这一次查岗看到的区间是空的。
   *
   * 刻意**不**用「截止时刻往前推 N 天」之类的估计：临时静默最长 7 天，一旦估计过大，
   * 第一次查岗会把一周的积压一次性全推出去，比「那一次查不到」糟糕得多。
   * 而且这只是升级那一刻的过渡态：静默结束提醒照旧会把本时段所有报警汇总送达，
   * 下一次开启静默就会带上准确的 tempSince。
   */
  function tempStartMs(c, now) {
    const since = Number(c.tempSince) || 0
    if (since > 0 && since <= now) return since
    let earliest = Infinity
    silentBuffer.forEach((r) => {
      const t = Number(r && r.time) || 0
      if (t > 0 && t < earliest) earliest = t
    })
    return Number.isFinite(earliest) && earliest <= now ? earliest : now
  }

  /**
   * 当前是否处于全局静默时段，并给出窗口的起止时间戳 / 文案标签。
   * 支持跨零点（19:00 ~ 次日 08:00）与**多个时段**（item 114）。
   * @returns {{active:boolean, startMs?:number, endMs?:number, rangeLabel?:string, endLabel?:string}}
   */
  function silentState(now) {
    const c = silentCfg()

    /*
     * 临时静默优先：只要它还有效就直接返回，rangeLabel 标成「临时静默（至 HH:MM）」。
     * 这样用户在事件面板点一下就能立刻免打扰，不用等夜里、也不用改定时设置。
     */
    const temp = tempSilentState(now)
    if (temp.active) {
      const p2t = (n) => String(n).padStart(2, '0')
      const e = new Date(temp.endMs)
      const left = Math.max(0, temp.endMs - now)
      /*
       * 分钟先四舍五入、再进位到小时。
       * 反过来算（小时向下取整、分钟四舍五入）会出现 "2 小时 60 分" ——
       * 因为 2h59.6m 的分钟四舍五入成 60，却没把它并进小时。
       */
      const totalMin = Math.round(left / 60000)
      const hh = Math.floor(totalMin / 60)
      const mm = totalMin % 60
      const leftLabel = hh ? `${hh} 小时 ${mm} 分后` : `${mm} 分后`
      return {
        active: true,
        temp: true,
        startMs: temp.startMs,
        endMs: temp.endMs,
        channels: temp.channels,
        // 用途备注要一路带到提醒文案里，否则「临时静默已开启」看不出是为什么静默的
        reason: temp.reason || '',
        rangeLabel: `临时静默（至 ${p2t(e.getHours())}:${p2t(e.getMinutes())}）`,
        endLabel: `${p2t(e.getHours())}:${p2t(e.getMinutes())}`,
        leftLabel
      }
    }

    if (!c || !c.enabled) return { active: false }
    const hit = matchSlot(now)
    if (!hit) return { active: false }

    const p2 = (n) => String(n).padStart(2, '0')
    const fmt = (ms) => {
      const x = new Date(ms)
      return `${p2(x.getHours())}:${p2(x.getMinutes())}`
    }
    const endDay = hit.crossDay ? '次日 ' : ''
    return {
      active: true,
      startMs: hit.startMs,
      endMs: hit.endMs,
      rangeLabel: `${fmt(hit.startMs)} ~ ${endDay}${fmt(hit.endMs)}`,
      endLabel: `${endDay}${fmt(hit.endMs)}`
    }
  }

  /**
   * 某渠道此刻是否应被全局静默收存（不实时推） */
  function isSilentSuppressed(id, now) {
    const s = silentState(now)
    if (!s.active) return false
    // 临时静默按 tempChannels 走，夜间定时按 channels 走
    const chans = s.temp ? s.channels || [] : silentCfg().channels || []
    return chans.includes(id)
  }

  /** 静默时段内收存的报警快照（去重 by key） */
  const silentBuffer = []
  const silentSeen = new Set()
  let silentTimer = null

  /* ---------------- 通道级静默：收存缓冲与窗口状态 ---------------- */

  /**
   * 每路通道一份的收存状态（惰性创建）。字段与全局那套一一对应，只是按 camId 分了份。
   *   buf / seen      收存的报警快照与去重集合
   *   win             当前所处的窗口（结束汇总要用它的 rangeLabel）
   *   timer/armedEnd  结束汇总的定时器与它对应的 endMs
   *   flushedEnd      已收尾过的 endMs（定时器与心跳都想去收尾，靠它只发一次）
   */
  const camStore = new Map()
  function camSlot(id) {
    let st = camStore.get(id)
    if (!st) {
      st = { buf: [], seen: new Set(), win: null, timer: null, armedEnd: 0, flushedEnd: 0 }
      camStore.set(id, st)
    }
    return st
  }

  /** 按 id 找一路通道配置（找不到返回 null） */
  function camById(id) {
    const list = camerasOf()
    return (Array.isArray(list) ? list : []).find((c) => c && c.id === id) || null
  }

  /** 这条 record 所属通道此刻的通道静默状态 */
  function recordCamSilent(record, now) {
    const cam = camById(record && record.id)
    return cam ? camSilentState(cam, now) : { active: false }
  }

  /**
   * 静默收存用的报警快照。
   * ⚠️ 刻意**不**收 faceThumb / thumb —— 那是几万字符的 dataURL，收进来会让
   * 静默缓冲整体膨胀几个量级，而汇总与查岗都不展示图片内容（图另有 store 里的路径）。
   * 相似度 faceScore 要收：汇总里「人脸命中」分区要显示「相似度 92%」，少了就只能列名字。
   */
  function silentSnapshot(record) {
    return {
      key: record.key,
      time: record.time,
      name: record.name,
      type: record.type,
      ratio: record.ratio,
      faceName: record.faceName,
      faceScore: record.faceScore,
      counts: record.counts,
      zoneName: record.zoneName,
      dwellMs: record.dwellMs,
      text: record.text
    }
  }

  /** 当前所处的静默窗口（开始/结束提醒、收尾文案都靠它定位）；null = 不在静默中 */
  let activeWin = null
  /** 已经发过「结束」提醒的窗口结束时刻：定时器与心跳都想去收尾，靠它只发一次 */
  let flushedEndMs = 0
  /**
   * 被临时静默「顶掉」的那个定时时段签名。
   * 临时静默到期时，如果底下那个定时时段还在跑，就不该再补一条
   * 「免打扰时段已开启」——用户会以为是新开了个窗口。
   */
  let coveredSlotKey = ''

  /**
   * 静默相关消息（开始提醒 / 结束提醒 / 汇总）发给哪些渠道 —— 全项目唯一的判定点。
   *
   * 默认口径（不是试发时）：只要静默提醒开着，就推给**现有已配置的三端**
   * （钉钉 / 企微 / TG）。这时刻意**不看** silent.channels —— 那个勾选决定的是
   * 「静默期间哪些渠道暂停实时推送」，跟「提醒本身发去哪」不是一回事：
   * 只对钉钉静默的人，一样应该在企业微信 / TG 上看到「免打扰已开启 / 已结束」。
   *
   * 唯一的例外是设置页的「试发」：那里传 only = silent.channels，
   * 让用户能挑一个渠道单独验证文案，不用被三端同时轰炸。
   *
   * @param {string[]} [only] 限定渠道（试发用）；缺省 / 空 = 全部已配置渠道
   */
  function restrictIds(only) {
    const all = CHANNEL_DEFS.filter((d) => isReady(d.id)).map((d) => d.id)
    if (Array.isArray(only) && only.length) {
      const hit = all.filter((id) => only.includes(id))
      // 两道防呆，避免试发变成「静默失败」：选中的渠道剔掉没配置好的；
      // 剔完一个都不剩（勾的三个都没配凭据，或传进来一堆不存在的 id），
      // 就退回「全部已配置渠道」—— 宁可多发，也不能让按钮点了却收不到东西。
      if (hit.length) return hit
    }
    return all
  }

  /**
   * 由当前时间推出所处窗口的信息对象；不在静默中返回 null。
   * 这里把 silentState 的结果整理成后续排程 / 文案统一要用的形状。
   */
  function currentWindow(now) {
    const st = silentState(now)
    if (!st.active) return null
    return {
      key: `${st.temp ? 'temp' : 'slot'}:${st.endMs}`,
      temp: !!st.temp,
      startMs: st.startMs,
      endMs: st.endMs,
      rangeLabel: st.rangeLabel,
      endLabel: st.endLabel,
      channels: st.channels || null,
      reason: st.reason || ''
    }
  }

  /** 定时时段的稳定签名（不含时间戳），用于识别「临时静默顶掉的那个时段」 */
  function slotSignature(now) {
    const hit = matchSlot(now)
    return hit ? `${hit.start}-${hit.end}` : ''
  }

  /** 已排上结束提醒的窗口末尾（同一个窗口不重复排，避免每条报警都重排定时器） */
  let armedEndMs = 0

  /**
   * 排程本窗口的「结束提醒」。
   *
   * 关键：**不管窗口里有没有报警都要排**（用户要求结束后也有推送）。
   * 原来只在有报警被收存时才排定时器，于是「静默了一晚什么都没发生」
   * 就永远收不到结束通知。
   */
  function armSilentEnd(win) {
    if (!win || !win.endMs) {
      if (silentTimer) {
        clearTimeout(silentTimer)
        silentTimer = null
      }
      armedEndMs = 0
      return
    }
    if (silentTimer && armedEndMs === win.endMs) return
    if (silentTimer) {
      clearTimeout(silentTimer)
      silentTimer = null
    }
    armedEndMs = win.endMs
    // +800ms 让「到点」这件事在内层判定里也真的算过了（matchSlot 用的是左闭右开）
    const wait = Math.max(1000, win.endMs - Date.now() + 800)
    silentTimer = setTimeout(() => {
      silentTimer = null
      armedEndMs = 0
      flushSilentSummary({ endMs: win.endMs, window: win }).catch(() => {})
    }, wait)
  }

  /** 兼容入口：按当前状态补排一次结束提醒（handleAlarm / startTempSilent 都会调） */
  function scheduleSilentFlush() {
    const win = currentWindow(Date.now())
    if (win) armSilentEnd(win)
  }

  /** 把汇总消息发到给定渠道，返回成功发出的渠道名 */
  async function pushSilentSummary(ids, summary) {
    const sent = []
    if (ids.includes('tg')) {
      try {
        await sendTelegramText(readCfg('tg'), summary.plain || summary.html || '')
        recordPush('tg', true)
        sent.push('TG')
      } catch (e) {
        recordPush('tg', false, (e && e.message) || '未知错误')
      }
    }
    const rest = await Promise.all(
      ids
        .filter((id) => id !== 'tg')
        .map(async (id) => {
          const name = CHANNEL_DEFS.find((d) => d.id === id).name
          try {
            if (id === 'ding') {
              const c = readCfg('ding')
              await sendDingTalk(
                { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy },
                { title: summary.title, text: summary.markdown, msgType: 'markdown' }
              )
            } else {
              const c = readCfg('wecom')
              await sendWeCom(c, { msgType: 'markdown', content: summary.markdown, atAll: false })
            }
            recordPush(id, true)
            return name
          } catch (e) {
            recordPush(id, false, (e && e.message) || '未知错误')
            return null
          }
        })
    )
    rest.forEach((n) => n && sent.push(n))
    return sent
  }

  /**
   * 静默收尾：发一条「免打扰时段已结束」提醒（含本时段汇总），然后清空缓冲。
   *
   * 三种触发来源：
   *   1) 窗口到点（定时器 / 心跳兜底）；
   *   2) 用户手动结束临时静默；
   *   3) 设置页「立即推送静默汇总」按钮（kind='manual'：缓冲为空时不必打扰）。
   *
   * @param {object} [opts]
   * @param {number} [opts.endMs]   本次结束对应的时间戳（默认现在）
   * @param {object} [opts.window]  正在结束的那个窗口（有则用它写时段文案）
   * @param {boolean}[opts.manual]  手动触发：没收到报警就不发（纯提醒按钮场景）
   * @param {boolean}[opts.test]    设置页试发：只生成并发送，不动真实缓冲
   * @param {string[]}[opts.onlyIds] 限定只发这几个渠道（试发用；缺省 = 全部已配置渠道）
   */
  async function flushSilentSummary(opts = {}) {
    const now = Date.now()
    const endMs = Number(opts.endMs) > 0 ? Number(opts.endMs) : now
    // test（设置页试发）用副本，别把真正待汇总的事件提前掏空
    const buf = opts.test ? silentBuffer.slice() : silentBuffer.splice(0, silentBuffer.length)
    if (!opts.test) {
      silentSeen.clear()
      // 记下来：定时器与心跳都想来收尾，谁先到谁发，后面那个看到这个值就不再发
      flushedEndMs = Math.max(flushedEndMs, endMs)
      const closedWin = opts.window || null
      if (closedWin && activeWin && activeWin.key === closedWin.key) activeWin = null
      coveredSlotKey = ''
    }

    /*
     * 什么情况下不发：
     *   - 手动汇总（设置页按钮）且一无所有 → 没有可讲的内容，不打扰；
     *   - preNotify 关闭 → 不再发状态提醒（有报警的汇总仍然要发）；
     *   - 本进程不负责发提醒（后端模式下前端页面只被动跟随）且自己没有待汇总 →
     *     不能跟着后端一起推「已结束」，否则同一条提醒会被两个进程各发一遍。
     * 试发（test）不受这些限制，否则文案永远看不到效果。
     */
    if (!buf.length && !opts.test && (opts.manual || silentCfg().preNotify === false || !preAllowed())) return

    const ids = restrictIds(opts.onlyIds)
    if (!ids.length) return

    const closedWin = opts.window || null
    const startMs = closedWin
      ? closedWin.startMs
      : (buf.length ? buf.reduce((m, r) => Math.min(m, r.time || endMs), endMs) : endMs)
    // 结束后是否还压在另一个免打扰窗口里（临时静默到期、夜间时段还在）
    const next = currentWindow(endMs + 60000)
    const summary = buildSilentEndMessages(buf, silentCfg(), {
      startMs,
      endMs,
      rangeLabel: closedWin ? closedWin.rangeLabel : '',
      stillSilent: !!next,
      stillLabel: next ? next.rangeLabel : ''
    })

    const sent = await pushSilentSummary(ids, summary)
    if (!opts.test) {
      ids.forEach((id) => {
        const st = chState[id]
        if (st) {
          st.windowTs.push(endMs)
          st.lastGlobalAt = endMs
        }
      })
      if (sent.length) {
        notify(
          buf.length
            ? `静默结束提醒已推送（含 ${buf.length} 条汇总 · ${sent.join(' + ')}）`
            : `静默结束提醒已推送（${sent.join(' + ')}）`
        )
      }
      /*
       * 关键事件单独提醒（静默汇总）。
       * 放在这里而不是 pushSilentSummary 内部：一个是"渠道分发"，
       * 一个是"额外私聊"，混在一起将来加渠道会互相牵连。
       * 汇总正文里已经含「人脸命中」单列分区（见 buildSilentSummary）。
       */
      pushDirectToUsers('summary', {
        title: summary.title,
        text: summary.plain,
        html: summary.html || summary.plain
      }).catch(() => {})
    }
    return summary
  }

  /* ==================== 通道级静默：收存 → 结束汇总 ==================== */

  /**
   * 排程某一路通道静默窗口的结束汇总。
   * 与全局那套同构：不管窗口里有没有报警都排（宁可排了空跑，也别漏收尾）。
   */
  function scheduleCamFlush(camId, now = Date.now()) {
    const st = camSlot(camId)
    const s = camSilentState(camById(camId), now)
    if (!s.active) {
      if (st.timer) {
        clearTimeout(st.timer)
        st.timer = null
      }
      st.armedEnd = 0
      st.win = null
      return
    }
    if (st.timer && st.armedEnd === s.endMs) return
    if (st.timer) {
      clearTimeout(st.timer)
      st.timer = null
    }
    st.win = s
    st.armedEnd = s.endMs
    // +800ms 与全局一致：让「到点」这件事在内层判定里也真的算过了（时段是左闭右开）
    const wait = Math.max(1000, s.endMs - Date.now() + 800)
    st.timer = setTimeout(() => {
      st.timer = null
      st.armedEnd = 0
      flushCamSilent(camId, { endMs: s.endMs, window: s }).catch(() => {})
    }, wait)
  }

  /**
   * 通道静默收尾：把这一路攒下的事件汇总发出去。
   *
   * 三处与全局静默**刻意不同**：
   *   1) **没有事件就不发**。全局静默即使一条都没有也要报「已结束」（否则用户会以为
   *      静默卡住了）；但通道静默图的就是"这一路这段别吵我"，为"什么都没发生"
   *      再补一条通知，等于把刚省下的打扰又还回去。
   *   2) **只发给被静默的那几个渠道**。全局汇总发给全部已配置渠道；但通道静默只
   *      静默了部分渠道，其余渠道这些事件早就实时收到了，再发一份就是重复打扰。
   *   3) **不发「开始提醒」**。通道静默大多是按天固定时段，每天两条提醒太吵；
   *      要确认是否生效，用 `/cams` 查（那里有实时状态）。
   */
  async function flushCamSilent(camId, opts = {}) {
    const st = camSlot(camId)
    const endMs = Number(opts.endMs) > 0 ? Number(opts.endMs) : Date.now()
    /*
     * 这批事件是在**哪个窗口**下被收存的 —— 用来决定汇总发给谁。
     * 必须在下面清 st.win 之前取出来（清完就取不到了）。
     */
    const bufferedWin = st.win
    // 定时器与心跳都想来收尾，谁先到谁发 —— 后到的看到 flushedEnd 就退出
    if (!opts.test && endMs <= st.flushedEnd) return null
    const buf = opts.test ? st.buf.slice() : st.buf.splice(0, st.buf.length)
    if (!opts.test) {
      st.seen.clear()
      st.flushedEnd = Math.max(st.flushedEnd, endMs)
      if (st.win && (!opts.window || st.win.endMs === opts.window.endMs)) st.win = null
    }
    if (!buf.length) return null

    const cam = camById(camId)
    const name = (cam && cam.name) || camId
    /*
     * 只发给**被静默的那几个渠道**：
     *   1) 调用方显式给的窗口渠道（定时器 / 心跳都走这条）；
     *   2) 收存这批事件时的窗口渠道 —— 临时静默会用 tempChannels，**不能**拿
     *      cam.silent.channels（那是"定时时段静默哪几端"的配置）顶上：静态配置与实际
     *      生效的窗口经常不是同一组，用错了就会把汇总发给早就实时收到过这些事件的那一端，
     *      正是这里要避免的重复打扰；
     *   3) 都没有（历史残留缓冲）才退回配置。
     * restrictIds 还会再剔掉"没配置好"的渠道。
     */
    const targetChans =
      (opts.window && opts.window.channels) ||
      (bufferedWin && bufferedWin.channels) ||
      opts.onlyIds ||
      (cam && cam.silent && Array.isArray(cam.silent.channels) ? cam.silent.channels : null)
    const ids = restrictIds(targetChans && targetChans.length ? targetChans : null)
    if (!ids.length) return null

    const startMs = opts.window
      ? opts.window.startMs
      : buf.reduce((m, r) => Math.min(m, r.time || endMs), endMs)
    const summary = buildSilentSummary(buf, silentCfg(), {
      startMs,
      endMs,
      variant: 'cam',
      scopeName: name,
      rangeLabel: opts.window ? opts.window.rangeLabel : ''
    })
    const sent = await pushSilentSummary(ids, summary)
    if (!opts.test && sent.length) {
      notify(`「${name}」通道静默结束汇总已推送（${buf.length} 条 · ${sent.join(' + ')}）`)
    }
    return summary
  }

  /**
   * 通道静默的心跳：逐路检查窗口进出。
   * 与全局那套（tickSilentWindow）同构 —— 签名比对 + 到点兜底补发，
   * 只是**每路独立**：多路可能各处在不同的窗口里。
   */
  function tickCamSilent(now = Date.now()) {
    const raw = camerasOf()
    const list = Array.isArray(raw) ? raw : []
    const alive = new Set()
    list.forEach((cam) => {
      if (!cam || !cam.id) return
      alive.add(cam.id)
      const st = camSlot(cam.id)
      const s = camSilentState(cam, now)
      const key = s.active ? `${s.temp ? 't' : 's'}:${s.endMs}` : ''
      const prevKey = st.win ? `${st.win.temp ? 't' : 's'}:${st.win.endMs}` : ''
      if (key === prevKey) return
      /*
       * 旧窗口刚走完、但定时器没跑到（休眠 / 卡顿 / 进程重启）→ 在这里补发。
       * `!st.timer` 很关键：定时器故意排在 endMs+800ms，心跳完全可能先一步到，
       * 不拦一下就会连发两条一模一样的汇总。
       */
      if (st.win && st.win.endMs <= now && st.win.endMs > st.flushedEnd && !st.timer) {
        flushCamSilent(cam.id, { endMs: st.win.endMs, window: st.win }).catch(() => {})
      }
      if (!s.active) {
        st.win = null
        if (st.timer) {
          clearTimeout(st.timer)
          st.timer = null
        }
        st.armedEnd = 0
        return
      }
      scheduleCamFlush(cam.id, now)
    })
    /*
     * 通道被删掉 → 连同它的缓冲与定时器一起清掉。
     * 不清的话：汇总迟早会发往一个已经不存在（或已被别的通道占用同名 id）的通道，
     * 而且 Map 会随着反复增删通道无限长大。
     */
    for (const id of [...camStore.keys()]) {
      if (alive.has(id)) continue
      const st = camStore.get(id)
      if (st.timer) clearTimeout(st.timer)
      camStore.delete(id)
    }
  }

  /* ==================== 通道级「日常事件静默」（按间隔汇总） ====================
   * 与上面的通道静默同构，只是驱动方式从「时段」换成「间隔」：
   *   · 通道静默：命中时段 → 收存 → 时段结束发一条汇总；
   *   · 日常静默：平时就一直收存 → 每满一个间隔发一条汇总。
   *
   * 两条规则（判定收在 defaults.camDigestState，这里只喂运行时状态）：
   *   1) **让位于静默窗口**：此刻有任一静默窗口生效（全局免打扰 ∨ 这一路的通道静默）
   *      就不吸收新事件 —— 否则同一条事件会既进静默汇总又进日常汇总。
   *   2) **不吸收关键事件**（在库的人脸命中，判据 isFaceHit）：它的意义就是"立刻知道"。
   */

  /**
   * 每路通道一份的日常收存状态（惰性创建）。
   *   buf / seen      收存的报警快照与去重集合
   *   since           本批**第一条**入队的时刻 —— 间隔从它算起，
   *                   而不是从"上一次汇总时刻"算起（否则长时间没事件时会立刻补一条空汇总）
   *   armedDue/timer  已排的到点时刻与定时器（幂等重排靠它们比对）
   */
  const digestStore = new Map()
  function digestSlot(id) {
    let st = digestStore.get(id)
    if (!st) {
      st = { buf: [], seen: new Set(), since: 0, armedDue: 0, timer: null }
      digestStore.set(id, st)
    }
    return st
  }

  /**
   * 这一路此刻的日常静默状态 —— **唯一判定**在 `defaults.camDigestState`。
   * 这里只负责把"此刻有没有静默窗口生效"喂给它：那是本文件的运行时状态
   * （要读全局免打扰 + 这一路的通道静默），纯函数拿不到。
   * 展示层（/cams、设置页）读的是同一个函数 —— 各算一份会出现
   * 「界面说在收存、实际没生效」这种最难查的不一致。
   */
  function digestStateOf(cam, now) {
    const camS = camSilentState(cam, now)
    return camDigestState(cam, { silentActive: !!(silentState(now).active || camS.active) })
  }

  /** 丢掉一路的定时器与收存（配置关闭 / 通道被删 / 恢复初始化） */
  function clearCamDigest(id) {
    const st = digestStore.get(id)
    if (!st) return
    if (st.timer) clearTimeout(st.timer)
    st.timer = null
    st.armedDue = 0
    st.buf.length = 0
    st.seen.clear()
    st.since = 0
  }

  /**
   * 排程这一路的日常汇总（**幂等**，心跳每 30 秒都会调它）。
   * @returns {boolean} 此刻是否**已到点** —— true 表示调用方应当立刻 flush
   */
  function armCamDigest(camId, now = Date.now()) {
    const st = digestSlot(camId)
    if (!st.buf.length) {
      if (st.timer) {
        clearTimeout(st.timer)
        st.timer = null
      }
      st.armedDue = 0
      return false
    }
    const s = digestStateOf(camById(camId), now)
    /*
     * 让位于静默窗口 → 收掉定时器，交给心跳重试。
     * 不在这里排一个"窗口结束后才该响"的定时器：那等于把两套时间轴搅在一起
     * （静默窗口本身有自己的心跳与收尾），排出来的时长还得先算窗口还剩多久。
     */
    if (!s.active) {
      if (st.timer) {
        clearTimeout(st.timer)
        st.timer = null
      }
      st.armedDue = 0
      return false
    }
    /*
     * dueAt 每次都从 since + 间隔**重算**，而不是记在状态里加一次：
     * 用户改了间隔就能立刻生效，不必等下一批事件。
     */
    const due = st.since + s.intervalMs
    if (now >= due) return true
    if (st.timer && st.armedDue === due) return false
    if (st.timer) clearTimeout(st.timer)
    st.armedDue = due
    st.timer = setTimeout(() => {
      st.timer = null
      st.armedDue = 0
      flushCamDigest(camId).catch(() => {})
    }, Math.max(1000, due - now))
    return false
  }

  /**
   * 日常汇总收尾：把这一路攒下的事件汇总发出去。
   *
   * 三处与通道静默**刻意一致**（理由同 flushCamSilent）：
   *   1) 没有事件就不发；2) 只发给被静默的那几个渠道；3) 不发"开始提醒"。
   *
   * 另外多一条：**静默窗口生效期间不发**，缓冲原样留着，等窗口结束由心跳补发。
   * 不照发的理由：用户刚把这一路设成免打扰，再来一条汇总就是自相矛盾。
   * 不丢的理由：这些事件本来就该由日常汇总送达，丢了就永远没人看见。
   */
  async function flushCamDigest(camId, opts = {}) {
    const st = digestSlot(camId)
    if (!st.buf.length) return null
    const cam = camById(camId)
    const now = Date.now()
    const s = digestStateOf(cam, now)
    if (!opts.test && !s.active) return null
    const ids = restrictIds(s.channels)
    if (!ids.length) return null

    const name = (cam && cam.name) || camId
    const buf = st.buf.splice(0, st.buf.length)
    st.seen.clear()
    const since = st.since || now
    st.since = 0
    const summary = buildSilentSummary(buf, silentCfg(), {
      startMs: buf.reduce((m, r) => Math.min(m, r.time || since), since),
      endMs: now,
      variant: 'digest',
      scopeName: name,
      intervalMinutes: s.intervalMinutes
    })
    const sent = await pushSilentSummary(ids, summary)
    if (!opts.test && sent.length) {
      notify(`「${name}」日常事件汇总已推送（${buf.length} 条 · ${sent.join(' + ')}）`)
    }
    return summary
  }

  /**
   * 日常静默心跳：兜底定时器（休眠 / 卡顿 / 进程重启）＋ 收尾已删通道。
   * 与 tickCamSilent 同构，挂在**同一个 30 秒心跳**里（见 tickSilentWindow）。
   */
  function tickCamDigest(now = Date.now()) {
    const raw = camerasOf()
    const list = Array.isArray(raw) ? raw : []
    const alive = new Set()
    list.forEach((cam) => {
      if (!cam || !cam.id) return
      alive.add(cam.id)
      const st = digestStore.get(cam.id)
      if (!st || !st.buf.length) return
      if (armCamDigest(cam.id, now)) flushCamDigest(cam.id).catch(() => {})
    })
    /*
     * 通道被删 / 关闭日常静默 → 连同缓冲与定时器一起清掉。
     * 不清的话汇总迟早发往一个已经不存在的通道，Map 也会随反复增删无限长大。
     */
    for (const id of [...digestStore.keys()]) {
      if (alive.has(id)) continue
      clearCamDigest(id)
      digestStore.delete(id)
    }
  }

  /**
   * 开启某一路通道的临时静默（远程 `/csilent` 与设置页共用）。
   * 与全局 startTempSilent 同构：渠道显式传空数组一律拒绝（**不**回落默认，
   * 否则「一个都不选」反而静默掉了配置里的渠道，比不选还糟）。
   * @returns {{ok:boolean, until?:number, reason?:string}}
   */
  function startCamTempSilent(camId, hours, channels, label, untilAt) {
    const cam = camById(camId)
    if (!cam) return { ok: false, reason: '找不到该监控通道' }
    if (Array.isArray(channels) && !channels.length) {
      return { ok: false, reason: '请至少选一个静默渠道 —— 一个都不选的话，静默不静默就没区别了' }
    }
    const now = Date.now()
    let until = 0
    if (Number(untilAt) > 0) {
      until = Number(untilAt)
      if (until <= now) return { ok: false, reason: '结束时间必须晚于当前时间' }
    } else {
      const h = Number(hours)
      if (!Number.isFinite(h) || h <= 0) {
        return { ok: false, reason: '请选择时长，或指定一个晚于当前时间的结束时刻' }
      }
      until = now + Math.min(h, 168) * 3600000
    }
    if (until - now > 7 * 24 * 3600000) return { ok: false, reason: '单次临时静默最长 7 天' }
    const s = cam.silent && typeof cam.silent === 'object' ? cam.silent : (cam.silent = {})
    s.tempUntil = until
    /*
     * 与全局一致，记下**开始时刻** —— 通道静默的汇总区间与将来的查岗都要用它；
     * 重复下发（延长）时一并重置，因为用户说的是"从现在起再静默 N 小时"。
     */
    s.tempSince = now
    if (Array.isArray(channels) && channels.length) s.tempChannels = channels.slice()
    if (label) s.tempLabel = String(label).slice(0, 40)
    // 立刻对齐窗口并排程（不等心跳那 30 秒，否则这几秒内的事件会被当成"没静默"实时推出去）
    const st = camSlot(camId)
    const win = camSilentState(cam, now)
    st.win = win.active ? win : null
    if (win.active) scheduleCamFlush(camId, now)
    return { ok: true, until }
  }

  /**
   * 提前结束某一路的临时静默。
   * flush=true 时把已收存的汇总发出去（与全局 endTempSilent 一致）；
   * 即使 flush=false 也要收尾 —— 否则心跳 30 秒后会再补一条。
   */
  function endCamTempSilent(camId, flush = true) {
    const cam = camById(camId)
    if (!cam) return { ok: false, reason: '找不到该监控通道' }
    const s = cam.silent || {}
    if (!Number(s.tempUntil)) return { ok: false, reason: '该通道当前没有临时静默' }
    const st = camSlot(camId)
    const win = st.win && st.win.temp ? st.win : null
    s.tempUntil = 0
    s.tempSince = 0
    s.tempLabel = ''
    if (st.timer) {
      clearTimeout(st.timer)
      st.timer = null
    }
    st.armedEnd = 0
    // 临时静默底下可能还压着定时时段 → 立刻按新状态重排（否则中间空一截没人收尾）
    const next = camSilentState(cam, Date.now())
    st.win = next.active ? next : null
    if (next.active) scheduleCamFlush(camId)
    if (flush) {
      return flushCamSilent(camId, { endMs: Date.now(), window: win }).then(() => ({ ok: true }))
    }
    return { ok: true }
  }

  /* ---------------- 免打扰「开启 / 结束」提醒（preNotify，默认开） ---------------- */

  /**
   * 把配置里的时间写法统一成「当天第几分钟」。
   *
   * 两种都收：'20:00'（界面输入框给的字符串）与 1200（readSlots / matchSlot
   * 内部就是分钟数）。**这里以前只认字符串**，而心跳传进来的是 matchSlot 的
   * 数字结果 → hm2min 返回 null → buildPreSilenceMessages 恒返回 null →
   * 开始提醒那条「时段格式无效」直接返回，从来没真正发出去过。
   */
  function hm2min(hm) {
    if (typeof hm === 'number' && Number.isFinite(hm)) return ((Math.round(hm) % 1440) + 1440) % 1440
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim())
    if (!m) return null
    return Number(m[1]) * 60 + Number(m[2])
  }

  /** 当天第几分钟 → 'HH:MM' */
  function min2hm(min) {
    const m = ((Math.round(Number(min) || 0) % 1440) + 1440) % 1440
    const p2 = (n) => String(n).padStart(2, '0')
    return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`
  }

  /** 分钟数 → 「X 小时 Y 分」 */
  function durMinutesText(durMin) {
    const dh = Math.floor(durMin / 60)
    const dm = durMin % 60
    return dh ? (dm ? `${dh} 小时 ${dm} 分` : `${dh} 小时`) : `${dm} 分钟`
  }

  /**
   * 「免打扰时段开启」提醒的三种文案（markdown / html / 纯文本）。
   * 内容按用户要求讲清四件事：本次免打扰时长、期间仍持续统计、结束时间、
   * 结束后会推送什么。
   * @param {object} slot 时段 { start, end }，值可以是 '20:00' 或分钟数
   */
  function buildPreSilenceMessages(slot) {
    const s = hm2min(slot && slot.start)
    const e = hm2min(slot && slot.end)
    if (s === null || e === null || s === e) return null

    // 结束时间早于开始时间 = 跨零点（夜里那场都是）
    const cross = e < s
    const startLabel = min2hm(s)
    const endLabel = (cross ? '次日 ' : '') + min2hm(e)
    const durText = durMinutesText(cross ? 1440 - s + e : e - s)
    const rangeText = `${startLabel} ~ ${endLabel}`

    return {
      title: '🔕 免打扰时段已开启',
      markdown: [
        '### 🔕 免打扰时段已开启',
        '>',
        `> **时段**：${rangeText}　（时长约 ${durText}）`,
        '>',
        '> 这段时间内**不再实时逐条推送**，但监控与事件**统计照常进行**，不会漏记。',
        `> 到 **${endLabel}** 自动结束，届时会**推送结束提醒 + 汇总**本时段内捕获的全部报警。`
      ].join('\n'),
      html: [
        '🔕 <b>免打扰时段已开启</b>',
        '',
        `时段：<b>${rangeText}</b>（时长约 ${durText}）`,
        '',
        '这段时间内<b>不再实时逐条推送</b>，但监控与事件<b>统计照常进行</b>，不会漏记。',
        `到 <b>${endLabel}</b> 自动结束，届时会<b>推送结束提醒 + 汇总</b>本时段内捕获的全部报警。`
      ].join('\n'),
      plain: [
        '🔕 免打扰时段已开启',
        `时段：${rangeText}（时长约 ${durText}）`,
        '这段时间内不再实时逐条推送，但监控与事件统计照常进行。',
        `到 ${endLabel} 自动结束，届时会推送结束提醒并汇总本时段内捕获的全部报警。`
      ].join('\n')
    }
  }

  /**
   * 「临时静默已开启」提醒（与结束提醒配对）。
   * 临时静默是用户/远程主动开启的，文案里带上截止时刻与用途备注，
   * 免得过后想不起来当时为什么静默。
   */
  function buildTempSilentMessages(win) {
    const p2 = (n) => String(n).padStart(2, '0')
    const e = new Date(win.endMs)
    const endLabel = `${p2(e.getHours())}:${p2(e.getMinutes())}`
    const durText = durMinutesText(Math.max(1, Math.round((win.endMs - win.startMs) / 60000)))
    const reason = String(win.reason || '').trim()
    const reasonMd = reason ? [`> **用途**：${reason}`] : []
    const reasonPlain = reason ? [`用途：${reason}`] : []

    return {
      title: '🔕 临时静默已开启',
      markdown: [
        '### 🔕 临时静默已开启',
        '>',
        `> **截止**：${endLabel}　（时长约 ${durText}）`,
        ...reasonMd,
        '>',
        '> 这段时间内**不再实时逐条推送**，但监控与事件**统计照常进行**，不会漏记。',
        `> 到 **${endLabel}** 自动结束，届时会**推送结束提醒 + 汇总**本时段内捕获的全部报警。`
      ].join('\n'),
      html: [
        '🔕 <b>临时静默已开启</b>',
        '',
        `截止：<b>${endLabel}</b>（时长约 ${durText}）`,
        ...reasonPlain.map((s) => s.replace('用途：', '用途：<b>') + '</b>'),
        '',
        '这段时间内<b>不再实时逐条推送</b>，但监控与事件<b>统计照常进行</b>，不会漏记。',
        `到 <b>${endLabel}</b> 自动结束，届时会<b>推送结束提醒 + 汇总</b>本时段内捕获的全部报警。`
      ].join('\n'),
      plain: [
        '🔕 临时静默已开启',
        `截止：${endLabel}（时长约 ${durText}）`,
        ...reasonPlain,
        '这段时间内不再实时逐条推送，但监控与事件统计照常进行。',
        `到 ${endLabel} 自动结束，届时会推送结束提醒并汇总本时段内捕获的全部报警。`
      ].join('\n')
    }
  }

  /**
   * 发一条「免打扰开始」提醒。
   * @param {object} win  窗口信息（currentWindow 的产物；win.temp 决定用哪套文案）
   * @param {object} slot 定时时段的 { start, end }（分钟数，来自 matchSlot）
   */
  async function pushStartNotice(win, slot, opts = {}) {
    if (silentCfg().preNotify === false) return { ok: false, reason: '静默提醒已关闭' }
    const msg = win && win.temp ? buildTempSilentMessages(win) : buildPreSilenceMessages(slot)
    if (!msg) return { ok: false, reason: '时段格式无效' }
    const r = await sendDirect({
      title: msg.title,
      text: msg.markdown,
      html: msg.html,
      kind: 'silent',
      // 试发时限定渠道；正常触发时 opts.onlyIds 为空 = 发全部已配置渠道
      onlyIds: opts.onlyIds
    })
    // sendDirect 成功时返回 { ok, reason }（reason 为空=全渠道成功，非空=部分失败说明），没有 sent 字段
    if (r && r.ok) {
      notify(r.reason ? `免打扰开始提醒已推送（${r.reason}）` : '免打扰开始提醒已推送')
      /*
       * 关键事件单独提醒（静默开始）。
       * 试发（设置页「试发一条开始提醒」）不私聊打扰别人 —— 那个按钮只是看文案。
       */
      if (!opts.test) {
        pushDirectToUsers('silence', { title: msg.title, text: msg.markdown, html: msg.html })
          .catch(() => {})
      }
    }
    return r
  }

  /**
   * 设置页「试发一条开始提醒」用的入口（不受 preNotify 开关限制，改完文案先看效果）。
   *
   * @param {object} [slot] 指定时段；缺省则用「当前正在跑的时段」，再缺省用第一个时段
   * @param {object} [opts] { onlyIds } —— 试发时限定只发这几个渠道
   */
  function pushPreSilenceNotice(slot, opts = {}) {
    const slots = readSlots()
    const hit = matchSlot(Date.now())
    const useSlot = slot || hit || slots[0] || null
    // 试发时若正处在临时静默里，用临时静默的文案更贴近真实
    const win = currentWindow(Date.now())
    // test：这是"预览文案"，不是真的静默了 —— 别把关键事件单独提醒也发出去
    return pushStartNotice(win && win.temp ? win : { temp: false }, useSlot, { ...opts, test: true })
  }

  /**
   * 设置页「试发一条结束提醒」用的入口。
   * 不走真实的缓冲清理（test 模式），所以随便点也不会把待汇总的事件弄丢。
   * @param {object} [opts] { onlyIds } —— 试发时限定只发这几个渠道
   */
  function pushPostSilenceNotice(opts = {}) {
    const now = Date.now()
    let win = currentWindow(now)
    if (!win) {
      // 不在窗口里就拿最近一个时段造一个，方便看清楚「结束提醒」长什么样
      const s = readSlots()[0]
      if (s) {
        const endMs = s.start < s.end ? slotBoundaryAt(now, s.end, 0) : slotBoundaryAt(now, s.end, 1)
        win = {
          key: `slot:${endMs}`,
          temp: false,
          startMs: slotBoundaryAt(now, s.start, 0),
          endMs,
          rangeLabel: `${min2hm(s.start)} ~ ${s.end < s.start ? '次日 ' : ''}${min2hm(s.end)}`,
          endLabel: min2hm(s.end),
          channels: null,
          reason: ''
        }
      }
    }
    return flushSilentSummary({ endMs: win ? win.endMs : now, window: win, test: true, onlyIds: opts.onlyIds })
  }

  /*
   * 免打扰窗口心跳（30 秒一次）。
   *
   * 一次签名比对同时管三件事：
   *   1) 刚踏进一个新窗口 → 发「免打扰已开启」提醒，并把**结束提醒排到窗口末尾**；
   *   2) 窗口已结束但定时器没跑到（休眠 / 卡顿 / 进程重启 / 到点被系统睡过去）
   *      → 在这里补发结束提醒；
   *   3) 窗口被替换（临时静默顶掉定时时段）→ 按新窗口重排，结束后不重复报「已开启」。
   *
   * 用签名比对而不是给每个时段排一堆定时器：改配置、跨零点、休眠唤醒都不会漏发。
   */
  let silentHeartbeat = null
  function tickSilentWindow(now = Date.now()) {
    /*
     * 通道静默与全局静默各自独立，先跑通道那套 —— 下面的全局逻辑有好几处 early return，
     * 把通道检查放在后面会被跳过（表现成"配了通道静默却永远不结算"）。
     */
    tickCamSilent(now)
    /*
     * 日常静默也在这里收尾。放在通道静默**之后**：它的 flush 要判断
     * "此刻有没有静默窗口生效"，先跑完通道那套，读到的窗口状态才是这一刻最终的样子。
     */
    tickCamDigest(now)
    const win = currentWindow(now)
    const prev = activeWin
    const key = win ? win.key : ''
    if (key === (prev ? prev.key : '')) return

    if (!win) {
      activeWin = null
      coveredSlotKey = ''
      /*
       * 窗口刚结束，但结束定时器还没收尾 → 兜底补一条。
       * `!silentTimer` 这个条件很关键：定时器是**故意**排在 endMs+800ms 的，
       * 心跳完全可能先一步在 endMs 整点跑到这里，那时定时器马上就会发，
       * 不拦一下就会连着发两条一模一样的结束提醒。
       */
      if (prev && prev.endMs > flushedEndMs && !silentTimer && preAllowed()) {
        flushSilentSummary({ endMs: prev.endMs, window: prev }).catch(() => {})
      }
      return
    }

    /*
     * 临时静默会「顶掉」底下的定时时段：先把那个时段签名记下来，
     * 等临时静默结束时如果它还在跑，就不再补一条「时段已开启」——
     * 它不是新窗口，只是一直在那里。
     */
    const underKey = win.temp ? slotSignature(now) : ''
    const resumed = !win.temp && ((coveredSlotKey && slotSignature(now) === coveredSlotKey) || (prev && prev.temp))
    /*
     * 上一个窗口在时间上已经走完、但还没收尾（典型：临时静默到期，正好被
     * 底下的夜间时段接管）→ 先把它的结束提醒发掉再换窗口。
     * 否则 armSilentEnd 会把它的结束定时器清掉，那段时间攒下的报警和
     * 「已结束」这条提醒就再也不会发出去了。
     */
    if (prev && prev.key !== win.key && prev.endMs <= now && prev.endMs > flushedEndMs && preAllowed()) {
      flushSilentSummary({ endMs: prev.endMs, window: prev }).catch(() => {})
    }
    coveredSlotKey = underKey
    activeWin = win
    armSilentEnd(win)
    // 从「临时静默」回到它底下那个定时时段 → 不是新窗口，不重复报「已开启」
    if (resumed) return
    // 临时静默的开始提醒由 startTempSilent / 远程指令自己发（那边带着用途备注）
    if (win.temp) return
    if (preAllowed()) pushStartNotice(win, matchSlot(now)).catch(() => {})
  }

  /**
   * 是否允许由「本进程」发免打扰提醒。
   * 后端模式下前端和后端都会跑这套推送，若两边都发提醒会重复，
   * 所以由调用方用 hooks.preSilenceEnabled 决定：
   *   - 前端传 () => !backendActive（后端接管时前端闭嘴）
   *   - 后端（notify.mjs）不传 = 默认恒为 true（它就是那个该发的人）
   */
  function preAllowed() {
    const h = hooks.preSilenceEnabled
    if (typeof h === 'function') return !!h()
    if (h === false) return false
    return true
  }

  /** 启动心跳，并把当前窗口状态对齐（启动时已经在窗口里 → 只排结束提醒，不补发「已开启」） */
  function startSilentWatcher() {
    if (silentHeartbeat) return
    const now = Date.now()
    activeWin = currentWindow(now)
    if (activeWin) {
      coveredSlotKey = activeWin.temp ? slotSignature(now) : ''
      armSilentEnd(activeWin)
    }
    silentHeartbeat = setInterval(() => tickSilentWindow(Date.now()), 30000)
  }

  /**
   * 开启临时静默（item 112）：从现在起免打扰，到期自动汇总。
   *
   * 两种指定结束方式（用户需求：既能设"N 小时"，也能选"静默到几点"）：
   *   - 传 hours（>0）：从现在起 N 小时；
   *   - 传 untilAt（时间戳，必须晚于现在）：静默到该时刻（跨零点也没问题）。
   * 两者都传时 untilAt 优先。立即重排汇总定时器，把原先排在夜里的那个换成这条窗口。
   *
   * @param {number} [hours] 时长（小时），支持小数
   * @param {string[]} [channels] 覆盖渠道，缺省沿用配置里的三端
   * @param {string} [label] 用途备注（会出现在状态文案里）
   * @param {number} [untilAt] 绝对截止时间戳（"静默到几点"用这个）
   * @returns {{ok:boolean, until?:number, reason?:string}}
   */
  function startTempSilent(hours, channels, label, untilAt) {
    /*
     * 渠道先校验，且必须在**任何写入之前** —— 下面一旦开始写 tempUntil，
     * 中途 return 就会留下"静默开着但没有渠道"的半截状态。
     *
     * 显式传空数组 = 用户把渠道勾全取消了。这里刻意**不**当成「没指定」往下回落：
     * 回落会走到下面「沿用配置里的渠道」那条分支，于是「一个都不选」
     * 反而静默掉了配置里的默认渠道 —— 比不选还糟，而且完全看不出来。
     */
    if (Array.isArray(channels) && !channels.length) {
      // 文案与指令层那道守卫对齐（两处都可能弹给用户看，别让人以为遇到了两个不同的错）
      return { ok: false, reason: '请至少选一个静默渠道 —— 一个都不选的话，静默不静默就没区别了' }
    }
    const now = Date.now()
    const maxMs = 7 * 24 * 3600000
    let until = 0
    if (Number(untilAt) > 0) {
      until = Number(untilAt)
      if (until <= now) return { ok: false, reason: '结束时间必须晚于当前时间' }
    } else {
      const h = Number(hours)
      if (!Number.isFinite(h) || h <= 0) {
        return { ok: false, reason: '请选择时长，或指定一个晚于当前时间的结束时刻' }
      }
      until = now + Math.min(h, 168) * 3600000
    }
    if (until - now > maxMs) return { ok: false, reason: '单次临时静默最长 7 天' }

    const c = silentCfg()
    c.tempUntil = until
    /*
     * 记下本次静默的**开始时刻**。两个用途：
     *   - 「静默查岗」（/check duty）要按它划第一次查询的区间；
     *   - 重复下发 /silent（延长静默）时一并重置 —— 用户说的是「从现在起再静默 2 小时」，
     *     窗口是重新开始算的，查岗也应该跟着从新起点算。
     */
    c.tempSince = now
    if (Array.isArray(channels) && channels.length) c.tempChannels = channels.slice()
    if (label) c.tempLabel = String(label).slice(0, 40)

    /*
     * 对齐窗口状态并发「临时静默已开启」提醒：
     * 结束提醒排到窗口末尾；开始提醒在这里发（而不是等心跳 30 秒后补），
     * 这样手动 / 远程 /silent 一开就能立刻收到确认。
     */
    const win = currentWindow(now)
    if (win) {
      coveredSlotKey = slotSignature(now)
      activeWin = win
      armSilentEnd(win)
      if (preAllowed()) pushStartNotice(win).catch(() => {})
    } else {
      scheduleSilentFlush()
    }

    const p2 = (n) => String(n).padStart(2, '0')
    const e = new Date(until)
    const span = until - now
    // 同上：分钟先进位到小时
    const totalMin = Math.round(span / 60000)
    const hh = Math.floor(totalMin / 60)
    const mm = totalMin % 60
    const how = hh ? `${hh} 小时 ${mm} 分后` : `${mm} 分后`
    notify(`已开启临时静默，至 ${p2(e.getHours())}:${p2(e.getMinutes())}（${how}）自动推送结束提醒 + 汇总`)
    return { ok: true, until }
  }

  /**
   * 提前结束临时静默：发一条「免打扰已结束」提醒，并把已收存的报警汇总带上。
   * flush=false 时不发消息，但同样要收尾（否则心跳 30 秒后会再补一条结束提醒）。
   */
  function endTempSilent(flush = true) {
    const c = silentCfg()
    if (!Number(c.tempUntil)) return { ok: false, reason: '当前没有临时静默' }
    const win = currentWindow(Date.now()) // 先取：清掉 tempUntil 就取不到了
    c.tempUntil = 0
    c.tempLabel = ''
    // 开始时刻一并清掉：留着会让下一次静默的下界错判（查岗会多推一段本不属于它的区间）
    c.tempSince = 0
    if (silentTimer) {
      clearTimeout(silentTimer)
      silentTimer = null
    }
    coveredSlotKey = ''
    if (flush) {
      return flushSilentSummary({ endMs: Date.now(), window: win }).then(() => ({ ok: true }))
    }
    activeWin = null
    return { ok: true }
  }

  /** 临时静默当前状态（给设置页 / 事件面板显示） */
  function tempSilentInfo(now = Date.now()) {
    const t = tempSilentState(now)
    if (!t.active) {
      return { active: false, expired: !!t.expired, endMs: t.endMs || 0 }
    }
    const p2 = (n) => String(n).padStart(2, '0')
    const e = new Date(t.endMs)
    const left = t.endMs - now
    // 同上：分钟先进位到小时，避免出现 "2 小时 60 分"
    const totalMin = Math.round(left / 60000)
    const hh = Math.floor(totalMin / 60)
    const mm = totalMin % 60
    /*
     * 跨天时补一个日期前缀（"明天 08:00" / "10-07 08:00"）——
     * 用户指定的结束时刻很可能落在第二天，只写 "08:00" 会以为已经过了。
     */
    const endDay = new Date(now)
    endDay.setHours(0, 0, 0, 0)
    const dayDiff = Math.round((new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime() - endDay.getTime()) / 86400000)
    const dayPrefix = dayDiff === 0 ? '' : dayDiff === 1 ? '明天 ' : dayDiff === 2 ? '后天 ' : `${dayDiff} 天后 `
    return {
      active: true,
      endMs: t.endMs,
      untilLabel: `${dayPrefix}${p2(e.getHours())}:${p2(e.getMinutes())}`,
      leftLabel: hh ? `${hh} 小时 ${mm} 分后` : `${mm} 分后`,
      channels: t.channels,
      reason: t.reason
    }
  }

  /**
   * 当前静默窗口信息 —— 远程「静默查岗」（/check duty）的判据。
   *
   * 和 tempSilentInfo 的分工：
   *   - tempSilentInfo 只讲临时静默、且面向设置页展示（剩余多久、截止几点）；
   *   - 这里讲的是**当前生效的那个窗口**（临时静默或夜间定时时段），
   *     带 key / startMs / endMs —— 查岗要靠 startMs 划区间、靠 key 判断「是不是同一个窗口」。
   *
   * @returns {{active:true, key:string, temp:boolean, startMs:number, endMs:number,
   *            rangeLabel:string, endLabel:string, channels:string[]|null, reason:string}
   *          | {active:false}}
   */
  function silentWindowInfo(now = Date.now()) {
    const win = currentWindow(now)
    if (!win) return { active: false }
    return { active: true, ...win }
  }

  /** 单渠道预检 */
  function checkChannel(id, record, now, ignoreQuiet = false) {
    const def = CHANNEL_DEFS.find((x) => x.id === id)
    const c = def.read()
    if (!c.enabled) return { ok: false, off: true, reason: '未启用该渠道' }
    if (!def.ready(c)) return { ok: false, off: true, reason: '凭据未配置完整' }

    /*
     * 该不该推这一路 —— 以「监控通道」页里的**通道级**配置为唯一权威：
     *   总开关 cam.push 关掉 → 三个渠道都不推
     *   这一路的某个渠道小勾关掉 → 只不推那个渠道
     *
     * ⚠️ 这里以前还有第二道闸（渠道配置里的 cameras，即渠道页的「需要监听的监控」），
     * 而且是 AND 关系。渠道配置的默认值只有第一个通道（['cam-1'] 门口），
     * 于是「监控通道」页把门口/电梯/大厅 三路的推送都打开也没用 ——
     * 电梯和大厅被那道看不见的闸静默挡掉，用户只收到门口的通知。
     * 现在渠道名单退化为通道级配置的**派生镜像**（见 defaults.syncChannelCameras），
     * 只给后端判断「哪几路掉线要提醒 / 哪几路要保活」用，不再参与放行判断。
     */
    if (record.push === false) return { ok: false, off: true, reason: '该通道已关闭推送' }
    if (record.channels && record.channels[id] === false) {
      return { ok: false, off: true, reason: `该通道已关闭「${def.name}」推送` }
    }
    /*
     * 兜底：极少数没带通道级信息的 record（老事件回放、外部直接调 handleAlarm），
     * 仍按渠道名单判断，保持与旧行为一致。
     */
    if (!record.channels && record.push === undefined) {
      if (Array.isArray(c.cameras) && c.cameras.length && !c.cameras.includes(record.id)) {
        return { ok: false, off: true, reason: '该通道未勾选' }
      }
    }
    /*
     * 人脸命中模式（通道级，见 features.camHitOn）：
     *   这一路被配成「只有命中已录入人脸（在库的人）才推送」时，其余**报警类**事件
     *   一律不推 —— 画面变动 / 人形 / 姿态 / 区域 / 计数都在收窄范围内。
     *
     * ⚠️ 只收窄报警事件（TYPE_GROUP 里有的类型），**不拦系统事件**：
     *   掉线 / 上线（offline / online）不属于"画面变动"，通道静默或命中模式下
     *   仍应把断线告诉用户，否则机器失联了却悄无声息。
     * ⚠️ 通道配置从 camerasOf() 取（前端 cameras ref / 后端 config.cameras），
     *   用 record.id 定位；找不到就不过滤，与旧行为一致。
     */
    const camCfg = (camerasOf() || []).find((x) => x && x.id === record.id)
    if (camCfg && camHitOn(camCfg) && TYPE_GROUP[record.type] && !(record.type === 'face' && record.faceName)) {
      return { ok: false, off: true, reason: '该通道仅推送「人脸命中」事件' }
    }
    const evt = normalizeEvents(c.events)
    const group = TYPE_GROUP[record.type] || record.type
    if (evt[group] === false) {
      const g = EVENT_GROUPS.find((x) => x.key === group)
      return { ok: false, off: true, reason: `未勾选「${g ? g.label : group}」` }
    }
    if (
      record.type === 'motion' &&
      Number(c.minRatioPercent) > 0 &&
      Number(record.ratio) * 100 < Number(c.minRatioPercent)
    ) {
      return { ok: false, off: true, reason: '变动幅度低于阈值' }
    }
    if (!ignoreQuiet && inQuietHours(c, now)) return { ok: false, off: true, reason: '静默时段' }

    const st = chState[id]
    const gap = Math.max(3, Number(c.minIntervalSec) || 30) * 1000
    if (now - (st.lastPushAt[record.id] || 0) < gap) return { ok: false, reason: '同通道间隔未到' }

    const globalGap = Math.max(0, Number(c.globalMinIntervalSec) || 0) * 1000
    if (now - st.lastGlobalAt < globalGap) return { ok: false, reason: '全局间隔未到' }

    prune(st, now)
    if (st.windowTs.length >= rateLimit(c, id)) {
      return { ok: false, reason: `已达每分钟 ${rateLimit(c, id)} 条上限`, overflow: true }
    }
    return { ok: true }
  }

  /* ------------------------------------------------------------------ */
  /* 各渠道的实际发送                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * 「看原图」的入口分两条路，各管各的：
   *
   * 1) Telegram 消息链接 —— 由 resolveTgLink 提供，**默认一定带上**：
   *      优先本次 TG 推送的那条消息（t.me/<群>/<消息id>）；
   *      本次没推 TG 时退回群链接（t.me/<群>），至少能点进去翻。
   *    （不用 api.telegram.org 的图片直链：国内加载不出来，只会是一张破图。）
   *
   * 2) 额外的公网图片直链 —— 由下面的 resolveShotUrl 提供，只在
   *    screenshotMode 选 litterbox / upload 时才会上传，拿到后钉钉能直接嵌图。
   */

  /**
   * 本条报警在 Telegram 里看原图的链接。
   * @param {object} tgCfg telegram 配置块
   * @param {object} ctx   本次推送上下文（tgMessageUrl 来自 pushTelegram）
   */
  function resolveTgLink(tgCfg, ctx) {
    if (ctx && ctx.tgMessageUrl) return ctx.tgMessageUrl
    // 本次没推 TG / 没拿到消息 id：退回群链接，保证消息里有入口
    return telegramGroupLink(tgCfg)
  }

  /**
   * 上传截图拿图片直链（仅 litterbox / upload 两种模式）。
   * 返回 { url, kind, warn }：kind='image' 表示钉钉 markdown 可以 ![]() 嵌图。
   * 失败不抛错，只把原因带回去写进事件备注，保证文字消息照发。
   */
  async function resolveShotUrl(cfg, shot) {
    const mode = cfg.screenshotMode || 'none'
    if (mode !== 'litterbox' && mode !== 'upload') return { url: '', kind: '', warn: '' }
    if (!shot) return { url: '', kind: '', warn: '本条事件没有留存截图' }
    if (mode === 'litterbox') {
      try {
        return { url: await uploadToLitterbox(shot, { time: cfg.imageHostTtl }), kind: 'image', warn: '' }
      } catch (e) {
        return { url: '', kind: '', warn: `图床上传失败：${(e && e.message) || '未知错误'}` }
      }
    }
    if (!cfg.uploadUrl) return { url: '', kind: '', warn: '未配置截图上传接口地址' }
    try {
      return { url: await uploadScreenshot(shot, cfg), kind: 'image', warn: '' }
    } catch (e) {
      return { url: '', kind: '', warn: `上传失败：${(e && e.message) || '未知错误'}` }
    }
  }

  async function pushDingTalk(records, merged, ctx = {}) {
    const c = readCfg('ding')
    const rec = records[0]
    const shot = merged
      ? { url: '', kind: '', warn: '' }
      : await resolveShotUrl(c, rec.shot || rec.thumb || '')
    // 原图链接「必须带上」：只有明确选了「不带」才省掉，其余模式一律附 TG 入口。
    // 图片直链走第 3 参（markdown ![]() 嵌图），TG 链接走第 4 参（放成「点击查看」）
    const link = (c.screenshotMode || 'none') === 'none' ? '' : resolveTgLink(readCfg('tg'), ctx)
    const msg = merged
      ? buildMergedMessage(records, c)
      : buildAlarmMessage(rec, c, shot.kind === 'image' ? shot.url : '', link, quotaNote('ding'))
    // 钉钉 @指定人：必须把 @手机号 字面写进正文，机器人才能真正通知到人（与关键事件推送同一套逻辑）
    const atMobiles = parseMobiles(c.atMobiles)
    let body = msg
    if (atMobiles.length) {
      const tokens = atMobiles.map((m) => `@${m}`).join(' ')
      body = { ...msg, text: `${msg.text || ''}\n${tokens}` }
    }
    await sendDingTalk(
      { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy },
      { ...body, msgType: c.msgType, atAll: c.atAll, atMobiles }
    )
    return { shotUrl: shot.url, warn: shot.warn }
  }

  /** 企业微信的 markdown 不支持 ![]() 图片语法，把截图那一行换成可点击链接 */
  function wecomShotLink(text, url) {
    return String(text || '')
      .split('\n')
      .filter((l) => !/!\[[^\]]*\]\(/.test(l))
      .map((l) => {
        if (!url || !/事件截图/.test(l)) return l
        // 已经是「文字 + 链接」形式的行不再重复处理
        if (/\[[^\]]+\]\([^)]+\)/.test(l)) return l
        return l.replace(/：.*$/, `：[点击查看截图](${url})`)
      })
      .join('\n')
  }

  async function pushWeCom(records, merged, ctx = {}) {
    const c = readCfg('wecom')
    if (merged) {
      const msg = buildMergedMessage(records, c)
      await sendWeCom(c, { msgType: c.msgType, content: msg.text, atAll: c.atAll, atMobiles: c.atMobiles })
      return {}
    }
    const rec = records[0]
    const shot = rec.shot || rec.thumb || ''
    // 直接发图片（base64）和「放链接」二选一，避免同一张图发两遍
    const inlineImage = c.screenshotMode === 'image'
    const linkShot = inlineImage ? { url: '', kind: '', warn: '' } : await resolveShotUrl(c, shot)
    // 和钉钉一致：原图入口默认带上（精确消息链接，拿不到就退群链接）
    const link = (c.screenshotMode || 'none') === 'none' ? '' : resolveTgLink(readCfg('tg'), ctx)
    const msg = buildAlarmMessage(rec, c, '', link, quotaNote('wecom'))
    const content = wecomShotLink(msg.text, linkShot.url)
    const { shotError } = await sendWeComAlarm(c, { content, shot: inlineImage ? shot : '' })
    return {
      shotUrl: linkShot.url,
      warn: shotError ? `文字已送达，但截图没发出去（${shotError}）` : linkShot.warn
    }
  }

  async function pushTelegram(records, merged, ctx = {}) {
    const t = readCfg('tg')
    const c = readCfg('ding')
    if (merged) {
      await sendTelegramText(t, buildTelegramMergedText(records, c))
      return {}
    }
    const rec = records[0]
    const image = rec.shot || rec.thumb || ''
    const { message } = await sendTelegramAlarm(t, {
      image: t.withPhoto ? image : '',
      // ⚠️ 标题前缀沿用钉钉配置（c）保持多端一致，但模板用 TG 自己的（t.template）
      caption: buildTelegramCaption(rec, c, t.template),
      mode: t.sendMode
    })

    if (t.alsoSendOriginal && t.withPhoto && rec.shot && t.sendMode === 'photo') {
      await sendTelegramAlarm(t, { image: rec.shot, caption: '', mode: 'document' })
    }
    // 钉钉 / 企业微信复用的是「这条消息的链接」，不是图片直链
    // （api.telegram.org 的直链国内打不开，放进去只会是破图；详见 resolveShotUrl）
    return { messageUrl: telegramMessageLink(t, message && message.message_id) }
  }

  const SENDER = { ding: pushDingTalk, wecom: pushWeCom, tg: pushTelegram }

  /** 汇总各渠道结果，写回事件状态 */
  function settle(records, merged, results) {
    const okNames = results.filter((r) => r.ok).map((r) => r.name)
    const fails = results.filter((r) => !r.ok)
    // 送达了、但附带信息没成功的（例如企微文字发出去了、截图没发出去）
    const warns = results.filter((r) => r.ok && r.warn).map((r) => `${r.name}：${r.warn}`)
    /*
     * pushResults 逐渠道记录最终成败（成功 / 失败+原因）。
     * pushChannels 只表示「本次调用过哪些渠道」，两者分开：
     * 前者回答"发了没有"，后者回答"发成了吗"。用户在详情里要能同时看到。
     */
    const detail = {}
    results.forEach((r) => {
      detail[r.name] = r.ok ? 'ok' : `fail:${r.reason || '未知错误'}`
    })
    if (okNames.length) {
      const note = [fails.map((f) => `${f.name}：${f.reason}`).join('；'), warns.join('；')]
        .filter(Boolean)
        .join('；')
      records.forEach((r) =>
        onState(r.key, merged ? 'merged' : 'ok', note, okNames.join(' + '), detail)
      )
      return
    }
    const reason = fails.map((f) => `${f.name}：${f.reason}`).join('；') || '未知错误'
    records.forEach((r) => onState(r.key, 'fail', reason, '', detail))
    notify(`推送失败：${reason}`)
  }

  /** 跑单个渠道，统一把异常转成 {ok:false}，并带上渠道返回的附加信息 */
  async function runSender(id, records, merged, ctx) {
    const name = CHANNEL_DEFS.find((d) => d.id === id).name
    try {
      const out = await SENDER[id](records, merged, ctx)
      // 累计推送统计（「关于系统」页要按渠道分开看）
      recordPush(id, true)
      return { id, name, ok: true, ...(out || {}) }
    } catch (e) {
      const reason = (e && e.message) || '未知错误'
      recordPush(id, false, reason)
      return { id, name, ok: false, reason }
    }
  }

  /**
   * 一条推送最多等多久：截图上传 / 图床可能长时间不返回，
   * 没有上限的话事件会永远停在「正在推送」。
   */
  const PUSH_TIMEOUT_MS = 60000

  /** 发送到指定的一组渠道 */
  async function deliver(records, merged, ids) {
    const now = Date.now()
    ids.forEach((id) => {
      const st = chState[id]
      records.forEach((r) => (st.lastPushAt[r.id] = now))
      st.lastGlobalAt = now
      st.windowTs.push(now)
    })

    /*
     * ⚠️ 立刻把「本次要发往哪些渠道」写回去，而不是等所有回调落定。
     * 详情页要靠 pushChannels 显示每个渠道的状态，而推送要等截图上传 +
     * 图床 + 各家接口返回，最长可达 PUSH_TIMEOUT_MS（60s）。
     * 以前这段时间里 pushChannels 是空的，界面就退化成「本次推送未包含该渠道」——
     * 明明三端都收到了，却显示得像没发。用户明确要求：调用了就显示已推送。
     * 这里的 'sent' 只是「已发出」，等 settle 落定后会被 ok / fail 覆盖成最终结果。
     */
    const attemptedNames = ids.map((id) => CHANNEL_DEFS.find((d) => d.id === id).name).join(' + ')
    records.forEach((r) => onState(r.key, 'sending', '', attemptedNames))

    // ⚠️ 顺序很关键：钉钉 / 企业微信要复用 Telegram 那条消息的链接，
    // 所以 Telegram 必须先发完，把 messageUrl 放进 ctx 再发其余渠道。
    // （都并行的话，钉钉拿不到消息 id，就只能带个「没拿到链接」的提示。）
    const ctx = { tgMessageUrl: '' }

    const runAll = async () => {
      const results = []
      if (ids.includes('tg')) {
        const r = await runSender('tg', records, merged, ctx)
        results.push(r)
        if (r.ok) ctx.tgMessageUrl = r.messageUrl || ''
      }
      const rest = ids.filter((id) => id !== 'tg')
      if (rest.length) {
        const others = await Promise.all(rest.map((id) => runSender(id, records, merged, ctx)))
        results.push(...others)
      }
      return results
    }

    // 兜底：渠道请求可能一直挂着（网络黑洞 / 图床无响应），
    // 设上限保证状态一定能落定，不会卡在「正在推送」。
    let timer = null
    const results = await Promise.race([
      runAll(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), PUSH_TIMEOUT_MS)
      })
    ])
    if (timer) clearTimeout(timer)

    if (!results) {
      const names = ids.map((id) => CHANNEL_DEFS.find((d) => d.id === id).name).join(' + ')
      const reason = `${names}：推送超时（${PUSH_TIMEOUT_MS / 1000}s 内未返回，通常是网络不通或图床无响应）`
      // 超时也逐渠道标注，这样界面能显示「已推送 · 结果未知」而不是"未包含该渠道"
      const detail = {}
      ids.forEach((id) => {
        detail[CHANNEL_DEFS.find((d) => d.id === id).name] = 'timeout'
      })
      records.forEach((r) => onState(r.key, 'fail', reason, names, detail))
      notify(`推送超时：${reason}`)
      return
    }

    settle(records, merged, results)

    /*
     * 人脸特写补推：主消息（含整帧原图）已经发出去了，这里再单独发一张放大的人脸。
     * 放在 settle 之后，是为了不污染主消息的推送状态；失败也不影响主消息。
     * 合并消息没有单条 record，跳过。
     */
    if (!merged) {
      const rec = records[0]
      if (rec && rec.faceThumb) {
        try {
          await pushFaceShot(rec, ids, ctx)
        } catch (e) {
          /* 特写只是加分项，静默失败 */
        }
      }
    }
  }

  function scheduleFlush(id) {
    if (flushTimers[id]) return
    const st = chState[id]
    prune(st, Date.now())
    const wait = st.windowTs.length ? Math.max(500, st.windowTs[0] + WINDOW_MS - Date.now() + 60) : 1000
    flushTimers[id] = setTimeout(() => {
      flushTimers[id] = null
      flushPending(id)
    }, wait)
  }

  async function flushPending(id) {
    const st = chState[id]
    if (!st.pending.length) return
    const now = Date.now()
    prune(st, now)
    if (st.windowTs.length >= rateLimit(readCfg(id), id)) {
      scheduleFlush(id)
      return
    }
    const batch = st.pending.splice(0, st.pending.length)
    pendingCount.value = Object.values(chState).reduce((n, s) => n + s.pending.length, 0)
    await deliver(batch, true, [id])
    if (st.pending.length) scheduleFlush(id)
  }

  /**
   * 紧急刹车：清空所有渠道的待发队列、合并定时器和限流窗口。
   *
   * 用于「恢复初始化 / 强制终结 App」这类必须立刻安静下来的时刻。
   * ⚠️ 光把配置清掉是**不够**的：已经排进 pending 的报警会在下一个
   * flush 定时器到点时照样发出去（deliver 阶段不再回头查配置），
   * 所以队列和定时器必须一起拆掉，否则"初始化之后还在收推送"。
   */
  function stopAll() {
    CHANNEL_DEFS.forEach((d) => {
      const st = chState[d.id]
      if (!st) return
      st.pending = []
      st.windowTs = []
      st.lastPushAt = {}
      st.lastGlobalAt = 0
      if (flushTimers[d.id]) {
        clearTimeout(flushTimers[d.id])
        flushTimers[d.id] = null
      }
    })
    // 静默缓冲与定时汇总一并拆掉，避免「恢复初始化」之后还在静默结束时刻发旧汇总
    if (silentTimer) {
      clearTimeout(silentTimer)
      silentTimer = null
    }
    armedEndMs = 0
    // 免打扰提醒心跳同理：配置被洗掉后不该再按旧时段发提醒
    if (silentHeartbeat) {
      clearInterval(silentHeartbeat)
      silentHeartbeat = null
    }
    activeWin = null
    coveredSlotKey = ''
    flushedEndMs = 0
    silentBuffer.length = 0
    silentSeen.clear()
    // 通道静默同理：缓冲、去重、定时器、窗口一并拆掉（"立刻安静下来"必须包含它）
    camStore.forEach((st) => {
      if (st.timer) clearTimeout(st.timer)
    })
    camStore.clear()
    // 日常事件静默同理：不清的话定时器到点照样把旧汇总发出去
    digestStore.forEach((st) => {
      if (st.timer) clearTimeout(st.timer)
    })
    digestStore.clear()
    pendingCount.value = 0
  }

  /** 入口：处理一条报警事件 */
  async function handleAlarm(record) {
    const now = Date.now()
    const decisions = CHANNEL_DEFS.map((d) => ({ id: d.id, ...checkChannel(d.id, record, now) }))
    let send = decisions.filter((d) => d.ok).map((d) => d.id)
    let queue = decisions.filter((d) => d.overflow && readCfg(d.id).overflowMode === 'merge')

    /*
     * 静默收存。两个来源**取并集**：
     *   · 全局静默（options.silent）—— 覆盖全通道，被选中的渠道在时段内不实时推；
     *   · 通道静默（cam.silent）—— 只覆盖这一路，对指定的那几个渠道不实时推。
     * 判定「该渠道本应收到」时忽略渠道级 quiet，避免和这里的收存打架
     * （全局 / 通道静默的优先级都更高）。临时静默（全局的与通道的）走同一套判断，
     * 只是渠道集合换成各自的 tempChannels。
     */
    const sState = silentState(now)
    const quietChans = sState.temp ? sState.channels || [] : (silentCfg().channels || [])
    const camS = recordCamSilent(record, now)

    /*
     * 这条事件「本来能推」的渠道。ignoreQuiet=true 已经排除了"这一路自己关了某渠道"
     * "变动幅度低于阈值"等本就不推的情况 —— 用它区分"被静默"和"本来就不推"，
     * 免得把后者也算进收存，汇总里冒出一堆根本没打算推的事件。
     */
    const liveOk = CHANNEL_DEFS.filter((d) => checkChannel(d.id, record, now, true).ok).map((d) => d.id)
    const byGlobal =
      sState.active && quietChans.length ? liveOk.filter((id) => quietChans.includes(id)) : []
    const byCam =
      camS.active && camS.channels.length ? liveOk.filter((id) => camS.channels.includes(id)) : []

    /*
     * suppressIds 是**集合语义**（只用来把渠道从 send / queue 里剔掉），
     * 所以两个来源重叠也不会"算两次"，这里不需要去重。
     * ⚠️ 「这条事件归哪个汇总」**不由这个并集决定**，由下面那个 if 决定
     * （byGlobal 非空就整条进整体汇总）。别把归属逻辑塞进这里 ——
     * 曾经写过 `byCam` 里排除 byGlobal 的写法，那是彻底的死代码：
     * 它只影响这个集合，看起来却像在实现"汇总归整体"，很能误导人。
     */
    const suppressIds = [...byGlobal, ...byCam]
    let buffered = false
    if (suppressIds.length) {
      send = send.filter((id) => !suppressIds.includes(id))
      queue = queue.filter((id) => !suppressIds.includes(id))
      /*
       * 归属「汇总归整体」：只要这条事件**有渠道被整体静默覆盖**，就整条进整体汇总，
       * 通道汇总里不再出现它（否则同一条会在两个汇总里各出现一次）。
       * 两个汇总的归属判据就这一处，别改成两个缓冲都写。
       */
      if (byGlobal.length) {
        if (!silentSeen.has(record.key)) {
          silentSeen.add(record.key)
          silentBuffer.push(silentSnapshot(record))
        }
        scheduleSilentFlush()
      } else {
        // 只被通道静默 → 进这一路自己的汇总
        const st = camSlot(record.id)
        if (!st.seen.has(record.key)) {
          st.seen.add(record.key)
          st.buf.push(silentSnapshot(record))
        }
        scheduleCamFlush(record.id, now)
      }
      buffered = true
    }

    // 完全被静默收存（没有任何渠道在本条事件上实时发送 / 排队）→ 标记「静默待推送」
    if (buffered && !send.length && !queue.length) {
      const isGlobal = byGlobal.length > 0
      const label = isGlobal ? sState.rangeLabel : camS.rangeLabel
      const endLabel = isGlobal ? sState.endLabel : camS.endLabel
      const scope = isGlobal ? '静默时段' : `通道静默（${record.name || record.id}）`
      onState(record.key, 'silent', `${scope}（${label}）已收存，将于 ${endLabel} 推送结束汇总`)
    }

    /*
     * 日常事件静默（cam.digest）：把「本来就能实时推、又不是关键事件」的那部分
     * 从 send / queue 里摘出来，攒进本路的下一条日常汇总。
     *
     * ⚠️ 与上面的静默收存是**互斥**的：camDigestState 在有静默窗口时就是 inactive，
     *    所以一条事件不可能既进静默汇总又进日常汇总（这是刻意的，别在这里
     *    "顺手"放宽成两者都收）。
     */
    let digested = false
    if (send.length || queue.length) {
      const dCam = camById(record.id)
      const dState = dCam ? digestStateOf(dCam, now) : { active: false }
      if (dState.active && !isFaceHit(record)) {
        const hitSend = send.filter((id) => dState.channels.includes(id))
        const hitQueue = queue.filter((id) => dState.channels.includes(id))
        if (hitSend.length || hitQueue.length) {
          const dchans = dState.channels
          send = send.filter((id) => !dchans.includes(id))
          queue = queue.filter((id) => !dchans.includes(id))
          const st = digestSlot(record.id)
          if (!st.seen.has(record.key)) {
            st.seen.add(record.key)
            st.buf.push(silentSnapshot(record))
            // 间隔从**这一批的第一条**算起：空等一整天之后不该立刻补一条空汇总
            if (!st.since) st.since = now
          }
          armCamDigest(record.id, now)
          digested = true
          if (!send.length && !queue.length) {
            onState(
              record.key,
              'silent',
              `日常事件静默（每 ${digestIntervalLabel(dState.intervalMinutes)} 汇总一次）已收存，` +
                `将于 ${hhmm(st.since + dState.intervalMs)} 一并推送`
            )
          }
        }
      }
    }

    /*
     * 关键事件单独提醒（人脸命中）。
     *
     * ⚠️ 刻意**不依赖是否被静默收存**：静默的本意就是"别打扰"，而这条存在的理由
     * 恰恰是"静默了也想第一时间知道库内的人来了"。若跟着静默一起收存，它就和普通
     * 报警没区别了、功能等于不存在。
     * 「静默时段到底推不推」交给三端各自的 critical.throughSilence（缺省即开）——
     * 默认仍是"静默也推"，与升级前一致；把它关掉就不再推（见 criticalSilentBlocked）。
     * 只在**命中在库人脸**（有 faceName）时发 —— 陌生人脸不在此列，
     * 否则门口路过一个人就打一条私聊，比不静默还吵。
     */
    if (record.type === 'face' && record.faceName) {
      /*
       * 带**事件原图**（事发那一帧），不是人脸特写。
       *
       * 私聊提醒要回答的是"现场刚才怎么回事"，一张 96×96 的脸说明不了周边情况；
       * 放大的脸由 pushFaceShot 另外单独补一条（那条才是"特写"语义）。
       * 取值顺序与日常推送一致（rec.shot || rec.thumb）—— 两者都是**整帧原图**的
       * dataURL：前端 shot = grabArchiveShot(canvas) 全分辨率、thumb = 360 宽缩略；
       * 后端 notify.makeRecord 收到的是 img.shot = 整帧 dataURL。
       *
       * ⚠️ 别再退回 `record.faceThumb`：那是人脸特写，不是事件原图。
       *    也别只写 `record.thumb`：后端 handleEvent 会把 record.thumb 覆盖成
       *    **落库用的相对路径**，推送侧拿它当图会变成 0 字节空图、静默发不出去。
       *    三端（TG / 钉钉 / 企微）都吃这里的 payload.image，所以改这一处即三端一致。
       */
      const shot = record.shot || record.thumb || ''
      const who = `${record.faceName}（相似度 ${Math.round((Number(record.faceScore) || 0) * 100)}%）`
      pushDirectToUsers(
        'face',
        {
          image: shot,
          caption: [
            `🙂 <b>人脸命中 · ${tgEsc(record.name || '')}</b>`,
            `认出：<b>${tgEsc(who)}</b>`,
            `时间：${tgEsc(formatTime(record.time))}`
          ].join('\n'),
          text: `人脸命中 · ${record.name || ''} / ${who} / ${formatTime(record.time)}`
        },
        // 带上通道 id：这一路自己的通道静默也要算进「此刻是不是静默时段」
        { camId: record.id }
      ).catch(() => {})
    }

    if (send.length) await deliver([record], false, send)

    if (queue.length) {
      queue.forEach((d) => {
        const st = chState[d.id]
        st.pending.push(record)
        pendingCount.value = Object.values(chState).reduce((n, s) => n + s.pending.length, 0)
        onState(record.key, 'queued', `${d.reason}，${CHANNEL_DEFS.find((x) => x.id === d.id).name}已排队合并推送`)
        scheduleFlush(d.id)
      })
      return
    }

    if (!send.length && !buffered && !digested) {
      const reasons = decisions
        .filter((d) => !d.ok && !d.off)
        .map((d) => `${CHANNEL_DEFS.find((x) => x.id === d.id).name}：${d.reason}`)
      const offs = decisions.filter((d) => d.off)
      if (reasons.length) onState(record.key, 'off', reasons.join('；'))
      else if (offs.length === decisions.length) onState(record.key, 'off', '三个渠道都没有推送该通道（未启用 / 凭据不全 / 该通道未勾选）')
    }
  }

  /**
   * 直接发送一条自定义消息（状态异常通知 / 定时巡检）。
   * 只发给「已启用 + 凭据齐全 + 该渠道勾选了接收此类通知」的渠道，各渠道失败互不影响。
   * @param {'status'|'patrol'|'test'} kind 通知类型，决定按哪个开关过滤渠道
   * @param {string} text 钉钉 / 企业微信用的 markdown
   * @param {string} html Telegram 用的 HTML（不传则用纯文本）
   */
  async function sendDirect({ title, text, html, atAll = false, kind = 'status', key, onState: cb, onlyIds }) {
    /*
     * 渠道集先由 restrictIds 收口 —— 它同时负责「限定渠道」与
     * 「限定到空的就退回全部已配置」这两件事，避免这里再各判一遍、两处走偏。
     */
    const allow = restrictIds(onlyIds)
    const ids = CHANNEL_DEFS.filter((d) => {
      if (!allow.includes(d.id)) return false
      const c = d.read()
      // 巡检 / 状态异常在各渠道里可以单独关掉
      if (kind === 'patrol') return !(c.patrol && c.patrol.enabled === false)
      if (kind === 'status') return !(c.statusAlerts && c.statusAlerts.enabled === false)
      // 'silent'：免打扰开始/结束提醒。发给**所有已配置的渠道**（三端），
      // 刻意不看 silent.channels —— 那是「静默期间暂停实时推送的渠道」，
      // 跟「提醒发去哪」不是一回事（只对钉钉静默，也该在企微/TG 上看到提醒）。
      // 试发的限定走上面的 onlyIds，不在这里改口径。
      if (kind === 'silent') return true
      return true
    }).map((d) => d.id)
    if (!ids.length) return { ok: false, reason: '没有渠道接收这类通知' }

    const mark = (ok) => {
      const now = Date.now()
      ids.forEach((id) => {
        const st = chState[id]
        st.windowTs.push(now)
        st.lastGlobalAt = now
      })
      return ok
    }
    const now = Date.now()
    let full = true
    ids.forEach((id) => {
      const st = chState[id]
      prune(st, now)
      if (st.windowTs.length >= rateLimit(readCfg(id), id)) full = false
    })
    if (!full) return { ok: false, reason: '已达每分钟推送条数上限' }
    mark(true)

    if (key && cb) cb(key, 'sending')

    const results = await Promise.all(
      ids.map(async (id) => {
        const name = CHANNEL_DEFS.find((d) => d.id === id).name
        try {
          if (id === 'ding') {
            const c = readCfg('ding')
            const atMobiles = atAll ? [] : parseMobiles(c.atMobiles)
            // 钉钉 @指定人：必须把 @手机号 字面写进正文，机器人才能真正通知到人
            let dingText = text
            if (atMobiles.length) dingText = `${text || ''}\n${atMobiles.map((m) => `@${m}`).join(' ')}`
            await sendDingTalk(
              { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy },
              { title, text: dingText, msgType: c.msgType, atAll, atMobiles }
            )
          } else if (id === 'wecom') {
            const c = readCfg('wecom')
            await sendWeCom(c, { msgType: c.msgType, content: text, atAll, atMobiles: c.atMobiles })
          } else {
            await sendTelegramText(readCfg('tg'), html || plainFromMarkdown(text || title || ''))
          }
          recordPush(id, true)
          return { name, ok: true }
        } catch (e) {
          const reason = (e && e.message) || '未知错误'
          recordPush(id, false, reason)
          return { name, ok: false, reason }
        }
      })
    )

    const okNames = results.filter((r) => r.ok).map((r) => r.name)
    const reason = results.filter((r) => !r.ok).map((f) => `${f.name}：${f.reason}`).join('；')
    if (okNames.length) {
      if (key && cb) cb(key, 'ok', reason, okNames.join(' + '))
      return { ok: true, reason: reason ? `部分渠道失败：${reason}` : '' }
    }
    if (key && cb) cb(key, 'fail', reason)
    return { ok: false, reason }
  }

  /* ------------------------------------------------------------------ */
  /* 关键事件「单独提醒」：由机器人私聊推给指定用户                         */
  /* ------------------------------------------------------------------ */

  /**
   * 关键事件的接收人 / 事件开关都走 useTelegram 里的**纯函数**（同一份定义）。
   * 设置页显示"将推送给 N 人"用的也是那两个函数 —— 否则界面说 3 人、
   * 实际发 2 条这种事迟早发生。
   */

  /**
   * 把一条关键事件私聊推给「单独提醒」的接收人。
   *
   * 刻意**逐个串行**：Telegram 对同一 Bot 的连发有限流，接收人一多，
   * 并发轰过去一旦被 429 拒掉，后面的就全丢；慢一点但一条不落更划算。
   * 单个接收人失败不影响其他人，最后把失败原因汇总进 notify。
   *
   * @param {'silence'|'summary'|'face'} kind 事件类别（决定要不要发）
   * @param {object} payload { title, text, html, image, caption }
   *        image 存在时发图片（caption 优先于 html/text）；否则发纯文本。
   */
  /**
   * 把 Telegram HTML（<b>/<i>/<code>/<a>）转成钉钉 / 企业微信能吃的 markdown。
   * 关键事件推送复用主渠道同一条正文（payload.html 是 TG HTML），
   * 必须先做一次格式转换，否则钉钉 / 企微里会残留一堆 <> 标签。
   */
  function tgHtmlToMd(html) {
    return String(html || '')
      .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
      .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
      .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
      .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
      .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  }

  /**
   * 关键事件此刻是否被「静默时段」挡下 —— **全项目唯一判定**。
   *
   * 静默时段 = 全局免打扰（options.silent）∨ 该事件所属通道的通道静默（cam.silent）。
   * 给 camId 才把后一项算上：绝大多数的关键事件（静默提醒 / 汇总 / 满库）没有
   * "某一路通道"可言，那时只有全局窗口算数。
   *
   * 判定与"挡不挡"是两件事：这里只说"此刻在不在静默时段"，
   * 真正挡不挡由三端各自的 `throughSilence`（缺省即开）决定 ——
   * 缺省为开是为了与老版本行为一致（关键事件一直是硬编码放行的）。
   */
  function criticalSilentBlocked(opts = {}) {
    const now = Date.now()
    if (silentState(now).active) return true
    if (!opts.camId) return false
    const cam = camById(opts.camId)
    return !!(cam && camSilentState(cam, now).active)
  }

  /**
   * 关键事件单独提醒 —— 入口。
   *
   * 现在 fan-out 到**三路独立通道**，各自用自己独立的凭据 / 开关 / 事件筛选，
   * 互不拖累（一路没配好不影响另一路）：
   *   1. Telegram 私聊（原有，指向 directPush 里的接收人）
   *   2. 钉钉「关键事件独立机器人」（dingtalk.critical 里的独立 webhook + 加签）
   *   3. 企业微信「关键事件独立机器人」（wecom.critical 里的独立 webhook）
   *
   * 三路都判定 `enabled` + `events[kind]`，且只认自己的凭据；
   * 日常推送（dingtalk/wecom 顶层）是否开启、TG 是否配置，都不影响这两路关键事件推送。
   *
   * @param {object} [opts] { camId } 该事件所属通道（有就把它自己的通道静默也算进静默判定）
   */
  async function pushDirectToUsers(kind, payload = {}, opts = {}) {
    // 「此刻在不在静默时段」只算一次，三端共用 —— 各端自己再算一遍迟早会漂
    const silentBlocked = criticalSilentBlocked(opts)
    const parts = await Promise.all([
      pushDirectTg(kind, payload, silentBlocked),
      pushCriticalDing(kind, payload, silentBlocked),
      pushCriticalWecom(kind, payload, silentBlocked)
    ])
    const reasons = parts.map((p) => p.reason).filter(Boolean)
    const sent = parts.reduce((a, p) => a + (p.sent || 0), 0)
    if (reasons.length) notify(`关键事件单独提醒部分失败：${reasons.join('；')}`)
    return { ok: sent > 0, sent, parts }
  }

  /** 关键事件单独提醒 —— Telegram 私聊（原有逻辑，拆出来便于和另外两路并列） */
  async function pushDirectTg(kind, payload = {}, silentBlocked = false) {
    let tg
    try {
      tg = readCfg('tg')
    } catch (e) {
      return { ok: false, sent: 0, reason: '' }
    }
    if (!directPushEventOn(tg, kind)) return { ok: false, sent: 0, reason: '' }
    const dp = tg.directPush || {}
    // 静默时段也允许推送：缺省即开（老配置没有这个字段 → 与升级前一致）
    if (silentBlocked && dp.throughSilence === false) return { ok: false, sent: 0, reason: '' }
    if (!isReady('tg')) return { ok: false, sent: 0, reason: '' }
    const to = directPushRecipients(tg)
    if (!to.length) return { ok: false, sent: 0, reason: '' }

    // 文本消息上限 4096，留出转义与余量；图片说明上限 1024
    const body = String(payload.html || plainFromMarkdown(payload.text || payload.title || '')).slice(0, 3500)
    const caption = String(payload.caption || body).slice(0, 1024)
    let sent = 0
    const fails = []
    for (const chatId of to) {
      const cfg = { ...tg, chatId }
      try {
        if (payload.image) await sendTelegramAlarm(cfg, { image: payload.image, caption, mode: tg.sendMode })
        else await sendTelegramText(cfg, body)
        sent += 1
      } catch (e) {
        /*
         * 刻意**不计入推送统计**（usePushStats）：这条消息是同一事件的
         * 补充副本，主渠道那边已经计过一次；再计一遍会让"累计推送/成功率"
         * 随着接收人数量膨胀，那个数字就不再代表报警量了。
         */
        fails.push(`${chatId}：${(e && e.message) || '未知错误'}`)
      }
    }
    return { ok: sent > 0, sent, reason: fails.join('；') }
  }

  /**
   * 钉钉「关键事件独立机器人」推送。
   * 用 dingtalk.critical 里的独立 webhook + 加签密钥，与日常推送完全分离。
   * 不依赖日常推送 / TG 是否配置，只认自己的开关与凭据。
   */
  async function pushCriticalDing(kind, payload = {}, silentBlocked = false) {
    let dt
    try {
      dt = readCfg('ding')
    } catch (e) {
      return { ok: false, sent: 0, reason: '' }
    }
    const crit = (dt && dt.critical) || null
    if (!crit || crit.enabled !== true) return { ok: false, sent: 0, reason: '' }
    if (crit.events && crit.events[kind] === false) return { ok: false, sent: 0, reason: '' }
    // 静默时段也允许推送：缺省即开（老配置没有这个字段 → 与升级前一致）
    if (silentBlocked && crit.throughSilence === false) return { ok: false, sent: 0, reason: '' }
    const webhook = String(crit.webhook || '').trim()
    if (!webhook) return { ok: false, sent: 0, reason: '' }

    const atMobiles = parseMobiles(crit.atMobiles)
    const atAll = !!crit.atAll
    const md = payload.html ? tgHtmlToMd(payload.html) : String(payload.text || payload.title || '')
    let text = md
    // 钉钉 @手机号：必须把这串 @139... 字面写进正文，机器人才能真正通知到人
    if (atMobiles.length) {
      const tokens = atMobiles.map((m) => `@${m}`).join(' ')
      if (!text.includes(tokens)) text = `${text}\n${tokens}`
    }
    // 截图（face 等关键事件带图时）：litterbox / upload 模式上传后嵌进正文
    if (payload.image && (crit.screenshotMode === 'litterbox' || crit.screenshotMode === 'upload')) {
      const shot = await resolveShotUrl(
        {
          screenshotMode: crit.screenshotMode,
          imageHostTtl: dt.imageHostTtl,
          uploadUrl: dt.uploadUrl,
          uploadField: dt.uploadField,
          uploadExtra: dt.uploadExtra
        },
        payload.image
      )
      if (shot.kind === 'image' && shot.url) text = `${text}\n![事件截图](${shot.url})`
    }

    const cfg = {
      webhook,
      secret: String(crit.secret || ''),
      useProxy: crit.useProxy !== false,
      proxyBase: crit.proxyBase || ''
    }
    try {
      await sendDingTalk(cfg, {
        title: crit.titlePrefix || '【监控报警】',
        text,
        msgType: crit.msgType || 'markdown',
        atAll,
        atMobiles
      })
      return { ok: true, sent: 1, reason: '' }
    } catch (e) {
      return { ok: false, sent: 0, reason: `钉钉关键事件：${(e && e.message) || '未知错误'}` }
    }
  }

  /**
   * 企业微信「关键事件独立机器人」推送。
   * 用 wecom.critical 里的独立 webhook，与日常推送完全分离。
   * ⚠️ 企微 markdown 不支持 @ 人：需要 @ 时（atAll / atMobiles）自动改用 text 消息。
   */
  async function pushCriticalWecom(kind, payload = {}, silentBlocked = false) {
    let wc
    try {
      wc = readCfg('wecom')
    } catch (e) {
      return { ok: false, sent: 0, reason: '' }
    }
    const crit = (wc && wc.critical) || null
    if (!crit || crit.enabled !== true) return { ok: false, sent: 0, reason: '' }
    if (crit.events && crit.events[kind] === false) return { ok: false, sent: 0, reason: '' }
    // 静默时段也允许推送：缺省即开（老配置没有这个字段 → 与升级前一致）
    if (silentBlocked && crit.throughSilence === false) return { ok: false, sent: 0, reason: '' }
    const webhook = String(crit.webhook || '').trim()
    if (!webhook) return { ok: false, sent: 0, reason: '' }

    const atMobiles = parseMobiles(crit.atMobiles)
    const atAll = !!crit.atAll
    // 企微 markdown 不支持 @，需要 @ 时自动改用 text 消息（这样 @ 才真正生效）
    const needAt = atAll || atMobiles.length > 0
    // payload.html 是 Telegram 的 HTML（含 <b>/<font> 等标签）：tgHtmlToMd 先把它们换成
    // markdown 的 **，plainFromMarkdown 再去掉 **。切到 text 模式的正文必须是「纯文本」，
    // 否则企业微信里会原样显示出 <b> 这类标签。
    const md = payload.html ? tgHtmlToMd(payload.html) : String(payload.text || payload.title || '')
    const plain = payload.text || plainFromMarkdown(md) || md
    const msgType = needAt ? 'text' : crit.msgType || 'markdown'
    let content = needAt ? stripHtmlTags(plain) : md

    // litterbox 模式：先把截图传上图床，再把链接附到正文里（text 模式下 link 语法不生效，直接给 URL）
    if (payload.image && crit.screenshotMode === 'litterbox') {
      const shot = await resolveShotUrl(
        { screenshotMode: 'litterbox', imageHostTtl: wc.imageHostTtl },
        payload.image
      )
      if (shot.kind === 'image' && shot.url) {
        content += msgType === 'text' ? `\n截图：${shot.url}` : `\n[点击查看截图](${shot.url})`
      }
    }

    const cfg = { webhook, proxyBase: crit.proxyBase || '' }
    try {
      await sendWeCom(cfg, {
        msgType,
        content,
        atAll: needAt ? atAll : false,
        atMobiles: needAt ? atMobiles : []
      })
      // image 模式：另发一条 base64 截图（文字已送达，图片失败不把整条判为失败）
      if (payload.image && crit.screenshotMode === 'image') {
        try {
          await sendWeComImage(cfg, payload.image)
        } catch (e) {
          /* 文字已送达，截图失败只记录 */
        }
      }
      return { ok: true, sent: 1, reason: '' }
    } catch (e) {
      return { ok: false, sent: 0, reason: `企业微信关键事件：${(e && e.message) || '未知错误'}` }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 人脸特写补推（放大的人脸单独再发一条）                                */
  /* ------------------------------------------------------------------ */

  /**
   * 把「人脸特写」单独再推一条。
   *
   * 用户诉求：「人脸需要多推一次放大人脸照片」——完整人形 / 整帧画面里的人脸
   * 通常只有几十像素，手机上看不出是谁；所以识别到人脸后再单独发一张裁剪放大图。
   *
   * 与报警本身分开走：
   *   - 不占用各渠道的「同通道最小间隔」（是同一次报警的补充，不是新报警）；
   *   - 但计入每分钟条数上限，避免刷爆机器人；
   *   - 只在渠道勾了「人脸识别」这个事件分组时才发（关掉人脸分组 = 不想要人脸消息）。
   *
   * @param {object} record 原报警记录（需带 faceThumb / faceName / faceScore）
   * @param {string[]} ids  本次已经接收该报警的渠道
   * @param {object} ctx    本次推送上下文（tgMessageUrl 用于给钉钉/企微留入口）
   * @returns {Promise<{ok:boolean, sent:string[], reason?:string}>}
   */
  async function pushFaceShot(record, ids, ctx = {}) {
    const shot = (record && record.faceThumb) || ''
    if (!shot) return { ok: false, sent: [], reason: '没有可补推的人脸特写' }
    const now = Date.now()
    const who = record.faceName
      ? `${record.faceName}（相似度 ${Math.round((Number(record.faceScore) || 0) * 100)}%）`
      : '未录入的人脸'
    const title = `【监控报警】人脸特写 · ${record.name}`
    const link = ctx.tgMessageUrl || telegramGroupLink(readCfg('tg'))

    const targets = ids.filter((id) => {
      const def = CHANNEL_DEFS.find((d) => d.id === id)
      if (!def) return false
      const c = def.read()
      if (!isReady(id)) return false
      if (!Array.isArray(c.cameras) || !c.cameras.includes(record.id)) return false
      if (record.channels && record.channels[id] === false) return false
      // 人脸分组没勾 → 用户不想要人脸类消息，特写也不发
      if (normalizeEvents(c.events).face === false) return false
      if (inQuietHours(c, now)) return false
      // 全局静默时段内被收存的渠道，人脸特写也不实时发（避免漏出单条推送）
      if (isSilentSuppressed(id, now)) return false
      const st = chState[id]
      prune(st, now)
      return st.windowTs.length < rateLimit(c, id)
    })
    if (!targets.length) return { ok: false, sent: [], reason: '没有渠道接收人脸特写' }

    targets.forEach((id) => {
      const st = chState[id]
      st.windowTs.push(now)
      st.lastGlobalAt = now
    })

    const escHtml = (s) =>
      String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')

    const results = []
    let tgMsgUrl = ctx.tgMessageUrl || ''

    // TG 先发：钉钉 / 企微要复用它那条消息的链接
    if (targets.includes('tg')) {
      try {
        const t = readCfg('tg')
        const caption = [
          `🙂 <b>${escHtml(title)}</b>`,
          `<b>人脸</b>：${escHtml(who)}`,
          `<b>时间</b>：${escHtml(formatTime(record.time))}`,
          `（报警后补发的放大特写）`
        ].join('\n')
        const { message } = await sendTelegramAlarm(t, { image: shot, caption, mode: 'photo' })
        tgMsgUrl = tgMsgUrl || telegramMessageLink(t, message && message.message_id)
        results.push({ name: 'TG', ok: true })
      } catch (e) {
        results.push({ name: 'TG', ok: false, reason: (e && e.message) || '未知错误' })
      }
    }

    const others = await Promise.all(
      targets
        .filter((id) => id !== 'tg')
        .map(async (id) => {
          const name = CHANNEL_DEFS.find((d) => d.id === id).name
          try {
            if (id === 'ding') {
              const c = readCfg('ding')
              // 钉钉 markdown 的图片必须是公网 http(s) 地址；只有配了图床才能嵌图，
              // 否则给一条 Telegram 链接（和主消息的处理方式保持一致）
              const up = await resolveShotUrl(c, shot)
              const lines = [
                `### ${title}`,
                `> 通道：**${record.name}**`,
                `- 人脸：**${who}**`,
                `- 时间：${formatTime(record.time)}`
              ]
              const note = quotaNote('ding')
              if (note) lines.push('', `> ${note}`)
              if (up.kind === 'image' && up.url) lines.push('', `![人脸特写](${up.url})`)
              else lines.push('', '> 钉钉机器人无法直接发本地图片，人脸特写已随报警发往 Telegram')
              if (tgMsgUrl) lines.push('', `[在 Telegram 查看人脸特写](${tgMsgUrl})`)
              // 钉钉 @指定人：必须把 @手机号 字面写进正文，机器人才能真正通知到人
              const atMobiles = parseMobiles(c.atMobiles)
              let dingText = lines.join('\n')
              if (atMobiles.length) dingText = `${dingText}\n${atMobiles.map((m) => `@${m}`).join(' ')}`
              await sendDingTalk(
                { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy },
                { title, text: dingText, msgType: c.msgType, atAll: false, atMobiles }
              )
            } else {
              const c = readCfg('wecom')
              const lines = [
                `### ${title}`,
                `> 通道：**${record.name}**`,
                `- 人脸：**${who}**`,
                `- 时间：${formatTime(record.time)}`
              ]
              const note = quotaNote('wecom')
              if (note) lines.push('', `> ${note}`)
              if (tgMsgUrl) lines.push('', `[在 Telegram 查看人脸特写](${tgMsgUrl})`)
              // 企微 image 消息直接收 base64，无需图床
              await sendWeComAlarm(c, { content: lines.join('\n'), shot })
            }
            recordPush(id, true)
            return { name, ok: true }
          } catch (e) {
            const reason = (e && e.message) || '未知错误'
            recordPush(id, false, reason)
            return { name, ok: false, reason }
          }
        })
    )
    results.push(...others)

    const sent = results.filter((r) => r.ok).map((r) => r.name)
    const reason = results.filter((r) => !r.ok).map((f) => `${f.name}：${f.reason}`).join('；')
    return { ok: !!sent.length, sent, reason }
  }

  /* ------------------------------------------------------------------ */
  /* 报警后的「完整人形」补图                                             */
  /* ------------------------------------------------------------------ */

  /**
   * 补图消息的文案（三个渠道各一份，长短不一）。
   *
   * meta 是这一轮补拍窗口里同时拿到的「人脸 + 姿态」信息：
   * 用户要的效果就是「第一时间报警的图」→「完整人形」→「这个人是谁、在干什么」
   * 一次给全，所以这些一并写进补图消息。
   */
  function buildPersonShotMessages(record, meta) {
    const t = new Date(record.time || Date.now())
    const p = (n) => String(n).padStart(2, '0')
    const hhmmss = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`
    const title = '【监控报警】完整人形补图'
    const rows = [`> 通道：**${record.name}**`, `- 时间：${hhmmss}`, '- 说明：报警后补发的完整人形原图']
    const plain = [title, `通道：${record.name}`, `时间：${hhmmss}`]

    if (meta && meta.faceChecked) {
      const faceText = meta.faceName
        ? `${meta.faceName}（相似度 ${Math.round((meta.faceScore || 0) * 100)}%）`
        : '未录入的人脸'
      rows.push(`- 人脸：**${faceText}**`)
      plain.push(`人脸：${faceText}`)
    }
    if (meta && meta.actionText) {
      rows.push(`- 姿态：**${meta.actionText}**`)
      plain.push(`姿态：${meta.actionText}`)
    }
    // 和主消息保持一致：这条通道此刻开了哪些附加分析，一并写清楚
    const ft = featureText(record.features)
    if (ft) {
      rows.push(`- 功能状态：${ft}`)
      plain.push(`功能状态：${ft}`)
    }
    rows.push(`- 运行设备：${runtimeLine(BRAND)}`)
    plain.push(`运行设备：${runtimeLine(BRAND)}`)

    return {
      tg: [...plain, '（本条为报警后补发的完整人形原图）'].join('\n'),
      ding: (imageUrl, linkUrl) => {
        const lines = [`### ${title}`, ...rows]
        if (imageUrl) lines.push('', `![完整人形](${imageUrl})`)
        if (linkUrl) lines.push('', `[点击查看事件原图](${linkUrl})`)
        return { title, text: lines.join('\n') }
      },
      wecom: (linkUrl) => {
        const lines = [`### ${title}`, ...rows]
        if (linkUrl) lines.push('', `[点击查看事件原图](${linkUrl})`)
        return lines.join('\n')
      }
    }
  }

  /**
   * 补推「完整人形」原图（并可带上人脸特写）。
   *
   * 和报警本身分开走：
   *   - 不占用各渠道的「同通道最小间隔」（它本来就是同一次报警的补充，不是新报警）；
   *   - 但仍然计入每分钟条数上限，避免刷爆机器人；
   *   - 静默时段 / 未启用 / 未勾选该通道 / 通道级关掉了这个渠道，一律不补。
   *
   * @param {object} record 原报警记录
   * @param {string} shot   完整人形原图（dataURL）
   * @param {object} [meta] 同一轮补拍拿到的人脸 / 姿态信息
   * @returns {Promise<{ok:boolean, sent:string[], reason?:string}>}
   */
  async function pushExtraShot(record, shot, meta) {
    if (!shot) return { ok: false, sent: [], reason: '没有可补推的图片' }
    const now = Date.now()
    const ids = CHANNEL_DEFS.filter((d) => {
      const c = d.read()
      if (!isReady(d.id)) return false
      if (!Array.isArray(c.cameras) || !c.cameras.includes(record.id)) return false
      if (record.channels && record.channels[d.id] === false) return false
      if (normalizeEvents(c.events).person === false) return false
      if (inQuietHours(c, now)) return false
      // 全局静默时段内被收存的渠道，补图也不实时发
      if (isSilentSuppressed(d.id, now)) return false
      const st = chState[d.id]
      prune(st, now)
      return st.windowTs.length < rateLimit(c, d.id)
    }).map((d) => d.id)
    if (!ids.length) return { ok: false, sent: [], reason: '没有渠道接收补图' }

    ids.forEach((id) => {
      const st = chState[id]
      st.windowTs.push(now)
      st.lastGlobalAt = now
    })

    const ctx = { tgMessageUrl: '' }
    const msgs = buildPersonShotMessages(record, meta)
    const results = []
    /*
     * 人脸特写**只在主推送没发过的时候才补**：
     *   - 人脸事件自己带 faceThumb → 主推送那一步（deliver 里的 pushFaceShot）已经单独发过一张，
     *     这里再发就是同一张脸刷两遍；
     *   - 补拍窗口现场认出来的人脸（meta.faceThumb，主推送时还不知道）→ 只能在这里补。
     */
    const faceThumb = record.faceThumb ? '' : (meta && meta.faceThumb) || ''

    // TG 先发：其余渠道要复用它那条消息的链接
    if (ids.includes('tg')) {
      try {
        const t = readCfg('tg')
        const { message } = await sendTelegramAlarm(t, {
          image: shot,
          caption: msgs.tg,
          mode: t.sendMode === 'document' ? 'document' : 'photo'
        })
        ctx.tgMessageUrl = telegramMessageLink(t, message && message.message_id)
        results.push({ name: 'TG', ok: true })
        // 人脸特写单独再发一张：完整人形图上人脸往往只有几十像素，看不清是谁
        if (faceThumb) {
          const who = meta && meta.faceName ? meta.faceName : '未录入的人脸'
          await sendTelegramAlarm(t, {
            image: faceThumb,
            caption: `【监控报警】人脸特写 · ${record.name}\n${who}`,
            mode: 'photo'
          }).catch(() => {})
        }
      } catch (e) {
        results.push({ name: 'TG', ok: false, reason: (e && e.message) || '未知错误' })
      }
    }

    const others = await Promise.all(
      ids
        .filter((id) => id !== 'tg')
        .map(async (id) => {
          const name = CHANNEL_DEFS.find((d) => d.id === id).name
          try {
            if (id === 'ding') {
              const c = readCfg('ding')
              // litterbox / upload 模式才能嵌图，其余模式给一条 TG 链接
              const up = await resolveShotUrl(c, shot)
              const link =
                (c.screenshotMode || 'none') === 'none'
                  ? ''
                  : ctx.tgMessageUrl || telegramGroupLink(readCfg('tg'))
              const msg = msgs.ding(up.kind === 'image' ? up.url : '', link)
              await sendDingTalk(
                { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy },
                { ...msg, msgType: c.msgType, atAll: false, atMobiles: parseMobiles(c.atMobiles) }
              )
            } else {
              const c = readCfg('wecom')
              const link = ctx.tgMessageUrl || telegramGroupLink(readCfg('tg'))
              // 企微 markdown 不支持嵌图，直接走 image 消息把图发出来（会自动压到 2MB 内）
              await sendWeComAlarm(c, { content: msgs.wecom(link), shot })
              // 人脸特写同样再补一张图
              if (faceThumb) {
                const who = meta && meta.faceName ? meta.faceName : '未录入的人脸'
                await sendWeComAlarm(c, {
                  content: `【监控报警】人脸特写 · ${record.name}\n${who}`,
                  shot: faceThumb
                }).catch(() => {})
              }
            }
            recordPush(id, true)
            return { name, ok: true }
          } catch (e) {
            const reason = (e && e.message) || '未知错误'
            recordPush(id, false, reason)
            return { name, ok: false, reason }
          }
        })
    )
    results.push(...others)

    const sent = results.filter((r) => r.ok).map((r) => r.name)
    const reason = results.filter((r) => !r.ok).map((f) => `${f.name}：${f.reason}`).join('；')
    return { ok: !!sent.length, sent, reason }
  }

  /*
   * 启动：
   *   1) 若已处在静默窗口里，只把「结束提醒」排到窗口末尾（不补发一条「已开启」，
   *      否则每次重启进程都会给用户刷一遍重复的开始提醒）；
   *   2) 起 30 秒心跳，负责「进入窗口 → 发开始提醒 + 排结束提醒」与「窗口到点兜底」。
   */
  startSilentWatcher()

  return {
    handleAlarm,
    sendDirect,
    pushExtraShot,
    /** 立即把当前静默缓冲汇总发出去（设置页可挂「立即推送」按钮） */
    flushSilentSummary,
    /**
     * 手动发一条「免打扰已开始」提醒（设置页「试发一条开始提醒」按钮）。
     * 心跳检测到进入新窗口时会自动调，这里只是给人工预览用，不受 preNotify 开关限制。
     */
    pushPreSilenceNotice,
    /** 手动发一条「免打扰已结束」提醒（设置页「试发一条结束提醒」按钮，不动真实缓冲） */
    pushPostSilenceNotice,
    /** 临时静默（item 112）：从现在起 N 小时免打扰，到期自动推送结束提醒 + 汇总 */
    startTempSilent,
    /** 提前结束临时静默（默认立刻把已收存的汇总发出去） */
    endTempSilent,
    /** 临时静默状态查询（设置页 / 事件面板显示剩余时长用） */
    tempSilentInfo,
    /**
     * 当前静默窗口（含开始时刻）。远程「静默查岗」用它划查询区间 ——
     * 不在静默时段时返回 { active: false }。
     */
    silentWindowInfo,
    /** 生成免打扰提醒文案（导出来方便单测与调试文案，不参与推送） */
    buildPreSilenceMessages,
    buildTempSilentMessages,
    pendingCount,
    rateLimit,
    channels,
    /** 关键事件单独提醒（私聊推送）；导出来是为了单测与设置页「试发」 */
    pushDirectToUsers,
    directPushRecipients,
    /**
     * 通道静默：立即汇总 / 状态一览 / 临时静默开关。
     * 指令层与设置页都从这里取 —— 各写一份迟早会漂移（典型症状：界面显示静默中、
     * 实际调度器读的是另一个字段，于是"看着配好了却没生效"）。
     */
    flushCamSilent,
    camSilentList: (now) => camSilentOverview(camerasOf(), now),
    startCamTempSilent,
    endCamTempSilent,
    /**
     * 日常事件静默：立即汇总 / 配置与收存状态一览。
     * 与通道静默并列导出，供设置页与远程指令共用同一份判定 ——
     * 各写一份的典型症状是「界面说在收存、实际没生效」。
     */
    flushCamDigest,
    camDigestList: (now) =>
      (Array.isArray(camerasOf()) ? camerasOf() : [])
        .filter((c) => c && c.id)
        .map((c) => {
          const st = digestStore.get(c.id)
          return {
            id: c.id,
            name: c.name || c.id,
            ...digestStateOf(c, now || Date.now()),
            /** 已收存待汇总的条数（0 = 下一条汇总不会发） */
            buffered: st ? st.buf.length : 0,
            since: st ? st.since : 0
          }
        }),
    stopAll
  }
}

/**
 * Telegram parse_mode=HTML 只需要转义这三个字符（其余原样）。
 * 提到模块级是因为现在有三处在拼 TG HTML：人脸特写、关键事件私聊提醒、
 * 未来还会更多 —— 每处各写一份转义迟早会漂移。
 */
function tgEsc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 时间戳 → `HH:MM`。只用于"约几点汇总"这类短提示；
 * 完整时间戳一律走 useDingTalk.formatTime（那里带日期与星期）。
 */
function hhmm(ms) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 把 markdown 里的标记去掉，得到一个可读的纯文本（Telegram 兜底用） */
function plainFromMarkdown(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .trim()
}

/**
 * 去掉所有 HTML 标签。
 * 关键事件正文可能夹带 Telegram 的 <b>/<i>/<font> 等标签；一旦企业微信因为要 @ 人
 * 而自动切到 text 模式，这些标签会原样显示出来，必须清掉。
 * （tgHtmlToMd 已经把 <b> 换成 ** 并兜底剥过一次标签，这里再剥一遍是为了挡住
 *  任何「直接传了 payload.text 且里面带了标签」的边缘情况。）
 */
function stripHtmlTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '')
}

export function parseMobiles(text) {
  return String(text || '')
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
