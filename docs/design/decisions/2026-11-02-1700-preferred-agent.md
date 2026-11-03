# 优先使用的 Agent, a row's Agent, and the empty 允许使用的模型

- Date: 2026-11-02
- Source: Alex, Harness draft (Artifact GnZnsPYEDJdkHBUJHzB5SJ, Version 2; Figma zPe5LKycb2XuT1ivCLRw07 page 855:2, screens 1–3) and the coordination draft's decision 1 (Artifact NXhjpSTmgDq1aVNqzLYP2x, Version 2); C8 of the second usability review (Artifact NwyzbbJRzXTVNc1orNenjE), relayed by the coordinator session.
- Rule: R-41 (an empty state is one line and one button)
- Replaces: —

**优先使用的 Agent.** 模型与订阅 has an 「Agent」 section with 优先使用的
Agent, Claude Code or Codex, Claude Code by default (stored per person and
workspace, `model_order_settings.preferredHarness`). A model both Agents can
run (a DeepSeek or Kimi key, [1620](2026-11-02-1620-preset-keys-speak-both-protocols.md))
goes on it: an untouched list follows it at read time; in a stored list, the
rows of such models that were on the old preferred Agent move with it.

**A row's Agent.** Each row reads 「<来源> · 只能用 <Agent>」 or
「<来源> · 两种 Agent 都能跑」. A row of a model both Agents run has an Agent
menu; 优先 marks the preferred one. Switching keeps the row's place; it is
refused when the other Agent is not offered or the model is already listed
there. 添加模型 lists one row per model and Agent, under the same group line.

**Empty list (C8).** With nothing to add, 允许使用的模型 says what is
missing, 「还没有订阅或 API Key」 or 「订阅和 API Key 还没有报告模型」, with one
button to the subscriptions and API keys above, instead of a greyed 添加模型
and a note.

**额度用完时.** 「订阅额度用完后，自动改用 API Key」 is its own section after
允许使用的模型: the order picks which model runs first; this switch picks
whether a subscription whose quota ran out goes on with the same model on an
API key. Two separate policies, on the page as two sections.
