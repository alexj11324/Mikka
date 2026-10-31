# Old authorization, budget and policy closeout

Baseline: main `375d670937ca06c53e47f336870481d38520c1fe` (PR #524 merged).
Issues #207, #215 and #230 were read on 2026-10-31; all had zero comments.
This record distinguishes implemented paths from the remaining issue criteria.

## Verified defects and fixes

| Issue | Concrete path | Occurrence × impact | Change |
| --- | --- | --- | --- |
| #215 | A hosted call whose estimated maximum exceeded the positive remaining balance obtained only a partial reservation and could reach the provider. Real PG: one of ten requests with 1 microdollar available and a 100,000 microdollar maximum was admitted. | 5 × 6 = 30 | Require the full estimated maximum before recording a reservation. Actual receipts, unknown charges and debt accounting remain intact; they grant no admission authority. |
| #207 / #230 | A legal Coordinator run has no Bot. `lockCliRunPolicy` previously ignored its workspace task, so workspace denials and membership revocation did not affect CLI policy/liveness. | 5 × 8 = 40; authorization boundary | Derive task scope from stored issue and trusted team relation; intersect task and Bot workspace ceilings and retain both active membership leases. Local admission uses the same task scope. The global Coordinator head stays personal. |

Task policy uses the existing fields, strict layer schema, policy generation,
revision, approval consumption, STOP and device lease contracts. It does not
accept a workspace from a model or request body. A rollback of policy content
still advances the existing version, so an old approved request cannot revive.

## Evidence

Cloud Linux, loopback PostgreSQL 17 at port 55599, dedicated database
`mikka_policy_closeout_e2e`; all three database URLs point there. Bootstrap
applied all 154 baseline migrations. Prior databases, containers and ledgers
were preserved. Raw logs remain local and must not be uploaded wholesale.

| Check | Result | Local evidence |
| --- | --- | --- |
| Hosted budget DB suite, including ten-way concurrency, full reservation, unaffected other workspace, combined balance and duplicate settlement | 9 pass, 0 fail/skip | `/tmp/mikka-policy-budget-final.log` |
| Same new task policy matrix against baseline policy-store | 0 pass, 6 fail; first failure is null workspace instead of task workspace | `/tmp/mikka-task-policy-before.log` |
| Task policy and current worker-token authorization together | 16 pass, 0 fail/skip | `/tmp/mikka-task-policy-final.log` |
| AgentKit compatibility, CLI policy layers/snapshot, frozen assignment and GitHub run-token source tests | 48 pass, 0 fail/skip | `/tmp/mikka-policy-source.log` |

The task matrix uses two real workspaces, SQL fixture identities and real
device credentials. It exercises the exported tool-approval HTTP route over a
loopback server: current revision is live, an old policy revision is not live,
and removed task membership returns 409. It also checks cross-workspace Bot
intersection, both memberships, personal task isolation, lower-layer attempts
to loosen a workspace denial, and stale approvals after policy rollback.
The worker suite separately exercises the exported MCP HTTP handler, STOP,
expired lease and task/Bot membership revocation. These are backend route/DB
checks, not a normal human signup or a complete Next/daemon/provider run.

## Remaining completion criteria

| Issue | Existing / newly verified coverage | Still required before closing |
| --- | --- | --- |
| #207 | Current task/Bot access, worker tokens, leased execution and actual MCP/tool-liveness route denials; task workspace CLI scope now included. Reuses existing issue visibility and membership guards. | A complete fixed-version application matrix for search pagination/count/cache, artifact/download links and background retries, with recorded revocation boundaries. The scoped tests do not establish every entry or every signed download. |
| #215 | Hosted model maximum-cost reservation, one pending/unknown call per workspace, idempotent settlement, platform free budget; existing BYOS quota and E2B compute caps remain separate. | Cross-entry model/tool/native/cloud quota inventory and execution evidence; provider 429/Retry-After behavior; crash/unknown-cost receipt reconciliation and authorized overrides; real provider receipt accounting. Unknown charges deliberately remain blocked until reconciled, rather than expiring into a free retry. |
| #230 | Existing Agent/worker/workspace CLI composition and live revision checks; task workspace ceilings and revocation now propagate; old approvals cannot cross a policy change or rollback. | Full authenticated application/claim/daemon/child propagation evidence; the issue's signed/versioned offline-cache contract, project/default hierarchy and publication/audit acceptance have not all been implemented or validated by this patch. |

No external provider write, paid resource purchase, new IAM, production deploy,
issue closure or merge is performed by this worktree. Full restricted approval
and scope suites remain assigned to genuine GitHub Actions; their target guards
are unchanged. The parent integrator registers the new task policy DB test and
owns overall type/build/CI and independent review.
