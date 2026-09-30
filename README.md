# Zoo Editor Hider

在 VS Code 启动时自动隐藏主编辑器区（editor area），只保留侧边栏（sidebar）——例如 Explorer 或 ZooCode 所在的侧边栏。

## 功能

| 操作 | 效果 |
|------|------|
| 启动时自动隐藏 | 工作区加载后自动隐藏编辑器区，仅保留侧边栏 |
| 切换（默认） | `Ctrl+Alt+H`（macOS: `Cmd+Alt+H`）在隐藏/显示之间切换 |
| 隐藏 | 命令面板：`Zoo Editor Hider: Hide Editor Area` |
| 显示 | 命令面板：`Zoo Editor Hider: Show Editor Area` |
| 状态栏按钮 | 右下角状态栏点击即可切换 |

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `zooEditorHider.autoHideOnStartup` | `true` | 启动时是否自动隐藏编辑器区 |

可在设置面板搜索 `zooEditorHider` 修改。