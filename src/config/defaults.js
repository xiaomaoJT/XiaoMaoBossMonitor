/**
 * 配置分成两层，互不污染：
 *
 *   1. 初始化配置（DEFAULT_*）——「空白」。打开就是一块空大屏：没有任何通道、
 *      没有推送凭据、AI 附加能力全关，一切都由用户自己配。
 *      底部的「恢复初始化」就是回到这一份。
 *
 *   2. 内置隐藏配置（HIDDEN_*）——完整的一份（7 路真实通道 + 推送凭据 + 摆放坐标）。
 *      只在「配置方案 → 加载内置配置」输入访问密码后载入，不会混进初始化配置里。
 */

const BASE = 'wss://media.example.com:443/rtp/00000000000000000000_000000000000000000'
const TAIL = '.live.flv?originTypeStr=rtp_push&videoCodec=H265'

/**
 * 内置隐藏配置的通道预置（真实名称 / 检测开关 / 摆放坐标）。
 * 仅在「配置方案 → 加载内置配置」输入密码后载入，不出现在初始默认值里。
 * 数组顺序 = 大屏里的默认排列顺序；
 * rect 是「自定义摆放」布局下的百分比坐标（0~100，相对大屏可视区）。
 */
const HIDDEN_CAMERA_PRESET = [
  { id: 'cam-1', name: '门口', motion: true, ai: true, blind: true, push: true, rect: { x: 1.29, y: 0.62, w: 31.29, h: 31.75 } },
  { id: 'cam-4', name: '电梯', motion: true, ai: true, blind: true, push: true, rect: { x: 1, y: 34, w: 32, h: 32 } },
  { id: 'cam-6', name: '大厅', motion: true, ai: true, blind: true, push: true, rect: { x: 67, y: 34, w: 32, h: 32 } },
  { id: 'cam-3', name: '厕所', motion: false, ai: false, blind: false, push: false, rect: { x: 34, y: 1, w: 32, h: 32 } },
  { id: 'cam-2', name: '通道1', motion: false, ai: false, blind: false, push: false, rect: { x: 67, y: 1, w: 32, h: 32 } },
  { id: 'cam-7', name: '通道2', motion: false, ai: false, blind: false, push: false, rect: { x: 1, y: 67, w: 32, h: 32 } },
  { id: 'cam-5', name: '楼梯', motion: false, ai: false, blind: false, push: false, rect: { x: 34, y: 34, w: 32, h: 32 } }
]

/**
 * 内置隐藏配置里「默认不显示」的通道：厕所 / 通道1 / 通道2 / 楼梯。
 * 载入内置配置后大屏只留 门口 / 电梯 / 大厅 三路在跑，
 * 其余四路仍留在通道列表里（设置 → 监控通道 里把「显示」打开即可恢复）。
 */
export const HIDDEN_HIDDEN_IDS = ['cam-3', 'cam-2', 'cam-7', 'cam-5']

/** 由预置项生成一路完整通道配置（拉流地址按 cam-N 的 N 拼 01~07） */
function makeCamera(preset) {
  const index = Number(String(preset.id).replace('cam-', ''))
  return {
    id: preset.id,
    name: preset.name,
    url: `${BASE}${String(index).padStart(2, '0')}${TAIL}`,
    /**
     * 子码流地址（可空）。
     * 网格里多路同看时拉子码流（分辨率低、软解压力小一个量级），
     * 点开放大单路时才切主码流；留空 = 永远拉主码流（老配置无感）。
     */
    urlSub: '',
    /**
     * 后端专用流地址（可空）。
     *
     * 浏览器只能播 ws/wss-flv，后端却可以直接吃 **rtsp://** 或 **https://…live.mp4**
     * 这类地址（实测该平台 rtsp:554 与 https mp4 都可用）。走这些协议时
     * ffmpeg 原生拉流，不必把字节流先接进 WebSocket 再转一道 ——
     * 多路并发时更稳、也更省 CPU。
     * 留空 = 后端与页面用同一个地址（wss 走桥接）。
     */
    urlBackend: '',
    /** 是否参与运动检测 */
    motion: preset.motion,
    /** 是否对该通道做人形识别（较吃 CPU） */
    ai: preset.ai,
    /**
     * 人形识别之上的「附加能力」，这一路是否参与（默认全部参与）。
     *
     * ⚠️ 这里只是通道级的分流开关，真正的总闸在「检测识别」页的全局开关里：
     *    全局开着 + 这里不是 false → 这一路才跑。
     *    所以把不看人脸的通道关掉，就能把算力集中在真正要看的几路上。
     *   face 人脸识别 / pose 人形姿态 / zone 区域规则（进出 · 徘徊 · 计数）
     */
    aiExt: {
      face: preset.face !== false,
      pose: preset.pose !== false,
      zone: preset.zone !== false
    },
    /** 检测区域（归一化坐标 0~1），null 表示全画面 */
    roi: null,
    /** 盲视模式：隐藏画面（省渲染开销），但保持解码与检测运行 */
    blind: preset.blind,
    /** 是否把该通道的报警推送到钉钉 / 企业微信 / Telegram（总开关） */
    push: preset.push,
    /** 该通道分别推送到哪些渠道（总开关打开时生效；false = 这个渠道不推这一路） */
    channels: { ding: true, wecom: true, tg: true },
    /**
     * 自定义摆放坐标（百分比 0~100，相对大屏可视区）
     * 仅在「自定义摆放」布局下生效，null 表示尚未排布（会自动套用默认网格）
     */
    rect: preset.rect ? { ...preset.rect } : null,
    /** 检测区域列表（区域进出 / 徘徊检测用），空 = 不启用区域规则 */
    zones: []
  }
}

/** 内置隐藏配置的通道列表（与 HIDDEN_OPTIONS 配套） */
export const HIDDEN_CAMERAS = HIDDEN_CAMERA_PRESET.map(makeCamera)

/**
 * 初始默认通道：**空的**。
 * 初始化配置是空白的 —— 打开就是一块空大屏，通道全部由用户自己「+ 新增一路」添加。
 * 那份完整的 7 路预置不在这里，在 HIDDEN_CAMERAS 里，靠密码载入。
 */
export const DEFAULT_CAMERAS = []

/** 播放器解码器路径（相对页面地址，decoder.wasm 必须与它同目录） */
export const DECODER_PATH = './js/decoder.js'

/**
 * 后端检测服务（headless）的默认地址。
 * 那台 Windows 机器在局域网里的固定地址 —— 开启后端模式时自动填入，
 * 省得每次都要翻出 IP 再手敲一遍（手敲最容易错的就是端口）。
 */
