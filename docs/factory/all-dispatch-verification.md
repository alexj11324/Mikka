# Factory #1104 verification and integration status

Runtime code: `beef7c9607ed83481a36c373fbe5352a28b14c88`.
Handoff branch: `factory/all-dispatch-through-factory`. No PR or main push.

## Deterministic checks

Cloud Linux, Node 24.19.0, loopback PostgreSQL 17, isolated databases ending in
`_e2e`, existing managed test-account leases and workload identity.

| Required database suite | Passed |
| --- | ---: |
| test:bot-threads-db | 143 |
| test:factory-routing-db | 96 + 5 |
| test:factory-checks-db | 56 |
| test:factory-approval-db | 43 |
| test:factory-check-independence-db | 55 |
| test:factory-monitor-db | 2 + 10 |
| test:coordinator-issue-tools-db | 2 |
| Total | 512 |

Application and daemon typechecks, root lint, explicit changed-package lint and
Next production build passed. Daemon permissions, runs, independent checks and
command-evidence regressions passed 72 tests. Native MCP verification/candidate
inspection plus the authenticated local GitHub fixture passed four tests.
The exact retained daemon build was packed, installed into a fresh directory and
ran its CLI and a real local Git task successfully. The event-masking PG17
regression passed 11 tests; it covers NUL and malformed Unicode persistence.

UI review uses static examples of the actual ApprovalBar with production CSS,
including light/dark and narrow widths. It is not browser functional testing.

## Real API/CLI acceptance: not passed

The final fixed-code invocation is `pnpm test:local-loop` with item 1 selected,
normal automatic account acquisition, local application/database/daemon, pinned
Claude Code 2.1.309 and the real DeepSeek model. GitHub API responses are synthetic;
Git operations and child verification commands are real. No production DB was
accessed, and this does not establish real E2B behavior.

Evidence directory: `.cache/dev-local/acceptance-be9f5a99477149a0` (private, ignored).
Database: `mikka_loop_be9f5a994771_e2e`.
Execute run: `fcf6df7a-e800-4793-8194-5ea1497bbd3f`.
The real worktree produced commit `005d310` and was clean. The CLI then encountered
repeated HTTP 503 responses, including retries 1 through 9. The run has not
established execute/review/verify success or human-approval readiness. Do not
interpret a local commit, healthy lease or synthetic reports as that result.
The driver ended at 2026-11-03 09:06 UTC after its unchanged 900,000 ms item
budget expired; the three-stage human-approval proof was not produced.
The earlier concurrent invocation failed during cold route compilation; it is
also retained as a failure, not an acceptance pass.

## Concurrent upstream delivery

At 2026-11-03 08:46 UTC, GitHub reported #1104 closed by the already merged batch
PR #1105; main was `a9f5444cb6e413dba84cf6aed82dd014d19ac059`. The original
handoff ref was still `0c9a988e`. These are parallel implementations with common
ancestor `95f0f08e`; the merge preview has 38 conflicts. This branch must not be
merged wholesale over that batch.

Preserve main's real deliverable snapshot and cloud task-filesystem handoff, as
well as its repository-move authorization, full cloud model catalogue and CLI
stderr-classification fixes. The coordinator can compare this branch's
host-bound candidate/PR/CI inspection, declared-entrypoint command restriction and
paired execution-receipt checks against main's protocol and port relevant pieces.
At 09:06 UTC main had also advanced to `200e2e2f` (PR #1111), preserving successful
Factory deliverables during server completion; retain that fix as well.
This record proves only the checks listed for this branch, not upstream rollout.
Any adopted runtime capability needs the matching daemon released before the
application starts relying on it. Human acceptance remains a real user's action.
