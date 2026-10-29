# Mikka development

- Project skills live in `.claude/skills/`. Use `systematic-debugging` before a fix, `incident`/`perf` for production work, `security` for trust-boundary reviews, and `settings-pages` for Settings IA. The vendored sources, licenses and precedence are in `.claude/skills/README.md`; never run a bundled skill script without reading it first.
- Before any design, spec or UI work, read `docs/design/README.md`. It sets which source wins and points to the rules, component list, decision log and spec template. Run `docs/review-checklist.md` before showing UI to anyone; new decisions from Alex go into `docs/design/decisions.md` the same day.
- UI copy has no filler (R-40). Before any string reaches a screen, a Figma frame, a spec or a subagent brief, delete it and look again; if the screen still says the same thing, leave it out. Sheets and dialogs have no subtitle; reassurance is a mark (🔒 Secured by Mikka), not a sentence; status lines name the state only. A reviewer fails a frame or PR that has such a sentence, even when the brief asked for it.
- Bot, thread and chat mean what `docs/design/glossary.md` says. The left column is the bot list (bots chat with people and dispatch tasks); the right column is the thread list (threads do the work, each with its own name). There is no conversation list.
- Develop and run ordinary functional acceptance in cloud Linux against a local application, a real isolated database and, when relevant, a real daemon. Builds and type checks run in cloud Linux or CI. Do not start a development server, database, browser acceptance environment, build or `tsgo` on the developer's Mac. Small source-only unit tests may run without a server.
- Test in layers (CONTRIBUTING.md, "How changes are tested"): while working run typecheck, lint and the unit tests for what you changed, plus the one browser test for a flow you changed. Do not run the full Playwright suite for every step; CI selects critical and affected browser flows for ready pull requests, escalates shared/unknown changes to full functionality, and runs full functionality plus performance on main, nightly and manual integration runs.
- Store project credentials in the Mikka Infisical Cloud project. Use cloud Secret Syncs and workload identities for delivery and Agent access. Never commit secret values or add credentials to local environment files.
- **REUSE EXISTING USABLE INFISICAL IDENTITIES.** Use any existing identity that can complete the authorized task, admin or non-admin. Do not create another identity, increase identity count or upgrade the plan when an existing usable identity is available. Check other existing identities if one fails. Do not attribute execution-review or unsaved-rule failures to a user ban on non-admin identities. See `docs/infisical-cloud.md`.
- Before asking for Infisical or database access, identify the environment, resource and effective identity, then check the existing authorized path and the actual error. A successful path for the requested action does not need a second permission request. On the developer's Mac, follow `~/.codex/rules/infisical-api.md` when available; cloud tasks use their own configured workload identity and must not assume access to the Mac's Keychain.
- Ordinary acceptance uses the existing automatic test-account allocation, reuse and lease mechanism by default (`scripts/test-accounts/session.mjs` and `pool.mjs`). It obtains a real application session through normal email sign-up or sign-in; use the helper's owner/peer identities, lease lifecycle and browser state rather than asking the user to log in manually. Keep credentials, cookies and retained session files out of reports.
- The current shared account adapter implements `isolated-ci` with loopback application/database targets and existing environment attestation, origin, database identity and lease checks. This is its present implementation scope, not a user ban on other environments. Use an already supported test-identity setup for the environment being tested; describe any missing adapter capability precisely without removing its safety checks. Preserve environment and database branch boundaries.
- Running an authorized test includes its normal setup and cleanup of disposable fixtures, schemas and temporary files created by that test in an isolated test environment. Verify the target and isolation first; do not extend this to shared or production data. Honor any explicit preservation or approval requirement for the current task.
- Preserve unrelated changes and keep secret values out of terminal output, screenshots and reports.
- Follow `docs/acceptance.md` for runtime acceptance. Real Google/GitHub OAuth is required for checks specifically involving OAuth rules, provider linking or OAuth proxy/callback routing, rather than ordinary business flows. Those checks use the stable HTTPS hub configured by `BETTER_AUTH_OAUTH_PROXY_URL`, the exact originating application origin and existing authorized provider/browser sessions. Deliver its shared secret through existing cloud configuration, preserve account ownership checks and diagnose linking conflicts separately. Do not request passwords or verification codes in chat.
- Record the branch/revision, Git-linked CI run, application origin, database/daemon environment and acceptance evidence. Keep the tested code and environment fixed within a run. Reuse valid results through Git's PR/commit-to-CI association; repeat relevant checks when code or environment changes, or the recorded version does not match. A moving branch alias or shared production domain does not identify an isolated acceptance run.
- **Review risk triage:** For each actionable bug report, estimate real-world occurrence (1–10) and impact (1–10), and cite a concrete failure path or evidence. If the product is below 5, file or deduplicate an issue and leave the code alone rather than entering speculative fix/re-review loops. Do not use the score to defer credible security, authorization, privacy, credential exposure, tenant-isolation, data-loss or irreversible external-side-effect risks; address those based on severity even when rare.
- **Scope discipline:** Do not design for rare or future cases nobody asked about. Prefer the smallest verified fix to a demonstrated defect or explicit requirement; introduce defensive complexity only when justified by a realistic, material failure mode.

## Cursor Cloud runtime

These notes apply to Cursor Cloud images provisioned with Mikka's `start`
script. Check the actual running services before using them; other cloud
environments do not inherit that image's setup.

- The provisioned image uses Node.js 24.22.1, pnpm 10.34.3 and PostgreSQL 17.
  Its local application database is `mikka_e2e` on `127.0.0.1`, matching the
  isolated CI schema. Keep application database URLs on that isolated target.
- `start` runs `pnpm test:e2e:setup`, then keeps Mikka at
  `http://127.0.0.1:3000/mikka` and the separate product site, when checked out,
  at `http://127.0.0.1:3001/mikka`. It reuses responding servers.
- Use the automatic test identities described above for ordinary acceptance.
  The image's local auth secret stays outside the repository at
  `/var/lib/mikka-dev/better-auth-secret`; never print or commit it.
- Run the project's `pnpm check` source checks and the relevant package checks
  in the cloud environment. Playwright uses `zh-CN`; a browser's default
  locale may instead open `/mikka/en`.
- The separate `mikka-web` development server can rewrite its untracked
  `AGENTS.md` and `CLAUDE.md`; leave generated copies uncommitted.
