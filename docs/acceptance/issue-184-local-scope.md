# Issue 184: local scope boundary (draft, disposition pending)

This is the common local half of [#184](https://github.com/alexj11324/Mikka/issues/184), not completion of the user-facing transition. The issue has no comments resolving archive versus unlink. [#91](https://github.com/alexj11324/Mikka/pull/91) and [#160](https://github.com/alexj11324/Mikka/pull/160) supplied identifiers and the forward transition; neither implemented the reverse transition. No active equivalent candidate was found in the repository's PR/branch inventory on 2026-10-26.

Branch: `codex/184-personal-revert-20261026`, initially based on main `5663504`, rebased onto main `470c5cd4873634ff2b992598349ab52cffe1ee62` before publication. The action still refuses linked or queued Linear transitions with `issueScopeInLinear`; its message now requests a Linear disposition decision. Tests explicitly check this public-action gate. `allowLinkedPersonal: true` is used only by the internal local-safety tests.

## Implemented local behavior

The owner/revision transaction records `scopeSetBy=user`, restores the existing personal identifier, and writes one activity version. A scope trigger saves the detached remote identity, removes active sync mappings, and finishes queued/processing/failed outbox jobs. Nonowner runs are cancelled, their leases cleared, and their tokens revoked in the same commit. Run/child writes serialize against the task scope; deadlock/serialization failures retry only the rolled-back local transaction, at most twice.

Run owners also need current task visibility when reading a linked run. Old issue/comment webhooks stop before provider access. Import and comment writers recheck scope under the task lock. Detached remote UUIDs cannot be linked again, including when their original local UUID was different.

No real Linear API was called. No real account, user, session, application data, or existing fixture was removed. Test records are retained.

## Evidence from cloud Linux

Dedicated Docker Postgres 17: `mikka-issue184-pg`, loopback port 55484, database `issue184_e2e`. It was initialized from the tracked schema and migrations. The new migration also passed reapplication with the synthetic records retained.

Run the database suite with all three DB URL variables pointing to this isolated target, `ISSUE184_LOCAL_TEST=1`, `NODE_ENV=development`, and a loopback `BETTER_AUTH_URL`:

```sh
node --test-force-exit --import ./scripts/server-test.mjs --import tsx \
  --test tests/issue-scope-detachment.db.test.ts
```

12 tests passed, zero failures/skips: owner/stale/pending gates; concurrent clicks; personal identifier and history; immediate task/run/token/lease revocation; native claim route HTTP 200 before and 409 after conversion (401 unauthenticated); stale imports/snapshots/comments; inbox/outbox retries; distinct remote UUID; full rollback; queue versus conversion; and real run-row/scope deadlock recovery. Every non-loopback fetch is prohibited by the test, and the rejected external request counter remained zero.

Additional checks passed: typecheck; oxlint with denied warnings; UI and interaction lint; migration validation; i18n validation; 83 issue tests; 17 Linear tests; and 30 migration/inventory/i18n regression tests. CI enrolls the new database suite through the existing inventory, with a one-line expected-suite pin update; migration-runner logic is unchanged.

Raw logs, fixture IDs and a synthetic-only PG dump are retained at `/workspace/scratch/issue184-evidence/`. This is a real PostgreSQL/native-route HTTP harness, not a deployed Preview or real Linear acceptance.

## Remaining gates before #184 can be completed

1. Confirm archive versus unlink. Archive preserves recoverable Linear history and needs a durable remote archive operation; unlink leaves the Linear issue unchanged. Neither provider action is authorized for live acceptance in this task.
2. Compose the selected disposition with a fenced external writer/outbox, including a writer already in flight, retry after a lost provider response, and a new stable publication identity on a later personal-to-workspace transition. The local tombstone alone does not serialize external network IO.
3. Open the existing action gate only after those pieces and their PG/HTTP/provider-boundary tests are ready. Do not treat the current internal local transition as the finished product flow.
4. Obtain Claude's Linear-sync review, passing exact-SHA CI, and a frozen nonproduction Preview acceptance URL. Real provider acceptance requires separate authorization and must not be inferred from this harness. R alone merges main; this draft must not be merged or deployed as #184 completion.
