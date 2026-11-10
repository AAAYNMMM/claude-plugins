# ds-credits

在 Claude Code 桌面版底部状态栏显示 DeepSeek 余额，形如 `¥110.00`。

## 安装

```bash
/plugin marketplace add AAAYNMMM/claude-plugins
/plugin install ds-credits@aaaynmmm-plugins
```

## 数据从哪来

本插件**只读一个本地文件**：

```
~/.workbuddy-claude/deepseek-balance.json
```

这个文件由 `claude-workbuddy` 网关写入。网关在转发一次真正的 DeepSeek 请求时，
用这次请求自带的 Key 调用只读的 `GET /user/balance`，查完立刻丢弃 Key，只保存结果：

```json
{
  "currency": "CNY",
  "total": "110.00",
  "available": true,
  "updatedAt": "2026-11-10T18:20:00.000Z",
  "balances": [
    { "currency": "USD", "total": "0.00" },
    { "currency": "CNY", "total": "110.00" }
  ]
}
```

因此：

- **不消耗余额**：查询是只读账户接口，不做模型推理、不产生 token；
- **插件本身从不接触 API Key**：它只读上面这个结果文件；
- 网关重启后，要等下一次走 DeepSeek 的请求才会有新数据；
- 没有数据时显示 `—`。

## 配置

余额文件路径可在 `/config` 的插件选项里改（`balanceFile`），默认值见 `plugin.json`。
换机器或换安装位置时需要改它。
