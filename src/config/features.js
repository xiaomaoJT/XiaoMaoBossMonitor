/**
 * 附加分析能力的**唯一权威定义**（前后端共享）
 * ----------------------------------------------------------------------------
 * 能力（人脸 / 人脸命中 / 姿态 / 区域 / 计数）的开关判定，画面芯片、推送消息里的
 * 「功能状态」、事件详情里的名单，全部走这一份 ——
 * 免得出现「画面上显示开了、推送里说没开」这种自相矛盾。
 *
 * ⚠️ 这个文件必须保持**零依赖**：后端 server/ 也是直接 import 它的，
 *    一旦引入浏览器 API 或 Vue，后端就跑不起来了。
 */

/**
 * 通道级附加能力开关。
 *
 * 语义是「分流」而不是「总闸」：全局总开关（options.face.enabled 等）关着的时候，
 * 这里即使为 true 也不会有任何动作；只有在全局开着的前提下，
 * 这一路把某个能力设为 false 才表示"这个通道不参与"。
 * 老配置里没有这个字段 → undefined → 视为参与，行为与升级前一致。
 *
 * @param {object} cam 通道配置
 * @param {'face'|'pose'|'zone'} key 能力名
 */
export function camExtOn(cam, key) {
  const ext = (cam && cam.aiExt) || {}
  return ext[key] !== false
}

/**
 * 通道级「人脸命中」模式开关。
 *
 * ⚠️ 与上面 `camExtOn` 的「缺省即参与」语义**相反**：这里缺省是**关**。
 *    因为它是**收窄推送**的限制型开关 —— 一旦为真，这一路**只有命中已录入人脸
 *    （在库人脸）的变动才会推送**，画面变动 / 人形 / 姿态 / 区域都不再单独推。
 *    默认打开会悄悄改变所有人现有的推送行为，所以只有显式设为 true 才算开。
 *
 * 依赖链（强依赖，缺一不可）：人形识别 `cam.ai` → 人脸识别 `cam.aiExt.face`
 *    → 全局人脸总闸 `options.face.enabled` → 底库非空 → 才可能"命中"。
 * 判定「这一路是否真的处于命中模式」用 EXT_FEATURES 里那一条的 `on`（含全部前置）。
 *
 * @param {object} cam 通道配置
 */
export function camHitOn(cam) {
  const ext = (cam && cam.aiExt) || {}
  return ext.hit === true
}

/**
 * on(cam, options) 的语义是「这一刻它真的在跑」：
 * 通道开着人形识别 + 通道级没关 + 全局总闸开着
 * （区域/计数还要求前置条件成立，例如真圈过区域）。
 */
export const EXT_FEATURES = [
  {
    key: 'face',
    label: '人脸识别',
    short: '人脸',
    on: (cam, o) => !!(cam && cam.ai) && camExtOn(cam, 'face') && !!(o.face && o.face.enabled)
  },
  {
    key: 'hit',
    label: '人脸命中',
    short: '人脸命中',
    /*
     * 只有「人在库」才算命中，所以它必须建立在前面的链路上：
     *   人形识别开 → 这一路的人脸识别开 → 全局人脸总闸开 → 才可能命中。
     * 三者任一不成立，「人脸命中」都不算在跑（画面上就不该亮这个芯片）。
     */
    on: (cam, o) =>
      !!(cam && cam.ai) &&
      camExtOn(cam, 'face') &&
      camHitOn(cam) &&
      !!(o.face && o.face.enabled)
  },
  {
    key: 'pose',
    label: '人形姿态',
    short: '姿态',
    on: (cam, o) => !!(cam && cam.ai) && camExtOn(cam, 'pose') && !!(o.pose && o.pose.enabled)
  },
  {
    key: 'zone',
    label: '区域规则',
    short: '区域',
    // 圈了区域才算「在跑」，否则只是个空开关
    on: (cam, o) => !!(cam && cam.ai) && camExtOn(cam, 'zone') && ((cam && cam.zones) || []).length > 0
  },
  {
    key: 'count',
    label: '人员计数',
    short: '计数',
    // 计数挂在通道的「区域规则」开关下，但不需要真的圈区域
    on: (cam, o) => !!(cam && cam.ai) && camExtOn(cam, 'zone') && !!(o.zone && o.zone.countEnabled)
  }
]

/** 只取真正在跑的（画面芯片用：没开的一律不画） */
export function activeFeatures(cam, options) {
  const o = options || {}
  return EXT_FEATURES.filter((d) => d.on(cam, o)).map((d) => ({ key: d.key, label: d.short, full: d.label }))
}

/**
 * 「画面变动」（移动检测）是否开启 —— 只算**配置**，不含"这一路此刻在不在解码"。
 * 这是移动检测开关的唯一权威定义：CameraTile 的 analysisOn = decode && motionOn(...)。
 */
export function motionOn(cam, options) {
  const o = options || {}
  return !!o.analysisEnabled && !!(cam && cam.motion !== false)
}

/**
 * 这一路**配置为要跑**的检测项全集：画面变动 / 人形 / 人脸 / 姿态 / 区域 / 计数。
 *
 * ⚠️ 存在的理由：盲视面板的「检测运行中」以前只看 `cam.motion`，
 *    于是"关了移动检测、开着人形识别"时面板写着「检测已关闭」，
 *    而画面顶上的人形芯片亮着 —— 同一个事实在同一个画面上两个说法。
 *    现在两处都从这里取，不可能再各说各话。
 *
 * 人形只认 `cam.ai`（与画面的人形芯片、「更多」菜单里的「人形识别」一致），
 * 不再叠一层全局 aiEnabled —— 后端模式下前端会把 aiEnabled 强制关掉，
 * 而人形检测其实跑在服务端，叠全局闸反而会把「真的在跑」显示成没跑。
 */
export const DETECT_FEATURES = [
  { key: 'motion', label: '画面变动', on: (cam, o) => motionOn(cam, o) },
  { key: 'person', label: '人形', on: (cam) => !!(cam && cam.ai) },
  ...EXT_FEATURES.map((d) => ({ key: d.key, label: d.short, on: d.on }))
]

/** 这一路真正开着的检测项（顺序固定：画面变动 → 人形 → 人脸 → 姿态 → 区域 → 计数） */
export function activeDetects(cam, options) {
  const o = options || {}
  return DETECT_FEATURES.filter((d) => d.on(cam, o)).map((d) => ({ key: d.key, label: d.label }))
}

/**
 * 全量状态（推送消息用）。
 * 和 activeFeatures 相反：这里**开了的要报，没开的也要显式说明「未开启」**——
 * 用户要的是「开了啥就带啥，没开就告诉我它没开」。
 */
export function featureState(cam, options) {
  const o = options || {}
  return EXT_FEATURES.map((d) => ({ key: d.key, label: d.label, short: d.short, on: d.on(cam, o) }))
}
