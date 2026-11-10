# bash-describe

每次会话开始时，往上下文里注入一条规则：

> 调用 Bash 工具时，description 参数必须用简体中文写清三件事：
> 这条命令做什么；会改动哪些文件或系统状态；风险高低与是否可逆。控制在 80 字以内。

你看到的权限卡片顶部那段说明，就是这个 `description` 参数。规则固定下来之后，
不用每次都靠临时发挥，格式和内容粒度都稳定。

## 安装

```
/plugin install bash-describe --marketplace AAAYNMMM/claude-plugins
```

## 原理

`hooks/hooks.json` 注册了一个 `SessionStart` 钩子，在会话启动、恢复、清空时执行一条
`node -e` 命令，输出：

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }
```

`additionalContext` 会被当作上下文交给模型，所以从第一轮起就带着这条规则。

## 依赖

- 需要 PATH 上有 `node`（本机为 v24）。没有 node 时钩子失败，规则不会注入，
  其他功能不受影响。

## 调参

改 `hooks/hooks.json` 里那行命令中的 `additionalContext` 文本即可，注意：
保持单引号包裹，文本里不要出现双引号、`%`、`!`、`&`、`|`、`<`、`>`，
否则命令在 shell 里可能被截断。

## 已知限制

- 上下文压缩（compact）之后，注入的这段文字可能不在上下文里了；重新开始会话即可恢复。
- 这条规则靠模型遵守，不是强制校验；它影响的是"说明怎么写"，不影响命令能不能执行。
