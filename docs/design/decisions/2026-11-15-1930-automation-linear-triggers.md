# 自动化：Linear 触发器

2026-11-15：Alex 要求把自动化补齐到 Capy 的程度（「补齐」）。这是第 5 步的 Linear 部分：Linear 里的事件可以启动自动化。延续 [2026-11-15-1704](2026-11-15-1704-automation-github-triggers.md)。

## 决定

- 「满足任一条件就运行」里加 **Linear 事件**：新建议题、议题状态变化、议题加了标签、议题被指派、新评论。每个触发器选团队（创建者自己的 Linear 连接能看到的团队），可以再限定标签，可以加一句条件（和 GitHub 触发器一样，由判断模型先判断）。只用于交给 Bot 的自动化。
- 只有人做的改动才算：Linear 应用或集成的改动（包括 Mikka 自己写回 Linear 的改动）不会启动自动化，避免自己触发自己。
- 权限：创建、修改、恢复时检查团队是否在创建者的 Linear 里能看到；每次运行前再查一次。事件到达时，创建者必须还连着这个 Linear 组织；断开后不再启动，已有自动化在下次运行时自动暂停并写明原因。
- 同一次投递只算一次。Linear 事件不是同步：同步关着也照样触发。
- 官方部署里 Linear 的 webhook 发到 Linear Worker；Worker 把 Issue 和 Comment 投递原样转给应用的 `/api/webhooks/linear/automations`，应用用同一个密钥再验一次签名。需要在 Worker 上设置 `LINEAR_AUTOMATIONS_FORWARD_URL`。自托管直接用应用自己的 `/api/webhooks/linear`。
- Bot 收到的要求后面附上 `<linear_event>` 块，并说明这是 Linear 的数据，不是创建者的指示。

实现：`docs/backend/179-conversation-schedules.md` § Linear triggers。
