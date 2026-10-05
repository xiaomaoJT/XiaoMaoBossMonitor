/**
 * 零配置图床（可选）：把事件截图换成一个公网可访问的 http(s) 地址。
 *
 * 为什么需要它：
 *   钉钉自定义机器人的 markdown 图片必须是公网 URL；
 *   企业微信的 markdown 不支持图片语法，只能放可点击链接。
 *   所以这两个渠道想显示图，就必须先有一个「图片地址」。
 *
 * 目前提供两个来源（见 useAlertPush 里的 screenshotMode）：
 *   1. 'tg'        —— 复用 Telegram 已上传的那张图（getFile 拿直链）
 *                     优点：不用重复上传；缺点：api.telegram.org 在国内需代理
 *   2. 'litterbox' —— 上传到 litterbox.catbox.moe（本文件）
 *                     优点：国内可直连、无需注册；缺点：最长 72 小时后失效
 *
 * litterbox 是 catbox.moe 的临时文件服务，接口极简：
 *   POST https://litterbox.catbox.moe/resources/internals/api.php
 *   form-data: reqtype=fileupload, time=1h|12h|24h|72h, fileToUpload=<文件>
 *   成功时直接返回一行纯文本 URL（没有 JSON 包装）。
 */

import { dataUrlToBlob } from './useTelegram.js'
import { timeoutSignal } from './useNet.js'

const LITTERBOX_API = 'https://litterbox.catbox.moe/resources/internals/api.php'
/** 上传是外网 + 大文件，给宽松一点，但必须有上限（否则会一直挂着） */
const UPLOAD_TIMEOUT_MS = 45000

/** 可选的有效期（litterbox 只接受这四个值） */
export const LITTERBOX_TTL = ['1h', '12h', '24h', '72h']

/**
 * 上传一张截图，返回公网直链
 * @param {string} dataUrl data:image/jpeg;base64,...
 * @param {object} opts { time: '72h' }
 */
export async function uploadToLitterbox(dataUrl, opts = {}) {
  if (!dataUrl) throw new Error('没有可上传的截图')
  const ttl = LITTERBOX_TTL.includes(opts.time) ? opts.time : '72h'
  const blob = dataUrlToBlob(dataUrl)
  const form = new FormData()
  form.append('reqtype', 'fileupload')
  form.append('time', ttl)
  form.append('fileToUpload', blob, `alarm-${Date.now()}.jpg`)

  let res
  try {
    res = await fetch(LITTERBOX_API, {
      method: 'POST',
      body: form,
      signal: timeoutSignal(UPLOAD_TIMEOUT_MS)
    })
  } catch (e) {
    throw new Error(`图床上传失败（网络不可达或超时）：${(e && e.message) || '未知错误'}`)
  }

  const text = (await res.text()).trim()
  if (!/^https?:\/\//i.test(text)) {
    throw new Error(`图床上传失败：${text.slice(0, 120) || `HTTP ${res.status}`}`)
  }
  return text
}
