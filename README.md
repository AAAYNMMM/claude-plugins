# claude-plugins

Claude Code 插件市场仓库。安装与维护说明见 [AGENTS.md](./AGENTS.md)。

插件清单以 `.claude-plugin/marketplace.json` 为准。

| 插件 | 作用 |
|---|---|
| [bash-describe](./bash-describe) | 每次会话开始时注入规则：Bash 命令的说明要写清做法、影响、风险 |
| [agent-gateway](./agent-gateway) | 多模型聚合翻译网关：把 WorkBuddy 与反重力 (Antigravity/Gemini) 模型接入 Claude 桌面端与 CLI，支持原本配置与网关的双向无损隔离切换 |
