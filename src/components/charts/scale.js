/**
 * 图表刻度与取整（纯函数，零依赖）
 * ----------------------------------------------------------------------------
 * 为什么单独抽一个模块：
 *   - 刻度算法是**唯一会被多个图型共用**的那部分几何逻辑（折线 / 柱条 / 热力图都要），
 *     写在某个 .vue 里另一张图就只能复制一份，迟早两边刻度不一样。
 *   - 纯函数 => 可以在 Node 里直接单测（`/tmp/charts-probe/test-scale.mjs`），
 *     不用开浏览器。y 轴出现 `3.3333` 这种刻度是肉眼才发现的缺陷，单测最合适。
 */

/** 整数显示（计数类） */
export function fmtInt(v) {
  const n = Number(v)
  return Number.isFinite(n) ? String(Math.round(n)) : ''
}

/**
 * 取"好看的"刻度：1 / 2 / 5 / 10 档。
 *
 * @param {number} max   数据最大值（0 或非法值会给一个 0~1 的最小骨架）
 * @param {number} count 期望的档数（实际档数会取整到 1/2/5/10 倍，可能多于它）
 * @returns {{v:number,label:string}[]} 从 0 递增，**最后一个值 ≥ max**（用它当缩放上限，
 *          数据点就绝不会画出绘图区）
 */
export function niceTicks(max, count = 4) {
  const m = Number(max)
  if (!Number.isFinite(m) || m <= 0) {
    return [
      { v: 0, label: '0' },
      { v: 1, label: '1' }
    ]
  }
  const raw = m / Math.max(1, count)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  // 减一点点避免 max 恰好等于整数倍时多出一整档（ceil(4/1 - eps) 才是 4）
  const nSteps = Math.min(100, Math.round(Math.ceil(m / step - 1e-9)))
  const decimals = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0
  const out = []
  for (let i = 0; i <= nSteps; i += 1) {
    // 用乘法重算而不是累加：浮点累加会出现 0.30000000000000004
    const v = i * step
    out.push({ v, label: decimals ? v.toFixed(decimals) : fmtInt(v) })
  }
  return out
}

/** 刻度里的最大档（= 缩放上限） */
export function tickTop(ticks) {
  const last = ticks && ticks.length ? ticks[ticks.length - 1].v : 0
  return last > 0 ? last : 1
}

/** 比例（0~1，越界夹住） */
export function ratio(v, max) {
  const m = Number(max)
  const x = Number(v)
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(x) || x <= 0) return 0
  return Math.min(1, x / m)
}

/** 小时标签：补零成 00~23 */
export function fmtHour(h) {
  return String(h).padStart(2, '0')
}

/**
 * 热力格的透明度：**零值也要看得见**（用 0 表示"这天这小时没报警"，
 * 而不是"没这一格"——留白和浅色是两回事，用户要能数出格数）。
 * 指数 0.6 让 1~2 次的小值也能显色，否则相对最大值一大就全看不见了。
 */
export function heatOpacity(v, max, { min = 0.07, max0 = 0.95, gamma = 0.6 } = {}) {
  const x = Number(v)
  if (!Number.isFinite(x) || x <= 0) return min
  const r = ratio(x, max)
  return min + (max0 - min) * Math.pow(r, gamma)
}
