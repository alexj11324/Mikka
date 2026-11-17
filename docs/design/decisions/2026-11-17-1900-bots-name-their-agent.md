# Bot 必须选 Agent

2026-11-17：用户决定，每个 Bot 都要选定它的 Agent（Claude Code 或 Codex），不设默认值。

## 决定

- `bots.agent` 记录 Bot 的 Agent（`claude_code` 或 `codex`，迁移 `20261117190000_bot_agent`）。新建 Bot 时必须选，网页、iOS 和 API（`createBot`、`POST /api/mobile/bots`、电脑 API、Coordinator 的建 Bot 工具）都不预选，缺了返回 `botAgentRequired`。编辑时可以换，不能清空。
- 已有的 Bot 不回填，保持没有 Agent。它的下一次派发（`dispatch_run`、Bot 电脑派发）直接被拒：`machineUnavailable`，原因 `botAgentRequired`，卡片写「请先为这个 Bot 选择 Agent」，按钮打开这个 Bot 的对话，在右栏「详情」里选。Coordinator 也是 Bot，同样要选。
- 派发不再按「优先使用的模型」第一项决定 Agent：模型只在 Bot 的 Agent 里按顺序选。点名了别的 Agent 的模型会被拒，不会换成 Bot 的 Agent。
- 运行中的额度回退（`run-provider-fallback`）不在本决定范围内，照旧。
