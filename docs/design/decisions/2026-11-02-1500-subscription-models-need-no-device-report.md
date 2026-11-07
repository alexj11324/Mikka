# A subscription's model runs on any computer that takes subscription runs

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session, after 「设置 › 模型与订阅」 showed 没有电脑能跑 Claude Code with two computers online and taking part: 「我明明连接了电脑，为什么说没有电脑能跑？」 The coordinator's rule: a Claude subscription's model can run when a computer is online, takes part and has Claude Code; the subscription's credential decides the model, not a model the computer reported; when nothing can run, the status says the specific reason.
- Rule: —
- Replaces: in [2026-11-02-1400](2026-11-02-1400-model-order-dispatch.md), "for a subscription model, the model among what its CLI reported" (Dispatch, 本地) and 这台电脑的 Codex 没有报告 <model>.

**本地, a subscription's model**: one of the person's computers with
参与调度 on, online, the Agent installed and its Mikka able to take a
subscription run (the daemon reports `subscriptionBroker` for that Agent).
The computer's CLI need not have reported the model: the account's catalogue
says what the account may use ([2026-11-02-1300](2026-11-02-1300-device-models-checked-against-account.md);
the probe runs without a login), and the run hands the model to the CLI.
When the CLI reported a slot for it, the slot runs. An API key's model is
unchanged: the Agent installed is enough.

`subscriptionBroker` is the protocol's compatibility name for a daemon that
can receive a selected subscription assignment. A computer without this
capability must update before claiming subscription work. Under
[1800](2026-11-06-1800-machine-is-the-execution-boundary.md) the assignment delivers real credentials
up front and the CLI uses the provider directly; the legacy capability name
does not require a provider proxy or per-call remote permission check.

**Why it cannot run**, in 允许使用的模型 and on the 没有能跑这个任务的模型 card,
is told from the computer closest to running it, by name when it is the only
one at that step:

- 还没有连接电脑
- <电脑> 没参与调度
- <电脑> 离线
- <电脑> 没装 <Agent>
- <电脑> 的 Mikka 需要更新 (no `subscriptionBroker`)

Several computers at that step: N 台电脑… . A computer the person names
reads 这台电脑没装 <Agent> or 这台电脑的 Mikka 需要更新.

Production evidence (2026-11-02, read only): the person's Mac and server were
online with 参与调度 on and Claude Code 2.1.309 reporting `installed` and
`subscriptionBroker` but no `models` or `modelSlots`; each had a Claude Code
Agent; the list was the untouched default (opus from the Claude Max catalogue).
