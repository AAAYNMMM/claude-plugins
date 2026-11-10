# workbuddy-for-claude

把本机已登录的 **WorkBuddy 模型**接入 **Claude Code**，并且和 DeepSeek 放在同一个模型列表里，切模型即切提供方。

## 作为插件安装

```bash
/plugin marketplace add AAAYNMMM/claude-plugins
/plugin install workbuddy-for-claude@aaaynmmm-plugins
```

插件提供 `/workbuddy-status` 和 `/workbuddy-models` 两条斜杠命令。网关的配置（环境变量、模型列表、桌面 App 的 provider）仍需按下面的步骤执行一次——Claude Code 的插件无法修改模型的 Base URL，只能由安装脚本写入。

原插件 [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 是给 DeepSeek Harness（DSH）用的：它从 WorkBuddy 桌面端读取登录凭据，在本机起一个 **OpenAI 协议**的回环服务，再把模型注册进 DSH 的模型选择器。

Claude Code 说的是 **Anthropic Messages API**（`/v1/messages`），两者协议不同，所以不能直接安装。这个项目在中间加了一层**会按模型名分流的翻译网关**：

```
Claude Code / 桌面 App ──Anthropic /v1/messages──▶ 本机网关 :43119
                                                     │
                        ┌────────────────────────────┴────────────────────────────┐
                        │ 模型是 DeepSeek 路由？                                   │
                        │   是 → 原样转发到 https://api.deepseek.com/anthropic     │
                        │         （调用方的 Bearer 一并转过去）                    │
                        │   否 → 协议翻译 Anthropic → OpenAI                       │
                        │         ▼                                                │
                        │  插件自带 shim（OpenAI，随机回环端口）→ WorkBuddy 网关     │
                        └──────────────────────────────────────────────────────────┘
```

复用与重写的边界：

| 来源 | 内容 |
| --- | --- |
| 原插件源码（MIT，见 `vendor/`） | 凭据发现与刷新、上游协议、渠道校验适配、工具调用（含 DSML 恢复）、模型目录、积分读取、回环 shim 的入站加固 |
| 本项目新写（`src/`） | Anthropic ↔ OpenAI 双向转换、按模型分流、固定端口网关、鉴权、模型名映射、安装/卸载脚本 |

原插件的设置卡片、账号池 UI、CodeBuddy CLI 桥接、生图/生视频工具属于 DSH 宿主界面，Claude Code 没有对应机制，**没有移植**。

---

## 模型列表与无感切换

网关按 `~/.workbuddy-claude/config.json` 里的 `routes` 分流。路由表由脚本按目录生成：**目录里每个 WorkBuddy 模型都会分到一个 Anthropic 模型名当别名**，外加一条 DeepSeek 透传。

```bash
node scripts/routes.mjs sync     # 扫描目录、补齐路由表（只追加，不重排已有别名）
node scripts/routes.mjs list     # 看看当前是怎么映射的
```

为什么要别名：桌面 App 要求模型条目的 `name` 必须是一个 Anthropic 模型 ID，而目录里有 16 个 WorkBuddy 模型。脚本用一组不同的 Anthropic 模型名（`claude-opus-5-5`、`claude-sonnet-4-6` 等）分别绑定它们，用户看到的显示名（`labelOverride`）则是 `WB · 模型 id (倍率)`。

同步完路由后，重启网关并把列表写进 App：

```bash
node scripts/app-provider.mjs apply     # 自动备份，然后重启 App
```

如果某个模型没出现在 App 列表里，说明 App 不认那个别名——`scripts/routes.mjs` 顶部的 `ALIAS_POOL` 里换一个 Anthropic 模型名重跑即可。

---

## 安装

### 一键装（终端 + 桌面 App 模型列表）

```bash
powershell -ExecutionPolicy Bypass -File install.ps1 -AppProvider
```

安装脚本会：

1. 构建 `dist/server.js`（首次）；
2. 后台启动网关，写入 `~/.workbuddy-claude/config.json`；
3. 把环境变量写进 `~/.claude/settings.json`（终端 Claude Code 用）；
4. **`-AppProvider`**：备份并改写桌面 App 的 provider 配置（只改地址与模型列表，不碰加密密钥）；
5. 安装两个斜杠命令到 `~/.claude/commands/`。

登录自启动默认**不安装**，需要时加 `-Autostart`。

### 分开做

| 目的 | 命令 |
| --- | --- |
| 只装终端设置 | `install.ps1` |
| 只同步桌面 App 模型列表 | 双击 `应用模型列表.bat`，或 `node scripts/app-provider.mjs apply` |
| 还原桌面 App 配置 | 双击 `还原App模型配置.bat`，或 `node scripts/app-provider.mjs restore` |

改完桌面 App 的配置后**需要重启 Claude App**。

### 关于鉴权（重要）

桌面 App 的 API 密钥是它自己用 Windows DPAPI 加密的，**网关读不到**。所以：

- 桌面 App 模式下网关用 `auth: "loopback"`：只要求请求来自回环地址且带非空凭据，不再校验本地令牌；DeepSeek 路由会把 App 的密钥原样转发出去。
- 代价：同机的其它进程也能调用 `127.0.0.1:43119` 借用你的 WorkBuddy 额度。
- 想更严格就改回 `node dist/server.js set auth token`，并在桌面 App 的 provider 设置里把密钥换成 `config.json` 里的 `token`（那样 App 就改用本地令牌，不再转发 DeepSeek 密钥）。

---

## 切换模型

终端里：改 `defaultModel` 后重启网关，或直接用真实 WorkBuddy 模型名。

```bash
node dist/server.js set defaultModel kimi-k3-1
```

桌面 App 里：模型选择器直接选「DeepSeek · Sonnet」或「WB · …」，无需重启网关。

查看目录里有什么模型、各自倍率：

```bash
node dist/server.js models
```

当前实测可用的模型（2026-11-10，倍率为相对积分倍率）：

| 模型 | 倍率 | 上下文 |
| --- | --- | --- |
| `deepseek-v4-pro` | x0.51 | 1000k |
| `deepseek-v4.1-flash` | x0.11 | 1000k |
| `kimi-k3-1` | x1.62 | 1000k |
| `kimi-k3.1-pro` | x0.97 | 1000k |
| `glm-5.3` | x0.69 | 1000k |
| `glm-5.2` | x0.79 | 1000k |
| `minimax-m3.1-flash` | x0.08 | 1000k |
| `hy4std` / `hy4free` | x0.29 / x0 | 960k |

---

## 停用 / 启用 / 卸载

| 目的 | 命令 | 效果 |
| --- | --- | --- |
| 临时切回原生 Claude | `disable.ps1` | 只移除终端设置里的环境变量 |
| 重新启用 | `enable.ps1` | 写回环境变量并确保网关在跑 |
| 完整卸载 | `uninstall.ps1` | 停网关、删自启动、还原终端设置与桌面 App 配置、删斜杠命令；保留 `~/.workbuddy-claude` |
| 连数据一起删 | `uninstall.ps1 -Purge` | 额外删除 `~/.workbuddy-claude` |

目录里也放了对应的中文 `.bat`，双击即可。还原是按**安装记录**逐键恢复的，不会覆盖你自己配置的其它设置。

---

## 目录与文件

| 路径 | 用途 |
| --- | --- |
| `~/.workbuddy-claude/config.json` | 端口、令牌、区域、默认模型、鉴权模式、路由表 |
| `~/.workbuddy-claude/status.json` | 运行中的网关 pid 与地址 |
| `~/.workbuddy-claude/gateway.log` | 网关日志（超过 2MB 自动截断） |
| `~/.workbuddy-claude/app-provider-backups/` | 桌面 App provider 配置的备份 |
| `~/.dsh/workbuddy-vault/` | 原插件的凭据副本，与本项目共用 |
| `src/anthropic.ts` | 协议翻译（请求、SSE、工具调用、用量） |
| `src/gateway.ts` | 网关、分流、鉴权、DeepSeek 透传 |
| `src/main.ts` | 组装、命令、后台循环 |
| `vendor/` | 原插件源码（MIT），未改动逻辑 |

---

## 安全边界

- 网关与插件的 shim **都只监听 `127.0.0.1`**，并校验 `Host` 头，防 DNS 重绑定；非回环 `Origin` 一律拒绝。
- `auth: "token"` 模式下每个请求必须带本地令牌，常量时间比较；`loopback` 模式的取舍见上文。
- 上游请求始终按插件已验证的客户端身份发送；`channelPerturbation` 默认 `failure`。
- 桌面 App 的加密密钥既不被读取也不被改写；`app-provider.mjs` 只动地址、模型列表、provider 类型三个字段，改动前整份备份。

## 已知限制

- **提示缓存不生效**：`cache_control` 被丢弃，WorkBuddy 上游没有对应机制。
- **扩展思考被丢弃**：`thinking` 块在翻译时丢弃，推理内容也不回传。
- **上下文窗口**：桌面 App 对自定义模型按 200k 处理；终端设置里已用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=800000` 提高压缩边界。
- **生图/生视频、账号池、签到**：这些是 DSH 侧功能，本移植版没有对应界面。
- **账号风险**：原项目明确说明它依赖 WorkBuddy 客户端接口而非官方 API，上游规则变化随时可能失效，使用后果由账号持有人自行承担。

## 许可与来源

- 本项目：MIT。
- `vendor/` 源码来自 [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT，Copyright (c) 2026 LaoDing），其上游参考项目见仓库内的 `THIRD_PARTY_NOTICES.md`（已保留在 `vendor/`）。
- 该项目与腾讯、WorkBuddy、DeepSeek 无隶属关系。
