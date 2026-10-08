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
  formatTime,
  normalizeDingTalk,
  sendDingTalk,
  uploadScreenshot
} from './useDingTalk.js'
import { normalizeWeCom, sendWeCom, sendWeComAlarm } from './useWeCom.js'
import { recordPush } from './usePushStats.js'
import { uploadToLitterbox } from './useImageHost.js'
import { EVENT_GROUPS, TYPE_GROUP, featureText, normalizeEvents } from './useAlarmText.js'
import { runtimeLine } from './useDeviceInfo.js'
import { BRAND } from '../config/defaults.js'
import {
  buildTelegramCaption,
  buildTelegramMergedText,
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
      ready: (c) => !!String(c.webhook || '').trim()
    },
    {
      id: 'wecom',
      name: '企微',
      read: () => normalizeWeCom(options.wecom || {}),
      ready: (c) => !!String(c.webhook || '').trim()
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
      ready: (c) => !!String(c.token || '').trim() && !!String(c.chatId || '').trim()
    }
  ]
}

export function useAlertPush(options, hooks = {}) {
  const { onState = () => {}, notify = () => {} } = hooks

  /** 每次创建实例时按当前 options 生成（read 是闭包，取的时候仍读实时配置） */
  const CHANNEL_DEFS = makeChannelDefs(options)

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

  const toMin = (s) => {
    const [h, m] = String(s || '0:0').split(':').map((n) => Number(n) || 0)
    return h * 60 + m
  }
  const silentCfg = () => options.silent || {}

  /**
   * 读出所有定时静默时段（item 114：支持多个时段）。
   *
   * 兼容老配置：老版本只有 start / end 两个字段、没有 slots。
   * 这里做一次归一化 —— 有 slots 就用 slots；没有但有 start/end 就当成单个时段。
   * 用户升级后原有的夜间时段不会丢，也不用写数据迁移脚本。
   * 非法项（start === end，等于 0 长度窗口）会被过滤掉。
   */
  function readSlots() {
    const c = silentCfg()
    if (!c) return []
    const out = []
    const push = (s, e) => {
      const a = toMin(s)
      const b = toMin(e)
      if (a === b) return
      out.push({ start: a, end: b })
    }
    if (Array.isArray(c.slots) && c.slots.length) {
      c.slots.forEach((it) => {
        if (it && it.start !== undefined && it.end !== undefined) push(it.start, it.end)
      })
    } else if (c.start !== undefined && c.end !== undefined) {
      // 老配置：单时段
      push(c.start, c.end)
    }
    return out
  }

  /** 「今天零点 + 距天分钟数」换算成时间戳；dayOff 用于跨天（-1=昨天，1=明天） */
  function slotBoundary(now, min, dayOff) {
    const d = new Date(now)
    d.setFullYear(d.getFullYear(), d.getMonth(), d.getDate() + (dayOff || 0))
    d.setHours(0, 0, 0, 0)
    return d.getTime() + min * 60000
  }

  /**
   * 找出当前命中的那个时段，并算出它的起止时间戳。
   * 多个时段重叠时取**结束最晚**的那个（免打扰当然按最宽的窗口算）。
   */
  function matchSlot(now) {
    const d = new Date(now)
    const m = d.getHours() * 60 + d.getMinutes()
    const today = d.getDate()
    let best = null
    readSlots().forEach((s) => {
      const hit = s.start < s.end ? m >= s.start && m < s.end : m >= s.start || m < s.end
      if (!hit) return
      let startMs
      let endMs
      if (s.start < s.end) {
        startMs = slotBoundary(now, s.start, 0)
        endMs = slotBoundary(now, s.end, 0)
      } else if (m >= s.start) {
        // 跨零点，现在处于「开始之后」那半段 → 结束在明天
        startMs = slotBoundary(now, s.start, 0)
        endMs = slotBoundary(now, s.end, 1)
      } else {
        // 跨零点，现在处于「结束之前」那半段 → 开始在昨天
        startMs = slotBoundary(now, s.start, -1)
        endMs = slotBoundary(now, s.end, 0)
      }
      if (!best || endMs > best.endMs) best = { start: s.start, end: s.end, startMs, endMs }
    })
    if (best) best.crossDay = new Date(best.endMs).getDate() !== today
    return best
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
   * 静默相关消息（开始提醒 / 结束提醒 / 汇总）发给哪些渠道。
   *
   * 用户要求：只要静默提醒开着，就推给**现有已配置的三端**（钉钉 / 企微 / TG）。
   * 注意这里刻意不看 silent.channels —— 那个勾选决定的是「静默期间哪些渠道
   * 暂停实时推送」，跟「提醒本身发去哪」不是一回事：只对钉钉静默的人，
   * 一样应该在企业微信 / TG 上看到「免打扰已开启 / 已结束」。
   */
  function noticeIds() {
    return CHANNEL_DEFS.filter((d) => isReady(d.id)).map((d) => d.id)
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

    const ids = noticeIds()
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
    }
    return summary
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
  async function pushStartNotice(win, slot) {
    if (silentCfg().preNotify === false) return { ok: false, reason: '静默提醒已关闭' }
    const msg = win && win.temp ? buildTempSilentMessages(win) : buildPreSilenceMessages(slot)
    if (!msg) return { ok: false, reason: '时段格式无效' }
    const r = await sendDirect({
      title: msg.title,
      text: msg.markdown,
      html: msg.html,
      kind: 'silent'
    })
    // sendDirect 成功时返回 { ok, reason }（reason 为空=全渠道成功，非空=部分失败说明），没有 sent 字段
    if (r && r.ok) notify(r.reason ? `免打扰开始提醒已推送（${r.reason}）` : '免打扰开始提醒已推送')
    return r
  }

  /** 设置页「试发一条开始提醒」用的入口（不受 preNotify 开关限制，改完文案先看效果） */
  function pushPreSilenceNotice(slot) {
    const slots = readSlots()
    const hit = matchSlot(Date.now())
    const useSlot = slot || hit || slots[0] || null
    // 试发时若正处在临时静默里，用临时静默的文案更贴近真实
    const win = currentWindow(Date.now())
    return pushStartNotice(win && win.temp ? win : { temp: false }, useSlot)
  }

  /**
   * 设置页「试发一条结束提醒」用的入口。
   * 不走真实的缓冲清理（test 模式），所以随便点也不会把待汇总的事件弄丢。
   */
  function pushPostSilenceNotice() {
    const now = Date.now()
    let win = currentWindow(now)
    if (!win) {
      // 不在窗口里就拿最近一个时段造一个，方便看清楚「结束提醒」长什么样
      const s = readSlots()[0]
      if (s) {
        const endMs = s.start < s.end ? slotBoundary(now, s.end, 0) : slotBoundary(now, s.end, 1)
        win = {
          key: `slot:${endMs}`,
          temp: false,
          startMs: slotBoundary(now, s.start, 0),
          endMs,
          rangeLabel: `${min2hm(s.start)} ~ ${s.end < s.start ? '次日 ' : ''}${min2hm(s.end)}`,
          endLabel: min2hm(s.end),
          channels: null,
          reason: ''
        }
      }
    }
    return flushSilentSummary({ endMs: win ? win.endMs : now, window: win, test: true })
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
    await sendDingTalk(
      { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy },
      { ...msg, msgType: c.msgType, atAll: c.atAll, atMobiles: parseMobiles(c.atMobiles) }
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
    pendingCount.value = 0
  }

  /** 入口：处理一条报警事件 */
  async function handleAlarm(record) {
    const now = Date.now()
    const decisions = CHANNEL_DEFS.map((d) => ({ id: d.id, ...checkChannel(d.id, record, now) }))
    let send = decisions.filter((d) => d.ok).map((d) => d.id)
    let queue = decisions.filter((d) => d.overflow && readCfg(d.id).overflowMode === 'merge')

    /*
     * 全局静默时段：被选中的渠道在时段内「不实时推」，改为收存到 silentBuffer，
     * 等时段结束统一发一条汇总。判定「该渠道本应收到」时忽略渠道级 quiet，
     * 避免和这里的全局收存打架（全局优先级更高）。
     * 临时静默（item 112）也走这里，只是渠道集合来自 silentState().channels。
     */
    const sState = silentState(now)
    const quietChans = sState.temp
      ? sState.channels || []
      : (silentCfg().channels || [])
    const suppressIds =
      sState.active && quietChans.length
        ? CHANNEL_DEFS.filter(
            (d) => quietChans.includes(d.id) && checkChannel(d.id, record, now, true).ok
          ).map((d) => d.id)
        : []
    let buffered = false
    if (suppressIds.length) {
      send = send.filter((id) => !suppressIds.includes(id))
      queue = queue.filter((id) => !suppressIds.includes(id))
      if (!silentSeen.has(record.key)) {
        silentSeen.add(record.key)
        silentBuffer.push({
          key: record.key,
          time: record.time,
          name: record.name,
          type: record.type,
          ratio: record.ratio,
          faceName: record.faceName,
          counts: record.counts,
          zoneName: record.zoneName,
          dwellMs: record.dwellMs,
          text: record.text
        })
      }
      scheduleSilentFlush()
      buffered = true
    }

    // 完全被静默收存（没有任何渠道在本条事件上实时发送 / 排队）→ 标记「静默待推送」
    if (buffered && !send.length && !queue.length) {
      onState(
        record.key,
        'silent',
        `静默时段（${sState.rangeLabel}）已收存，将于 ${sState.endLabel} 推送结束提醒 + 汇总`
      )
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

    if (!send.length && !buffered) {
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
  async function sendDirect({ title, text, html, atAll = false, kind = 'status', key, onState: cb }) {
    const ids = CHANNEL_DEFS.filter((d) => {
      if (!isReady(d.id)) return false
      const c = d.read()
      // 巡检 / 状态异常在各渠道里可以单独关掉
      if (kind === 'patrol') return !(c.patrol && c.patrol.enabled === false)
      if (kind === 'status') return !(c.statusAlerts && c.statusAlerts.enabled === false)
      // 'silent'：免打扰开始/结束提醒。发给**所有已配置的渠道**（三端），
      // 刻意不看 silent.channels —— 那是「静默期间暂停实时推送的渠道」，
      // 跟「提醒发去哪」不是一回事（只对钉钉静默，也该在企微/TG 上看到提醒）
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
            await sendDingTalk(
              { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy },
              { title, text, msgType: c.msgType, atAll, atMobiles: atAll ? [] : parseMobiles(c.atMobiles) }
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
              await sendDingTalk(
                { webhook: c.webhook, secret: c.secret, useProxy: c.useProxy },
                { title, text: lines.join('\n'), msgType: c.msgType, atAll: false, atMobiles: parseMobiles(c.atMobiles) }
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
    stopAll
  }
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

export function parseMobiles(text) {
  return String(text || '')
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
