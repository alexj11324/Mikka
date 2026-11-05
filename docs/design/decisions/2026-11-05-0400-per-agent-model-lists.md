# Each Agent keeps its own 优先使用的模型; the page re-reads on its own

- Date: 2026-11-05
- Source: Alex, testing 设置 › 模型与订阅 in production, relayed by the coordinator session: the 优先使用的 Agent toggle does not filter the list (「选了 Claude Code，只显示 Claude Code 能跑的模型；选了 Codex，只显示 Codex 能跑的模型。每个 Agent 有自己的优先顺序」); the page does not refresh after a subscription connects; 「待检查」 does not change after 检查额度; there is no way to refresh a subscription's models. The coordinator filled in what Alex did not say (marked "coordinator").
- Rule: R-05 (link)
- Replaces: in [2026-11-02-1700](2026-11-02-1700-preferred-agent.md), "in a stored list, the rows of such models that were on the old preferred Agent move with it"; the single mixed list of [2026-11-02-1830](2026-11-02-1830-preferred-models-and-agent.md).

**One list per Agent.** 优先使用的模型 shows only the rows of the
优先使用的 Agent: Claude Code shows what Claude Code runs, Codex what Codex
runs. 添加模型 offers only that Agent's models, and an empty list reads
「<Agent> 还没有优先使用的模型」. Each Agent keeps its own order; reordering
one never moves the other's rows. Switching 优先使用的 Agent moves no rows, it
only picks which list is shown and tried first. Storage is unchanged: one
ordered list whose entries each carry their Agent.

An untouched list gets a default for each Agent (decision 1400's rule, per
Agent). A model both Agents run stays on the 优先使用的 Agent, as before.

**Dispatch follows the same split** (coordinator). With no Agent named, a
thread tries the 优先使用的 Agent's list in order, then the other Agent's list
in order. The second list is a fallback, not a mix: a computer that only has
Codex, or a 优先使用的 Agent with an empty list, still gets a run. A thread or
computer that names an Agent uses only that Agent's list, as before.

**A model the account dropped** stays in the list, marked
「账号已不提供这个模型」 and skipped by dispatch, until the person removes it.
It is never deleted silently.

**刷新模型.** Each connected subscription's menu has 刷新模型. It reads the
account's model catalogue again, shows a loading toast, then
「<订阅>：N 个模型」 or 「<订阅> 的模型未能刷新」.

**Live, no polling** ([0200](2026-11-05-0200-no-new-polling.md)). Connecting,
reconnecting, pausing, disconnecting or removing a subscription, a quota
reading (检查额度, a meter, dispatch), a model refresh and a change to the
order each push `workspace_settings` to every workspace the owner is in; the
subscriptions and 优先使用的模型 sections re-read on it. The action's own
response updates the page that sent it.

**待检查** (coordinator). Dispatch still treats a quota reading older than a
minute as unknown. The page shows the last reading for 15 minutes
(`QUOTA_DISPLAY_MS`), so 检查额度 changes the row at once; older than that,
or a used-up window whose reset has passed, reads 待检查 again.