export const DEFAULT_BACKEND_URL = 'http://10.0.0.12:8787'

/** 布局预设 */
export const LAYOUTS = [
  { key: 'auto', label: '自动铺满', cols: 'auto' },
  { key: '1', label: '单画面', cols: 1 },
  { key: '2', label: '2 × 2', cols: 2 },
  { key: '3', label: '3 × 3', cols: 3 },
  { key: '4', label: '4 × 4', cols: 4 },
  { key: 'focus', label: '1 大 + N 小' },
  { key: 'free', label: '自定义摆放' }
]

/**
 * 内置隐藏配置（完整版）。
 * ⚠️ 它会被打进前端构建产物（JS 包）里，密码只是 UI 层面的门槛，
 * 不是加密——拿到安装包的人理论上可以解包提取。适合"不让界面上直接看到"，
 * 不适合防有心人逆向。
 */
export const HIDDEN_OPTIONS = {
  /** 是否解码音频（枪机一般无音轨，关闭可降低 CPU 占用） */
  hasAudio: false,
  /** 优先使用 MSE / WebCodecs 硬件解码（仅 H.264 有效，H.265 会自动回退 wasm） */
  useHardDecode: false,
  /** 是否在画面上显示码率 / 帧率 */
  showStats: true,

  /* ---------------- 性能保护 ---------------- */
  /**
   * 同时解码的路数上限。H.265 走 WASM 软解非常吃 CPU，
   * 3200×1800 主码流同时解 7 路会把 CPU 打满导致页面卡死。
   * 超出上限的画面进入「省流模式」（显示占位，点击可加载）。
   * 设为 0 表示不限制（机器配置好可关闭）。
   */
  maxDecode: 3,
  /**
   * 打开页面时自动解码的路数（按画面顺序取前 N 路）。
   * 0 = 全部手动点击播放；1 = 只自动播放第一路（默认）。
   * 其余画面显示「省流模式 · 点击播放」。
   */
  autoPlayCount: 1,
  /**
   * 自定义「同时播放通道」：手动指定哪几路开机即播。
   * 非空时优先于 autoPlayCount（只播列在这里的通道，仍受 maxDecode 上限约束）；
   * 留空则按「打开时自动播放」的前 N 路规则。数组顺序 = 播放优先级。
   */
  autoPlayIds: ['cam-1', 'cam-4', 'cam-6'],
  /**
   * 点播互斥：点击某一路播放时，自动关闭其它正在播放的画面。
   * 关闭后则按「同时解码路数上限」最多并行播放。
   */
  exclusivePlay: false,
  /** 互斥点播时保留钉钉监听通道（推荐，避免监听/推送中断） */
  keepWatchedOnPlay: true,

  /* ---------------- 屏幕常亮 ----------------
   * 值守大屏的核心诉求：人不去碰键鼠时，系统默认几分钟就自动息屏，
   * 画面直接黑掉。默认**开**，开关抛在设置「播放性能」页由用户手动控制。
   *
   * 三端落地方式不同（自动挑选，见 src/composables/useWakeLock.js）：
   *   Electron → 主进程 powerSaveBlocker('prevent-display-sleep')，最小化也有效
   *   iOS 壳  → 原生插件 UIApplication.isIdleTimerDisabled
   *   Web/H5  → navigator.wakeLock('screen')，页面隐藏会被浏览器强制释放、回前台自动重申请
   */
  keepAwake: true,

  /* ---------------- 界面布局偏好 ---------------- */
  /** 界面微调：通知卡片位置等（item 117） */
  ui: {
    /**
     * 报警通知卡片（弹入式、带缩略图、10 秒自动消失）停靠在哪个角：
     *   tl = 左上（默认）、tr = 右上、bl = 左下、br = 右下
     * 靠上的位置会自动让开顶栏，不会压住品牌栏。
     *
     * 注：右下角那个**可点开的常驻事件面板**位置固定为右下角，不在这里配置 ——
     * 它是历史查阅入口，位置固定才不会和用户拖动的画面抢地方。
     */
    notifyPos: 'tl',
    /** 通知卡片与屏幕边缘的间距（px） */
    notifyGap: 14
  },

  /* ---------------- 智能分析 ---------------- */
  /** 运动检测总开关 */
  analysisEnabled: true,
  /** 灵敏度 1~10（越大越容易触发） */
  sensitivity: 5,
  /**
   * 画面变动「档次」：变动面积占画面的比例达到该百分比，才算一次有效异常
   * （低于它的抖动直接忽略，不发通知也不推送）。与灵敏度取「较大者」生效。
   *   0.3 极轻微 / 1 轻微 / 2.5 一般 / 5 明显 / 10 剧烈
   *
   * ⚠️ 降开销的关键旋钮：门槛提高 = 触发次数下降。
   * 每触发一次报警都要走「原图截图 → 补拍完整人形 → 多渠道路推送」这条重链路，
   * 所以把水桶线从「轻微」抬到「一般」是性价比最高的一刀——省的是整条链路，不是单点。
   * 灵敏度 5 换算出来是 1.92%，低于这里的 2.5%，因此实际以本档位为准。
   */
  motionMinPercent: 2.5,
  /**
   * 每路每秒采样分析的帧数（画面变动是持续开销，降一档整体省约三分之一）。
   * 值守时定在 **3 帧/秒**：2 帧偶尔会漏掉一闪而过的人，5 帧又太费 CPU
   * （多路同看时软解已经很紧张），3 是「不漏」和「跑得动」之间的平衡点。
   */
  sampleFps: 3,
  /** 同一通道两次报警的最小间隔（秒）：翻倍可直接砍掉一半的报警链路 */
  cooldownSec: 20,
  /** 需要连续多少帧判定为移动才报警（抗噪） */
  confirmFrames: 3,
  /** 报警时声音提示 */
  alarmSound: false,
  /** 在画面上常显检测区域框 */
  showRoi: false,
  /** 人形识别总开关（模型已在项目本地，无需联网下载） */
  aiEnabled: true,
  /**
   * 人形识别模型（本地 /ai/models/*.onnx）：
   * yolo11n 最快最省 / yolo11s 均衡（默认）/ yolo11m 最准
   */
  aiModel: 'yolo11s',
  /** 人形识别用的采样帧宽度（越大越准，也越吃性能，640 与模型输入匹配） */
  aiInputSize: 640,
  /** 人形置信度阈值 */
  aiScore: 0.5,
  /** 人形识别间隔（毫秒） */
  aiIntervalMs: 5000,
  /**
   * 是否允许用 WebGPU（显卡）加速推理，默认开。
   * ⚠️ 个别 Windows 显卡 / 驱动组合会让 WebGPU 后端抛
   * `Uncaught RuntimeError: memory access out of bounds`（WebAssembly trap，
   * 一旦发生整个推理线程死掉、人形框全没了）。出现这种就关掉，走 CPU 推理。
   * Worker 侧还有「trap → 自动降级 WASM」的兜底，但这里关掉更彻底。
   */
  aiGpu: true,

  /* ---------------- AI 扩展分析 ----------------
   * ⚠️ 这里是「总闸」。打开之后还要看通道级的分流开关（每个通道的 cam.aiExt）：
   *    全局开 + 该通道 aiExt 不是 false → 这一路才真的跑。
   *    只盯 1~2 路时，把其余通道的附加能力关掉，省下的算力非常可观。
   *
   * 内置（隐藏）配置里的取法：人脸开、区域进出与徘徊开、人员计数开（只统计不推送）、姿态关。
   * 姿态（YOLOv8n-pose）是这几项里最贵的，而且落到 WASM 回退时会吃满单核，所以留关。
   * 初始化配置里这些会被「洗」成全关（见下面的 DEFAULT_OPTIONS）。
   */
  /**
   * 人脸识别。
   * 成本：SCRFD 人脸检测 19ms（WebGPU）/ 76ms（WASM），
   *       MobileFaceNet 特征提取 39ms —— 后者在 WebGPU 下建不了会话，只能跑 WASM。
   * 优化：只在检出人形的帧上跑；同一个人的脸 6 秒内只提一次特征（靠轨迹去重）。
   */
  face: {
    enabled: true,
    /** 人脸检测置信度阈值 */
    score: 0.5,
    /** 判定为同一个人的余弦相似度阈值（越高越严格） */
    matchThreshold: 0.38,
    /** 人脸库容量上限 */
    libMax: 50,
    /** 同一个人的两次人脸事件最小间隔（秒） */
    cooldownSec: 30,
    /** 同一个人的脸多少秒内不重复提特征（省算力） */
    dedupeSec: 10,
    /** 识别到已录入的人 → 记事件并推送 */
    eventOnKnown: true,
    /** 检测到未录入的人脸 → 也记事件（默认关，避免刷屏） */
    eventOnUnknown: false,
    /** 把没录入的人脸暂存起来，方便在设置里一键录入 */
    collectUnknown: true,
    /** 画面上画人脸框 */
    drawBox: true
  },
  /**
   * 人形姿态（YOLOv8n-pose，17 关键点）。
   * 成本：48ms（WebGPU）/ 365ms（WASM），每帧最多处理 maxPersons 个人。
   * ⚠️ WASM 回退下非常吃 CPU，iOS 上建议保持关闭。
   */
  pose: {
    enabled: false,
    score: 0.4,
    /**
     * 每帧最多对几个人做姿态（面积大的优先）。
     * 姿态是「一人一次前向」，1 个人和 2 个人就是两倍开销 —— 默认只算最靠近镜头的那一个。
     */
    maxPersons: 1,
    /** 要上报的基础动作（没勾的动作仍然会算，只是不产生事件） */
    actions: { fall: true, handUp: false, crouch: false, stand: false }
  },
  /**
   * 区域规则：走出 / 走入区域、徘徊、人员计数。
   * 这三项都不需要额外模型，靠人形检测 + 轻量跟踪（零成本）实现，
   * 所以即使不开人脸 / 姿态也能用。
   * 区域本身画在每个通道的 zones 上（默认空 = 不启用区域规则）。
   */
  zone: {
    /** 上报「走入区域」 */
    enterAlarm: true,
    /** 上报「走出区域」 */
    exitAlarm: false,
    /** 上报「徘徊」 */
    loiterAlarm: true,
    /** 徘徊判定时长（秒）：在区域内停留超过它才可能判定为徘徊 */
    loiterSec: 20,
    /** 徘徊判定范围（归一化）：这段时间内脚点移动范围小于它才算「原地徘徊」 */
    loiterRadius: 0.08,
    /** 人员计数：统计 + 在画面上显示 + 定期推送（用户要求默认就要推） */
    countEnabled: true,
    /** current 当前人数 / total 累计人次 / both 两者 */
    countMode: 'current',
    /**
     * 计数是否定期推送到渠道。
     *
     * ⚠️ 这是**第一层**开关；第二层在各渠道的「推送哪些事件 → 人员计数」。
     * 两层都开才会真的推，任一层关掉都只是"统计但不推"。
     * 曾经默认关（怕刷屏），用户明确要求打开 —— 想静音时改这里或渠道分组即可。
     */
    countPush: true,
    /**
     * 计数推送间隔（秒）。默认 **4 小时**。
     *
     * 为什么从 60 秒改成 14400：这是一条**定时播报**而不是"报警" ——
     * 画面里 0 个人它也会照推（历史行为），60 秒一条意味着一夜之间几百条
     * 「人员计数 · 大门外」推送，用户根本没法把真正的报警从里面捞出来。
     * 4 小时一次把它还原成"定时汇报"的本意；想更密可以在设置里改
     * （10 分钟 ~ 24 小时可选）。已装的老配置会在启动时一次性迁移（见 App.vue）。
     */
    countIntervalSec: 14400,
    /** 在画面上显示当前人数 */
    showOnScreen: true
  },

  /* ---------------- 后端检测服务（headless，手动开关，默认关） ---------------- */
  /**
   * 开启后：各通道停止本地 AI 人形检测（省解码/推理算力），改为轮询
   * server/headless-monitor.mjs 提供的 HTTP API 拉事件并合入事件流。
   * 关闭后：一切回到原来的纯前端链路，两边互不影响。
   */
  backend: {
    /**
     * 开关默认**关** —— 默认还是纯前端链路（检测与推送都在这个页面里跑）。
     * 需要值守时再打开，打开的瞬间会自动填入下面这个地址。
     */
    enabled: false,
    /** 常驻设备的局域网地址：开启后端模式时若地址为空，自动填它 */
    url: DEFAULT_BACKEND_URL,
    /** 轮询间隔（毫秒） */
    pollMs: 4000,
    /**
     * 后端 ffmpeg 可执行文件路径（可空 = 用 npm 自带的 ffmpeg-static）。
     * ⚠️ 自带的是 6.0，**解不了 H.265 的「增强型 FLV」**（codecId=0 + FourCC hvc1），
     * 表现为各通道一直「拉流失败」；需要 7 以上（实测 9 正常）。
     * 走 options 一起同步过去，后端重启后生效。
     */
    ffmpegPath: ''
  },

  /* ---------------- 报警记录 ---------------- */
  /**
   * 报警记录最多保留多少条（含截图），超出后循环删除最旧的。
   * 记录与截图存在 IndexedDB 里，几百 MB 配额，200 条原图毫无压力。
   */
  maxEvents: 200,

  /* ---------------- 监控状态异常推送（全局，三个渠道共用调度） ---------------- */
  statusAlerts: {
    /** 被监听的通道出现异常（拉流失败 / 停止重试）时推送 */
    enabled: true,
    /**
     * 恢复正常时也推送一条。
     *
     * 默认**关**：值守现场的网络本来就在抖，通道会「异常 → 正常 → 异常」来回翻，
     * 每次恢复都推一条，刷屏比不推还烦。异常那一条仍然照推（那才是要处理的信息），
     * 恢复只在需要确认"问题已解决"时才值得单独看 —— 交给「定时巡检」去汇报即可。
     */
    notifyRecover: false,
    /**
     * 持续异常时的重复提醒间隔（分钟），0 = 每次故障只提醒一次。
     *
     * 内置配置给 **30**：网络抖动时同一路通道在半小时内反复掉线又恢复，
     * 30 分钟内只提醒一次，不再随抖动反复播报。
     * ⚠️ 这个窗口会**跨"恢复"延续**（见 watchdog.notifyUp）：
     *    以前一恢复就把节流戳清掉，导致每次掉线都立刻再报一条，等于没有节流。
     */
    repeatMinutes: 30
  },

  /* ---------------- 定时状态巡检（全局，三个渠道共用调度） ---------------- */
  patrol: {
    enabled: true,
    /** 巡检推送间隔（分钟） */
    intervalMinutes: 60,
    /** 只在存在异常时才推送 */
    onlyWhenAbnormal: true,
    /** 报告里是否包含非监听通道 */
    includeAll: true
  },

  /* ---------------- 静默时段（免打扰推送） ----------------
   * 全局「夜间免打扰」：在设定的时段内，被选中的渠道**不再实时逐条推送**，
   * 而是把这段时间里的所有报警先收存起来，等时段结束（截止时刻）一次性
   * 发一条**汇总消息**——既不被半夜的消息吵到，第二天早上也能一眼看全夜间发生了什么。
   *
   * 与每个渠道各自「静默时段」的区别：
   *   - 渠道级 quiet 只是「这一个渠道在那段时间不推」，没有汇总；
   *   - 这里的 silent 是**全局**的，跨三端统一收口，并且在结束时补一条详尽汇总。
   *   两者可以同时开，但 silent 优先级更高（被 silent 收存的渠道不会再走渠道级 quiet）。
   *
   * 默认开启：晚上 7 点 ~ 次日早上 8 点；三端（钉钉 / 企微 / TG）默认全部参与。
   * 汇总消息内容见 useDingTalk.buildSilentSummary：报警总数、按通道、按类型、
   * 人员识别（已识别人数）、累计到访人次、峰值同时在线等，全部列清。
   *
   * 时段可以配**多个**（slots）：夜里一场、午休再一场，各自在结束时发一条汇总。
   * 单个时段写法：{ start: '19:00', end: '08:00' }（end 小于 start 视为跨零点）。
   */
  silent: {
    /** 是否开启静默时段（默认开） */
    enabled: true,
    /**
     * 静默时段列表（item 114）。每一项是 { start, end }，支持跨零点。
     * 空数组 = 没有定时静默（但临时静默仍然可用）。
     *
     * 内置隐藏配置的默认两个时段：夜里 20:00 ~ 次日 08:00 + 午休 12:00 ~ 13:30。
     */
    slots: [
      { start: '20:00', end: '08:00' },
      { start: '12:00', end: '13:30' }
    ],
    /**
     * 免打扰「开始 / 结束」是否都推一条提醒（默认开）。
     *
     * 开始那条告诉：本次免打扰的时长、期间仍持续统计但不实时推送、结束时间，
     * 以及结束后会推送结束提醒 + 汇总本时段内捕获的全部报警；
     * 结束那条告诉：本时段结束了、期间收存了多少条报警（没有就说没有），
     * 并附上详尽汇总 —— **即使一条报警都没捕获到，结束提醒也照发**，
     * 否则用户会以为静默卡住了。
     *
     * ⚠️ 提醒发给**已配置好的三端**（钉钉 / 企微 / TG），
     * 不受下面 channels（静默期间暂停实时推送的渠道）勾选影响。
     * 关掉这个开关只保留「有报警才发的汇总」，开始 / 结束都不再通知。
     */
    preNotify: true,
    /**
     * @deprecated 老版本的单时段字段。读取时会自动并入 slots（见 useAlertPush.readSlots），
     * 保留仅为了兼容用户已保存的旧配置，新代码不要再直接用 start/end。
     */
    start: '20:00',
    end: '08:00',
    /**
     * 静默时段内暂停**实时逐条推送**的渠道（注意：不是「提醒发去哪」）。
     * 空数组 = 不暂停任何渠道（等于没开）。默认三端都参与。
     */
    channels: ['ding', 'wecom', 'tg'],

    /* ---- 临时静默（item 112）：手动「接下来 N 小时别吵我」 ----
     * 与上面的定时静默并存，且**优先级更高**：
     *   - tempUntil    截止时间戳（毫秒），0 / 缺省 = 未开启
     *   - tempSince    本次静默的**开始时刻**（毫秒）。只用于「静默查岗」（远程 /check duty）
     *                  划查询区间：第一次查岗要看的就是「静默开始 → 现在」。参与静默判定
     *                  的仍是 tempUntil，这个字段丢了不影响静默本身。
     *   - tempChannels 覆盖的渠道；空数组则沿用上面的 channels
     *   - tempLabel    用途备注（会出现在状态文案里，便于回头看当时为什么静默）
     * 用于会议、演示、临时排查这类"这段时间别给我发消息"的场景。 */
    tempUntil: 0,
    tempSince: 0,
    tempChannels: [],
    tempLabel: ''
  },

  /* ---------------- 流自愈（持续异常自动恢复） ----------------
   * 某路监控在「解码中断 / 网络断连」后，后端本身会无限退避重试（源级自愈）；
   * 但若是较顽固的故障（如 TLS 握手卡死、后端进程卡住），单纯重连可能一直起不来。
   * 这里提供「升级方案」：被监控的通道持续异常超过阈值分钟后，
   * 直接触发一次「系统重启」来彻底恢复（见 autoRestart）——对应告警示例里
   * "持续异常 · 解码中断：ws: Client network socket disconnected..." 这类问题。
   */
  streamRecovery: {
    /** 是否启用：持续异常达到阈值后升级为系统重启 */
    enabled: true,
    /** 持续异常多少分钟（被监控通道）后触发系统重启恢复，默认 30 分钟 */
    restartSystemAfterMin: 30
  },

  /* ---------------- 自动重启系统 ----------------
   * 7x24 值守的监控大屏，长时间运行容易积累内存泄漏 / 解码器卡死 /
   * 某路流僵死等「重启一下就好」的状态。这里支持按「天 + 小时」设置间隔，
   * 到点在后端进程里自愈式重启（重新拉起所有流与前端服务）。
   * 重启前会先推一条「系统即将重启」通知。
   */
  autoRestart: {
    /** 是否启用定时重启（默认关，按需开启） */
    enabled: false,
    /** 每隔多少天触发一次（0 = 不按天计） */
    days: 1,
    /** 每隔多少小时触发一次（与 days 叠加，例如 1 天 0 小时 = 每天一次） */
    hours: 0
  },

  /* ---------------- 系统级硬重启（最后手段，默认关） ----------------
   * ⚠️ 注意：这不是「重启 BossMonitor 进程」，而是重启**整台机器**。
   *    - 机器会下线几分钟；
   *    - 重启后 BossMonitor **不会自己回来**，除非另外配了开机自启
   *      （Windows 任务计划程序 / NSSM 服务、macOS launchd、Linux systemd）；
   *    - 需要管理员 / root 权限（Windows 的 shutdown、Linux 的 systemctl；
   *      macOS 走 osascript 需要给本进程授予「辅助功能」权限）。
   *
   * 它的定位是「自愈重启这条正常路子确实走不通了」时的兜底：
   * 只有 enabled 打开、且 onFailure 也打开时，才会在
   * 「拉起新进程失败 + 回滚也失败」的情况下自动执行。
   */
  systemReboot: {
    /** 是否允许执行系统级硬重启（默认关） */
    enabled: false,
    /** 允许在自愈重启与回滚都失败时自动执行，作为兜底（默认关） */
    onFailure: false
  },

  /* ---------------- 报警提醒方式 ---------------- */
  alert: {
    /** 左上角弹出的简要通知卡片（10 秒自动消失） */
    topNotify: true,
    /**
     * 事件截图留档宽度（像素）。
     * 直接从播放器原生分辨率的画布截取（例如 3200 宽），所以细节清晰；
     * 列表里的小缩略图另外单独生成，不受这里影响。
     * 0 = 原图（视频原始分辨率，最清晰，推荐）。
     */
    shotWidth: 0,
    /** 浏览器桌面通知（需要授权，切到别的窗口也能看到） */
    desktopNotify: true,
    /** 报警时闪烁页面标题（标签栏一眼可见） */
    flashTitle: true,
    /** 报警时自动把该画面放大到全屏铺满，方便立刻看清是谁 */
    autoZoom: false,
    /** 人形报警声音与移动报警区分开 */
    distinctSound: true,
    /**
     * 报警后补拍并补推一张「完整人形」原图：
     * 先按最快检测到的结果立刻推报警，再在几秒内挑一张人形最完整的高清帧补推，
     * 并把事件记录里的截图换成这张（详情/大图也是完整人形）。需该通道开启人形识别。
     */
    extraPersonShot: true
  },

  /* ---------------- 隐私遮罩 ---------------- */
  mask: {
    /** 解锁密码，留空表示点击屏幕即可恢复 */
    password: '',
    /** 无操作多少分钟后自动遮罩（0 = 关闭自动遮罩） */
    autoMaskMinutes: 0,
    /** 遮罩期间是否保持播放（关闭可省资源，但恢复需要重新拉流） */
    keepPlaying: true
  },

  /* ---------------- 钉钉报警推送 ---------------- */
  dingtalk: {
    /** 是否启用推送 */
    enabled: true,
    /** 群机器人 Webhook（完整地址） */
    webhook:
      'https://***REMOVED-ding_hook***',
    /** 加签密钥（安全设置=加签时填写，留空表示使用关键词或 IP 白名单） */
    secret: '***REMOVED-ding_secret***',
    /** 走本地代理（推荐，规避浏览器跨域限制） */
    useProxy: true,
    /**
     * 自定义代理基地址，留空 = 自动判断：
     *   浏览器/桌面端 → /dingtalk-robot（同源代理）
     *   iOS/Android 原生壳 → https://oapi.dingtalk.com（走原生网络栈）
     * 部署到服务器且没配反向代理时，可以填自建的云函数地址，例如
     *   https://your-domain.com/api/dingtalk
     */
    proxyBase: '',

    /**
     * 「需要推送的通道」—— 由「监控通道」页的推送开关派生（见 syncChannelCameras），
     * 不要当成第二个独立开关来理解/编辑。
     * 内置配置里给的就是 HIDDEN_CAMERAS 中 push 为 true 的那三路：门口 / 电梯 / 大厅。
     */
    cameras: ['cam-1', 'cam-4', 'cam-6'],

    /** 勾选要推送的事件类型（人脸 / 区域 / 姿态一并推送，计数不推） */
    events: { motion: true, person: true, face: true, zone: true, pose: true, count: true },
    /** 画面移动的变动幅度低于该百分比时不推送（0 = 不限制） */
    minRatioPercent: 0,

    /* ---- 频率限制（钉钉机器人硬限制 20 条/分钟） ---- */
    /** 同一通道两次推送的最小间隔（秒） */
    minIntervalSec: 30,
    /** 全局两次推送的最小间隔（秒） */
    globalMinIntervalSec: 3,
    /** 每分钟最多推送条数（上限 20） */
    rateLimitPerMin: 18,
    /** 超过每分钟上限时：merge 合并成一条汇总 / drop 直接丢弃 */
    overflowMode: 'merge',

    /* ---- 静默时段 ---- */
    quietEnabled: false,
    quietStart: '22:00',
    quietEnd: '07:00',

    /* ---- 消息内容 ---- */
    /** markdown 或 text */
    msgType: 'markdown',
    /** 消息标题前缀（同时可作为钉钉「自定义关键词」） */
    titlePrefix: '【监控报警】',
    /** 推送内容包含哪些字段 */
    fields: {
      camera: true,
      cameraId: false,
      time: true,
      type: true,
      ratio: true,
      confidence: true,
      resolution: true,
      bitrate: true,
      url: false,
      roi: true,
      seq: true,
      screenshot: true
    },

    /* ---- 事件原图 ----
     * 默认不传图片，而是在消息末尾附一条 Telegram 原图链接（点开去 TG 看原图）。
     * 需要钉钉里直接看到图时，才改成上传图床 / 自建接口：
     *   tg        只带 Telegram 原图链接（推荐：零额外开销，不传图）
     *             —— 优先指到本次那条 TG 消息；本次没推 TG 则退回群链接
     *   litterbox 上传到零配置图床后直接嵌图，国内可直连（最长 72 小时有效）
     *   upload    上传到自建接口后嵌图（需接口返回公网 URL）
     *   none      既不带图也不带链接（截图仍保存在本地事件面板）
     */
    screenshotMode: 'tg',
    /** litterbox 图床的文件有效期：1h / 12h / 24h / 72h */
    imageHostTtl: '72h',
    uploadUrl: '',
    uploadField: 'file',

    /* ---- 监控状态异常推送 ---- */
    statusAlerts: {
      /** 被监听的通道出现异常（拉流失败 / 停止重试）时推送 */
      enabled: true,
      /** 恢复正常时也推送一条 */
      notifyRecover: true,
      /** 持续异常时的重复提醒间隔（分钟），0 = 只提醒一次 */
      repeatMinutes: 10
    },

    /* ---- 定时状态巡检 ---- */
    patrol: {
      enabled: true,
      /** 巡检推送间隔（分钟） */
      intervalMinutes: 30,
      /** 只在存在异常时才推送 */
      onlyWhenAbnormal: false,
      /** 报告里是否包含非监听通道 */
      includeAll: true
    },

    /* ---- @ 设置 ---- */
    atAll: false,
    /** 手机号，多个用英文逗号分隔 */
    atMobiles: ''
  },

  /* ---------------- Telegram 推送（图片走这里） ---------------- */
  telegram: {
    /**
     * 是否启用 Telegram 推送。
     * 钉钉自定义机器人的 markdown 图片必须是公网可访问的 http(s) 地址，
     * 而 Telegram Bot 支持直接上传文件（multipart），所以报警截图统一由 Telegram 发送。
     * 钉钉与 Telegram 可同时开启，事件会同时推送到两边。
     */
    enabled: true,
    /** 机器人 Token（@BotFather 里获取，形如 123456789:AA....） */
    token: '***REMOVED-tg_token***',
    /**
     * 目标会话 ID：群组 / 频道 / 私聊。
     * 超级群与频道的 id 必须带 -100 前缀（例如 1234567890 → -1001234567890）。
     */
    chatId: '-1001234567890',
    /**
     * 群 / 频道的公开用户名（就是 t.me 链接里那一段，例如 my_monitor_group）。
     * 填了它才能生成 https://t.me/my_monitor_group/<消息ID> 这种手机点开就能跳转的链接；
     * 留空则退回 t.me/c/<内部ID>/<消息ID>（这种只有装过 TG 且已入群才能打开）。
     */
    groupUsername: 'my_monitor_group',
    /** 图片发送方式：photo = 聊天里直接预览（TG 会压缩）；document = 原始文件，不压缩 */
    sendMode: 'photo',
    /** 事件有截图时一并发送图片 */
    withPhoto: true,
    /** 静默发送（收到但不响铃、不弹通知） */
    silent: false,
    /** 报警截图是否也作为文件再发一份原图（想看无损原图时开启） */
    alsoSendOriginal: false,

    /* ---- 需要推送的通道 id 列表（由通道级推送开关派生，见 syncChannelCameras） ---- */
    cameras: ['cam-1', 'cam-4', 'cam-6'],
    /** 勾选要推送的事件类型（人脸 / 区域 / 姿态一并推送，计数不推） */
    events: { motion: true, person: true, face: true, zone: true, pose: true, count: true },

    /* ---- 这个渠道是否接收「监控异常」与「定时巡检」通知 ---- */
    statusAlerts: { enabled: true },
    patrol: { enabled: true },

    /* ---- 远程控制（方案 C：TG 私聊指令控制后端） ----------------
     * 不需要公网入口：后端用 Bot API 的 getUpdates 长轮询取指令，
     * 你在手机上私聊机器人发 /silent 2h 就能控制这台机器。
     *
     * ⚠️ 安全边界（改之前务必读完）：
     *   1. **只认私聊** —— chat.type 必须是 'private'，群里任何人发都直接忽略；
     *   2. **只认白名单用户** —— allowUserIds 之外的 id 一律不回不回、不执行；
     *   3. 远程能重启机器，所以**默认关闭**，要显式打开 remote.enabled 才会监听指令。
     */
    remote: {
      /** 是否接受 TG 指令（安全起见默认关闭） */
      enabled: false,
      /**
       * 允许发指令的 Telegram 用户 id（数字）。
       * 空数组 = 谁都不能控制；多个 id 用逗号分隔。
       * ⚠️ 这是**唯一的身份判据**，不要为了图省事填群 id。
       */
      allowUserIds: ['100000001'],
      /** 长轮询间隔（毫秒）。Telegram 建议 ≤50s；调大省流量但响应变慢 */
      pollMs: 3000,
      /**
       * 是否允许 /reboot（重启系统）。
       * 危险动作单独一档开关：调试远程功能时先关掉，确认无误再开。
       */
      allowReboot: false,
      /**
       * 静默查岗（/check duty）单次最多推几张截图。
       * 0 = 不限（只受代码里 200 张的防呆上限约束）—— 默认就是这个，因为用户要的是
       * 「图片全部推送过来」。觉得刷屏就调小，超出的部分可在事件面板里回看。
       */
      dutyMaxImages: 0,
      /**
       * 静默查岗：两张截图之间的间隔（毫秒）。
       * Telegram 对同一会话的连续 sendPhoto 有频率限制，并发发图大概率被 429 拒掉，
       * 所以刻意串行 + 留间隔。网络差 / 图大时可以调大到 1200~2000。
       */
      dutyImageGapMs: 700
    }
  },

  /* ---------------- 企业微信推送（群机器人 Webhook） ---------------- */
  wecom: {
    /** 是否启用企业微信推送（可和钉钉 / Telegram 同时开启） */
    enabled: true,
    /**
     * 群机器人 Webhook 完整地址，形如
     *   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa
     * 只填 key 那一串也行，代码会自动补全前缀。
     */
    webhook:
      'https://***REMOVED-wecom_hook***',
    /**
     * 自定义代理基地址，留空 = 自动判断（与钉钉同理）：
     *   浏览器/桌面端 → /wecom-bot（同源代理）
     *   iOS/Android 原生壳 → https://qyapi.weixin.qq.com（原生网络栈）
     */
    proxyBase: '',

    /** 需要推送的通道 id 列表（由通道级推送开关派生，见 syncChannelCameras） */
    cameras: ['cam-1', 'cam-4', 'cam-6'],
    /** 勾选要推送的事件类型（人脸 / 区域 / 姿态一并推送，计数不推） */
    events: { motion: true, person: true, face: true, zone: true, pose: true, count: true },
    /** 画面移动的变动幅度低于该百分比时不推送（0 = 不限制） */
    minRatioPercent: 0,

    /* ---- 频率限制（企业微信群机器人同样是 20 条/分钟） ---- */
    minIntervalSec: 30,
    globalMinIntervalSec: 3,
    rateLimitPerMin: 18,
    overflowMode: 'merge',

    /* ---- 静默时段 ---- */
    quietEnabled: false,
    quietStart: '22:00',
    quietEnd: '07:00',

    /* ---- 消息内容 ---- */
    /** text 或 markdown */
    msgType: 'markdown',
    /** 消息标题前缀（可兼作企业微信机器人的关键词过滤） */
    titlePrefix: '【监控报警】',
    /** 推送内容包含哪些字段 */
    fields: {
      camera: true,
      cameraId: false,
      time: true,
      type: true,
      ratio: true,
      confidence: true,
      resolution: true,
      bitrate: true,
      url: false,
      roi: true,
      seq: true,
      screenshot: true
    },

    /* ---- 报警截图 ----
     * 企业微信的 image 消息直接收 base64 + md5，不需要公网图床，是最省事的方式。
     *   image      随报警消息直接发一张截图（最大 2MB，超限自动压缩）—— 推荐
     *   tg         文字消息里附一条 Telegram 原图链接（本次没推 TG 则给群链接）
     *   litterbox  上传到零配置图床后在文字消息里附链接（国内可直连）
     *   none       既不带图也不带链接
     */
    screenshotMode: 'image',
    /** litterbox 图床的文件有效期：1h / 12h / 24h / 72h */
    imageHostTtl: '72h',

    /* ---- 这个渠道是否接收「监控异常」与「定时巡检」通知 ---- */
    statusAlerts: { enabled: true },
    patrol: { enabled: true },

    /* ---- 提醒（企业微信 text 消息的 mentioned_list） ---- */
    atAll: false,
    /** 成员手机号，多个用英文逗号分隔 */
    atMobiles: ''
  }
}

