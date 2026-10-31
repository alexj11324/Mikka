# Coordinator OpenUI instructions follow OpenUI's generator

- Date: 2026-10-31
- Source: Alex, 2026-10-31, testing the Coordinator after 「介绍一下北京的历史」 and 「北京有哪些景点啊?」 came back as plain Markdown: 「是不是我们没有按照 Vercel 的 AI Gateway，还有 OpenUI 官网的那些 instruction，来做这个提示词和这些设计啊？」
- Rule: —
- Replaces: the hand-written Coordinator presentation block that opened with "Prefer a natural text reply for a simple exchange"

The Coordinator's OpenUI instructions follow OpenUI's own method.
`generateSystemPrompt` writes the syntax, component, streaming and example
sections from the component library at build time
(`lib/coordinator-ui-prompt.json`). Mikka adds only a short preamble and rules
(`lib/coordinator/presentation-options.ts`).

Content with structure uses components:

- several places or items → BeCardGrid of BeImageCard;
- a history or timeline → Steps;
- a comparison → BeTable or a chart.

Conversation stays plain text. Every Coordinator and bot path (hosted model,
subscription model, native Codex and Claude) carries the block exactly once.
Progressive streaming (#648) is kept.
