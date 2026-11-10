# unrestricted

通过 `prompt.context` 往会话的首条用户消息里注入一段固定的回答约定，让回复的尺度、结构和表达方式保持一致，而不是每轮靠临场发挥。

插件只改**内容层**：不碰工具目录、不碰调用协议、不碰权限模式、不碰沙箱和审批。它决定的是「答案怎么写」，不是「能不能做」。

## 安装

```
/plugin install unrestricted --marketplace AAAYNMMM/claude-plugins
```

安装后需确认开关已开（见下方「启用」）。终端里执行 `/reload-plugins`，桌面版在插件面板重载，或下次启动自动加载。

## 启用

两层开关，后者的优先级更高：

1. **插件设置**：`enabled` 字段，默认 `false`。首次使用需要打开一次。

   ```bash
   claude plugin configure unrestricted@aaaynmmm-plugins
   ```

   或直接在 `/config` 菜单里找到对应行。

2. **运行时开关**：会话内用斜杠命令覆盖，值存在插件自己的 store 里，跨会话保留。

   ```
   /unrestricted on        打开
   /unrestricted off       关闭
   /unrestricted status    查看当前状态与来源
   /unrestricted preview   打印注入的全文
   ```

## 生效时机

上下文块每个会话只计算一次。开关切换**不会改动当前会话已经注入的上下文**，要等新会话之后才生效。

想立刻看到效果，开一个新会话。

## 原理

`hooks/hooks.json` 指向 `hooks/register.ts`，模块导出 `register(on, options)`，挂了四个钩子：

| 钩子 | 作用 |
|---|---|
| `prompt.context` | 在会话首条用户消息的上下文块里追加一块 `unrestricted:execution-mode` |
| `prompt.attachment`（`plan_mode`、`plan_mode_reentry`） | 在计划模式的提醒文本末尾追加边界说明 |
| `engine.create` | 注册 `/unrestricted` 命令 |
| `command.run` | 应答该命令本身 |

几个实现上的取舍：

- **幂等**：上下文块列表里已有同名块就直接放行，不会重复注入。
- **开关读取包了 `try/catch`**：`$.store` 读取失败时回落到插件默认值，不让钩子抛异常。
- **命令自答的 matcher 用字面量，且不读 `next`**：否则它会被登记成 gating hook。

### 为什么不用 `prompt.compose`

最初版本用的是 `prompt.compose`（往系统提示词的段列表里插一段）。它在命令行下工作，但在桌面版**不生效**：

```
unrestricted: its prompt.compose hook was skipped.
"cc-plugin-sec-default" runs first and sent the event on past it.
```

桌面版把内置安全插件 `cc-plugin-sec-default` 排在插件链最外层，它在 `prompt.compose` 上继续往下走时短路掉了后面的钩子。命令行（`claude -p`）不加载这个内置插件，所以同一份代码在两处的表现不同。这是插件层级问题，改配置绕不过去。

改用 `prompt.context` 之后两边都能生效。代价是规则作为用户消息的一个上下文块发送，不再进入系统提示词的缓存前缀：模型照样读得到，但没有系统提示词那样的缓存待遇。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 插件加载时的默认开关 |

## 已知限制

- 开关切换对当前会话无效，见「生效时机」。
- 规则随用户消息发送，不在系统提示词里；它占用一点上下文，不享受系统提示词的缓存前缀。
- 这是提示词层面的约定，靠模型遵守，不是强制校验。
- 如果上游接口网关对特定内容做了拦截（返回错误或断流），提示词层面绕不过去，那属于传输层。
- 插件不改变任何权限、沙箱或审批行为。

## 许可

MIT。规则文本改编自 [yexi-by/dsh-unrestricted](https://github.com/yexi-by/dsh-unrestricted)（MIT）。
