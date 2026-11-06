# Model routing judges only model strength and reasoning effort

- Date: 2026-11-06
- Source: Alex, 2026-11-06, relayed by the coordinator, on the thread detail 「难度未判断 → claude-opus-5-5」: 「按照道理来说，只应该判断模型跟推理强度吧」, and use the Decisions API as OpenAI's guide recommends.
- Rule: —
- Replaces: the difficulty, model-candidate and reason questions of [model-difficulty-routing.md](../model-difficulty-routing.md) (issue #1329)

Automatic model routing asks the Decision judge two independent `score`
questions about the task: the model strength it needs (light, standard,
strongest) and the reasoning effort it needs (low … max). The judge never sees
the person's candidates. The host rounds the strength score, takes the first
listed runnable model of that tier, else of the nearest higher tier, and only
when nothing at or above it can run, the strongest tier that can. Effort is
the level nearest its score that the model supports; a model with no effort
setting keeps its default.

Only a refused, failed, malformed or very uncertain strength judgement keeps
the person's list order. An uncertain effort sends no override and never
discards the model. The threshold is set from labeled examples
(`tests/fixtures/model-routing-labeled.json`,
`scripts/model-routing-calibration.ts`), not a fixed guess.

The thread detail shows the judged strength, not a difficulty:
「标准模型 → Claude Sonnet 5.5 · 高推理强度」. Runs frozen before this change keep
their recorded difficulty.

Guide: https://developers.openai.com/api/docs/guides/decisions ("Use `choice`
for unordered categories and `score` for ordered levels"; "For decisions that
depend on an earlier answer, send separate requests"; "Use labeled examples
from your application to set thresholds").
