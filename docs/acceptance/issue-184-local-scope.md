# Issue 184: scope retirement and publication generations (draft)

The policy choice in [#184](https://github.com/alexj11324/Mikka/issues/184) remains open: its text says “Archiving the Linear issue is the proposed default.” It retains an explicit **Open point** for unlink-only, and has no comments confirming either policy. [#91](https://github.com/alexj11324/Mikka/pull/91) and [#160](https://github.com/alexj11324/Mikka/pull/160) provided identifiers and the forward transition; neither completed the reverse transition. No equivalent active scope candidate was found beyond this PR.

Branch `codex/184-personal-revert-20261026` is based on main `470c5cd4873634ff2b992598349ab52cffe1ee62`; R/Claude's main changes, CLA deletion, UI layout and auth/migration-runner logic are preserved. The public action still uses `allowLinkedPersonal: false`. Its linked, queued/processing/failed, or retained-publication Linear transition remains closed until the provider disposition is selected and reviewed. The internal transition is exercised only on synthetic fixtures.

## Completed backend behavior

The owner/revision transaction records `scopeSetBy=user`, restores the existing personal identifier and writes one activity version. A monotonically increasing `scopeVersion` changes on every actual scope transition. Personal retirement atomically saves remote identity tombstones, retires publications, removes active sync mappings, finishes old outbox jobs, cancels nonowner runs, clears leases and revokes tokens. Current task visibility also applies to a member's own runs.

A publication reserves its stable remote UUID in a committed transaction **before** HTTP. A later workspace generation gets another UUID. Existing workspace generation 1 keeps its legacy app UUID for retry compatibility. The database makes publication identities immutable and forbids reactivation of retired identities.

```text
workspace v1 / remote A -> personal v2 / A retired -> workspace v3 / remote B
                       -> personal v4 / B retired -> workspace v5 / remote C
```

Writers serialize per publication through a dedicated, short-lived PG advisory-lock connection. No task row or publication transaction is held across issue/comment HTTP, so retirement can commit and a new publication can finish while an old response is still delayed. Credential-refresh behavior is unchanged. The writer takes a fresh snapshot in its captured generation after acquiring its publication lock. Each issue/label/comment mutation rechecks generation/claim ownership; local acknowledgements and mappings recheck under the task row lock. Comments retain their captured publication link rather than looking up a possibly newer link by local task ID. An unacknowledged write is recorded so a reclaimed claim does not interpret the application's own delayed write as a new remote edit.

Outbox jobs capture `scopeVersion` and receive a new claim token on each claim. Success/failure updates require that exact processing claim; retired jobs cannot requeue themselves or overwrite a new link/job/diagnostic. Old webhooks stop before provider access when already retired, and revalidate generation before changing diagnostics when retirement happened during HTTP. Imports resolve a reserved remote UUID back to its original local task rather than creating a second task.

An in-flight operation that passed its last check may still reach or finish at **retired remote A**, using its captured workspace content. Its result cannot attach to personal state or remote B/C, and it never reads newly personal content. No archive, delete or unlink provider policy is inferred from this fact. Guard-only tombstones for a legacy app UUID are not evidence that a real remote issue exists to archive.

## Run completion revocation fix

The reported `/complete` race was reproduced on a task with **no Linear link or queued sync**: a request paused after reading a live run subsequently changed a personal task to review. The retained pre-fix PG record is `status=review, scope=personal`.

`lib/run-completion.ts` now locks task then run, rereads permissions/live state, and commits run terminal state, token revocation, completion event and permitted review mutation together. A separate short task lock rechecks scope/generation before scheduling postcommit dispatch. Retirement winning first causes zero run/task/event writes and zero dispatch; completion winning first commits before retirement, and its deferred dispatch is rejected after retirement or a personal-to-workspace round trip. Deadlock/serialization retries apply only to rolled-back local transactions, at most twice. An independent read-only investigation/review was reconciled, including a real heartbeat deadlock reproduction and retry fix.

Legitimate owner-personal and null-task completions, member completion while workspace, plan behavior, `not_run`, failed verify, and terminal replay remain covered. Coordinator and worker-auth helper logic was not changed.

## Real PG / loopback HTTP evidence

On Mikka cloud Linux, Docker Postgres 17 `mikka-issue184-pg` listens only on loopback port 55484. The provisioning DB is `issue184_e2e`; every suite creates and retains a fresh `scope184_<uuid>_e2e` database initialized from **all tracked migrations**, including actual production constraints, foreign keys and triggers. It does not depend on the shared CI column-only setup or modify another suite's records.

Point `E2E_DATABASE_URL`, `MIKKA_DATABASE_URL`, and `DATABASE_URL` at the isolated provisioning DB and set `ISSUE184_LOCAL_TEST=1`, `NODE_ENV=development`, and a loopback `BETTER_AUTH_URL`:

```sh
node --test-force-exit --import ./scripts/server-test.mjs --import tsx \
  --test tests/issue-scope-detachment.db.test.ts
```

**Prior 1682ed0 baseline: 41 tests passed before the retention directive; those tests deleted synthetic link rows and do not certify the current local patch.** They cover owner/stale/pending gates; concurrent clicks; identifier/history; immediate task/run/token/lease revocation; native claim HTTP 200 before and 409 after retirement; stale imports/comments/inbox/outbox; rollback; queue/scope and heartbeat/completion deadlocks; native HTTP completion paused after live-read; atomic completion/retirement ordering; postcommit generation dispatch; compatibility controls; delayed update/create/failure; old comment isolation; repeated re-publication; old-job replay; webhook diagnostic races; lost-response retry with one stable identity; and claim reclamation with a fresh snapshot. The final migration also passes reapplication without losing retained identities.

The real production GraphQL/client/token code made **70 synthetic GraphQL calls redirected to a loopback HTTP provider fixture**, with controlled delayed/lost responses. All other non-loopback fetches are prohibited; real provider requests remain **zero**. This is a mock provider boundary over real HTTP, not real Linear acceptance or a deployed Preview.

Additional checks: typecheck; denied-warning oxlint; UI/interaction lint; migration/i18n checks; 83 issue tests; 17 Linear tests; protocol completion tests 4/4; and migration/inventory/i18n regressions. The CI inventory change only pins the existing new DB suite; migration-runner logic is unchanged. Raw logs, fixture IDs, CI summaries and synthetic-only PG dumps are retained under `/workspace/scratch/issue184-evidence/`.

## Public retry generation regression

The independent review reproduced a P2 regression at `38ee473`: after the ordinary public personal-to-workspace action creates generation 2 and its initial job is done, `retryLinearIssue` inserted a new job with the database default generation 1. The worker made no provider request, marked it done and left the link pending. The retained pre-fix run asserts `1 !== 2`; the normal forward action itself succeeds as a control.

The public retry now takes the task row lock, rechecks owner/current workspace/deletion state, and captures the current generation in that transaction. It restarts failed jobs only in that generation, clears their claim, and inserts explicit generation for new work. Stale open jobs are finished without retagging their identity; old failed jobs remain retained. The task lock serializes retries without taking the old issue-ID advisory lock in the reverse order from imports. A retry that waited for retirement returns an error without enqueue or dispatch. A retry that waited for a personal/workspace round trip captures generation 3 and publishes a fresh remote UUID.

Both public actions execute with the actual Next `AfterContext` lifecycle in the real PG suite; their scheduled worker callbacks run after the action. The regression asserts queued generation before response close, provider HTTP after close, and final synced link/done job. It also covers restarting a current-generation failed job and preserving old-generation failed/processing identities.

The conservative public personal gate now checks **any retained publication** and **failed outbox jobs**, as well as links and queued/processing work. A real loopback sequence makes seven transport failures, then succeeds remotely on attempt eight while losing both response and fallback lookup. With no link and an exhausted failed job, the action stays blocked with unchanged scope/revision and zero additional provider calls. A reservation still blocks after its job becomes terminal; a failed job without a reservation also blocks. Absence of a link or a terminal job is not proof that an external issue does not exist. These are policy guards, not authorization to archive.

The before/after logs (`issue184-retry-before.log`, `issue184-retry-after.log`), public-action fixture IDs, provider JSONB evidence and synthetic-only dumps remain under `/workspace/scratch/issue184-evidence/`. Typecheck, denied-warning lint and 17 Linear unit tests pass for this increment; exact-head CI results are recorded in `manifest.json` after completion. Real Linear requests remain zero.

## Explicit scope and personal confirmation increment

New app and MCP tasks remain personal even with team-like text and an enabled Linear team. The old scope-classification callback is now inert, and a database trigger rejects a delayed legacy classifier that tries to promote an agent-owned personal scope. The existing explicit user scope control remains available; this guard does not validate an arbitrary SQL writer that falsely marks its own write as user-originated.

The owner-only `previewIssuePersonalScope` action returns the current revision, scope generation, whether a Linear link or retained publication exists, whether recorded outbound activity makes an external copy possible, and a confirmation digest. `confirmIssuePersonalScope` rechecks that digest under the task lock; changed state yields `issueStale`. Recorded links, publications or queued/processing/failed outbound work still return `issueScopeInLinear`. A negative recorded-state flag is not proof no external copy exists, especially for legacy history. The confirmation never authorizes provider archive or unlink.

The old `setIssueScope` entry point also requires confirmation for a workspace-to-personal transition; a linked or uncertain external state remains blocked first. Main #314/#315 has been merged into the candidate with both test inventories preserved and without additional changes to Coordinator business logic.

## Explicit team creation

`createIssueForTeam({ requestId, teamId, title, content, status, priority })` is an owner-session server action under the `/mikka` Next application. `requestId` and `teamId` are UUIDs; the caller must retain the same request ID and identical request body on retry. Success returns `{ issue, linearSync: { enabled: false, reason: 'no_explicit_target' } }`. On first completion the task has `scope=workspace` and `linearSyncBlocked=true`. A later replay returns the task’s current scope and does not re-promote it. This is a persistent per-task gate: enqueue, manual retry, publication reservation and Linear link insertion cannot publish it. Other tasks and the user's global Linear configuration are unchanged. A later verified external target association is separate work and is not implemented here.

The action checks active workspace/team access, creates the task personal with the block already set, commits its team association and durable workspace receipt, then rechecks the membership and exact association under workspace locks while committing the scope change in the application database. A request row and payload fingerprint prevent duplicate or altered replays. A retained receipt prevents retries from restoring a team relation that was changed or removed later. Failure before promotion leaves a personal task; a retry can complete it without duplication. If a commit response is lost, the action reconciles its request record; if reconciliation is unavailable, it returns `teamIssueOutcomeUnknown` and the client must retry the same request ID rather than assume either outcome.

Errors are `teamIssueInvalid`, `teamIssueAccessDenied`, `teamIssueRequestConflict`, `teamIssueChanged`, `teamIssueRetry`, or `teamIssueOutcomeUnknown`; database-stage errors include `requestId`. Any internal `actAs` context, including one without an explicit actor, is rejected by this user-choice action; it requires the ordinary signed-in session path. The existing UI's two-call `saveIssue`/`setIssueTeam` flow is not equivalent; frontend integration must call the new action. The legacy `setIssueScope` workspace path is now rejected with `issueScopeTeamRequired`, since it has no target. New explicit team creation uses the team action. An existing personal task cannot yet be moved to a selected team by a dedicated action. Missing authentication from the team, preview, and confirmation actions is returned as `authRequired` through the shared action boundary; unexpected errors still propagate. On a completed request replay, `issue` is current state and can already be personal; it is not promoted again.

A new pending migration `20261026224200_require_verified_team_promotion.sql` fences every personal-to-workspace update: the task must be provider-blocked, carry user scope attribution, have the matching pending team request, and have task/team transaction-local markers installed by the server while its workspace membership and relation locks are held. An old scope-only writer or a lone marker without a request is rejected. Existing Linear-origin workspace inserts and already-workspace publications are not detached. The task/team markers are an assertion by trusted application DB code, not proof against a principal with arbitrary SQL write access.

The local candidate also introduces `linear_issue_links.externalTargetVerified`. Publication and per-issue dispatch require this marker and an owner-matching link; an account-level active Linear team or an unacknowledged publication is insufficient. New authenticated Linear-origin imports mark their own links verified. The candidate migration backfills only links whose local task ID matches the remote ID and whose revision-one history proves a system Linear import. Other legacy links are retained but their outbound sync pauses until a future explicit verification flow; this may pause some previously authorized links whose provenance is unavailable. The migration and compatibility impact require review and have not been exercised against PostgreSQL under the current retention restriction. In-flight external calls from older binaries cannot be recalled; rollout must account for older workers.

The prior DB suite contains historical tests that promote an existing personal task and republish without a verified team or Linear target. Their assertions remain present and have not been changed; they conflict with the new safety rule and must be redesigned to preserve their original race coverage under an explicit authorized target before the full suite can pass. No PG suite or automatic CI has been run for this local patch under the current retention restriction. The new commit-response-loss, stale-writer, ordinary save/update/manual-retry and authorization tests are prepared but unexecuted.

The regression uses two separate retained PG17 databases and actual server-action calls, plus synthetic loopback HTTP. It covers simultaneous replay, unauthorized and agent attempts, first application transaction failure, association failure, promotion failure, changed association, and membership revocation between commits. Tests also update task/document state, attempt direct outbox/link writes and manual retry, and verify no provider request or outbox for the blocked task. No production migration or real Linear write was performed. The HTTP harness invokes the action; it is not a frozen deployed Preview.


## Remaining policy and acceptance gates

| Choice | Eventual provider behavior |
| --- | --- |
| Archive then unlink | Queue a durable, retry-safe archive operation for the retired publication, keep recoverable team history in Linear, then stop synchronization. Requires explicit authorization for real provider writes/acceptance. |
| Unlink only | Stop synchronization and leave the old Linear issue and its status unchanged. Requires no archive/delete API mutation. |

Neither choice is implemented as a live provider action here. Confirm the choice before opening the linked action gate. Claude's Linear-sync review, a frozen nonproduction Preview and authorized real provider acceptance remain separate gates. Full browser tests stay skipped while draft. R alone integrates main; this PR has not been merged or deployed and must not be treated as #184 completion.
