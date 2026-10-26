# Issue 184: scope retirement and publication generations (draft)

The policy choice in [#184](https://github.com/alexj11324/Mikka/issues/184) remains open: its text says “Archiving the Linear issue is the proposed default.” It retains an explicit **Open point** for unlink-only, and has no comments confirming either policy. [#91](https://github.com/alexj11324/Mikka/pull/91) and [#160](https://github.com/alexj11324/Mikka/pull/160) provided identifiers and the forward transition; neither completed the reverse transition. No equivalent active scope candidate was found beyond this PR.

Branch `codex/184-personal-revert-20261026` is based on main `470c5cd4873634ff2b992598349ab52cffe1ee62`; R/Claude's main changes, CLA deletion, UI layout and auth/migration-runner logic are preserved. The public action still uses `allowLinkedPersonal: false`. Its linked/queued Linear transition remains closed until the provider disposition is selected and reviewed. The internal transition is exercised only on synthetic fixtures.

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

**23 tests pass, zero failures/skips.** They cover owner/stale/pending gates; concurrent clicks; identifier/history; immediate task/run/token/lease revocation; native claim HTTP 200 before and 409 after retirement; stale imports/comments/inbox/outbox; rollback; queue/scope and heartbeat/completion deadlocks; native HTTP completion paused after live-read; atomic completion/retirement ordering; postcommit generation dispatch; compatibility controls; delayed update/create/failure; old comment isolation; repeated re-publication; old-job replay; webhook diagnostic races; lost-response retry with one stable identity; and claim reclamation with a fresh snapshot. The final migration also passes reapplication without losing retained identities.

The real production GraphQL/client/token code made **34 synthetic GraphQL calls redirected to a loopback HTTP provider fixture**, with controlled delayed/lost responses. All other non-loopback fetches are prohibited; real provider requests remain **zero**. This is a mock provider boundary over real HTTP, not real Linear acceptance or a deployed Preview.

Additional checks: typecheck; denied-warning oxlint; UI/interaction lint; migration/i18n checks; 83 issue tests; 17 Linear tests; protocol completion tests 4/4; and migration/inventory/i18n regressions. The CI inventory change only pins the existing new DB suite; migration-runner logic is unchanged. Raw logs, fixture IDs, CI summaries and synthetic-only PG dumps are retained under `/workspace/scratch/issue184-evidence/`.

## Remaining policy and acceptance gates

| Choice | Eventual provider behavior |
| --- | --- |
| Archive then unlink | Queue a durable, retry-safe archive operation for the retired publication, keep recoverable team history in Linear, then stop synchronization. Requires explicit authorization for real provider writes/acceptance. |
| Unlink only | Stop synchronization and leave the old Linear issue and its status unchanged. Requires no archive/delete API mutation. |

Neither choice is implemented as a live provider action here. Confirm the choice before opening the linked action gate. Claude's Linear-sync review, a frozen nonproduction Preview and authorized real provider acceptance remain separate gates. Full browser tests stay skipped while draft. R alone integrates main; this PR has not been merged or deployed and must not be treated as #184 completion.