/**
 * 初始化默认配置：在隐藏配置的基础上「洗」出一份**空白**配置。
 *
 * 洗掉的是所有「个人化」的东西：推送凭据、绑定的通道、AI 附加能力总闸、播放策略。
 * 留下的都是产品级的中性参数（变动档位、采样帧率、事件保留条数……），
 * 那些是"可用性默认"而不是"个人数据"，所以跟着隐藏配置一起演进。
 *
 * ⚠️ 通道列表不在这里 —— 走 DEFAULT_CAMERAS（空数组）。
 */
export const DEFAULT_OPTIONS = (() => {
  const o = JSON.parse(JSON.stringify(HIDDEN_OPTIONS))

  /* ---- 外观主题：liquid = 液态风格（玻璃质感）；dark / light / auto 见设置「外观」 ---- */
  o.theme = 'liquid'

  /* ---- 巡检 / 异常推送：初始化的空白配置里全部默认关闭，别一上来就打扰用户 ---- */
  o.statusAlerts.enabled = false
  o.statusAlerts.notifyRecover = false
  o.patrol.enabled = false

  /*
   * 后端检测服务：初始化配置是「什么都不知道」的空白状态，默认保持关闭
   * （默认链路 = 纯前端）。地址仍然预填着 —— 用户一打开开关就能连上，
   * 不需要先去把 IP 抄一遍。
   */
  o.backend.enabled = false

  /* ---- 播放策略：回到中立默认（初始化没有通道，开机不自动播任何画面） ---- */
  o.maxDecode = 4
  o.autoPlayCount = 1
  o.autoPlayIds = []
  o.exclusivePlay = true
  /*
   * 后台时暂停画面：默认**关**。
   * 监控大屏的核心价值是「人不在屏幕前也在记录」—— 暂停解码等于连运动检测、
   * AI 识别、报警推送一起停了。这个开关是给笔记本 / 手机等在意耗电的
   * 场景准备的，由用户自己在「播放性能」里决定开不开。
   */
  o.pauseWhenHidden = false

  /*
   * 屏幕常亮：初始化配置里也保持**开**。
   * 它不属于"个人化数据"，而是监控大屏的产品级默认 ——
   * 刚装好、还没配通道时，用户第一件事就是盯着屏幕调试，
   * 这时候屏幕自己黑掉非常影响体验。用户在设置里可以随时关掉。
   */
  o.keepAwake = true

  /* ---- AI 附加能力：总闸全关，用不用由用户自己决定 ---- */
  /*
   * aiEnabled 是「人形检测」总闸。它原本在 HIDDEN_OPTIONS 里是开的，
   * 而这里只洗了 face / pose / zone —— 结果「恢复初始化」之后首屏照样去拉
   * 默认模型（yolo11n 10MB，选 large 则 36MB）。空白配置就该是克制的：
   * 没配摄像头、没开推送，自然也不该先替用户下模型。
   */
  o.aiEnabled = false
  o.face.enabled = false
  o.pose.enabled = false
  o.zone.countEnabled = false
  /*
   * 「定期推送人数」也归零。
   * 设置页那句说明写的就是「默认关，避免刷屏」，但默认值一直是 true ——
   * 文案和行为对不上。初始化既然是"什么都没有"，这条定时播报也不该预先打开；
   * 用户真想定时收到人数播报时，自己在「检测识别 → 区域」里打开即可。
   */
  o.zone.countPush = false

  /* ---- 三个推送渠道：关闭 + 凭据清空 + 解绑通道 ---- */
  const wipe = (ch, keys) => {
    ch.enabled = false
    keys.forEach((k) => (ch[k] = ''))
    ch.cameras = []
    /*
     * 渠道级的「异常通知 / 巡检报告」子开关也一并归零。
     * 不归零会留下一个刺眼的不一致：全局 statusAlerts / patrol 已经关掉了（见上），
     * 但三个渠道的对应子开关还是 true —— 界面上就会出现
     * 「正文写着未启用、页签徽标却亮着 on」的自相矛盾。
     * 空白配置就该是彻底关干净的。
     */
    if (ch.statusAlerts) ch.statusAlerts.enabled = false
    if (ch.patrol) ch.patrol.enabled = false
  }
  wipe(o.dingtalk, ['webhook', 'secret'])
  wipe(o.telegram, ['token', 'chatId', 'groupUsername'])
  wipe(o.wecom, ['webhook'])

  /*
   * 远程控制的白名单 id **只活在隐藏配置（HIDDEN_OPTIONS）里**，不许进默认配置。
   * 初始化配置里把它清空（没人能下发指令），只有「加载内置配置」输密码后才带回来。
   * 否则「恢复初始化」之后白名单还在，等于把授权 id 写死进了空白配置。
   */
  if (o.telegram.remote) o.telegram.remote.allowUserIds = []

  return o
})()

