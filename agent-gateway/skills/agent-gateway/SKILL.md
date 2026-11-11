---
name: agent-gateway
description: 管理、开启、关闭 agent-gateway 聚合网关，查询 WorkBuddy 与反重力模型及算力状态
---

# Agent Gateway 网关管理技能

本技能用于控制和管理本地 `agent-gateway` 聚合网关服务（支持反重力 Gemini/Claude/GPT-OSS、WorkBuddy 以及直连 DeepSeek 的聚合代理与协议翻译）。

## 常用操作指引

### 1. 开启网关并接入桌面端与 CLI
当用户希望启动网关、使用反重力或 WorkBuddy 提供的模型时：
- 执行命令：`node dist/server.js on`
- 对应快捷斜杠命令：`/gateway-on`

### 2. 关闭网关并还原原本配置
当用户希望停止网关、无损切回原本的官方账号或直连代理时：
- 执行命令：`node dist/server.js off`
- 对应快捷斜杠命令：`/gateway-off`

### 3. 查看当前状态与余额
查询网关端口、各模块登录与在线状态、账号与可用算力：
- 执行命令：`node dist/server.js status`
- 对应快捷斜杠命令：`/gateway-status`

### 4. 列出可用模型列表与倍率
查看当前所有合规别名与对应的真实上游模型、倍率及 free 状态：
- 执行命令：`node dist/server.js models`
- 对应快捷斜杠命令：`/gateway-models`

### 5. 重新同步模型表
- 执行命令：`node dist/server.js sync`
- 对应快捷斜杠命令：`/gateway-sync`
