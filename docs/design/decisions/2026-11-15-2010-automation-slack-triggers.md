# 自动化：Slack 触发器

2026-11-15：Alex 要求把自动化补齐到 Capy 的程度（「补齐」）。这是第 5 步的 Slack 部分：Slack 里的事件可以启动自动化。延续 [2026-11-15-1930](2026-11-15-1930-automation-linear-triggers.md)。

## 决定

- 「满足任一条件就运行」里加 **Slack 事件**：频道新消息、提到 Mikka、加了表情回应。每个触发器选频道（这个工作区的 Slack 应用能看到的频道），表情回应可以限定表情，可以加一句条件（和其他触发器一样，由判断模型先判断）。只用于交给 Bot 的自动化。
- 只有人发的消息、提及和回应才算：机器人的消息（包括 Mikka 自己发的）、编辑或删除都不算，避免自己触发自己。
- 权限：工作区连了 Slack，创建者是这个 Slack 安装的成员，频道是 Slack 应用能看到的频道。创建、修改、恢复和每次运行前都会检查；创建者不再是成员时自动暂停并写明原因。
- 同一个 Slack 事件只算一次。
- Slack 的事件由 Eve 接收。Eve 把签名过的事件原样转给应用的 `/api/webhooks/slack/automations`，应用用同一个签名密钥再验一次。需要设置 `SLACK_AUTOMATIONS_FORWARD_URL`；Slack 要求 3 秒内回应，所以转发最多等 1.5 秒，失败不影响 Slack 对话本身。
- 表情回应需要 Slack 应用订阅 `reaction_added` 并有 `reactions:read` 权限，改完要重新安装；消息和提及用现有订阅。
- Bot 收到的要求后面附上 `<slack_event>` 块，并说明这是 Slack 的数据，不是创建者的指示。

实现：`docs/backend/179-conversation-schedules.md` § Slack triggers。
