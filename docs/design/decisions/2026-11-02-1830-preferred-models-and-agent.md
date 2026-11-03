# 允许使用的模型 becomes 优先使用的模型, with 优先使用的 Agent in the same card

- Date: 2026-11-02
- Source: Alex, reviewing 设置 › 模型与订阅 on a phone, relayed by the coordinator session: Bot chats pick their own model, so this list only orders the models of tasks dispatched to an Agent; it is a preference, not a permission. 「允许」 is the wrong word. 优先使用的 Agent (Claude Code / Codex) belongs with it.
- Rule: —
- Replaces: the separate 「Agent」 section of [2026-11-02-1700](2026-11-02-1700-preferred-agent.md), and the name 允许使用的模型 everywhere it reaches a screen (decision 1400 and later).

**One card.** 模型与订阅 has a card titled 「优先使用的模型」, with the
description 「派发给 Agent 的任务按这个顺序选模型」 (en: Preferred models / Tasks
for Agents pick a model in this order). Its first row is 「优先使用的 Agent」
(Claude Code | Codex). The ordered models follow. The row is shown whether or
not the list is empty, and whether or not a model runs on both Agents.

**The name.** Every screen that said 允许使用的模型 now says 优先使用的模型:
设备's 「能跑 N 个优先使用的模型」 / 「不能跑优先使用的模型」, the dispatch card's
「还没有优先使用的模型」, 「优先使用的模型都没有电脑能跑」 and 「优先使用的模型都暂时不可用」,
and the settings search keywords. The Coordinator's context and instructions
call it the person's preferred models (优先使用的模型).

Behaviour is unchanged: dispatch still takes the first entry that can run now.
