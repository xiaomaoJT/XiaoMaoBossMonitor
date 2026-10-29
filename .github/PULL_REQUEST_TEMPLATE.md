## 变更类型

<!-- 勾选一项主力类型 -->
- [ ] `feat` 新功能
- [ ] `fix` 修缺陷
- [ ] `refactor` 重构（行为不变）
- [ ] `perf` 性能优化
- [ ] `docs` 文档
- [ ] `chore` 构建 / 依赖 / 版本号
- [ ] `security` 安全

## 改了什么

<!-- 一句话说清改动本身，再补为什么要改 -->

## 为什么这么改

<!-- 背景、复现路径、或对应 Issue 编号 -->

Closes #

## 影响范围

<!-- 会改变哪些用户可见行为？需要重新构建 dist 吗？需要重启后端吗？ -->

## 自检

- [ ] `env -u NODE_OPTIONS npm run build` 通过，`dist/` 已随提交更新
- [ ] 未提交 `config/*.json`、`server/data/`、任何真实凭据（Token / Webhook / 群 ID / 内网 IP / 设备号）
- [ ] 新增或修改的配置字段，写 / 存 / 读 / 展示四处已对齐
- [ ] 涉及设置抽屉 tab 时，`provide('sd')` 与 `inject('sd')` 名字逐字对齐
- [ ] 用户可见的行为变化已写进 `docs/使用手册.md`
- [ ] 未擅自替换或新增 `models/` 下的模型权重

## 贡献者许可协议（必填）

<!-- 首次贡献必须完成，否则 PR 不会被合并。细则见 CLA.md -->

- [ ] 我已阅读并同意 [CLA.md](CLA.md)，并在本 PR 评论中发表了签署声明
- [ ] 我是代表公司贡献，已附公司授权说明（否则无需勾选）

签署声明（评论一行即可，中英文任选）：

```
I have read the CLA Document and I hereby sign the CLA
```

```
我已阅读并同意《BossMonitor 贡献者许可协议》
```
