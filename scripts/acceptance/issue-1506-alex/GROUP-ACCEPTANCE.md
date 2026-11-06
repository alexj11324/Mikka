# Issue 1506：新群公开／私聊停止验收

本稿只使用 retained ready receipt 中的 ACME 本人、本人独立测试 team 和两个已选定模型的 Bot。不会重新创建 team、选择模型、调整共享或访问既有群。`group-stop.mjs observe` 每个场景新建一个明确带“测试”的群，成员恰好是本人和两个 receipt Bot。生产调用由执行者单独开启。

## 入口与四个模型边界

通用环境：`MIKKA_ACCEPTANCE_SHA` 是即将验证的完整生产 SHA；`MIKKA_FIXTURE_RECEIPT` 指向已核对的 ready receipt；`ACME_DEMO_EMAIL/PASSWORD` 仅由正式 OIDC 路径注入 runner 环境。脚本正常登录并在 finally 退出；凭证、cookie、prompt、回复和私聊内容不写报告。

| 场景 | `MIKKA_FIXTURE_KIND` | `MIKKA_GROUP_STOP_SCENARIO` | 第一位被提及 Bot | 真正待停止的生成 |
|---|---|---|---|---|
| 公开 Haiku | `haiku` | `public` | Haiku | Haiku 公开生成 |
| 公开 Luna | `luna` | `public` | Luna | Luna 公开生成 |
| 私聊 Haiku | `haiku` | `private` | Luna | Haiku 收到仅测试私聊后的生成 |
| 私聊 Luna | `luna` | `private` | Haiku | Luna 收到仅测试私聊后的生成 |

公开默认 `MIKKA_GROUP_STOP_BOUNDARY=responding_bot`。可独立选择 `after_send` 做发送确认后的停止，但必须保留 `send_acknowledged` 标签，不能把这个时刻称为 provider 已开始。私聊场景固定 `private_generation_receipt`，不采用公开 responding 状态推断私聊开始。

## 实际事件与停止收据

准备阶段验证生产 SHA、精确 workspace 名称/slug/唯一管理员、Bot owner/workspace/模型绑定及群成员集合。实际新建群 ID 会先写 checkpoint；创建或发送确认丢失不会重试相同写操作。发现同名群会拒绝重发。

通过正常 live ticket 建立一个真实 WebSocket。只有新的、匹配该群 UUID 的 `group_chat` revision 才触发正常群状态读取；最多 8 次、最多 60 秒，没有 timer polling。正常群 `GET messages` 可能触发已有排队 worker，报告不会称其为只读数据库快照。

公开场景读取到选定 Bot 正在 responding 后调用正常 Stop API。私聊场景还必须看到以本次新用户消息 position 为锚点的唯一 `agent_exchange`、恰好 1 条已提交私聊、且双方正是两个测试 Bot。此时只读取一次正常 decisions API，要求同一 turn 仍 running，且 trace 顺序为 lead 的 `private_publish` 后接目标 Bot 的 `generate`，没有任何公开 publish/delegate，也没有目标之后的新输出。收据缺失就失败并停止自己的群，不能增加 trace 轮询补齐证据。

这个收据证明主机进入了私聊生成路径；`providerInFlight=requires_start_end_log_correlation` 保留到执行者匹配真实 provider 日志。`status=stop_evidence_captured` 只是脚本完成上述观测，不代表整个 issue 的取消验收通过。

Stop 后只有一次群状态读取和一次同 message 的 decision trace 读取。必须看到 `stopped`、无 active turn、停止计数以及 human cancellation 记录。读取仍 active 或 trace 不符时保存失败；不会重新发消息、重复 stop、循环读取状态来隐藏失败。失败清理只会在尚未发出 stop 的情况下补一次停止。

## Provider 结束之后再审计、再清理

所有发过消息的 observe 用例均保留成员，报告写入 `retainedForProviderAudit=true` 和 `lateSideEffects=pending_provider_terminal_and_one_database_audit`。无消息的空群可直接清理。不能在等待 provider 返回期间移除 Bot，否则成员资格的检查可能阻挡迟到写入，让真正的取消缺陷无法被发现。

执行者需要记录真实 provider start/end/abort 与报告里的 `sentAt`、`stopRequestedMs`、`stopAcknowledgedMs`，明确这次停止属于 before 或 during。私聊 case 要对应目标模型的第二段 private generation，不能使用第一段 lead 的 provider 结束时间。

确认目标 provider 已结束之后，用 `workspaceId + groupId + messageId` 精确范围做一次正常授权的数据库审计：

- 本群 turn 的最终 stopped 状态和 cancellation 记录；公开 Bot 消息没有在停止后增加。
- 仅本消息 anchor 对应的 conversation link 和两测试 Bot 的私聊；预期第一条测试私聊已经存在，停止后不再追加目标回复。
- 同 turn 没有新 delegate/task side effect。只输出计数、时间和 ID，不输出内容。

审计完成并保留结果后，独立 `group-stop.mjs cleanup <group-receipt.json>` 再校验精确 scope，正常 stop 该既有群、读取一次闲置状态、移除这两个成员并隐藏该群。它不发消息、不改 Bot 模型。清理不能自动宣布 provider 审计通过；是否调用由执行者以真实终止和审计证据决定。

最终 `cleanup-workspace.mjs` 要求所有群清理 receipt 完整、群集合精确匹配、无 active turn、无额外资源，才正常删除这个专属 team。群没有单独公开 DELETE API，相关群/私聊记录随最终测试 workspace 清理。

## 离线验证范围

`node --test scripts/acceptance/issue-1506-alex/group-stop.test.mjs scripts/acceptance/issue-1506-alex/cleanup-workspace.test.mjs`：17 项通过，全局 fetch 禁用。覆盖 public/private 两模型边界、未知确认不重发、仅实际事件驱动有限读取、缺少 private generate 记录时失败、provider 审计前保留成员、独立清理与最终删除的 scope guard。

离线结果不是生产取消、延迟或零迟到副作用的证据。生产尚未执行此 group 草案。