/** 「加载内置配置」的访问密码 */
export const HIDDEN_PASSCODE = '***REMOVED-passcode***'

/**
 * 深拷贝一份内置隐藏配置（通道 + 通道可见性 + 配置）。
 * 载入后大屏只留 HIDDEN_HIDDEN_IDS 之外的三路，其余四路在通道列表里但默认不显示。
 */
export function cloneHiddenConfig() {
  const cameras = JSON.parse(JSON.stringify(HIDDEN_CAMERAS))
  const options = JSON.parse(JSON.stringify(HIDDEN_OPTIONS))
  /*
   * 渠道级「需要推送的监控」名单直接从通道级推送开关派生一次 ——
   * 免得 HIDDEN_CAMERA_PRESET 里改了哪几路要推，这边忘了跟着改，
   * 又出现「监控通道里开了推送、实际推不出去」的那种不一致。
   */
  syncChannelCameras(cameras, options)
  return { cameras, options, hiddenIds: [...HIDDEN_HIDDEN_IDS] }
}

/**
 * 深拷贝一份「初始化配置」——空白的那个。
 * 「恢复初始化」用的就是它：0 路通道 + 空白 options + 无隐藏记录。
 */
export function cloneInitConfig() {
  return {
    cameras: cloneDefaultCameras(),
    options: cloneDefaultOptions(),
    hiddenIds: []
  }
}

