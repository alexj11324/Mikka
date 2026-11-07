# Production acceptance only for what cannot be tested locally

- Date: 2026-11-07
- Source: Alex, 2026-11-07, after #1603's refresh fixes waited on a shared-account sign-in to finish: 「你是对桌面这个进行刷新的测试，你为什么需要真实账号呢？」 He then approved: 能在本地生产构建上测的不再做生产验收；只有本地测不了的才上生产验；另加一个上线后自动跑的冒烟测试。
- Rule: AGENTS.md「After the merge」, `docs/acceptance.md`「Production acceptance after a merge」, `docs/dev-workflow.md` § 5
- Replaces: the rule that every merged change is accepted in production with the shared test account

After a merge the owner still watches the production deployment until it is
READY and serves the merge commit. What follows depends on what the change
touches.

A change a local production build can show (UI, interaction, navigation,
page refresh, layout, copy) is accepted by CI and the PR's screenshots of a
local production build. The owner notes that production serves the merge
commit and closes the issue. It does not sign in to production, wait for a
merge window or hold `main`.

Only what a local build cannot exercise is accepted in production: real
Claude Code and Codex subscriptions, OAuth sign-in, model providers, the
GitHub App, payments, push notifications and other external services. Those
checks keep the shared test account in the Acme Inc. workspace and a real
task.

Every production Web deploy runs an automatic smoke test with the shared
test account: sign in, send a Coordinator message, dispatch a task. It
reports only when it fails. It does not replace the external-service checks,
and a failing run is fixed forward first.

Why: per-change production acceptance of UI work kept owners waiting for
credentials and merge windows, and every acceptance run held `main` for
others. Industry practice (LobeHub, T3 Code) accepts UI changes in CI and
watches production with automated smoke checks and monitoring.
