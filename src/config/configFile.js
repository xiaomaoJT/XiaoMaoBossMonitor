/**
 * 本地配置文件（.json）的读取与归一化 —— **唯一判定**。
 * ----------------------------------------------------------------------------
 * 完整的那一份配置（真实通道 / 推送凭据 / 白名单 / 摆放坐标）不再编译进源码，
 * 它是一份普通文件，由用户自己从本机选进来。这个文件负责把「文件里写的东西」
 * 变成「系统能直接用的配置」，并且只有这一处判定：
 *
 *   · 设置页「配置方案 → 载入配置文件」（整份配置，含凭据）
 *   · 设置页「导入配置」（同一套逻辑 —— 以前这里是第二份手写字段清单，
 *     导进来的通道丢了 silent / digest，属于典型的"两份清单漂开"）
 *
 * 三条规矩：
 *   1. **宽松读取，严格归一化**。文件是用户手写/手改的，缺字段是常态：
 *      缺的补默认值，多的原样保留，类型不对的按默认值纠正 —— 但不许因为
 *      某个字段怪就整份拒收（除了一眼就不像配置文件的情况，见 parseConfigFile）。
 *   2. **不猜**。文件里没写凭据就是没有凭据，绝不用源码里的值去填 ——
 *      那正是这次要去掉的东西。
 *   3. **不在渲染期调用**。这里的函数会就地补字段，只能在载入 / 保存路径上调。
 *
 * ⚠️ 相对 import 带 `.js`（与 defaults.js 同理：后端也可能 import 到这个模块）。
 */

import {
  cloneDefaultOptions,
  fillMissingOptions,
  normalizeCameraChannels,
  normalizeCameraSilent,
  normalizeCameraDigest,
  normalizeFlows,
  migrateSecretFields,
  syncChannelCameras
} from './defaults.js'
import { normalizeDingTalk } from '../composables/useDingTalk.js'
import { normalizeTelegram } from '../composables/useTelegram.js'
import { normalizeWeCom } from '../composables/useWeCom.js'

/** 配置文件格式版本（导出时写入；读取时不强校验，只用于提示） */
export const CONFIG_FILE_VERSION = 1

/**
 * 解析一份配置文件文本。
 *
 * @param {string} text 文件内容
 * @returns {{ok:true, config:{cameras:Array, options:object, hiddenIds:Array}, stats:object}
 *          |{ok:false, error:string}}
 */
export function parseConfigFile(text) {
  let data
  try {
    data = JSON.parse(String(text))
  } catch (e) {
    return { ok: false, error: '不是合法的 JSON 文件（解析失败），请确认选的是本系统导出的 .json 配置' }
  }
  return normalizeConfigPayload(data)
}

/**
 * 归一化一份配置对象（不碰 DOM，可单独测）。
 *
 * 判据只有一条：**必须有 cameras 数组**。
 * 其它字段（options / hiddenIds / version）缺了都按默认值补 —— 一份"只有通道"的
 * 文件也是合法配置，只是没有推送凭据而已。
 */
