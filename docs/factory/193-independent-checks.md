# Independent review and verification (#193)

Current shared baseline: `87696d6344f65a6369117e8145759462f0e59ef7`, including the coordinated migration manifest at `7e93b86277fbfeb1a5f19d41bcc0c03596484491`. Factory contract v1 is unchanged. The sole #191 migration is `20261025051201_run_dispatch_keys.sql` and #192 is `20261025051202_factory_192_stages.sql`. #193 adds no migration or stage source. Downstream consumers use the coordinated #194 compatibility commit and the manifest's existing #195 filename; duplicate migration histories must not be introduced.

`factoryCheckGates` supplies only review and verify validators to `createFactoryStore(pool, authorize, gates)`. Existing authenticated `route/read/apply`, #191 dispatch transaction and Coordinator preparation/completion events remain the execution path. Pending review and verify dispatch through the same Coordinator tool, on separate run/session identities. No new scheduler is added; #176 still owns reliable wake. Approval, publish and monitor validators remain closed and their implementations are unchanged.

A check dispatch freezes the candidate SHA, original repository/device environment and verify command in the existing attempt output, and sets the existing run kind to `acceptance` (the existing protocol check kind). Dispatch requires the selected, owned device to be enabled, recently online and reporting the selected Harness installed. Missing Harness, repository or verify command is durably blocked; the failed dispatch transaction leaves no queued orphan. Claim locks the task and rechecks current issue access in the same transaction that claims the run. It returns the frozen SHA and command with the existing read-only policy, never a resumed executor session. A stale or unbound check is refused. Device-loss retry continuity is unchanged; an unbound retry cannot claim a check and the original task remains blocked for recovery.

The existing daemon drives the independent Harness and its existing verify command/sandbox. Checks skip writable setup recipes and never reach the existing publisher. Trusted Git reads, pinned to the actual worktree Git directory, verify exact HEAD and an unchanged worktree before the Harness and around successful verification. The shared run report has additive optional `check: {sha, readOnly:true}` and `verify.exitCode/signal/timedOut` fields, filled by the daemon, stripped from model input by the existing `pickAgentReport`. Older daemon reports cannot pass these validators. Terminal HTTP patches cannot overwrite the recorded session or status.

Verification also requires persisted adapter input/output chunks proving the separate verifier executed the frozen command. Model claims or the daemon command alone cannot satisfy this gate. A pass requires persisted valid ordered run start/finish timestamps (compatible with #194 inventory), the exact candidate/run/session/command receipt, actual zero exit, no timeout/signal/files changed, explicit passing criteria with evidence, and the existing stored artifact checks. Distinct run/session checks include the implementer and all earlier attempts, subject to the exact question ancestry rule below. Failed commands and findings retain the original report reference and command/exit/output in attempt history; the fresh execute brief includes that evidence. Repairs clear candidate eligibility, require a changed SHA, and run fresh review and verify. Automatic repairs use the existing default `maxFixAttempts` (3); exhaustion stays failed with an explicit human takeover reason. Missing or invalid provenance, auth/environment failures and timeouts remain blocked rather than triggering success or an unlimited repair loop.

## Same-stage execution questions

The existing #192 `questionContinuation` path creates a new run and attempt while strictly resuming the questioned review/verify session. Both passing and failed check provenance validate every ancestor against its resolved durable question, accepted answer, waiting/revision fence, continuation result, original run and attempt. Owner, issue, task, candidate, phase, session, agent, device and repository must stay bound through the entire chain. Historical questioned attempts remain waiting; only the current continuation supplies completion evidence. A genuine failed continuation retains its findings and opens the existing bounded repair path.

Only these exact consecutive same-stage ancestors may share a session. Execute, review and verify remain independent. Unrelated retries, `retryOf` descendants, missing or changed continuation metadata, cross-candidate/phase/session edges, cancelled questions/runs, revoked attempts and current authorization loss fail closed. This adds no state, migration, gate interface or downstream approval/publication behavior.

`check-independence.test.ts` exercises this path against real PostgreSQL using explicit synthetic provider reports, including multiple questions and both successful and failed completions. Run it with the same local database override shown below and `node --import tsx --test lib/factory/check-independence.test.ts`. It retains its isolated schema for evidence review and performs no automatic resource deletion. These fixtures do not establish real provider acceptance.

## Reproducible layered checks

On a disposable remote Linux environment, the local PG test override accepts only `127.0.0.1:55493/factory193`. Tests create and drop their own schemas. It never accepts a cloud database URL. CI keeps its existing disposable `mikka_e2e` service.

```sh
FACTORY_TEST_DATABASE_URL=postgresql://factory193@127.0.0.1:55493/factory193 pnpm test:factory
pnpm --filter @mikka/protocol exec vitest run src/run.test.ts
pnpm --filter @mikka/daemon exec vitest run test/factory-check.test.ts test/runs.test.ts test/hardening.test.ts src/permissions.test.ts
```

`checks.test.ts` exercises real PG17 migrations/transactions, ten concurrent dispatches, frozen commands, session/SHA/owner rejection, restart reconciliation, real persistence of fixture failure evidence, changed candidates, bounded repairs, missing Harness/command and closed approval. All its Harness reports are explicitly fixtures.

`factory-check.test.ts` uses the real daemon, Git worktrees and actual child commands with an explicitly mock Harness. An intentional command failure exits 17 and prints `REAL_ASSERTION_FAILURE`; a real Git commit repairs it and fresh sessions get zero exit. This proves the daemon/command layer, not sandboxed CC/Codex acceptance. `factory-check-api.spec.ts` adds real HTTP/PG coverage in existing CI, using synthetic daemon reports; it checks claim policy/SHA, command freezing, duplicate claim, receipt persistence and out-of-order terminal patches.

## Acceptance boundary

Execution records are maintained privately. Layered source, fixture, database and HTTP tests do not replace real Mikka/Harness acceptance, the required deployment and same-version checks, or independent review. A missing runtime or authorization must remain visibly blocked; no gate may be bypassed or passed from model claims alone.
