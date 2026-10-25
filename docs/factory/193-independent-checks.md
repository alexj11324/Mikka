# Independent review and verification (#193)

Initial frozen base: PR #197, `605bf086d4371e19f2df2e2857a487f1decd649d`. The parent-coordinated unified #191/#192 baseline `4cd3a1b5fa05773094722bab7774e15a8d49d018` was subsequently merged without conflicts; its stage/candidate runtime contract is unchanged. Factory contract v1 is unchanged. The candidate retains only `20261025011347_run_dispatch_keys.sql` for #191 and `20261025010001_factory_192_stages.sql` for #192. There is no new migration or stage source.

`factoryCheckGates` supplies only review and verify validators to `createFactoryStore(pool, authorize, gates)`. Existing authenticated `route/read/apply`, #191 dispatch transaction and Coordinator preparation/completion events remain the execution path. Pending review and verify dispatch through the same Coordinator tool, on separate run/session identities. No new scheduler is added; #176 still owns reliable wake. Approval, publish and monitor validators remain closed and their implementations are unchanged.

A check dispatch freezes the candidate SHA, original repository/device environment and verify command in the existing attempt output, and sets the existing run kind to `acceptance` (the existing protocol check kind). Dispatch requires the selected, owned device to be enabled, recently online and reporting the selected Harness installed. Missing Harness, repository or verify command is durably blocked; the failed dispatch transaction leaves no queued orphan. Claim locks the task and rechecks current issue access in the same transaction that claims the run. It returns the frozen SHA and command with the existing read-only policy, never a resumed executor session. A stale or unbound check is refused. Device-loss retry continuity is unchanged; an unbound retry cannot claim a check and the original task remains blocked for recovery.

The existing daemon drives the independent Harness and its existing verify command/sandbox. Checks skip writable setup recipes and never reach the existing publisher. Trusted Git reads, pinned to the actual worktree Git directory, verify exact HEAD and an unchanged worktree before the Harness and around successful verification. The shared run report has additive optional `check: {sha, readOnly:true}` and `verify.exitCode/signal/timedOut` fields, filled by the daemon, stripped from model input by the existing `pickAgentReport`. Older daemon reports cannot pass these validators. Terminal HTTP patches cannot overwrite the recorded session or status.

Verification also requires persisted adapter input/output chunks proving the separate verifier executed the frozen command. Model claims or the daemon command alone cannot satisfy this gate. A pass requires the exact candidate/run/session/command receipt, actual zero exit, no timeout/signal/files changed, explicit passing criteria with evidence, and the existing stored artifact checks. Distinct run/session checks include the implementer and all earlier attempts. Failed commands and findings retain the original report reference and command/exit/output in attempt history; the fresh execute brief includes that evidence. Repairs clear candidate eligibility, require a changed SHA, and run fresh review and verify. Automatic repairs use the existing default `maxFixAttempts` (3); exhaustion stays failed with an explicit human takeover reason. Missing or invalid provenance, auth/environment failures and timeouts remain blocked rather than triggering success or an unlimited repair loop.

## Reproducible layered checks

On a disposable remote Linux environment, the local PG test override accepts only `127.0.0.1:55493/factory193`. Tests create and drop their own schemas. It never accepts a cloud database URL. CI keeps its existing disposable `mikka_e2e` service.

```sh
FACTORY_TEST_DATABASE_URL=postgresql://factory193@127.0.0.1:55493/factory193 pnpm test:factory
pnpm --filter @mikka/protocol exec vitest run src/run.test.ts
pnpm --filter @mikka/daemon exec vitest run test/factory-check.test.ts test/runs.test.ts test/hardening.test.ts src/permissions.test.ts
```

`checks.test.ts` exercises real PG17 migrations/transactions, ten concurrent dispatches, frozen commands, session/SHA/owner rejection, restart reconciliation, real persistence of fixture failure evidence, changed candidates, bounded repairs, missing Harness/command and closed approval. All its Harness reports are explicitly fixtures.

`factory-check.test.ts` uses the real daemon, Git worktrees and actual child commands with an explicitly mock Harness. An intentional command failure exits 17 and prints `REAL_ASSERTION_FAILURE`; a real Git commit repairs it and fresh sessions get zero exit. This proves the daemon/command layer, not sandboxed CC/Codex acceptance. `factory-check-api.spec.ts` adds real HTTP/PG coverage in existing CI, using synthetic daemon reports; it checks claim policy/SHA, command freezing, duplicate claim, receipt persistence and out-of-order terminal patches.

## Acceptance still blocked

On 2026-10-25 the selected remote Debian environment had Node 24.19.0 and Codex CLI 0.163.0. Disposable PG17.11 and the missing `socat` dependency were unpacked only under `/tmp`; no system installation, cloud database, IAM, paid resource or credential transfer was used. After dependencies passed, the actual existing sandbox-runtime command failed with:

```text
bwrap: setting up uid map: Read-only file system
```

Action: launch the existing sandbox-runtime process in this selected execution environment. Result: blocked by container UID-map restrictions before any Harness session. No unsandboxed real Harness fallback, old CLI credential access or retry through another path was attempted. Raw probe and test evidence is saved under `/workspace/issue193-evidence` for the parent thread's private Pages evidence collection.

The parent-coordinated nonproduction Preview deployment was already denied by approval review and is pending the user's response. No Preview deployment was requested or retried here. Fixed Preview OAuth, actual Mikka chat → CC/Codex implement → independent review/verification → real failure/repair/retest, readonly-write denial and #181 same-version acceptance remain incomplete. No screenshot/recording is fabricated. Passing source, PG, mock Harness, HTTP or CI checks does not complete #193.
