# claude-plugins

自用的 Claude Code 插件集合。一个插件一个文件夹，文件夹里是插件本体和它的说明。

## 安装

在换好的新电脑上，打开 Claude Code 的终端会话，执行：

```
/plugin install perm-explainer --marketplace AAAYNMMM/claude-plugins
```

第一次会问要不要添加这个市场仓库，回答 `y`，然后选择安装范围（推荐 user，全局可用）。

## 插件清单

| 插件 | 作用 |
|---|---|
| [perm-explainer](./perm-explainer) | 权限卡片顶部显示三行中文解释：作用 / 影响 / 风险 |

## 结构约定

```
claude-plugins/
├─ .claude-plugin/marketplace.json   市场清单，Claude Code 靠它发现插件
├─ README.md                         本文件
├─ LICENSE
└─ <插件名>/
   ├─ .claude-plugin/plugin.json     插件清单
   ├─ hooks/{hooks.json,register.ts} 钩子代码
   └─ README.md                      这个插件做什么、怎么调
```

新增插件时：建一个同名文件夹、写好 `plugin.json` 和代码、在 `marketplace.json` 的 `plugins` 数组里加一项，再在下面的表格里加一行。
