# agent-gateway (Claude 多模型聚合翻译网关插件)

一个符合 Claude Code / Desktop 插件规范的本地多上游模型聚合翻译网关。

把 **WorkBuddy 模型** 与 **反重力 (Antigravity/Gemini) 核心模型** 统一接入 **Claude Code** 与 **Claude 桌面端**，实现与 DeepSeek 同列表切换，切模型即切代理。

## 架构特性

- **完全独立的配置双向隔离**：
  - **开启网关**：自动持久化备份您原本的 Claude 桌面端代理或官方账号配置，注入网关回环端点与所有已登记模块的模型；
  - **关闭网关**：一键从备份完整还原原有配置，原本的 DeepSeek API Key、自定义端点和官方模型不受任何污染，方便您随时修改原本的代理。
- **模块化底座（Micro-kernel Modules）**：
  - `modules/workbuddy`：WorkBuddy 桥接模块，包含凭据刷新、OpenAI shim 以及**附属余额/积分查询**小模块。
  - `modules/antigravity`：反重力代理模块，提供 Gemini 3.8 Flash、Gemini 3.8 Pro 等核心模型的 Anthropic Messages API 实时转换与流式输出。
  - `modules/passthrough`：直连透传模块，原生转发至 DeepSeek 官方 Anthropic 兼容端点。
- **开关与插件启用状态联动**：
  - 在 Claude 桌面端**启用** `agent-gateway` 插件（或运行 `开启网关并接入Claude.bat`）：启动网关并自动同步可用模型、接入桌面端与 CLI；
  - 在 Claude 桌面端**禁用/关闭** `agent-gateway` 插件（或运行 `关闭网关并还原Claude.bat`）：自动停止后台网关、还原原本代理与模型配置，并清理桌面端网关注入条目；
  - 双击 `查看网关与算力状态.bat` 随时查看各模块运行状况与余额。
