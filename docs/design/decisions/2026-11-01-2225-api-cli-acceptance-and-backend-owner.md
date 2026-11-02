# Acceptance is API and CLI only; Codex owns backend changes

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: no browser tests in CI or
  locally, acceptance through API and CLI; local work uses the DeepSeek key with
  DS 4.1 Flash, not the AI Gateway or Mikka 默认; backend changes are now
  Codex's, with [the handoff](../../handoff-codex-to-cc-2026-11-01.md) as the
  starting point.
- Rule: — (process, not product)
- Replaces: [2026-11-01-1520-no-browser-tests-in-ci](2026-11-01-1520-no-browser-tests-in-ci.md), the sentence "Browser specs under `tests/e2e/` stay and run locally"

1. **No browser tests anywhere.** CI does not run them (1520), and neither does
   local work. Acceptance runs through the API and the CLI: the local MVP
   acceptance is `pnpm test:local-loop`
   ([local-runtime.md](../../local-runtime.md),
   [record](../../acceptance-mvp-cli-2026-11-01.md)). A UI change is still
   checked with screenshots of a local production build, reviewed before
   merge. The specs under `tests/e2e/` stay in the repository but are not an
   acceptance entry point.
2. **Local model.** Local development and acceptance use DS 4.1 Flash through
   the workspace's own DeepSeek key (`DEEPSEEK_API_KEY`, Infisical
   `dev:/vercel`), never the AI Gateway or Mikka 默认
   ([local-runtime.md](../../local-runtime.md#which-model-local-runs-use)).
3. **Backend owner.** Backend changes (server, API, database, daemon) are
   Codex's. Start from
   [`docs/handoff-codex-to-cc-2026-11-01.md`](../../handoff-codex-to-cc-2026-11-01.md)
   and [#838](https://github.com/alexj11324/Mikka/issues/838); anyone else asks
   before changing the backend ([dev workflow](../../dev-workflow.md) § 5).

Local first, trunk-based merging and never faking CI variables stand as
[`dev-workflow.md`](../../dev-workflow.md) says (1440, 1545).
