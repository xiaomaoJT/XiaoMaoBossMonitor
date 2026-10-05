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

  /** 单渠道预检 */
  function checkChannel(id, record, now) {
    const def = CHANNEL_DEFS.find((x) => x.id === id)
    const c = def.read()
    if (!c.enabled) return { ok: false, off: true, reason: '未启用该渠道' }
    if (!def.ready(c)) return { ok: false, off: true, reason: '凭据未配置完整' }
    if (!Array.isArray(c.cameras) || !c.cameras.includes(record.id)) {
      return { ok: false, off: true, reason: '该通道未勾选' }
    }
    // 通道级渠道开关：某一路可以在设置里单独关掉某个渠道
    if (record.channels && record.channels[id] === false) {
      return { ok: false, off: true, reason: `该通道已关闭「${def.name}」推送` }
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
    if (inQuietHours(c, now)) return { ok: false, off: true, reason: '静默时段' }

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
    if (okNames.length) {
      const note = [fails.map((f) => `${f.name}：${f.reason}`).join('；'), warns.join('；')]
        .filter(Boolean)
        .join('；')
      records.forEach((r) => onState(r.key, merged ? 'merged' : 'ok', note, okNames.join(' + ')))
      return
    }
    const reason = fails.map((f) => `${f.name}：${f.reason}`).join('；') || '未知错误'
    records.forEach((r) => onState(r.key, 'fail', reason))
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

    records.forEach((r) => onState(r.key, 'sending'))

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
      records.forEach((r) => onState(r.key, 'fail', reason))
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
    pendingCount.value = 0
  }

  /** 入口：处理一条报警事件 */
  async function handleAlarm(record) {
    const now = Date.now()
    const decisions = CHANNEL_DEFS.map((d) => ({ id: d.id, ...checkChannel(d.id, record, now) }))
    const send = decisions.filter((d) => d.ok).map((d) => d.id)
    const queue = decisions.filter((d) => d.overflow && readCfg(d.id).overflowMode === 'merge')

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

    if (!send.length) {
      const reasons = decisions
        .filter((d) => !d.ok && !d.off)
        .map((d) => `${CHANNEL_DEFS.find((x) => x.id === d.id).name}：${d.reason}`)
      const offs = decisions.filter((d) => d.off)
      if (reasons.length) onState(record.key, 'off', reasons.join('；'))
      else if (offs.length === decisions.length) onState(record.key, 'off', '所有渠道都未监听该通道')
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

  return { handleAlarm, sendDirect, pushExtraShot, pendingCount, rateLimit, channels, stopAll }
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
