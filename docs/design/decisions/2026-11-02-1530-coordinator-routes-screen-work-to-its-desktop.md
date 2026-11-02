# The Coordinator does screen work on its own desktop and dispatches the rest

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session in the Coordinator prompt
  audit: 「涉及 computer use、要看前端测试过程的，Coordinator 用自己的桌面做；不涉及的，默认派活给 Agent。」
  The coordinator session added on the same day: Mikka 默认 is for Bot chats
  only; threads take 允许使用的模型 in order, and an empty list shows where to add
  a subscription or key, in place
  ([1400](2026-11-02-1400-model-order-dispatch.md)).
- Rule: —
- Replaces: —

The Coordinator decides where work goes without asking the person:

- **Work that needs a screen** (computer use, or watching a front-end flow or
  test run as it happens) goes to the Bot's own computer:
  `start_web_subagent` for a browser check, or `wake_bot_computer` and
  `dispatch_bot_computer` for a desktop thread, which runs on its own machine
  with a desktop ([0251](2026-11-02-0251-desktop-runs-get-their-own-machine.md)).
  The workspace 电脑 policy still decides whether Agents may use a computer
  ([1232](2026-11-02-1232-computer-policy-binds-agents-not-people.md)).
- **Everything else** goes to an Agent with `dispatch_run`.

A thread never runs on Mikka 默认. When the person names only an Agent
(「派给 Codex」), `dispatch_run` takes that Agent's first model in 允许使用的模型,
else the first model a connected credential offers on it; with none, the
card reads 没有订阅或 Key 能用 Codex.

In `lib/coordinator/instructions.ts` (「Where work goes」) and the tool
descriptions in `workflows/coordinator/tools.ts`; scenarios in
`lib/coordinator/scenarios.test.ts`.
