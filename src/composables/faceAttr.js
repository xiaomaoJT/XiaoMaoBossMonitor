/**
 * 人脸属性的「解读口径」（纯函数，前后端 + 展示层共用）
 * ============================================================================
 * 属性模型吐出来的是**概率**（0~100 的整数），不是布尔：
 *   face_attrib_net → { leftEyeOpen, rightEyeOpen, glasses, mask, sunglasses }
 *   genderage       → gender: 'male'|'female'，age: 整数（模型估算）
 *
 * 「多少算戴了口罩」如果写在两个地方（设置页徽标一处、统计页一处），
 * 迟早出现「卡片上写着口罩、统计里没算他一顶」的对不上账。所以阈值与
 * 标签判定都收在这一份里：
 *   · 设置页/待录入徽标 —— faceAttrTags()
 *   · 统计按维度累加   —— faceAttrTags() + ageBucket()
 *   · 推送/汇总文案     —— 同样取 faceAttrTags()
 *
 * ⚠️ 年龄只宜当粗标签：模型对儿童估高非常严重（实测 8 岁估成 30+），
 *    所以统计给的是**分桶**而不是平均值 —— 平均值会被模型偏差带跑，
 *    分桶至少能回答"来的人大概在哪个年龄段"。
 */

/** 概率多少算「命中」这个标签。50% = 半数以上的把握，低于它的判定不显示，避免抖动误导。
 *  这是出厂默认；实际运行时由 setAttrOnSource 注入的可调阈值覆盖（见下方）。 */
export const FACE_ATTR_ON = 50

/**
 * 运行期把"属性标签阈值从哪读"注入进来（前后端各注入一次）：
 *   · 浏览器：useAlertPush 工厂里 setAttrOnSource(() => options.face.attribThreshold)
 *   · 无头后端：headless-monitor 启动处注入
 * 不注入时退回 FACE_ATTR_ON 常量（=50，等价于旧行为）。
 */
let _attrOnGetter = null
export function setAttrOnSource(getter) {
  _attrOnGetter = typeof getter === 'function' ? getter : null
}
function attrOnNow() {
  if (_attrOnGetter) {
    try {
      const v = Number(_attrOnGetter())
      if (Number.isFinite(v) && v > 0 && v <= 100) return v
    } catch (_) {
      /* 忽略 */
    }
  }
  return FACE_ATTR_ON
}

/**
 * 属性标签表（顺序固定：展示与统计都按这个顺序，避免两处排版不一致）。
 * @type {{id:string,label:string}[]}
 */
export const FACE_ATTR_TAGS = [
  { id: 'mask', label: '口罩' },
  { id: 'sunglasses', label: '墨镜' },
  { id: 'glasses', label: '眼镜' },
  { id: 'eyesClosed', label: '闭眼' }
]

/**
 * 属性概率 → 命中的标签 id 数组。
 *
 * 判定细节（与设置页徽标同一份，别在别处再写一遍）：
 *   · 墨镜优先于眼镜 —— 戴墨镜的人同样满足"有镜片"，两个都显示没有意义；
 *   · 「闭眼」= 任一只眼的睁开概率低于阈值（单眼眨也算，宁可多说）；
 *   · 字段缺失（undefined/NaN）**不**判命中，避免"没算过"被读成"戴着"。
 *
 * @param {{leftEyeOpen?:number,rightEyeOpen?:number,glasses?:number,mask?:number,sunglasses?:number}|null} attr
 * @returns {string[]} 例如 ['mask'] / ['glasses'] / ['eyesClosed']
 */
export function faceAttrTags(attr) {
  const a = attr && typeof attr === 'object' ? attr : null
  if (!a) return []
  const on = attrOnNow()
  const hit = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= on
  }
  const out = []
  if (hit(a.mask)) out.push('mask')
  if (hit(a.sunglasses)) out.push('sunglasses')
  else if (hit(a.glasses)) out.push('glasses')
  // 任一只眼低于阈值就判闭眼（单眼眨也算，宁可多说）；缺字段不算闭眼
  const closed = (v) => {
    if (v == null) return false
    const n = Number(v)
    return Number.isFinite(n) && n < on
  }
  if (closed(a.leftEyeOpen) || closed(a.rightEyeOpen)) out.push('eyesClosed')
  return out
}

