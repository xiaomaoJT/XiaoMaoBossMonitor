# 贡献指南

感谢你有兴趣改进 BossMonitor。这份文档讲清三件事：**怎么跑起来**、**提 PR 前要过哪些闸门**、**以及你必须先签的贡献者许可协议**。

---

## 一、先签 CLA（硬性要求）

来源不明的代码不能进主干——不是不信任，是**授权链必须可追溯**。没有书面授权，本项目将来既无法更换许可证，也无法把社区贡献并入商业版本。

所以：**首次提交 PR 前，请先在 PR 里评论一行签署声明**，细则见 [CLA.md](./CLA.md)。

```
I have read the CLA Document and I hereby sign the CLA
```

或中文：

```
我已阅读并同意《BossMonitor 贡献者许可协议》
```

签署一次，此后所有贡献长期有效。**未签署的 PR 不会被合并**，无论代码质量多高。

> 如果你代表公司在工作时间贡献，请先确认你的雇佣合同没有把知识产权整体转让给雇主，并附上公司授权说明。

---

## 二、本地环境

| 项 | 要求 |
|---|---|
| Node.js | 20 LTS 或更高（`node -v` 自查） |
| 包管理 | npm（仓库只有 `package-lock.json`，别用 pnpm/yarn 生成第二份锁文件） |
| 系统 | macOS / Windows / Linux 均可；涉及 iOS 打包需 macOS + Xcode |

```bash
git clone <repo> && cd Monitor
npm install
npm run dev            # 前端开发服务器
npm run server         # 另开一个终端：常驻检测后端（可选）
```

首次跑 `npm run server` 会在 `server/data/` 下建 SQLite 与截图目录，**这些永远不进库**。

---

## 三、三条铁律（踩过坑，别再踩）

### 1. 改了 `src/` 必须重新构建，且构建失败视为致命

```bash
env -u NODE_OPTIONS npm run build
```

前缀 `env -u NODE_OPTIONS` 不是装饰——某些环境注入的 `NODE_OPTIONS` 会让 Vite 构建静默产出坏包。构建报错时**不要**用旧 `dist/` 蒙混过去。

`dist/` 在仓库中被跟踪，因此改 `src/` 的 PR **必须同时包含构建产物**，否则部署方会拿到不一致的代码。

### 2. 绝不提交真实凭据

以下内容一律留在本机：

- `config/*.json`（`.gitignore` 已排除，只提交 `config/config.example.json`）
- `server/data/`（事件库、人脸样本、截图）
- 任何 Token、Webhook、群 ID、内网 IP、设备序列号

提交前自检：

```bash
git diff --cached | grep -nE '[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|SEC[0-9a-f]{40,}|access_token=[0-9a-f]{40,}|key=[0-9a-f]{8}-[0-9a-f]{4}'
```

有输出就说明你把玩具带出门了。

### 3. 别擅自替换或新增模型权重

`models/` 与 `dist/ai/models/` 下的 ONNX 受**上游许可证**约束（其中人形检测与姿态模型来自 Ultralytics，为 AGPL-3.0）。换模型会改变整个项目的许可证义务，属于需要维护者决策的事项——请开 Issue 讨论，不要直接提 PR。

---

## 四、代码约定

- **Vue 3 `<script setup>` + Composition API**，不写 Options API。
- 状态与判定逻辑尽量下沉到 `src/composables/` 或 `src/config/` 的**纯函数**里；同一个事实只允许有一份判定，展示层与执行层共用它。
- **渲染期间不要调用 `normalize*` 一类会改写数据的函数**，只在写入侧调用。
- 跨模块 `import` 显式带 `.js` 后缀（本项目为 ESM，Node 侧不做扩展名补全）。
- 注释用中文，写**为什么**而不是**是什么**。踩坑类改动请在注释里留一句「不这样会怎样」。
- 新增配置字段时，请把「写 → 存 → 读 → 展示」整条链一次过完。历史上有过多次「只改一半」导致的运行期崩溃。
- 改设置抽屉（`src/components/settings/*Tab.vue`）时，注意父组件 `provide('sd', …)` 与子组件 `inject('sd')` 的解构名必须**逐字对齐**——删函数要同步删 provide 条目，否则构建不报错、运行才炸。

---

## 五、提交信息

格式：`type(scope): 中文描述`

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修缺陷 |
| `refactor` | 重构，行为不变 |
| `perf` | 性能优化 |
| `docs` | 只动文档 |
| `chore` | 构建、依赖、版本号 |
| `security` | 安全相关 |

描述用中文，一句话说清**改了什么**，必要时在正文补「为什么」。不要写 `update`、`fix bug` 这类无法回溯的信息。

请用**真实姓名与邮箱**配置 `git config user.name / user.email`，匿名提交无法与 CLA 签署记录对应。

---

## 六、PR 流程

1. 开 Issue 说明动机（小改动可跳过）；
2. 从 `main` 切分支，分支名 `feat/xxx`、`fix/xxx`；
3. 提交前跑一遍 [自检清单](#七提交前自检清单)；
4. 提 PR 并按模板填写，**勾选 CLA 声明**；
5. 等待维护者审阅。涉及检测算法、推送语义、许可证的改动，可能需要来回几轮。

维护者保留不合并任何 PR 的权利，也保留关闭与项目方向不符的 PR 的权利。

---

## 七、提交前自检清单

- [ ] `env -u NODE_OPTIONS npm run build` 通过，且 `dist/` 已随提交更新
- [ ] 没有提交 `config/*.json`、`server/data/`、任何真实凭据
- [ ] 新增/修改的配置字段，读写展示四处都已对齐
- [ ] 改了设置抽屉的 tab 时，`provide('sd')` 与 `inject('sd')` 名字逐字对齐
- [ ] 文档已同步（用户可见的行为变化要写进 `docs/使用手册.md`）
- [ ] 提交信息符合上面的格式
- [ ] 已在 PR 中完成 CLA 签署声明

---

## 八、报告问题

提 Issue 时请附：版本号（设置 → 关于系统）、操作系统、复现步骤、以及**脱敏后**的日志片段。截图请务必涂掉人脸、姓名、摄像头地址与账号——这个项目处理的正是敏感画面，随手一张图就可能造成泄露。
