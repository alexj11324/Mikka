# Every bot replies, not only the Coordinator

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator: 「现在只有 Coordinator 能够回复，另外一个 BOT 是没有办法进行回复的」; on subscriptions: 「我开 10 个，不是要绑 10 次吗？」; then a 重试 action on the failed-reply notice
- Rule: R-40
- Superseded in part by: [2026-10-31-2110-bots-reply-on-mikka-cloud](2026-10-31-2110-bots-reply-on-mikka-cloud.md) (a chosen subscription whose account is gone)
- Replaces: bots without a subscription refused with `binding_required`, retried three times and shown as 「Reply failed — Step … failed after 3 retries: binding_required」

A connected subscription belongs to the account and every bot uses it on its
own; nobody binds a subscription per bot. Every bot, the Coordinator included,
runs on:

1. the model the person picked for that bot;
2. otherwise the account's connected subscription (any per-bot binding row is
   internal and never shown);
3. otherwise the hosted default (Mikka 默认), through the same admission
   (verified card, one-off allowance, points; decisions.md 2026-10-30) and the
   workspace's billing. A hosted refusal shows the same line and next steps as
   in the Coordinator chat.

~~A chosen subscription whose binding is missing or revoked still refuses and
never falls back to a paid default~~ (superseded: it now moves to another bound
subscription or the hosted default)
([coordinator-model-judgment](../../coordinator-model-judgment.md), Frozen
subscription).

A subscription refusal fails the turn once, without step retries, and shows one
line above the composer in place of 回复失败 and the raw step error, for the
Coordinator and every bot alike: 所选订阅不可用 / 订阅需要重新连接 /
订阅额度已用完 / 订阅暂时不可用, each with 模型与额度 except the last.

Every failed-reply notice (回复失败, a hosted refusal, a subscription refusal)
has 重试 beside its existing next-step link (验证银行卡 / 连接订阅 / 模型与额度).
It runs the same turn again for the message already sent, once per click, never
in a loop, with the chat's normal working state while it runs; one shared
button for the Coordinator and every bot. Wake errors, which the server is
already retrying, have no 重试.

The question card drops empty entries a reply parses to (`,,`) instead of
failing the whole card.
