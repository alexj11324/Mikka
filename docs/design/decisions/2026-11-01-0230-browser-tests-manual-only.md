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
3. CI does not run the production build (Alex: 「走 Vercel 部署，把 CI 压到3分钟」).
   Type checks still run in "Source checks". Vercel builds `main`; a failed
   build there leaves production on the last good deployment and is fixed
   forward. Vercel does not build pull requests.
4. The desktop release gate waits only for `ui-policy.yml` on the merge commit.

Why: in 47 sampled red browser runs, 5 were real bugs; the rest were
infrastructure, outdated tests and flakes. The suite was the last check to
finish on 75% of pull requests (median 13 minutes).
