# 桌面窗口不再用毛玻璃

2026-11-17：Alex 决定，macOS 桌面窗口去掉毛玻璃（`sidebar` vibrancy），和 Windows、Linux 一样用不透明窗口。

## 决定

- 主窗口不再设 `vibrancy`、`visualEffectState` 和透明背景色，始终用不透明背景（浅色 `#f5f5f4`，深色 `#000000`）。macOS 保留 `hiddenInset` 标题栏和红绿灯位置。
- preload 不再给页面加 `data-desktop-translucent`。组件库里的 `in-data-desktop-translucent:` 样式不再生效，按库文件规则保留。
- macOS 上所有控件（按钮、链接、输入框和对应 role）都是 `-webkit-app-region: no-drag`，顶栏只有空白处能拖动窗口，盖在拖动条上的按钮也能点。

取代 [decisions.md](../decisions.md) 2026-10-31「macOS 桌面窗口像 Codex 一样半透明」那一条。
