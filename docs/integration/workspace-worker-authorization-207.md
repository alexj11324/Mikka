# Current worker authority (#207)

Baseline: `be539ca31449e52b8b361da6d99e74ed63f72836`.
Scope: the existing run-token MCP entry, not a replacement organization or IAM
model. No migrations or product components change.

## Reproduced gap

The existing issue, search and run-read helpers resolve current team membership.
However, the run-token verifier only checked token expiry/revocation, owner and
live run status. A member could legitimately start a shared task, be suspended
or removed, and keep using the previously issued token for worker tools.
Likewise, STOP and an expired device lease did not deny the token until another
path changed the run status or revoked its tokens.

Real PostgreSQL tests reproduced those cases. A Bot worker without a task also
retained its token after the member lost that Bot's workspace membership.
Occurrence 4/10 × impact 6/10 = 24: this is a normal member-removal/stop path,
not a hypothetical identifier collision or future tenancy model.

## Resulting checks

- Every token call checks STOP and the live token/run rows.
- Device-bound runs in the existing leased execution statuses require a fresh
  lease. Non-device runs and queued protocol states retain their existing rules.
- Task-bound tokens use `issueForUser`, including current workspace visibility
  and soft deletion. Existing owner access to their own tasks remains intact.
- Bot-bound tokens use the existing `agentScope`, which checks Bot ownership
  and active membership in its workspace.
- After permission reads, token/run authority is checked again so a concurrent
  STOP, token revocation or lease expiry does not return stale execution rights.

The verified worker tools are reports, questions, blocked notices and artifact
submission; optional personal mailbox tools already have their own execution
fences. Request JSON does not choose the run, Bot, owner or workspace.

## Verification

Cloud Linux, isolated PostgreSQL 17 at loopback port 55599, database
`mikka_old207_e2e`; all 145 tracked migrations and Better Auth schema applied.
Both application and workspace database URLs point to that isolated database.
All issued fixture run tokens were revoked after testing; no real provider or
personal credential was retrieved.

| Check | Result | Private local log |
| --- | --- | --- |
| Current task/workspace/execution authority | 10 passed, zero skips | `/tmp/mikka-old207-http.log` |
| Existing run-token authority/provider-contract compatibility | 11 passed, zero skips | `/tmp/mikka-old207-token-compat.log` |
| Existing actor/team/locked-scope source regressions | 13 passed | `/tmp/mikka-old207-existing-scope.log` |
| Root TypeScript | Passed | `/tmp/mikka-old207-types-final.log` |

The first row includes actual HTTP requests through the exported
`app/api/mcp/route.ts` handler with its real MCP middleware and real database:
an active member's tools-list request succeeds; after suspension, the same
token's report request returns 401 and the Coordinator event count stays
unchanged. It also covers task-token removal, Bot membership suspension, STOP,
expired device leases, terminal/revoked tokens and allowed personal runs.

That test uses a loopback Node HTTP adapter around the actual exported handler,
persisted SQL identity fixtures and the real run-token issuer. It is not a full
Next server, a shared-pool human sign-in, OAuth or a real model/provider run.
The compatibility runner explicitly substitutes the external GitHub issuer.

## Remaining #207 acceptance

This patch does not establish all of #207's tenant/role/resource matrix. The
integrated application still needs its current-session workspace checks,
background jobs, paging/cache/download paths and relevant revoked in-flight
actions verified on the final release. This entry denies subsequent worker
calls; it does not cancel every already-running native process or withdraw
already-issued external-provider credentials. Provider side-effect fencing is
tracked with #208/#209. No production deployment or issue closure is included.
