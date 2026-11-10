# AGENTS.md

本文件写给 AI 代理，不写给人。目标是让一个 AI 代理只读本文件，就能把本仓库的插件装好、维护好。

## 仓库是什么

一个 Claude Code 插件市场仓库。`owner/repo` 为 `AAAYNMMM/claude-plugins`，市场名为 `aaaynmmm-plugins`。

> 注意：市场名不能以 `claude` 开头。Claude Code 会把这类名字判定为"冒充 Anthropic 官方市场"
> 并拒绝整个仓库（报错 `Marketplace name impersonates an official Anthropic/Claude marketplace`）。
> 仓库目录名可以叫 claude-plugins，但 `marketplace.json` 的 `name` 字段不行。

唯一的事实来源是 `.claude-plugin/marketplace.json`：

- `name`：市场名（`aaaynmmm-plugins`）
- `plugins[]`：插件列表
  - `plugins[].name`：插件名，同时也是仓库里的文件夹名
  - `plugins[].source`：插件目录，形如 `./<插件名>`
  - `plugins[].description`：一句话说明

## 任务：安装本仓库的全部插件

收到"安装 <本仓库> 的所有插件"这类指令时，按以下步骤执行，不要询问用户选择，除非某一步失败。

### 1. 确认 claude 可执行

```bash
claude --version
```

如果命令不存在（Windows 桌面版常见，`claude` 通常不在 PATH 上），按版本号从大到小查找桌面版自带的二进制：

- Windows：`%LOCALAPPDATA%\Claude-3p\claude-code\<版本号>\<哈希>\claude.exe`
- macOS：`~/Library/Application Support/Claude-3p/claude-code/<版本号>/<哈希>/claude`

取版本号最大的那个，用它的绝对路径代替下文的 `claude`。

要求版本 ≥ 2.1.292（`--marketplace` 参数从该版本起可用）。

### 2. 逐个安装

对 `.claude-plugin/marketplace.json` 里 `plugins` 的每一项执行：

```bash
claude plugin install <插件名> --marketplace AAAYNMMM/claude-plugins -y --json
```

- 首次执行会自动添加市场（打印 `Successfully added marketplace: aaaynmmm-plugins`），无需额外步骤。
- 作用域默认 user（对本机所有项目生效），不加 `--scope`。
- `-y` 用于无人值守：接受市场声明的命令，非交互环境下必需。
- `--json` 输出一行机器可读结果，便于判断成功与否；去掉它则输出人类可读文本。
- 成功时输出 `Successfully installed plugin: <插件名>@aaaynmmm-plugins (scope: user)`。
- 本仓库的插件都是 `directory` 源，不会触发需要确认的命令安装，`-y` 实际不会用到。

### 3. 验证

```bash
claude plugin list
```

输出中应包含每个插件，且状态为 enabled。缺哪个就重跑哪个的安装命令。

### 4. 生效时机

安装不会影响已经打开的会话。下次启动 Claude Code 时自动加载；已在运行的会话在终端里执行 `/reload-plugins`，桌面版通过插件面板重载。

## 安装前检查

- `bash-describe` 的钩子依赖 PATH 上有 `node`（`node --version`）。没有 node 时该插件的规则不会注入，但不影响 Claude Code 本身。
- 企业/组织策略可能禁止添加第三方市场。遇到此类报错时，如实告知用户，不要尝试绕过。

## 任务：维护本仓库

### 新增插件

1. 建文件夹 `<插件名>/`；
2. 写 `<插件名>/.claude-plugin/plugin.json`：`name`、`version`、`description`、`author`、`license`；
3. 写组件（如 `hooks/hooks.json` + 脚本，或 `skills/`、`agents/`）；
4. 在 `.claude-plugin/marketplace.json` 的 `plugins` 数组追加：
   ```json
   { "name": "<插件名>", "source": "./<插件名>", "description": "<一句话>" }
   ```
5. 在 `README.md` 的插件表格里追加一行；
6. 校验并提交：
   ```bash
   claude plugin validate <插件目录>
   git add -A && git commit -m "<说明>" && git push
   ```

### 修改插件

改 `version` 字段，然后提交推送。已安装的机器用 `claude plugin update <插件名>@aaaynmmm-plugins` 更新。

### 删除插件

```bash
git rm -r <插件名>
```

同时从 `.claude-plugin/marketplace.json` 的 `plugins` 数组和 `README.md` 的表格里删掉对应项。

### 校验

对每个插件目录运行 `claude plugin validate <插件目录>`，输出必须是 `Validation passed`。README/LICENSE/图标相关告警只影响提交到 Anthropic 插件目录，不影响自用安装。

## 写文档的约定

- 面向 AI 的步骤必须具体到可复制执行的命令，不要写"打开界面点击某某"。
- 不写营销话术，不写用户语气。
- 仓库内不得出现任何凭据、令牌、个人绝对路径。
