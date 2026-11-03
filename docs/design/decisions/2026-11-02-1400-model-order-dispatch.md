# Threads take the allowed models in the person's order

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: 「就这么去做吧」 on the model-order scheme, then his additions the same day (the default order; two settings entries, 「设备」 and 「模型与订阅」; 「允许使用的模型」 with add/remove and drag order; run location on that page). The coordinator filled in what Alex did not say (marked "coordinator" below).
- Rule: —
- Partly superseded by: [2026-11-02-1500](2026-11-02-1500-subscription-models-need-no-device-report.md) (a subscription model needs no report from the computer's CLI); [2026-11-02-1530](2026-11-02-1530-local-server-first.md) (本地 picks a server first, then the least busy device, not at random); [2026-11-02-2330](2026-11-02-2330-cloud-first-dispatch.md) (运行位置: 云端 the default, then a server, then a computer; 本地 a server, then a computer)
- Replaces: [decisions.md](../decisions.md) rows on label execution rules and 任务默认; [2026-10-31-2200 run machine fallback](2026-10-31-2200-run-machine-fallback.md) as to how a new run picks its machine; the 「允许调度」 / 「允许自动调度」 pair; 「Bot 与 Agents」 and 「API 与订阅」 as settings entries; [2026-11-02-1200](2026-11-02-1200-api-keys-own-group-and-provider-models.md) as to key models in 「Bot 与 Agents」.

## Settings

Two entries replace 「API 与订阅」 and 「Bot 与 Agents」:

- **设备**: the person's computers, each with one switch, 参与调度. Off: Mikka
  never sends that computer a run. The two old switches (允许调度,
  允许自动调度) are this one now; a computer whose owner had turned
  允许自动调度 off keeps out, every other one takes part. Its groups are
  本机 and 服务器 (once 「Remote control」; 服务器 is what the rest of the
  product calls these machines); each computer lists its Agents with their
  versions (Claude Code 2.1 · Codex 0.9).
- **模型与订阅**: first the subscriptions and API keys (connect, status, a
  key's model count, 重新获取模型 and the reason a fetch failed; each
  subscription's switch is labelled 启用), then
  运行位置 and 允许使用的模型. 付款 is under 计费 only. Bots of people who
  left moved to 常规.

**允许使用的模型** is an ordered list. Each entry is an Agent and a model of
one credential: a subscription's models are what its account's catalogue
lists, a key's what its provider's /models answered (no model name written
in code, decision 2026-11-02-1030). The same model under two Agents is two
entries. The person adds entries from those candidates, removes them (with
a confirmation), and orders them by drag or from the keyboard (Space to pick
up, arrows to move, Space to drop) or with 上移 / 下移. Each row shows
可用, or why it cannot run now: 额度用完 · <when> 恢复, 需要重新连接,
Key 无效或已被撤销, 已不可用, or 没有电脑能跑 <Agent>; a subscription
turned off (启用 off) reads 订阅已停用 on each of its models. A personal and a team
workspace each keep their own list.

An API key's Agent follows its protocol: an OpenAI-compatible key runs on
Codex, an Anthropic-compatible one on Claude Code. That is what the Agent
can talk to, not a guess from the model's name.

**Default** (Alex, 2026-11-02, revised the same day): a list the person
never changed is filled at read time from what they connected and what it
reported, subscriptions and API keys alike:

- A Claude subscription, or a key that runs Claude Code, that reported an
  opus model: that model first (a subscription's before a key's).
- A Codex model reported by a subscription or an OpenAI-compatible key: the
  first one it reported, after opus. The account lists its top model first;
  no reasoning-tier word is required, and tiers are left out for now.
- Neither: the first model anything connected reported, so the list is not
  empty (only a DeepSeek key: DeepSeek's first model).
- Nothing connected: an empty list.

The one preference word, `opus`, is matched against reported model ids and
names (`DEFAULT_ORDER_PREFERENCE` in `lib/model-order-plan.ts`, the one
allowlisted exception in `lib/model-options-source.test.ts`); no model name
is written in code.

**A model the thread names** (coordinator, 2026-11-02) is the only one tried;
it never falls back to the list. No subscription or key offers it on that
Agent: 没有订阅或 Key 能用 <Agent> 跑 <model>. Offered but nothing can run it now:
没有电脑能用 <Agent> 跑 <model>, or <Agent> 的 <model> 暂时不可用.

**A computer the person names** fixes only where the run goes. The model is
chosen by the same rule: the thread's own model, else 允许使用的模型 in order,
the first this computer can run (its Agent installed and, for a subscription,
the model reported). Nothing it can run: the card says what it lacks
(这台电脑没装 Codex; 这台电脑的 Codex 没有报告 <model>), and no other Agent is
put in its place.

**运行位置**: 云端 or 本地, one choice per list.

## Dispatch

A new thread's run:

1. The model the person picked for this thread, when they did (coordinator),
   then the list in order.
2. The first entry that can run now: its credential is usable (connected, not
   paused, quota left by the stored meter, the key not refused) and the run
   location has a place for it.
   - 本地: one of the person's computers with 参与调度 on, online, the Agent
     installed and, for a subscription model, the model among what its CLI
     reported (by id, slot, or the model a slot resolves to). An API key's
     model needs only the Agent. One such computer is picked at random.
   - 云端: the person's own E2B key is set; the run goes to the bot's own
     cloud machine.
3. The run is frozen on that entry: its Agent, model, device, and credential
   (a subscription entry binds that account to the Agent). Once a run
   starts none of them changes (coordinator).
4. Nothing can run: no run is created and the bot shows
   「没有能跑这个任务的模型」 with the reason (coordinator): 还没有允许使用的模型,
   允许使用的模型都没有电脑能跑, 云端还没有 E2B Key, or 允许使用的模型都暂时不可用,
   and rows that fix it (打开模型与订阅, 连接电脑, 填入 E2B Key).

A computer the person names, and a thread continuing where it ran, are used
as asked, as before.

Removed (coordinator): label rules and 任务默认, the code that picked an
Agent from a model name (`harnessForModel` / `agentFor` in dispatch) and the
fallback to a computer's first installed Agent. The old `execution_rules`
rows are not migrated: a rule's model was a device slot, not a credential's
model, so it cannot become an entry; the default above takes its place.

## Borrowed, and not yet

From yetone/magpie@c51bc906 (a local LLM gateway, not a task dispatcher;
`internal/gateway/fallback.go`, `docs/reference.md:1684-1733`): an ordered
model list with move up / down and remove, strict order mode, and a session
that stays on its account. Not built yet: skipping a model for a cooldown
after a 429 and the 「限流 · N 秒后恢复」 status, since Mikka records quota
from the meter, not from failed requests; a later change can add it to the
same row status.
