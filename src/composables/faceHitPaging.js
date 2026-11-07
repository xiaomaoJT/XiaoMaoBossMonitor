/**
 * 命中修正列表的分页规则（唯一判定）
 * ----------------------------------------------------------------------------
 * 设置页「命中修正」最多展示 99 条（后端 HIT_KEEP=120 留了余量），
 * 一屏放不下，按每页 9 条（hit-grid 固定 3 列 × 3 行）翻页。
 *
 * 为什么单独成一个模块：
 *   · 页大小、页数、越界收敛这三件事以前散在组件里，改一处就会和「删除后
 *     停在空白页」这种边界打架；
 *   · 纯函数没有 Vue 依赖，Node 探针可以直接 import 验证（99 → 11 页、
 *     末页 9 条、页码越界拉回最后一页），不用起浏览器。
 */

/** 每页条数：与 .hit-grid 的固定 3 列保持一致（3 列 × 3 行） */
export const HIT_PAGE_SIZE = 9

/** 总页数（空列表也算 1 页，页面不会出现「1 / 0」） */
export function hitPageCount(list) {
  const n = Array.isArray(list) ? list.length : 0
  return Math.max(1, Math.ceil(n / HIT_PAGE_SIZE))
}

/** 页码收敛到 [1, 总页数]；数据变短后不会停在空白页 */
export function clampHitPage(page, list) {
  const p = Math.floor(Number(page) || 1)
  const max = hitPageCount(list)
  return Math.min(Math.max(1, p), max)
}

/** 取某一页的 9 条（页码先收敛，返回的永远是新数组） */
export function sliceHitPage(list, page) {
  const arr = Array.isArray(list) ? list : []
  const p = clampHitPage(page, arr)
  const from = (p - 1) * HIT_PAGE_SIZE
  return arr.slice(from, from + HIT_PAGE_SIZE)
}
