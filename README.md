# BossMonitor · 视频监控多路实时预览大屏

> 一个「大屏看画面 + 后台常驻盯人 + 出事推到手机」的完整监控系统。
> Web 一份代码，同时跑在 **浏览器 / macOS 桌面端 / Windows / iOS / Apple Watch / 微信小程序** 六个端上。

---

## 目录

- [一、这是什么](#一这是什么)
- [二、核心能力](#二核心能力)
- [三、整体架构](#三整体架构)
- [四、目录结构](#四目录结构)
- [五、运行逻辑](#五运行逻辑)
- [六、各端运行方式](#六各端运行方式)
- [七、配置说明](#七配置说明)
- [八、远程控制指令](#八远程控制指令)
- [九、HTTP API](#九http-api)
- [十、环境变量](#十环境变量)
- [十一、常见问题与排障](#十一常见问题与排障)
- [十二、技术栈](#十二技术栈)

---

## 一、这是什么

BossMonitor 最初是一个「7 路摄像头铺满一块大屏」的网页，后来长成了下面这套东西：

- **一块大屏**：多路实时画面（H.265 ws-flv 也能解），支持网格 / 自动铺满 / 自由摆放三种布局、单路放大、隐藏、隐私遮罩。
- **一个检测大脑**：画面移动、人形识别、**人脸识别（可建人脸库）**、**区域进出 / 徘徊**、**人形姿态（跌倒 / 举手 / 蹲下）**、**人员计数**。
- **一条推送链路**：钉钉群机器人 / 企业微信群机器人 / Telegram Bot 三端，带限流、合并、免打扰时段、静默期汇总。
- **一个常驻后端**：`server/` 下的 headless 服务 —— **把所有页面关掉，它照样在盯人、照样在推送**。
- **一套远程遥控**：在手机上私聊 Telegram 机器人发指令，就能静默推送、查岗要截图、重启服务，甚至重启整台机器。

核心设计取向：**同一份逻辑，不让它漂移两份**。前端和 Node 后端跑的是**同一批 composable 源码**（靠一层 `compat.mjs` 补上 `window` / `document` / `localStorage`），所以钉钉的加签、企微的限流、消息模板、静默策略在两边的行为天然一致。

---

## 二、核心能力

### 画面与播放

| 能力 | 说明 |
|---|---|
| 多路实时预览 | 网格（自适应列数）/ 自动铺满 / 自由摆放（拖拽改位置尺寸） |
| H.265 ws-flv | 用 Jessibuca（WASM 软解）在浏览器内解码，无需插件 |
| 主 / 子码流切换 | 网格里多路同看自动拉子码流降压；点开放大单路切主码流 |
| 解码路数保护 | `maxDecode` 限制并发解码路数，超出自动排队 |
| 单路放大 / 隐藏 | 未隐藏的通道可随时恢复；顶栏一键「恢复全部」 |
| 隐私遮罩 | 一键盖住整屏，可设自动遮罩时长与解锁密码（遮罩期间画面可继续播） |
| 屏幕常亮 | Web / Electron / iOS 三端统一开关，挂机值守必备 |

### 检测与分析

| 能力 | 实现 | 依赖模型 |
|---|---|---|
| 画面移动 | 帧差法，缩到 ~256px 灰度逐像素差分 | 无（零模型） |
| 人形识别 | YOLO 检测 COCO `person` | `yolo11n` / `yolo11s` |
| 人脸识别 | SCRFD 检测 + MobileFaceNet 512 维特征 + 余弦比对 | `scrfd-500m` + `mobilefacenet` |
| 区域规则 | 进出 / 徘徊（纯几何，靠跨帧轨迹连续性） | 无 |
| 人形姿态 | 17 关键点 → 跌倒 / 举手 / 蹲下 | `yolov8n-pose` |
| 人员计数 | 按配置间隔播报当前 / 累计人数 | 复用跟踪器 |
| 未录入人脸收集 | 认不出的脸自动进「待录入」队列，可一键录入人脸库 | — |

> 四项扩展能力（人脸 / 姿态 / 区域 / 计数）有两层开关：**全局总闸**（`options.face.enabled` 等）和**通道级分流**（`cam.aiExt`）。总闸关着时，通道级即使为 true 也不会有动作 —— 这一份判定集中在 `src/config/features.js`，前后端共用，不会出现「画面上显示开了、推送里说没开」。

### 推送与通知

- **三渠道**：钉钉（加签 + text/markdown）、企业微信（markdown + 图片 base64）、Telegram Bot（直接上传截图）。
- **各渠道独立限流**：`globalMinIntervalSec`（全局最小间隔）、`rateLimitPerMin`（每分钟上限）、超限合并策略（`merge` / `drop`）。
- **事件筛选**：按通道勾选推哪些事件类型（移动 / 人形 / 人脸 / 区域 / 姿态 / 计数）、按最小面积比过滤。
- **免打扰（静默）**：支持多个时段（如 `20:00-08:00` + `12:00-13:30`）和临时静默（`/silent 2h`），静默开始/结束都发提醒，静默期间的报警**收存起来、结束时汇总推送**。
- **消息模板**：三端排版可自定义并实时预览（`推送模板` 页）。
- **补图推送**：报警后补拍完整人形 / 人脸特写再补推一条。
- **状态巡检**：通道掉线推「监控异常」，恢复推「监控恢复」，持续异常按间隔重复提醒；另有定时巡检报告。
- **系统通知**：Web Notification / Electron 原生通知 / iOS 本地通知，三端统一封装。

---

## 三、整体架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            展示端（同一份 frontend）                       │
│                                                                            │
│  浏览器 / macOS(Electron) / Windows / iOS(Capacitor) / 小程序(web-view)     │
│    ├─ 大屏画面    CameraTile × N ── Jessibuca(WASM) ── 摄像头 ws-flv/rtsp    │
│    ├─ 事件列表    EventPanel  ← IndexedDB(useEventStore)                    │
│    ├─ 设置抽屉    SettingsDrawer（14 个分页）                                │
│    └─ 纯前端模式下的检测与推送（默认；后端模式开启后本地停掉）                  │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ POST /api/config（把配置整体推给后端）
                                │ GET  /api/events（拉后端事件增量）
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    常驻后端  server/headless-monitor.mjs                    │
│                                                                            │
│  摄像头流 ──ffmpeg──▶ JPEG 帧 ──onnxruntime-node──▶ 人形框                   │
│                              ├─ Tracker（复用前端 useTracker）──▶ 区域/徘徊/计数│
│                              ├─ SCRFD + MobileFaceNet ──▶ 人脸比对            │
│                              └─ YOLOv8n-pose ──▶ 姿态动作                     │
│                                                                            │
│  事件 ──▶ 推送调度（复用前端 useAlertPush 全套：三渠道 / 限流 / 合并 / 静默）    │
│       ──▶ SQLite(server/data/monitor.db) + 快照(server/data/shots/)          │
│                                                                            │
│  旁路：状态哨兵 watchdog（掉线告警 + 定时巡检）                                │
│        自愈重启 restart.mjs（端口释放→spawn→自检→回滚）                        │
│        系统级硬重启 hard-reboot.mjs（最后手段，默认关）                         │
│        Telegram 远程控制 tg-remote.mjs（getUpdates 长轮询）                    │
│        静默查岗 duty-check.mjs（/check duty）                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

**为什么后端也要起一个 HTTP 服务**：它同时充当三件事 —— ① 给前端拉事件 / 推配置的 API；② 把 `dist/` 静态页直接 serve 出去（所以一台机器只跑 `npm run server`，浏览器打开 `http://<ip>:8787` 就能看大屏）；③ 钉钉 / 企微 / Telegram 的**反向代理**（官方接口都没有 CORS 响应头，浏览器直连必被拦）。

---

## 四、目录结构

```
Monitor/
├─ index.html                  入口 HTML（defer 引入 Jessibuca，避免白屏）
├─ vite.config.js              Vite 配置（构建时间戳注入 + 钉钉/企微本地代理）
├─ package.json                全部 npm 脚本入口
├─ capacitor.config.json       iOS 壳配置（appId com.mao.monitorwall）
├─ electron-builder.yml        macOS / Windows 桌面端打包配置
├─ start-windows.bat           Windows 一键启动后端（双击即用）
│
├─ src/                        ★ 前端源码（前后端共享）
│  ├─ main.js                  Vue 挂载 + 三层全局错误兜底
│  ├─ App.vue                  大屏主容器（布局 / 放大 / 事件流 / 各类调度）
│  ├─ style.css
│  ├─ components/
│  │  ├─ TopBar.vue            顶栏（布局切换 / 在线数 / 今日报警 / 入口按钮）
│  │  ├─ CameraTile.vue        单路画面（播放器 / 检测循环 / 区域绘制 / 芯片）
│  │  ├─ EventPanel.vue        事件列表（筛选 / 详情弹窗 / 导出）
│  │  ├─ SettingsDrawer.vue    设置抽屉（14 个分页：监控通道 / 播放性能 / 检测识别 / 报警提醒 / 推送模板 / 钉钉 / TG / 企微 / 状态巡检 / 系统维护 / 配置方案 / 隐私遮罩 / 外观 / 关于系统）
│  │  ├─ StatsPanel.vue        统计面板
│  │  ├─ PushTemplatePanel.vue 推送模板编辑与预览
│  │  ├─ PrivacyMask.vue       隐私遮罩层
│  │  ├─ NotifyStack.vue       左上角通知卡片栈
│  │  ├─ AboutSystem.vue       关于系统（运行时长 / 推送统计 / 设备信息）
│  │  ├─ SelectField.vue       自定义下拉（弹层可点选）
│  │  └─ InfoTip.vue           说明气泡
│  ├─ composables/             27 个可复用逻辑单元，见下表
│  ├─ config/
│  │  ├─ defaults.js           两层配置：初始化配置 + 内置隐藏配置
│  │  └─ features.js           四项扩展能力的唯一权威判定（零依赖，前后端共用）
│  └─ workers/aiWorker.js      ONNX 推理 Worker（前端用）
│
├─ server/                     ★ 常驻后端（Node，无框架）
│  ├─ headless-monitor.mjs     主服务：HTTP API / 配置热更新 / 全链路编排（约 2120 行）
│  ├─ analyzer.mjs             每路一个分析器：跟踪 / 区域 / 人脸 / 姿态 / 计数
│  ├─ detector.mjs             ONNX 推理（onnxruntime-node），按「槽位」区分模型
│  ├─ source.mjs               流 → JPEG 帧管道（ffmpeg；ws-flv 走 ws 灌 stdin）
│  ├─ watchdog.mjs             状态哨兵：掉线告警 + 定时巡检
│  ├─ notify.mjs               推送调度（转发到前端 useAlertPush）
│  ├─ store.mjs                SQLite 存储层（事件 / 人脸库 / 待录入 / kv 游标）
│  ├─ face-lib.mjs             人脸库（512 维向量 + 内存缓存 + 余弦比对）
│  ├─ imageops.mjs             纯 JS 位图 + 最小 Canvas 2D 实现（给 alignFace 用）
│  ├─ compat.mjs               Node 兼容层（window / document / localStorage）
│  ├─ tg-remote.mjs            Telegram 远程控制（指令表 / 解析 / 长轮询 / 游标落盘）
│  ├─ tg-guard.mjs             远程重启熔断（落盘计数，防重启死循环）
│  ├─ duty-check.mjs           静默查岗（/check duty）
│  ├─ restart.mjs              自愈重启器（端口释放 → spawn → 自检 → 回滚）
│  ├─ hard-reboot.mjs          系统级硬重启（三平台命令 + 权限检测）
│  ├─ ffmpeg-fetch.mjs         ffmpeg 自动获取（首次运行自动下载 ≥7 版本）
│  ├─ ffmpeg-fetch-cli.mjs     预取 ffmpeg 的命令行入口
│  ├─ logstamp.mjs             给所有 console 输出加 [HH:mm:ss] 前缀
│  ├─ config.json              后端的落盘配置（运行时数据，可删）
│  └─ data/                    运行期数据（已 gitignore）
│     ├─ monitor.db            SQLite：事件 / 人脸库 / 待录入 / kv
│     ├─ shots/                事件快照 JPEG
│     ├─ restart.log / .json   重启日志与台账
│     ├─ tg-offset.json        TG 指令游标（重启不重放积压，见 5.12）
│     ├─ tg-reboot.json        远程重启熔断台账（见 5.12）
│     └─ localstorage.json     推送统计的持久化（shim 出来的 localStorage）
│
├─ public/                     构建期静态素材
│  ├─ js/jessibuca.js          469KB 播放器（defer 引入）
│  ├─ js/decoder.wasm          软解 wasm
│  └─ ai/models/               107MB ONNX 模型（会被复制进 dist/ai）
│
├─ electron/                   Electron 主进程
│  ├─ main.cjs                 自定义协议 app://local + 静态服务 + 反向代理 + IPC
│  └─ preload.cjs              受控桥（屏幕常亮 / 通知 / 退出 / 重启）
│
├─ ios/                        Capacitor iOS 工程
│  └─ App/App/
│     ├─ WatchBridgePlugin.swift  WatchConnectivity 桥
│     ├─ MonitorExtrasPlugin.swift
│     └─ public/                  同步进来的 H5 产物
│  └─ App/MonitorWatch/          原生 SwiftUI 手表 App（看事件 + 标已读）
│
├─ miniprogram/                微信小程序壳（web-view 指向 H5）
│  ├─ pages/index              web-view 容器
│  ├─ pages/guide              未配置 H5 地址时的引导页
│  └─ utils/config.js          ★ 要改的 H5_URL 在这里
│
├─ scripts/                    零依赖构建脚本（只用 Node 内置模块）
│  ├─ build-all.mjs            一条命令打全平台（只 build 一次，产物同源）
│  ├─ make-portable.mjs        便携版目录（拷走双击即用）
│  ├─ make-win-deploy.mjs      Windows 部署包（含 node_modules）
│  ├─ serve-static.mjs         便携版的本地静态服务（含三个代理）
│  ├─ build-mp.mjs             小程序体检（主包 ≤2MB / 总包 ≤20MB）
│  ├─ build-watch.mjs          watchOS 编译与手表注册
│  └─ electron-dev.mjs         Electron 热更新开发（自动拉起 vite）
│
├─ docs/
│  └─ 远程控制方案.md           远程控制的方案设计与踩坑记录
│
├─ build/                      图标等打包资源
├─ dist/                       构建产物（含 ai 模型，共约 113MB）
└─ release/                    打包产物（桌面端 / 便携版 / 部署包，已 gitignore）
```

### `src/composables/` 速查

| 文件 | 职责 |
|---|---|
| `useJessibuca.js` | 按需等待 469KB 播放器就绪（不再阻塞 App 挂载） |
| `useMotion.js` | 帧差法移动检测（零模型） |
| `useAiDetector.js` | 前端 ONNX 推理总入口（模型 / 人脸对齐 / 裁剪） |
| `useAiExtras.js` | 区域 / 徘徊 / 姿态 / 计数的编排 |
| `useTracker.js` | 轻量多目标跟踪器（纯几何，零模型，**后端复用**） |
| `useFaceLib.js` | 人脸库（IndexedDB，512 维向量 + 缩略图） |
| `useEventStore.js` | 事件存储（IndexedDB，可放原图） |
| `useDailyStats.js` | 每日统计（不受事件条数淘汰影响） |
| `useAlertPush.js` | **推送调度核心**：三渠道路由 + 各自限流 + 超限合并 + 静默时段 |
| `useDingTalk.js` / `useWeCom.js` / `useTelegram.js` | 三个渠道的协议实现（加签 / 图片 / 模板正文） |
| `useMessageTemplate.js` | 推送模板引擎（三端排版统一） |
| `useAlarmText.js` | 报警文案统一收口（8 种事件类型的标题） |
| `useImageHost.js` | 零配置图床（把截图换成公网 URL，钉钉 markdown 需要） |
| `usePushStats.js` | 推送统计（三端分开 + 累计） |
| `useSystemNotify.js` | 系统通知（Web / Electron / iOS 三端统一） |
| `useDeviceInfo.js` | 运行设备信息（推送里写清「哪条链路发出来的」） |
| `useBackendSync.js` / `useBackendEvents.js` | 后端模式的配置同步与事件轮询 |
| `useWatchBridge.js` | Apple Watch 桥接（节流推送事件 + 接回执指令） |
| `useWakeLock.js` / `useAppExit.js` / `useFileIO.js` / `useNet.js` / `useErrorLog.js` | 常亮 / 退出 / 导入导出 / 超时 fetch / 错误留档 |

---

## 五、运行逻辑

### 5.1 两种运行模式

这是理解整个项目的关键。同一套代码有两个「谁是大脑」的选择：

| | **纯前端模式**（默认） | **后端检测模式** |
|---|---|---|
| 谁做检测 | 浏览器里的 Web Worker（ORT Web） | `server/` 的 Node 进程（onnxruntime-node） |
| 谁发推送 | 页面里的 `useAlertPush` | 服务端 `notify.mjs`（同一份 `useAlertPush`） |
| 关掉页面会怎样 | **停止检测与推送**（画面也没了） | **照常检测、照常推送** |
| 事件存在哪 | IndexedDB | SQLite + `shots/` 快照 |
| 怎么开启 | 默认 | 设置 → 检测识别 → 「后端检测服务」打开 |

开启后端模式后会发生三件事：

1. 前端把**当前整份配置**（含每路流地址、区域、推送凭据、人脸库）POST 到 `POST /api/config`，后端落盘并热生效 —— **正常情况下你不需要手改 `server/config.json`**。
2. 前端把各通道的本地 AI 检测临时置为关闭（`App.vue` 把 `aiEnabled` 置 false 传给画面），运动检测保留（几乎不占资源，且只对当前在看的画面有意义）。
3. 前端改为轮询 `GET /api/events?since=<上次毫秒时间戳>`、`GET /api/status`，把后端事件合进同一份事件流展示。

> 前端配置里的后端地址默认是 `http://10.0.0.12:8787`（那台常驻设备的局域网地址，见 `DEFAULT_BACKEND_URL`）。换机器记得改这里。

### 5.2 「一份代码跑在两个运行时」

后端要复用前端逻辑，靠 `server/compat.mjs` 补三样东西：

| 需要补的 | 用途 |
|---|---|
| `window` | 运行环境判断、`crypto.subtle` |
| `document` | canvas（图片压缩 / 人脸对齐），由 `imageops.mjs` 提供最小实现 |
| `localStorage` | 推送统计持久化，落成 `server/data/localstorage.json`（写盘 300ms 防抖） |

⚠️ **必须在 import 任何前端模块之前**调用 `installBackendCompat()`。

所以像 `useAlertPush.js`（推送调度）、`useDingTalk.js`（加签）、`useTracker.js`（跟踪器）、`features.js`（能力判定）这些文件是**前后端共用的同一份源码**。前端改了推送策略，后端下次启动自动跟着变。

### 5.3 后端检测流水线

```
摄像头流
  │  ① source.mjs：rtsp:// / http-flv 直接给 ffmpeg；
  │     ws:// / wss:// 先用 ws 客户端收二进制帧，原样灌进 ffmpeg stdin（-f flv）
  ▼
ffmpeg  ── `-f image2pipe -vcodec mjpeg` ──▶ JPEG 连续字节流
  │  ② JPEGFrameSplitter 按 SOI/EOI 切成一个个 Buffer
  ▼
detector.mjs（onnxruntime-node）
  │  ③ 人形检测（yolo11n / yolo11s）→ person 框
  ▼
analyzer.mjs（每路一个实例）
  │  ④ Tracker 跨帧关联，给出稳定的身份 id
  │  ⑤ 人脸：只在**检出人形的帧**上跑 SCRFD + MobileFaceNet，同一个人靠轨迹去重
  │  ⑥ 姿态：同样只跑在有人的帧上，17 关键点判跌倒/举手/蹲下
  │  ⑦ 区域：进出 / 徘徊（纯几何，靠轨迹连续性）
  ▼
事件 ──┬──▶ store.mjs：正文进 SQLite，快照 JPEG 落 shots/，库里只存相对路径
       ├──▶ notify.mjs：交给 useAlertPush（限流 / 合并 / 静默判断）→ 钉钉 / 企微 / TG
       └──▶ GET /api/events 供前端轮询
```

**几个刻意的性能约定（实测结论，别改）**：

- 人脸、姿态**只在检出人形的帧上才跑**，空帧直接跳过；
- 同一个人的脸**不会每个周期都重提特征**（靠轨迹去重），否则 2fps 下站着不动的人会白烧大量算力；
- 区域 / 徘徊 / 计数是**纯几何**的，不需要任何模型。

### 5.4 关于 ffmpeg（最容易踩的坑）

- 市面平台的 ws-flv 大量使用**增强型 FLV（E-FLV）**：视频 tag 里 `codecId=0`，真正的编码放在 FourCC 里（`hvc1` = H.265）。
- `ffmpeg-static` 自带的是 **6.0，解析不了**，表现是 `Decoder (codec none) not found for input stream #0:0`，**而且一行错误日志都不打**，只是静默不出帧。
- 所以本项目的 ffmpeg 查找顺序是：

  ```
  显式指定（config.json 的 ffmpegPath / 环境变量 BOSSMONITOR_FFMPEG）
    → server/.cache/ffmpeg/<版本>/（首次运行自动下载，≥7）
    → ffmpeg-static（6.0，只能解普通 H.264）
    → 系统 PATH
  ```

- 完全离线时设 `BOSSMONITOR_FFMPEG_OFFLINE=1`，只查缓存不下载。
- 想提前预取：`npm run ffmpeg:fetch`。

### 5.5 推送调度（`useAlertPush` 内部）

```
事件进来
  │
  ├─ ① 静默判断：当前在免打扰窗口内？
  │     ├─ 是 → 存进 silentBuffer（只存文字字段），等结束/查岗时汇总，本次结束
  │     └─ 否 → 继续
  │
  ├─ ② 通道筛选：这一路勾了「要推送」吗？这个事件类型勾了吗？
  │     没勾 → 结束（通道无关的事件直接丢弃，不会误推）
  │
  ├─ ③ 每渠道独立限流：
  │     · globalMinIntervalSec  两条之间的全局最小间隔
  │     · rateLimitPerMin       每分钟上限
  │     · 超限 → 按 overflowMode 合并（merge）或丢弃（drop）
  │
  └─ ④ 按渠道协议发送
        钉钉：加签（HMAC-SHA256）→ text / markdown（图片需公网图床）
        企微：markdown + image base64（直接发截图，不用图床）
        TG  ：sendPhoto 直接上传文件
```

### 5.6 静默（免打扰）

- **定时时段**：`silent.slots`，可配多段（默认 `20:00-08:00` 与 `12:00-13:30`），跨零点自动处理。
- **临时静默**：`/silent 2h` 或 `/until 08:00` 开启，`silent.tempUntil` 记截止时刻、`silent.tempSince` 记**真实开始时刻**。
- **开始 / 结束都推提醒**：开启前推「免打扰已开启」，结束时推「免打扰已结束」+ **期间积压事件的汇总**。
- 静默期间的事件不丢 —— 统一收存，结束或查岗时汇总发出。
- 汇总正文复用同一个 `buildSilentSummary`，保证「结束汇总」和「查岗汇总」口径一致。

### 5.7 静默查岗 `/check duty`

场景：半夜开着静默，人不在手机旁边，想中途看一眼积压了什么。

| 语义 | 实现 |
|---|---|
| 首次查岗 | 区间 = **静默窗口开始 → 现在**，推汇总 + 区间内**全部截图** |
| 再次查岗 | 区间 = **上次查岗 → 现在**（增量，不重复推） |
| 不在静默时段 | 直接回提示，不推任何东西 |
| 静默中无事件 / 已查完 | 分别给明确提示 |

几个关键实现取舍：

- **查数据库而不是内存缓冲**：`silentBuffer` 里只存文字字段、**没有截图路径**，满足不了「图片全部推过来」。改查 `events` 表拿 `thumb` 再读文件，顺带解决了「进程重启后缓冲清空」的问题。
- **游标用 `created_at` 而不是 `time`**：`time` 是分析器判定时刻，落库在它之后；按 `time` 做游标会永久漏掉「查询跑在 time 之后、入库之前」那几十毫秒里的事件。
- **游标存 SQLite 的 kv 表**（`dutyCursor`），所以后端自愈重启后不会重复推。
- **截图丢后台串行推**：几十张要几十秒，同步等待会把 TG 长轮询卡死，期间什么指令都收不到。汇总则先发（确认发得出去再回执）。
- **结果发回你发指令的那个私聊**（`ctx.msg.chat.id`），而不是配置里的 `chatId`（那可能是群）。
- **防呆**：单次硬上限 200 张；连续 3 次失败熔断；读图三道防线（非空 / 无 `..` / 解析后仍在 `SHOTS_DIR` 内）。

### 5.8 自愈重启（`restart.mjs`）

设置 → 系统维护 → 定时重启 / 持续异常自动重启 / 手动「立即重启」，走的是同一条流程：

```
风暴保护 → 通知 → 停流 → 【await 关闭 HTTP server，真正释放端口】
  → spawn（绝对脚本路径 · 显式 cwd · stdio 落 restart.log · detached）
  → 轮询 /api/status，校验 startedAt 确实变新（自检）
      ├─ 成功 → 记台账 → 本进程退出
      ├─ 超时 → 回滚（本进程重新 listen）+ 告警
      └─ 回滚也失败 → 才考虑系统级硬重启兜底
```

老的实现是「spawn 一个进程 → 400ms 后 `exit(0)`」，实测会把**重启变成停机**，五个原因：

1. **端口竞态**：旧进程 400ms 后才释放端口，新进程何时 `listen()` 不确定 → 撞 `EADDRINUSE`；
2. **`listen()` 没挂 error 处理器**：异常冒泡到 `uncaughtException` 被兜底吞掉 → 新进程**活着但没人监听端口**；
3. **没有自检**：spawn 完就退出，从不确认新进程有没有接管；
4. **`restarting` 标志永不复位**：第一次失败后，**后续所有重启请求（含远程 `/reboot`）被静默忽略**；
5. **作用域错位**：`/api/restart` 写在模块级 `server()` 里，而 `requestSystemRestart` 定义在 `main()` 内部 → 点「立即重启」只产生一条 `ReferenceError`。

配套还有 `listenWithRetry`：端口被占用时退避重试（`EADDRINUSE` / `EACCES`），失败则明确报错退出，而不是假活。

### 5.9 系统级硬重启（`hard-reboot.mjs`，最后手段）

⚠️ 这不是「重启 BossMonitor」，而是**重启整台机器**。

| 平台 | 命令 | 权限要求 |
|---|---|---|
| Windows | `shutdown /r /t 5` | 管理员 |
| macOS | `osascript -e 'tell application "System Events" to restart'` | 给本进程授「辅助功能」 |
| Linux | `sudo -n systemctl reboot` | root 或免密 sudo |

**默认关闭**，两个开关都要打开才会生效：`systemReboot.enabled`（总开关）+ `systemReboot.onFailure`（仅在「自愈重启失败 + 回滚也失败」时自动执行）。

> 打开前必须先配好**开机自启**（Windows 任务计划程序 / NSSM、macOS launchd、Linux systemd），否则硬重启的结果是「机器起来了，但监控还是死的」。

### 5.10 状态哨兵（`watchdog.mjs`）

- **掉线告警**：哪一路掉了推「监控异常」；恢复了推「监控恢复」；持续异常按 `repeatMinutes` 重复提醒。
- **定时巡检**：每 `intervalMinutes` 分钟把全通道状态汇总成报告推出去（可设「仅异常时推」）。
- **判定口径**：后端模式下没有播放器，所以以「最近一次出帧时间」为准 —— 有帧且在 `STALE_MS` 内 = `playing`；从未出过帧 = `connecting`；曾好但现在超时无帧 = `error`；没配地址 / 停用 / 没拉流 = `idle` / `closed`。这比播放器状态更接近事实（后端 ffmpeg 24 小时在拉，页面开不开都不影响判定）。
- **流自愈**：某路持续异常超过 `streamRecovery.restartSystemAfterMin` 分钟（默认 30），升级为触发一次自愈重启。

### 5.11 Telegram 远程控制（`tg-remote.mjs`）

用 **`getUpdates` 长轮询**（方案 C）而不是 Webhook 卡片，原因是：卡片回调必须有一个**公网 HTTPS 入口**，得额外开隧道、配证书、维护域名；长轮询是「后端主动去 Telegram 拉」，全程出站连接，内网机器不开任何端口就能用。

三道硬约束，任何一条不满足就不执行、也不回执：

1. **必须是私聊**（`chat.type === 'private'`）—— 群里任何人发都直接丢弃；
2. **必须在白名单**（`from.id ∈ allowUserIds`）；
3. **必须以 `/` 开头**。

危险指令（`/reboot`、`/hardreboot`）额外要 `allowReboot` 开关，且默认关闭。每条指令都写一行审计日志（时间 / 来源 id / 指令 / 结果）。

### 5.12 启动重放与积压（为什么「一启动就反复重启」）

`getUpdates` 是**确认式**的：Telegram 只有在收到「**下一次带更大 offset** 的 `getUpdates`」时，才认为之前那批已送达并真正删除。如果服务在确认之前就退出/重启了，那批 update 会**原封不动留在队列里**；而**不带 `offset`** 调用 `getUpdates` 会返回**全部未确认的积压**，并且不删除。

而 `/reboot` 恰好就是「执行完立刻把进程换掉」的指令 —— 于是三件事叠加成死循环：

1. 取到积压里的 `/reboot confirm` → 执行重启 → 进程被换掉，`offset` 没来得及确认；
2. 指令游标原先**只在内存里**，重启就归零；
3. 远程 `/reboot` 走 `force: true`，**故意跳过**重启风暴保护（那条保护统计的是「失败的自动重启」，而循环里每一次重启都是「成功」的，转多久都不会触发）。

⇒ 新进程不带 `offset` 再取一遍 → 同一条 `/reboot confirm` 被重放 → 再重启 → 无限循环。

三处修复：

| 修复 | 位置 | 作用 |
|---|---|---|
| **指令游标落盘** `server/data/tg-offset.json` | `tg-remote.mjs` | 重启后从上次位置继续，**不重放**。关键：**先把游标落盘、再执行业务** —— `/reboot` 会在执行过程中把进程换掉，只有提前落盘才来得及 |
| **远程重启熔断** | `tg-guard.mjs` | 10 分钟内因 TG 指令重启超过 3 次就拒绝并告警（回执里直接说明原因与解除时间）。台账**落盘**，否则每轮重启都把内存计数清零 |
| **`--drop-pending` 启动参数** | `headless-monitor.mjs` | 手动清一次积压：启动时**先清空、再开始收指令**，日志报出清掉几条 |

游标落盘带来的是 **at-most-once** 语义：若在「落盘之后、执行之前」崩溃，这条指令会**丢失**。对 `/reboot` 这类危险指令这正是想要的偏向 —— 宁可漏执行一次，也绝不重复执行。

---

## 六、各端运行方式

### 0. 通用准备

```bash
git clone https://github.com/xiaomaoJT/BossMonitor.git
cd Monitor
npm install
```

- **Node.js 20+ LTS**（推荐 22）。
- `better-sqlite3` / `onnxruntime-node` / `ffmpeg-static` 都是**平台原生二进制**，所以 `node_modules` **不能跨平台拷贝** —— 在 Windows 上要重新 `npm install`。

### 1. Web 开发模式（改代码用）

```bash
npm run dev          # http://127.0.0.1:5173，热更新
```

vite 已配好 `127.0.0.1` 绑定，并内置了钉钉 / 企微的本地反向代理（浏览器直连这两个官方接口必被 CORS 拦）。

### 2. Web 生产构建 / 预览

```bash
npm run build        # 产出 dist/
npm run preview      # 起 vite preview：http://127.0.0.1:4173
```

### 3. 常驻后端检测服务 ★

这是「7×24 无人值守」的正式跑法：

```bash
npm run server                               # 按 server/config.json 启动，默认 8787
node server/headless-monitor.mjs --port=9000 # 换端口
node server/headless-monitor.mjs --drop-pending   # 启动时先清空 Telegram 侧积压的指令
npm run server:status                        # curl 一下 /api/status 看状态
```

> **`--drop-pending` 什么时候用**：如果服务**一启动就反复重启**，多半是 Telegram 那边积压了旧的
> `/reboot confirm`（详见下面「反复重启」小节）。带上这个参数启动一次即可清除，日志会报出
> 清掉了几条；下次正常启动就不用再带。它只作用于本次启动，不会被自重启的子进程继承。

Windows 上直接**双击 `start-windows.bat`**（会自动开浏览器并启动服务，窗口保持打开即代表在跑）。

启动后：

- 浏览器打开 `http://<这台机器的IP>:8787` 就能看大屏（后端会顺便把 `dist/` serve 出去）；
- 前端「设置 → 检测识别 → 后端检测服务」打开，填入这个地址（默认预设 `http://10.0.0.12:8787`），配置会自动同步过去并热生效；
- 想让它开机自启：Windows 用「任务计划程序」或 NSSM 装成服务，macOS 用 launchd，Linux 用 systemd。

首次启动会**自动下载 ffmpeg（≥7）**到 `server/.cache/`，需要联网；离线环境先在有网的机器上跑一次 `npm run ffmpeg:fetch` 再把 `.cache` 带过去。

### 4. macOS 桌面端（Electron）

```bash
npm run electron:dev          # 热更新开发（自动拉起 vite + Electron，退出时自动关 vite）
npm run electron:preview      # 先 build 再直接跑 Electron
npm run electron:build        # 打成 dmg + zip → release/
npm run electron:build:dir    # 只出 .app 目录（快很多）
npm run electron:smoke        # 自检：加载页面后跑一遍资源/协议/代理检查再退出
```

> 为什么不用 `loadFile()` 直接加载 `dist/index.html`：`file://` 协议下浏览器禁止 `fetch` 本地文件，Jessibuca 的 `decoder.wasm`、ORT 的 `.wasm/.mjs`、AI Worker 全部会加载失败。所以主进程注册了自定义协议 **`app://local`**（等价于一个本地 HTTP 服务器），并把钉钉 / 企微接口反向代理掉。
>
> 默认不签名（本地自用）。要分发就去掉 `electron-builder.yml` 里的 `identity: null` 并配签名证书。

### 5. Windows 桌面端

```bash
npm run electron:build:win       # portable exe + nsis 安装包
npm run electron:build:win:dir   # 免安装目录
```

⚠️ 这个包**只含大屏前端**，人脸 / 人形 / 姿态检测仍然跑在 `server/` 的 Node 进程里，所以 Win 机上要**同时跑 `npm run server`**（或把服务装成开机自启）。

### 6. Windows 部署包（拷过去就能跑）

```bash
# 必须在 Windows 机器上执行
npm install --omit=dev
node scripts/make-win-deploy.mjs          # → release/BossMonitor-Win/
node scripts/make-win-deploy.mjs --zip    # 额外压一个 zip
```

产物是个自包含目录：`dist/` + `server/` + `node_modules/` + `start-windows.bat` + 使用说明。拷到另一台 Windows 上双击 bat 即可。

> ⚠️ **必须在目标平台执行**：`node_modules` 里 `better-sqlite3` / `onnxruntime-node` / `ffmpeg-static` 都是平台原生二进制，mac 上打出来的包拿到 Windows 上跑不起来。

### 7. 便携版（免安装，任意平台）

```bash
npm run pack:portable     # → release/BossMonitor-便携版/
```

目录里自带一个**零依赖**的本地静态服务（`serve-static.mjs`，只用 Node 内置模块），双击 `启动监控.command`（macOS / Linux）或 `start-windows.bat`（Windows）即可。也可手动：

```bash
npm run serve                                   # 起服务并打开浏览器
node scripts/serve-static.mjs --host=0.0.0.0    # 允许局域网访问（手机上看大屏）
```

> 为什么不能双击 `index.html`：Vite 产物带 `crossorigin`，`file://` 下 origin 是 `null`，module script / CSS / fetch / Worker 全被 CORS 拦；即使绕过，`fetch()` 读本地文件本身也是禁止的，107MB 的 ONNX 模型和播放器 wasm 一个都加载不了。

### 8. iOS App（Capacitor）

```bash
npm run ios:add      # 首次：添加 ios 平台（已存在则跳过）
npm run ios:sync     # build + cap sync：把 H5 产物同步进 ios/App/App/public
npm run ios:open     # 用 Xcode 打开工程
npm run ios:run      # build + 直接部署到已连接的设备 / 模拟器
```

`capacitor.config.json`：`appId = com.mao.monitorwall`，`appName = BossMonitor`，`webDir = dist`。

### 9. Apple Watch（原生 SwiftUI）

watchOS 不提供 WKWebView，所以手表端是**原生 SwiftUI**（`ios/App/MonitorWatch/`），只做「看事件 + 标已读」，数据走 WatchConnectivity。

```bash
npm run watch:build              # 类型检查 + 完整编译
npm run watch:build -- --strict  # xcodebuild 失败也算失败（CI 用）
npm run watch:register           # ★ 装到真手表前必须做一次
```

> 为什么「注册手表」不能省：手表 App 有自己的 bundle id，需要自己的描述文件，且描述文件的设备列表里必须包含**手表 UDID**。不注册时的现象特别隐蔽 —— 点「安装」一直转圈，几秒后退回「安装」按钮，**没有任何报错**（签名校验在手表侧被静默拒绝）。

手机侧的桥接是 `src/composables/useWatchBridge.js`，做了三件事：**节流**（最多每 1.2s 推一次，永远推最新快照）、**只推该推的**（原图 / 流地址 / ROI 留在手机上）、**降级要无声**（没配对、插件不存在都不影响主流程）。

### 10. 微信小程序

小程序本身只是**壳**，真正的监控大屏是本仓库 `npm run build` 产出的 H5。

```bash
# 1) 改 miniprogram/utils/config.js 里的 H5_URL（必须是 https://）
# 2) 或直接让脚本写进去：
npm run mp:set-url -- --url=https://your-domain.com/
# 3) 体检（结构完整性 + 体积 + JSON 语法 + H5_URL 是否配置）
npm run mp:build          # 报告写入 build/mp-size-report.json，硬性违规退出码 1
```

然后用微信开发者工具打开 `miniprogram/` 目录即可。

上传前必须在小程序后台「开发管理 → 开发设置」里配置：

- **业务域名**：H5 的域名，并把校验文件放到该域名根目录；
- **socket 合法域名**：视频流走的 `wss://` 域名需单独配置。

> 107MB 的 AI 模型**不进小程序包**（总包上限 20MB），要放 CDN 或让它走服务端检测。

### 11. 一条命令打全平台

```bash
npm run build:all                                  # 六步全跑
npm run build:all -- --only=portable,electron      # 只跑指定步骤
npm run build:all -- --skip=ios --keep-going       # 跳过 iOS，某步失败也继续
npm run build:all -- --dir                         # macOS 只出 .app 目录
npm run build:all -- --mp-url=https://x/           # 顺手把 H5 地址写进小程序配置
```

覆盖：Web 产物 → 便携版 → macOS 桌面端 → iOS App → Apple Watch → 小程序体检。

> 为什么不在 `package.json` 里串 `&&`：`pack:portable` / `electron:build` / `ios:run` 各自都带一次 `npm run build`，串起来就是构建 4 次；而且 `vite.config.js` 的 `__BUILD_TIME__` 每次构建都不同，四个产物会拿到四个不同的构建时间戳（「关于系统」页里看到对不上，排障时误导人）。这里**只构建一次**，后面复用同一份 `dist`，四个平台产物完全同源。

---

## 七、配置说明

配置分成两层，互不污染（`src/config/defaults.js`）：

1. **初始化配置（`DEFAULT_*`）**：「空白」—— 打开就是一块空大屏，没有通道、没有推送凭据、AI 附加能力全关。设置里的「恢复初始化」就是回到这一份。
2. **内置隐藏配置（`HIDDEN_*`）**：完整的一份（7 路真实通道 + 推送凭据 + 摆放坐标）。只在「配置方案 → 加载内置配置」输入访问密码后载入，不会混进初始化配置。

内置隐藏配置里的 7 路：**门口 / 电梯 / 大厅**（开检测 + 推送），**厕所 / 通道1 / 通道2 / 楼梯**（默认隐藏，设置里把「显示」打开即可恢复）。

### 关键配置项速查

| 位置 | 字段 | 说明 |
|---|---|---|
| 顶层 | `port` | 后端端口（默认 8787，可被 `--port=` 覆盖） |
| 顶层 | `sampleFps` / `model` / `keepEvents` | 采样帧率 / 检测模型 / 事件保留条数 |
| `options.backend` | `enabled` / `url` / `pollMs` / `ffmpegPath` | 后端检测服务开关与地址 |
| `options.silent` | `slots` / `channels` / `tempUntil` / `tempSince` | 定时时段 / 静默渠道 / 临时静默起止 |
| `options.streamRecovery` | `enabled` / `restartSystemAfterMin` | 持续异常多少分钟后升级为重启 |
| `options.autoRestart` | `enabled` / `days` / `hours` | 定时自愈重启间隔 |
| `options.systemReboot` | `enabled` / `onFailure` | 系统级硬重启（默认全关） |
| `options.face` | `enabled` / `matchThreshold` / `libMax` / `collectUnknown` | 人脸识别参数（默认阈值 0.38） |
| `options.pose` | `enabled` / `actions.fall` 等 | 姿态动作开关 |
| `options.zone` | `enterAlarm` / `loiterSec` / `countEnabled` | 区域与计数 |
| `options.dingtalk` / `wecom` / `telegram` | 各自的 `webhook` / 限流 / 事件勾选 / 模板 | 三端推送 |
| `options.telegram.remote` | `enabled` / `allowUserIds` / `pollMs` / `allowReboot` / `dutyMaxImages` / `dutyImageGapMs` | 远程控制 |
| `options.mask` | `password` / `autoMaskMinutes` | 隐私遮罩 |

---

## 八、远程控制指令

前提：`telegram.remote.enabled = true`，且你的 `from.id` 在 `allowUserIds` 里，且**必须是私聊**。

| 指令 | 作用 |
|---|---|
| `/silent <小时数>` | 开启临时静默，如 `/silent 2`（开启与结束都会推送提醒，期间报警收存、结束时汇总） |
| `/until <HH:MM>` | 静默到指定时刻（今天已过则顺延到明天），如 `/until 08:00` |
| `/resume` | 立刻结束临时静默，并推结束提醒 + 已收存报警汇总 |
| `/patrol` | 立即推送一次巡检报告（各通道状态与功能开关） |
| `/status` | 查看当前状态：在线路数、静默情况、今日报警与推送统计 |
| `/check duty` | **静默查岗**：推静默期间积压事件的汇总 + 全部截图；再发一次只看增量 |
| `/duty` | 同上（短别名，**也单独注册进了命令菜单**，手机上手打更省事） |
| `/reboot` | 重启检测服务（需另开 `allowReboot`） |
| `/hardreboot` | 重启整台电脑（需 `allowReboot` + `systemReboot.enabled` + 回复 `confirm`） |

`/checkduty` 与 `/check duty`、`/duty` 三者等效。

> 指令菜单通过 `setMyCommands` 注册进 Telegram，输入 `/` 会自动弹出候选，不用背。`check` 与 `duty` 都注册，两条都会出现在候选里。
>
> **远程控制是热生效的**：在设置里打开开关并保存，监听器会立刻起来，不需要重启后端。设置页「远程控制」区还有诊断面板（机器人身份 / Token / 白名单 / 最近被拒原因）和「测试连接」「删除 Webhook」两个按钮 —— 「配好了却没响应」的六种成因都能在那里直接看到结论。

---

## 九、HTTP API

后端（默认 `http://127.0.0.1:8787`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 大屏页面（后端顺带 serve `dist/`） |
| `GET` | `/api/status` | 服务状态快照（含 `startedAt`，自愈重启自检靠它） |
| `POST` | `/api/config` | 前端把整份配置推过来并热生效 |
| `GET` | `/api/events?since=<ms>&limit=` | 拉事件增量（`since=0` 则返回最近若干条） |
| `GET` | `/api/watchdog` | 状态哨兵快照 |
| `POST` | `/api/patrol` | 手动触发一次巡检推送 |
| `POST` | `/api/restart` | 立即重启服务（立刻返回 `accepted`，非阻塞） |
| `GET` | `/api/restart-status` | 上次重启结果 / 连续失败次数 / 历史 / 日志路径 / 硬重启可用性 |
| `GET` `POST` `DELETE` | `/api/temp-silent` | 查询 / 开启 / 结束临时静默 |
| `POST` | `/api/silent-notice` | 由后端发一条静默提醒：`kind=pre`（开始）/ `post`（结束，不动缓冲）/ `flush`（真实汇总）。可带 `channels` 限定渠道 |
| `GET` | `/api/tg-remote` | Telegram 远程控制诊断（是否在听、机器人身份、白名单数量、最近被拒原因、为什么没运行） |
| `POST` | `/api/tg-remote/test` | 主动打一次 Telegram（`getMe` + `getWebhookInfo`）做连接自检 |
| `POST` | `/api/tg-remote/webhook` | `{action:'delete'}` 删除 Webhook（它与 `getUpdates` 互斥，不清掉就收不到指令） |
| `POST` | `/api/read` | 已读回写（保持前后端一致） |
| `POST` | `/api/shot` | 补图 / 人脸信息回写 |
| `GET` | `/api/pending-faces` | 未录入人员队列 |
| `GET` `DELETE` | `/api/faces` · `/api/pending-face` | 人脸库查询 / 删除待录入单条 |
| `GET` | `/shots/*` | 事件快照 JPEG（带防目录穿越校验） |
| `*` | `/dingtalk-robot/**` | 反向代理 → `oapi.dingtalk.com` |
| `*` | `/wecom-bot/**` | 反向代理 → `qyapi.weixin.qq.com` |
| `*` | `/tg-bot/**` | 反向代理 → `api.telegram.org` |

> 静态兜底**不做 `index.html` 回落**（本项目没有 history 路由）：回落只会把代理请求伪装成 200 的 HTML，推送失败时看不出根因。

---

## 十、环境变量

| 变量 | 作用 |
|---|---|
| `MONITOR_DATA_DIR` | 覆盖数据目录（默认 `server/data/`）。测试隔离靠它，避免误写生产库 |
| `MONITOR_CONFIG` | 覆盖配置文件路径（默认 `server/config.json`）。跑真实服务但用临时配置时用 |
| `BOSSMONITOR_FFMPEG` | 指定 ffmpeg 可执行文件的绝对路径 |
| `BOSSMONITOR_FFMPEG_OFFLINE` | 设为 `1` 表示完全离线：只查缓存与显式指定，不发起下载 |
| `MONITOR_SMOKE_TEST` | 设为 `1` 时 Electron 自检模式（`npm run electron:smoke`） |
| `MONITOR_RESTARTED_BY` / `MONITOR_RESTART_AT` | 由自愈重启器注入，标记「本进程是被谁、何时拉起的」 |
| `VITE_DEV_SERVER_URL` | Electron 加载的开发服务器地址（`npm run electron:dev` 自动设置） |

---

## 十一、常见问题与排障

**Q：所有通道都是「拉流失败」，但同一路流在前端页面播得好好的？**
ffmpeg 版本问题。市面 ws-flv 大量使用增强型 FLV（`codecId=0` + FourCC `hvc1`），`ffmpeg-static` 的 6.0 解不了，且**静默不出帧、不打日志**。确认 ffmpeg ≥ 7：看启动日志里的版本号，或用 `BOSSMONITOR_FFMPEG` 指定一个 9.x。

**Q：自动重启之后服务直接停机了？**
已在 `restart.mjs` 修复（端口释放 → spawn → 自检 → 回滚）。如果还遇到，看设置 → 系统维护的诊断面板：上次结果 / 原因 / 连续失败次数 / 日志路径，或 `GET /api/restart-status`、`server/data/restart.log`。

**Q：远程 `/reboot` 没反应？**
先看 `allowReboot` 开了没；再看是不是连败触发了风暴保护（手动/远程 `force` 不受限，但自动重启会被暂停）；最后看 `GET /api/restart-status` 的 `consecFailures`。

**Q：后端服务一启动就一直在反复重启？**
Telegram 侧积压了旧的 `/reboot confirm`，被反复重放执行。用 `node server/headless-monitor.mjs --drop-pending` 启动一次即可（日志会报出清掉了几条），之后正常启动就行。根因与三处修复见 [5.12](#512-启动重放与积压为什么一启动就反复重启)。附带症状：连续远程重启超过 3 次会被**熔断**拒绝，回执里会直接说明还要等多久。

**Q：硬重启之后监控没回来？**
硬重启只负责重启机器，**不会**帮你把服务拉起来。必须先配开机自启。

**Q：硬件重启报权限不足？**
Windows 需管理员；macOS 需给本进程「辅助功能」授权；Linux 需 root 或免密 sudo。模块会返回可读提示，不会静默失败。

**Q：钉钉推送测试失败，控制台看起来像跨域？**
用后端模式（后端内置了三个代理）；或确认 `useProxy` 开着、且代理前缀在 `vite.config.js` / `electron/main.cjs` / `headless-monitor.mjs` **三处保持一致**（不一致会让某个渠道静默失效）。

**Q：推送统计 / 事件清空后，顶部的今日报警数也归零了？**
不会。每日统计走 `useDailyStats` 独立存储，不受事件条数淘汰与清空影响。

**Q：想彻底重置后端？**
删掉 `server/data/` 即重置（数据库 + 快照 + 重启台账 + TG 指令游标 `tg-offset.json` + 远程重启熔断台账 `tg-reboot.json` 全在里面）。只清事件不清配置的话，用设置里的「清空事件」。

---

## 十二、技术栈

| 层 | 选型 |
|---|---|
| 前端框架 | Vue 3（组合式 API）+ Vite 6，**无路由、无状态库**，全部逻辑收在 composable |
| 实时播放 | Jessibuca（WASM 软解，H.264 / H.265，ws-flv） |
| AI 推理（前端） | ONNX Runtime Web（wasm / WebGPU），跑在 Web Worker |
| AI 推理（后端） | onnxruntime-node |
| 模型 | `yolo11n` / `yolo11s`（人形）、`scrfd-500m`（人脸检测）、`mobilefacenet`（人脸特征）、`yolov8n-pose`（姿态） |
| 后端 | Node 原生 `http` + `ws`，无 Web 框架 |
| 存储（后端） | better-sqlite3（WAL 模式），快照落磁盘 |
| 存储（前端） | IndexedDB（事件 + 人脸库） |
| 图像处理 | `jpeg-js` + 自实现的位图与最小 Canvas 2D（`imageops.mjs`） |
| 视频解码 | ffmpeg（≥7，首次运行自动下载到 `server/.cache/`） |
| 桌面端 | Electron 44 + electron-builder |
| 移动端 | Capacitor 8（iOS）+ 原生 SwiftUI（watchOS） |
| 小程序 | 微信小程序 web-view 壳 |
| 构建脚本 | 纯 Node 内置模块，零依赖 |

---

## 相关文档

- [`docs/远程控制方案.md`](docs/远程控制方案.md) —— 远程控制的方案设计、安全边界与踩坑记录（含自愈重启的五处根因、查岗的实现取舍）。

---

*BossMonitor · 仅供自用部署。涉及远程重启 / 系统级硬重启的能力默认关闭，开启前请确认权限与开机自启已就绪。*
