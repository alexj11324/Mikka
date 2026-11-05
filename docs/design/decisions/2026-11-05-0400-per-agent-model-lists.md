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

**Precedence** (Alex, via the coordinator: Agent and model for a dispatch are
already set by Agent Profiles and the Decision API, #1284 / #1297). In order:

1. An explicit choice: the model the person picked for the thread, or the
   Profile they picked (its Agent, and its model when the Profile fixes one).
2. The Profile the Decision API chose for a Factory task (`lib/factory/agent-profile*.ts`).
3. Only then the lists above: a Profile that inherits 优先使用的模型 gets them
   (a Profile with a fixed Agent sees only that Agent's list, never the other's;
   one on 自动 gets the 优先使用的 Agent's list, then the other's), and so does a
   dispatch that goes through no Profile (ordinary threads, chat).

This change adds no second way to choose: the per-Agent order is the inherited
list the Profile path already reads (`resolveModelDispatch`), and a fixed model
(`exactEntry`) bypasses it. Covered by `lib/factory/agent-profile.db.test.ts`
("per-Agent lists").

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

**Plain words on this page** (Alex, the same day: he could not follow
「这个工作区 / 分享给团队成员」 or 「依次用：云端 → 服务器 → 电脑 · 没有能跑的位置」).
Every row says what it is and what happens when it is on or picked:

- The share switch is 「分享我的订阅给团队成员」 under 「团队共享」. Its line is
  always shown: 「<工作区> 的成员也能用你的 <Claude、ChatGPT> 订阅跑任务，用量算在你的额度上」,
  naming the connected subscriptions; on, 「已分享 <…> 订阅 · 成员跑任务时凭据会临时放到他们的电脑上」.
- 运行位置 reads 「任务先在云端跑，云端不行就换服务器，再不行用你的电脑；现在会先用 <位置>」
  (本地: 「任务先在你的服务器跑，没有服务器就用你的电脑」); nothing available:
  「现在三个都没有可用的」 / 「现在两个都没有可用的」.
- 优先使用的模型: 「任务从上往下选第一个现在能用的模型」; 优先使用的 Agent:
  「任务先交给它，按它的模型顺序选；它跑不了就换另一个」.