/** 品牌信息（顶栏 / 关于页 / 桌面端 / 移动端共用） */
export const BRAND = {
  name: 'XiaoMao',
  fullName: 'BossMonitor',
  slogan: '7 路实时预览 · AI 人形识别 · 多端推送',
  logo: './logo/logo.png',
  version: '1.0.0'
}

export const STORAGE_KEY = 'monitor-wall-config-v1'

/** 深拷贝一份默认配置，避免多处共享同一个对象引用 */
export function cloneDefaultOptions() {
  return JSON.parse(JSON.stringify(DEFAULT_OPTIONS))
}

/** 深拷贝一份默认摄像头列表 */
export function cloneDefaultCameras() {
  return DEFAULT_CAMERAS.map((c) => ({
    ...c,
    roi: c.roi ? { ...c.roi } : null,
    rect: c.rect ? { ...c.rect } : null,
    channels: { ...c.channels },
    aiExt: { ...c.aiExt },
    zones: (c.zones || []).map((z) => ({ ...z, rect: { ...z.rect } }))
  }))
}

/**
 * 三个推送渠道：`id` = 通道级 channels 的字段名，`cfgKey` = options 里的配置块名。
 * 顺序 = 界面上展示的顺序。
 */
export const PUSH_CHANNEL_KEYS = [
  { id: 'ding', cfgKey: 'dingtalk', label: '钉钉' },
  { id: 'wecom', cfgKey: 'wecom', label: '企微' },
  { id: 'tg', cfgKey: 'telegram', label: 'TG' }
]

