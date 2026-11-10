# perm-explainer

把系统权限卡片顶部那段说明，换成分三行的中文解释：作用 / 影响 / 风险。

- 卡片本身不变：原命令、拒绝 / 允许一次 / 始终允许，全都在。
- 只有真会问你的命令才生成解释；已自动放行的命令零延迟。
- Edit / Write 这类卡片不需要替换说明，直接跳过。
- 解释生成失败时保持原说明，不影响授权。

## 安装

```
/plugin install perm-explainer --marketplace AAAYNMMM/claude-plugins
```

## 调参

都在 `hooks/register.ts` 顶部：

| 常量 | 作用 |
|---|---|
| `MODEL` / `FALLBACK_MODEL` | 生成解释用的模型，必须是环境允许列表里的完整 id |
| `TIMEOUT_MS` | 单次模型调用的超时，默认 6 秒 |
| `MAX_TOKENS` | 解释长度上限 |
| `SYSTEM` | 提示词，想改解释的格式或语气就改这里 |

## 诊断

日志写在插件自己所在的目录：`perm-explainer.log`（仓库已忽略 `*.log`）。
每行记录一次触发：查询判定、解释成功或失败。

## 已知限制

- 只能用**改写 `description`** 的方式改卡片文案。桌面版权限卡片不接受插件额外加的文字，
  `reason` 字段和 `$.ui.notice` 都实测无效。
- 因此 `Edit`、`Write` 这类没有 `description` 的工具无法附加解释。
