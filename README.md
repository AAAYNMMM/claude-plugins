# claude-plugins

自用的 Claude Code 插件集合仓库。结构已经搭好，目前还没有插件。

## 换电脑后怎么装

有插件之后，在 Claude Code 的终端会话里执行：

```
/plugin install <插件名> --marketplace AAAYNMMM/claude-plugins
```

第一次会问要不要添加这个市场仓库，答 `y`，然后选安装范围（推荐 user，全局可用）。

## 目录结构

```
claude-plugins/
├─ .claude-plugin/marketplace.json   市场清单，Claude Code 靠它发现插件
├─ README.md                         本文件
├─ LICENSE
├─ .gitignore                        忽略 *.log 等
└─ <插件名>/                         每个插件一个文件夹
   ├─ .claude-plugin/plugin.json     插件清单
   ├─ hooks/{hooks.json,代码文件}    钩子
   └─ README.md                      这个插件做什么、怎么调
```

## 新增一个插件

1. 建一个文件夹，名字就是插件名；
2. 写 `.claude-plugin/plugin.json`（`name`、`version`、`description`）；
3. 写 `hooks/hooks.json` 和钩子代码；
4. 在 `.claude-plugin/marketplace.json` 的 `plugins` 数组里加一项：
   ```json
   { "name": "<插件名>", "source": "./<插件名>", "description": "<一句话>" }
   ```
5. 在下面的"插件清单"表格里加一行；
6. 提交并推送。

## 插件清单

（暂无）

## 历史

- `perm-explainer`：曾用于在权限确认时生成三行中文说明，已废弃删除。
  代码仍可从 git 历史找回（提交 `08a747f`）。
