# Browser tests run only when started by hand

- Date: 2026-11-01
- Source: Alex: 「把浏览器测试给我撤了，太费时间了，不值得。…CI 里面直接取消掉浏览器测试。」
- Replaces: the browser tiers in `CONTRIBUTING.md` ("How changes are tested",
  items 3–5) and the two-level plan in #721.

## Rule

1. CI does not run browser tests on pull requests, on pushes to `main` or
   nightly. `browser-tests.yml` runs only from Actions → Browser tests → Run
   workflow.
2. `browser-gate.yml` reports the protected check name
   "Browser tests (before merge)" and passes at once, so pull requests are not
   blocked while branch protection still lists it.
3. The production build (`pnpm build`) moves to "Database checks (1/4)" in
   `ui-policy.yml` for every event, so a pull request that breaks the build
   still goes red.
4. The desktop release gate waits only for `ui-policy.yml` on the merge commit.

Why: in 47 sampled red browser runs, 5 were real bugs; the rest were
infrastructure, outdated tests and flakes. The suite was the last check to
finish on 75% of pull requests (median 13 minutes).