/**
 * 标签 id → 中文标签（找不到就原样返回 id，绝不抛错）。
 * @param {string} id
 * @returns {string}
 */
export function faceAttrLabel(id) {
  const t = FACE_ATTR_TAGS.find((x) => x.id === id)
  return t ? t.label : String(id || '')
}

/**
 * 年龄分桶（统计页用）。
 * 上界包含在桶内；负数/非数字 → 'unknown'（模型没算出来，不是"0 岁"）。
 * @type {{id:string,label:string,max:number}[]}
 */
export const AGE_BUCKETS = [
  { id: 'u18', label: '<18', max: 17 },
  { id: '18-29', label: '18-29', max: 29 },
  { id: '30-44', label: '30-44', max: 44 },
  { id: '45-59', label: '45-59', max: 59 },
  { id: '60+', label: '60+', max: Infinity }
]

/**
 * 年龄 → 桶 id。
 * @param {number|null|undefined} age
 * @returns {string} AGE_BUCKETS 里的 id，或 'unknown'
 */
export function ageBucket(age) {
  if (age == null) return 'unknown'
  const n = Number(age)
  if (!Number.isFinite(n) || n < 0) return 'unknown'
  for (const b of AGE_BUCKETS) {
    if (n <= b.max) return b.id
  }
  return '60+'
}

/**
 * 年龄 → 一行「粗标签」文案。模型对儿童估高非常严重（实测 8 岁估成 30+），
 * 所以**绝不**给精确岁数，只给分桶：'18岁以下' / '18-29岁' / '30-44岁' /
 * '45-59岁' / '60岁以上'。没算过（null / -1）或非法返回 ''。
 * @param {number|null|undefined} age
 * @returns {string}
 */
export function ageBucketLabel(age) {
  const id = ageBucket(age)
  if (id === 'unknown') return ''
  const MAP = {
    u18: '18岁以下',
    '18-29': '18-29岁',
    '30-44': '30-44岁',
    '45-59': '45-59岁',
    '60+': '60岁以上'
  }
  return MAP[id] || ''
}

/**
 * 属性 → 一行人类可读文本（设置页徽标 / 推送正文 / 远程明细共用）。
 *
 * 只输出**有把握**的部分：性别只认 male/female（''/'unknown' 不出字），
 * 年龄要 >= 0 才出（null / -1 都是"没算过"），标签走 faceAttrTags。
 * 三个维度全空返回 '' —— 调用方据此判断"要不要画分隔符"，不必自己判空。
 *
 * @param {{gender?:string, age?:number|null, attr?:object|null}} f
 * @param {string} [sep] 分隔符（远程明细用 ' · '，一行内已用 · 时可传 '/'）
 * @returns {string} 例如 '男 · 30-44岁 · 口罩 · 闭眼'（年龄只给粗分桶，见 ageBucketLabel）
 */
export function faceAttrText(f, sep = ' · ') {
  if (!f) return ''
  const parts = []
  if (f.gender === 'male') parts.push('男')
  else if (f.gender === 'female') parts.push('女')
  const ageLabel = ageBucketLabel(f.age)
  if (ageLabel) parts.push(ageLabel)
  faceAttrTags(f.attr).forEach((id) => parts.push(faceAttrLabel(id)))
  return parts.join(sep)
}

/**
 * 一条记录的属性「够不够格进统计」。
 *
 * 只认**真的算过属性**的记录（有性别，或有口罩眼镜那一组概率）。
 * 为什么要这个闸门：属性模型可以关掉（face.genderAge / face.attrib），
 * 关掉之后每条记录都没有属性字段 —— 如果这种记录也计入分母，
 * 统计页会显示「属性样本 1200 条、男 0 女 0」，看着像模型坏了。
 * @param {object} rec 事件记录
 * @returns {boolean}
 */
export function hasFaceAttrs(rec) {
  if (!rec) return false
  if (rec.gender === 'male' || rec.gender === 'female') return true
  return !!(rec.attr && typeof rec.attr === 'object')
}
