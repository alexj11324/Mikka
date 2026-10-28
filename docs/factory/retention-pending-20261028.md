# Test retention checkpoint

Current task authorization does not permit automatic deletion, cleanup or
rebuilding/restoring existing resources. Historical main migration replay did
execute files containing DROP in task-owned isolated fixtures. Object pre-state
and deleted-row counts were not recorded; successful tests do not establish
deletion authorization or absence of impact. Those runs are not accepted as
authorized validation. Existing local databases, schemas, directories and the
task-owned PostgreSQL container remain retained.

Only this task's full CI run `40773647098` was cancelled. GitHub reports the
browser job ended `2026-10-28T21:41:13Z` at the build step. Other owners' runs
were not stopped. GitHub service teardown and earlier per-statement effects
are not fully audited; a workflow environment variable cannot control the
platform lifecycle and does not authorize a rerun.

This source checkpoint removes automatic DROP SCHEMA and directory removal
from the touched test teardowns, browser Factory fixture deletion, the email
test container's `--rm`/`docker rm`, and daemon shared-directory cleanup.
Fault-injection triggers are retained and disabled instead of dropped.
Known functional deletion or indirect cleanup tests are blocked as pending,
including account deletion, group migration reordering, outbox file retirement,
daemon crash/sweep and worktree removal. Retention is not a passing replacement
for those behavior assertions.

Direct historical SQL bootstrap paths now preflight the complete manifest
before database setup. The migration runner also applies test-only retention
preflight when `MIKKA_TEST_RETAIN_RESOURCES=1`; the three test workflows set it.
The seven reviewed byte-pinned SQL files may declare rejection triggers, but
unknown DROP/DELETE/TRUNCATE text keeps setup pending. This conservative check
does not prove arbitrary SQL safe and does not confer deletion authorization.

Related PG, browser, daemon lifecycle and historical replay tests must not run
until independent static review establishes no unapproved destructive action
and the exact platform resource scope is resolved. Pure source checks remain
available. This checkpoint uses `[skip ci]` solely to prevent a push from
restarting the suspended workflows; no skipped/cancelled/pending check is
reported as passed, and no merge or deployment is allowed on that basis.