export function normalizeConfigPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '文件内容不是一个配置对象' }
  }
  if (!Array.isArray(data.cameras)) {
    return { ok: false, error: '缺少 cameras 数组 —— 这不像一份配置导出文件' }
  }

  /* ---------------- 通道 ---------------- */
  const usedIds = new Set()
  const cameras = data.cameras.map((raw, i) => normalizeCamera(raw, i, usedIds))

  /* ---------------- 配置项 ---------------- */
  const options = cloneDefaultOptions()
  if (data.options && typeof data.options === 'object' && !Array.isArray(data.options)) {
    /*
     * 用「文件覆盖默认值」的方向合并，再交给 fillMissingOptions 补第二层缺失。
     * 直接 Object.assign 到 options 上不行：文件里那些**不认识的**键会被带进来
     * （例如老版本字段），落盘后又被当成新配置存下去，越滚越脏。
     */
    Object.keys(data.options).forEach((k) => {
      const v = data.options[k]
      if (v === undefined) return
      if (!(k in options)) return
      options[k] = JSON.parse(JSON.stringify(v))
    })
    fillMissingOptions(options)
  }

  /* 三个渠道的嵌套子配置（critical / remote / directPush …）各有自己的补齐规则 */
  try {
    if (options.dingtalk) normalizeDingTalk(options.dingtalk)
    if (options.telegram) normalizeTelegram(options.telegram)
    if (options.wecom) normalizeWeCom(options.wecom)
  } catch (e) {
    /* 单个渠道归一化失败不该让整份配置作废：它只是这一路推送不生效 */
    console.warn('⚠️ 渠道配置归一化失败（已忽略）：', (e && e.message) || e)
  }
  /* 人员走向：旧文件里可能没有 flows / flow.oppositeSec */
  normalizeFlows(options)
  /* 老文件里可能还留着明文遮罩密码 → 换算成摘要并删掉明文 */
  migrateSecretFields(options)
  /* 渠道级「要推哪几路」从通道级开关重算一次，避免文件里那份名单和开关对不上 */
  syncChannelCameras(cameras, options)

  /* ---------------- 哪几路默认不显示 ---------------- */
  const hiddenIds = Array.isArray(data.hiddenIds)
    ? data.hiddenIds.map((x) => String(x)).filter((id) => usedIds.has(id))
    : []

  return {
    ok: true,
    config: { cameras, options, hiddenIds },
    stats: {
      cameras: cameras.length,
      visible: cameras.length - hiddenIds.length,
      flows: Array.isArray(options.flows) ? options.flows.length : 0,
      exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
      /* 只回"有没有凭据"，绝不把凭据本身回显到界面上 */
      credentials: {
        ding: !!(options.dingtalk && (options.dingtalk.webhook || options.dingtalk.critical?.webhook)),
        wecom: !!(options.wecom && (options.wecom.webhook || options.wecom.critical?.webhook)),
        tg: !!(options.telegram && options.telegram.token)
      }
    }
  }
}

/**
 * 归一化一路通道。
 *
 * ⚠️ 字段清单**不在这里重写** —— 一律交给 defaults.js 的 normalizeCamera*：
 *   normalizeCameraChannels  channels / push / urlSub / urlBackend / zones / aiExt
 *   normalizeCameraSilent    通道静默（含临时静默四个字段）
 *   normalizeCameraDigest    日常事件静默
 * 以前设置页的「导入配置」是手写一份字段清单，结果导进来的通道
 * 丢了通道静默与日常汇总（配置有值但不生效），就是"手写清单"的典型翻车。
 */
function normalizeCamera(raw, index, usedIds) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  /* id 必须唯一且非空：大屏、推送名单、流向节点全靠它认通道 */
  let id = typeof src.id === 'string' ? src.id.trim() : ''
  if (!id || usedIds.has(id)) {
    let n = index + 1
    while (usedIds.has(`cam-${n}`)) n += 1
    id = `cam-${n}`
  }
  usedIds.add(id)

  const cloneable = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : null)
  const str = (v) => (typeof v === 'string' ? v : '')

  const cam = {
    id,
    name: str(src.name).trim() || `画面 ${index + 1}`,
    url: str(src.url).trim(),
    urlSub: str(src.urlSub),
    urlBackend: str(src.urlBackend),
    motion: src.motion !== false,
    ai: src.ai === true,
    blind: src.blind === true,
    roi: cloneable(src.roi),
    rect: cloneable(src.rect),
    zones: Array.isArray(src.zones) ? JSON.parse(JSON.stringify(src.zones)) : [],
    /*
     * push / channels / aiExt 交给 normalizeCameraChannels 判（它才是判据）：
     * 这里给个「同语义的初值」只为让它有东西可纠正。
     */
    push: src.push !== false,
    channels: cloneable(src.channels) || undefined,
    aiExt: cloneable(src.aiExt) || undefined,
    /* 通道静默 / 日常汇总：文件里没有就让 normalize* 补默认（= 关闭） */
    silent: cloneable(src.silent) || undefined,
    digest: cloneable(src.digest) || undefined
  }
  if (!cam.channels) delete cam.channels
  if (!cam.aiExt) delete cam.aiExt
  if (!cam.silent) delete cam.silent
  if (!cam.digest) delete cam.digest

  normalizeCameraChannels(cam)
  normalizeCameraSilent(cam)
  normalizeCameraDigest(cam)
  return cam
}
