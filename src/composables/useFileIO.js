/**
 * 文件读写：把事件（含截图）导出成真实的本地文件夹、导入 JSON 配置等。
 *
 * 优先用 File System Access API（Chrome / Edge / Electron 都支持），
 * 可以让用户选一个目录，然后真的在里面建文件夹、写 jpg / json 文件；
 * 不支持的环境（iOS Safari / 小程序）自动退化为「下载单个 JSON 文件」。
 */

/** dataURL -> Blob */
export function dataURLtoBlob(dataURL) {
  if (!dataURL || typeof dataURL !== 'string' || !dataURL.includes(',')) return null
  try {
    const [head, body] = dataURL.split(',')
    const mime = /:(.*?);/.exec(head)
      ? /:(.*?);/.exec(head)[1]
      : 'application/octet-stream'
    if (/;base64$/i.test(head)) {
      const bin = atob(body)
      const len = bin.length
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type: mime })
    }
    return new Blob([decodeURIComponent(body)], { type: mime })
  } catch (e) {
    return null
  }
}

/** 生成排序友好、可当文件名的事件标识 */
export function eventFileName(record, index) {
  const d = new Date(record.time || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`
  const type = record.type === 'person' ? '人形' : record.type === 'motion' ? '移动' : record.type || '事件'
  const name = String(record.name || record.id || '通道').replace(/[\\/:*?"<>|\s]+/g, '_')
  const seq = String(index + 1).padStart(3, '0')
  return `${seq}_${name}_${stamp}_${type}`
}

export function supportsDirectoryPicker() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/**
 * 把事件导出成文件夹：
 *   <选中的目录>/BossMonitor-事件-yyyyMMdd-HHmmss/
 *     ├── events.json          全部事件（含截图 dataURL）
 *     └── screenshots/*.jpg    每条事件的截图
 */
export async function exportEventsToFolder(events) {
  if (!supportsDirectoryPicker()) throw new Error('当前环境不支持选择文件夹')
  const root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'monitor-export' })
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const folderName = `BossMonitor-事件-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours()
  )}${p(d.getMinutes())}${p(d.getSeconds())}`

  const dir = await root.getDirectoryHandle(folderName, { create: true })
  const shotDir = await dir.getDirectoryHandle('screenshots', { create: true })

  let shots = 0
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i]
    if (!ev.thumb && !ev.shot) continue
    const blob = dataURLtoBlob(ev.shot || ev.thumb)
    if (!blob) continue
    const fh = await shotDir.getFileHandle(`${eventFileName(ev, i)}.jpg`, { create: true })
    const w = await fh.createWritable()
    await w.write(blob)
    await w.close()
    shots += 1
  }

  const jh = await dir.getFileHandle('events.json', { create: true })
  const jw = await jh.createWritable()
  await jw.write(
    JSON.stringify(
      {
        app: 'BossMonitor',
        exportedAt: new Date().toISOString(),
        count: events.length,
        events
      },
      null,
      2
    )
  )
  await jw.close()

  return { folder: `${root.name}/${folderName}`, shots, count: events.length }
}

/** 退化方案：下载一个 JSON 文件 */
export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** 让用户选一个 .json 文件并解析（配置导入 / 事件导入） */
export function pickJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = () => {
      const file = input.files && input.files[0]
      if (!file) {
        reject(new Error('未选择文件'))
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result)))
        } catch (e) {
          reject(new Error('文件不是合法的 JSON'))
        }
      }
      reader.onerror = () => reject(new Error('读取文件失败'))
      reader.readAsText(file, 'utf-8')
    }
    input.click()
  })
}