/**
 * 由「通道级推送配置」派生各渠道的「需要监听的监控」名单（渠道配置里的 cameras）。
 * ----------------------------------------------------------------------------
 * 唯一权威是「监控通道」页那一份：cam.push（总开关）+ cam.channels[渠道]。
 * 渠道配置里的 cameras 只是它的**镜像**，服务两类消费方：
 *   - 后端 watchdog 判断「哪几路掉线要提醒」（isWatchedCamera）
 *   - 后端 headless-monitor 判断「哪几路要保活拉流」、状态页展示
 *
 * ⚠️ 历史坑：这份镜像以前是**独立可编辑**的第二道闸，而 checkChannel 把
 * 「通道级」和「渠道级」做 AND —— 于是渠道配置里默认只有第一个通道（cam-1）时，
 * 「监控通道」页把门口/电梯/大厅 三路推送都打开也没用，只有门口能推出来。
 * 现在镜像由通道级单向派生，两边不可能再打架。
 *
 * ⚠️ 只在内容真的变了才赋值：调用方（App.vue）会把它挂在 options 的深度监听上，
 * 无条件赋新数组会「写 → 触发监听 → 再写」造成死循环。
 *
 * @param {Array}  cameras 当前通道列表
 * @param {object} opts    options 配置对象（会原地更新 dingtalk/wecom/telegram.cameras）
 */
