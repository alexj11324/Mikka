# Reasoning text when the model returns it (003b42e)

Local production build of 003b42e (`next build`, `next start` with `MIKKA_TEST_MODE=1 MIKKA_MVP_E2E=1`, the existing local test mode, see ../pr2-ai-elements/README.md) at http://localhost:3000/mikka, isolated PostgreSQL 17 `mikka_e2e`. `repro-activity.mjs` is the runner; `REASONING=text|none` picks the case. The stream is scripted and the stored rows follow the workflow's format. The cloud dispatch succeeds and 查看日历 fails, as in ../pr2-ai-elements/.

- `text/`: the model returned readable reasoning.
  - `states.png`, left to right: 思考中 → 思考了 3 秒 opened live (AI Elements ReasoningContent, closed by default; opened here by a click) → tools → stored 已思考 opened, with the same text read through `coordinatorReasoning`.
  - `result.json`: `storedReadable: "readable"`, and `storedOpenText` is the same text as live.
- `none/`: encrypted reasoning, no text.
  - `states.png`: 思考了 3 秒 with no chevron → stored 已思考 with no chevron.
  - `result.json`: `storedReadable: "none"`, trigger `disabled`.

The small Mikka mark change (ad23f38) is reverted in cc974b2 (Alex's decision), so 「1 个来源」 shows the original mark.
