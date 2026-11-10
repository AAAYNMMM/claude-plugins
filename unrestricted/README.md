# unrestricted

通过 `prompt.compose` 往系统提示词里注入一段固定的回答约定，让回复的尺度、结构和表达方式保持一致，而不是每轮靠临场发挥。

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

`prompt.compose` 的回答按线程记录。开关切换**不会改动当前会话已经发出的系统提示词**，要等新会话或一次压缩（compaction）之后才生效。这不是缺陷，是宿主的行为：提示词前缀一旦发出，中途改写会让缓存和思考块失效。

想立刻看到效果，开一个新会话。

## 原理

`hooks/hooks.json` 指向 `hooks/register.ts`，模块导出 `register(on, options)`，挂了四个钩子：

| 钩子 | 作用 |
|---|---|
| `prompt.compose` | 往系统提示词的段列表里插入一段 `scope: "session"` 的新段 |
| `prompt.attachment`（`plan_mode`、`plan_mode_reentry`） | 在计划模式的提醒文本末尾追加边界说明 |
| `engine.create` | 注册 `/unrestricted` 命令 |
| `command.run` | 应答该命令本身 |

几个实现上的取舍：

- **新段一律 `scope: "session"`**，且插在第一个 session 段之前。段列表要求「所有 shared 段在前」，顺序错了整个钩子会被跳过。
- **不改写 `intro` / `system` 这类 shared 段**。shared 段是会跨组织缓存的公共前缀，往里写任何可变内容都会让缓存整体失效。
- **幂等**：段列表里已有同 id 的段就直接放行，不会重复注入。
- **开关读取包了 `try/catch`**：`$.store` 读取失败时回落到插件默认值，不让钩子抛异常。
- **命令自答的 matcher 用字面量，且不读 `next`**：否则它会被登记成 gating hook。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 插件加载时的默认开关 |

## 已知限制

- 开关切换对当前会话无效，见「生效时机」。
- 这是提示词层面的约定，靠模型遵守，不是强制校验。
- 如果上游接口网关对特定内容做了拦截（返回错误或断流），提示词层面绕不过去，那属于传输层。
- 插件不改变任何权限、沙箱或审批行为。

## 许可

MIT。规则文本改编自 [yexi-by/dsh-unrestricted](https://github.com/yexi-by/dsh-unrestricted)（MIT）。