export function syncChannelCameras(cameras, opts) {
  if (!opts || typeof opts !== 'object') return
  const list = Array.isArray(cameras) ? cameras : []
  PUSH_CHANNEL_KEYS.forEach(({ id, cfgKey }) => {
    const cfg = opts[cfgKey]
    if (!cfg || typeof cfg !== 'object') return
    const want = list
      .filter((cam) => cam && cam.push !== false && !(cam.channels && cam.channels[id] === false))
      .map((cam) => cam.id)
    const cur = Array.isArray(cfg.cameras) ? cfg.cameras : null
    // 内容一致就一个字节都不动（幂等）
    if (cur && cur.length === want.length && cur.every((x, i) => x === want[i])) return
    cfg.cameras = want
  })
}

/** 补齐历史配置里缺失的通道级推送开关，避免旧存档读进来是 undefined */
export function normalizeCameraChannels(cam) {
  if (!cam || typeof cam !== 'object') return cam
  const src = cam.channels && typeof cam.channels === 'object' ? cam.channels : {}
  cam.channels = { ding: src.ding !== false, wecom: src.wecom !== false, tg: src.tg !== false }
  if (cam.push === undefined) cam.push = true
  // 子码流是后加的字段，老存档里没有 → 补成空串（= 永远拉主码流，行为不变）
  if (typeof cam.urlSub !== 'string') cam.urlSub = ''
  // 后端专用流地址同样是后加的，老存档补空串（= 与页面共用同一个地址）
  if (typeof cam.urlBackend !== 'string') cam.urlBackend = ''
  // 区域规则是后加的字段，老存档里没有
  if (!Array.isArray(cam.zones)) cam.zones = []
  // 附加能力（人脸 / 姿态 / 区域）也是后加的字段，老存档里没有 → 默认全部参与
  const ext = cam.aiExt && typeof cam.aiExt === 'object' ? cam.aiExt : {}
  cam.aiExt = {
    face: ext.face !== false,
    pose: ext.pose !== false,
    zone: ext.zone !== false
  }
  return cam
}

/** 新建摄像头时使用的默认地址模板 */
export const URL_TEMPLATE = `${BASE}01${TAIL}`
