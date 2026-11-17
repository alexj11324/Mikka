# 一个线程只用一个 Agent；每次派发都要点名 Agent

- Date: 2026-11-17
- Source: Alex, 2026-11-17, 「要改」: approving no cross-Agent fallback and a required Agent on every dispatch.
- Rule: —
- Replaces:
  - [2026-11-05-0400](2026-11-05-0400-per-agent-model-lists.md): "Nothing for this Agent, models for the other" (「任务会交给 <other>」, 「改用 <other>」, 「<other> 列表作为后备 · N 个模型」) and "Dispatch follows the same split" (the other Agent's list as a fallback for dispatch and provider fallback); in its precedence, "one on 自动 gets the 优先使用的 Agent's list, then the other's".
  - [2026-11-15-1630](2026-11-15-1630-agent-profile-is-a-role.md): a new task without a named model following the dispatching chat's own model (「跟随主线程」). Older runs keep their `modelDispatch.followed` mark.
  - [2026-11-17-1400](2026-11-17-1400-subscriptions-owner-only.md), last rule: a named computer's only Agent, or the chat model's Agent, no longer stands in for a named Agent on a new thread.

## 决定

1. **一个线程一辈子只用一个 Agent。** 重试、续跑、模型额度用完、服务商出错、模型不可用之后的接续，都只用这个线程自己的 Agent（Claude Code 或 Codex），绝不换成另一个。同一个 Agent 的 优先使用的模型 里还有能跑的模型，可以换到下一个模型；没有了，这次运行就停下，并给出有编码的、用户看得见的原因（「没有能跑这个任务的模型」卡片，原因只列这个 Agent 的模型）。云端起不来、改到服务器或电脑上跑时，也只用这个 Agent。
2. **每次新派发都必须点名 Agent。** 不再从 优先使用的模型 里挑第一个能用的，也没有默认 Agent。没点名的派发直接拒绝，返回 `agentRequired`，不建任何运行。覆盖所有入口：
   - Coordinator 和 Bot 的 `dispatch_run`：`model.harness` 是必填参数，模型必须传；人没说用哪个 Agent 时，模型要先问，不能自己选。
   - Bot 电脑上的新线程（`dispatch_bot_computer`、`/api/bots/{botId}/computer/runs`）：新线程没有 `harness` 就拒绝。
   - MCP `dispatch_run`：本来就必须给 `agentId`，Agent 由它确定。
   - 网页 新建任务：创建并派发时必须选 Agent，默认不选；所选 Agent 随任务命令（`taskCommand.agent`）送到服务端，服务端以它为准。
   - 群聊任务（group-factory）：新任务只用消息里点名的 Agent（Claude Code 或 Codex 恰好提到一个），否则拒绝并在群里说明要写明 Agent。
   - 定时和事件触发的自动化：用自动化里保存的 Agent（`dispatch_task.agent`）；没有保存就拒绝。已有线程的后续运行沿用线程自己的 Agent。
3. **设置 › 模型与订阅 不再有跨 Agent 的后备。** 去掉「任务会交给 <other>」、「改用 <other>」、「<other> 列表作为后备 · N 个模型」和对应文案。每个 Agent 的 优先使用的模型 仍是这个 Agent 自己的有序模型列表；Agent 切换只决定显示哪一个列表。同一 Agent 列表内的模型回退保留。付费 UI 块原样使用，只改数据和文字。

## 实现

- `lib/run-provider-fallback.ts`：恢复时固定在线程的 Agent（Agent 配置的 Agent，否则 `modelDispatch.entry.harness`，否则运行自己的 harness），已尝试和不可用原因都只算这个 Agent 的列表。
- `workflows/coordinator/steps.ts`：云端起不来改到电脑时限定同一个 Agent；新线程没有 Agent 返回 `agentRequired`；线程的后续运行在原处跑不了、按规则重新安排时，沿用线程的 Agent。
- `lib/factory/agent-profile.ts`：`resolveAgentProfileDispatch` 没有 Agent 时抛出 `agentRequired`，作为所有派发路径的最后一道关。
- 新建任务、自动化编辑器、群聊和定时任务把 Agent 带到派发；`get_issue` 返回线程的 `agent`。
- 测试：`tests/run-provider-fallback.db.test.ts` 把跨 Agent 回退的用例改成断言停下并给出原因，同 Agent 的回退用例保留。
