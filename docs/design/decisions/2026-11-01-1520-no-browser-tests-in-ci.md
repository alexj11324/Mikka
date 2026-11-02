# CI runs no browser tests

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「取消掉那个浏览器测试的 CI……直接替换掉现在的 CI，不允许他再做这个浏览器测试了」
- Rule: —
- Superseded in part by: [2026-11-01-2225-api-cli-acceptance-and-backend-owner](2026-11-01-2225-api-cli-acceptance-and-backend-owner.md) (no browser tests locally either; acceptance through API and CLI)
- Replaces: [2026-11-01-0230-browser-tests-manual-only](2026-11-01-0230-browser-tests-manual-only.md) rule 1 (browser tests run by hand from Actions)

CI runs no browser tests: not on pull requests, not on `main`, not nightly and
not by hand. `browser-tests.yml` and its runner `scripts/ci-browser-tests.mjs`
are deleted.

UI changes are verified locally with a production build (`next build`, then
`next start`) and screenshots, reviewed before merge
([dev workflow](../../dev-workflow.md)). Browser specs under `tests/e2e/`
stay and run locally.

`browser-gate.yml` remains only because `main`'s branch protection still
requires the check name "Browser tests (before merge)". Its one job passes at
once; delete the file once Alex removes that name from the required checks in
the repository settings.

The CI production build stays off (0230 rule 3); "Production build and
browser interactions" remains the name of the database-suite gate.
