# Old authorization, budget and policy closeout

Baseline: main `375d670937ca06c53e47f336870481d38520c1fe` (PR #524 merged).
Issues #207, #215 and #230 were read on 2026-10-31; all had zero comments.
This record distinguishes implemented paths from the remaining issue criteria.

## Superseding budget decision

On 2026-10-31 the user explicitly rejected prepayment/reservation:
“调用前不需要预留”. Their current decision is authoritative over #215's old
reservation requirement: a positive current balance allows a call; its actual
receipt is charged afterwards. Exhaustion refuses later calls until recorded
credit restores a positive net balance. No estimate freezes or debits money.
The earlier maximum-cost proposals `99746a0e` and `456ccc5b` are superseded and
excluded from this branch, which starts from baseline plus the independent
task-policy and strict-policy fixes. Their former tests are historical evidence,
not the acceptance criteria for the current product decision.

## Verified defects and fixes

| Issue | Concrete path | Occurrence × impact | Change |
| --- | --- | --- | --- |
| #215 | Baseline `reserve` debited the free allowance before provider I/O and subtracted pending purchased reservations from spendable points. This contradicts the user's new postpayment decision. | Explicit product requirement | Record only the existing concurrency slot before I/O; reserved-money fields are zero. Charge the actual receipt once afterwards, retaining existing debt and legacy prepaid-row accounting. |
| #207 / #230 | A legal Coordinator run has no Bot. `lockCliRunPolicy` previously ignored its workspace task, so workspace denials and membership revocation did not affect CLI policy/liveness. | 5 × 8 = 40; authorization boundary | Derive task scope from stored issue and trusted team relation; intersect task and Bot workspace ceilings and retain both active membership leases. Local admission uses the same task scope. The global Coordinator head stays personal. |
| #230 | The policy parser silently dropped unknown policy/action fields, which could discard an unsupported restriction. | 3 × 7 = 21; policy enforcement | Strict policy and permissions objects reject unsupported input, preserving existing optional legacy fields. |

Task policy uses the existing fields, strict layer schema, policy generation,
revision, approval consumption, STOP and device lease contracts. It does not
accept a workspace from a model or request body. A rollback of policy content
still advances the existing version, so an old approved request cannot revive.

## Evidence

Cloud Linux, loopback PostgreSQL 17 at port 55599, dedicated database
`mikka_policy_closeout_e2e`; all three database URLs point there. Bootstrap
applied all 154 baseline migrations. Prior databases, containers and ledgers
were preserved. Raw logs remain local and must not be uploaded wholesale.
The subsequent provider-owner integration takes policy core `efb56f54` and
wrapper `3cd7754e` and applies its one additional migration (155 total) to the
same isolated database. The postpayment transport test also passes against
that real wrapper, which no longer reads model prices or computes a maximum:
`/tmp/mikka-postpay-current-wrapper.log` (1 pass, zero fail/skip). The combined
hosted source checks pass 15/15: `/tmp/mikka-postpay-combined-source.log`.

| Check | Result | Local evidence |
| --- | --- | --- |
| Hosted accounting DB suite: no prepayment, ten-way concurrency, unknown receipt without a debit, actual spend breaker, debt/top-up, legacy prepaid-row compatibility and duplicate settlement | 10 pass, 0 fail/skip | `/tmp/mikka-postpay-store.log` |
| Existing hosted policy, model wrapper and card source checks | 12 pass, 0 fail/skip | `/tmp/mikka-postpay-source.log` |
| Actual hostedModel + complete PG + loopback provider transport: positive balance below the old estimate allowed; held response leaves balance unchanged and all reserved fields zero; receipt charges actual cost; ten exhausted calls reach no provider; credited balance restores generation and streaming; duplicate settlement does not double charge | 1 pass, 0 fail/skip; baseline fails the pre-receipt unchanged-balance assertion | `/tmp/mikka-postpay-{before,transport}.log` |
| Same new task policy matrix against baseline policy-store | 0 pass, 6 fail; first failure is null workspace instead of task workspace | `/tmp/mikka-task-policy-before.log` |
| Task policy and current worker-token authorization together | 16 pass, 0 fail/skip | `/tmp/mikka-task-policy-final.log` |
| AgentKit compatibility, CLI policy layers/snapshot, frozen assignment and GitHub run-token source tests | 48 pass, 0 fail/skip | `/tmp/mikka-policy-source.log` |
| Strict transport policy compatibility | 24 pass | `/tmp/mikka-policy-protocol.log` |

The task matrix uses two real workspaces, SQL fixture identities and real
device credentials. It exercises the exported tool-approval HTTP route over a
loopback server: current revision is live, an old policy revision is not live,
and removed task membership returns 409. It also checks cross-workspace Bot
intersection, both memberships, personal task isolation, lower-layer attempts
to loosen a workspace denial, and stale approvals after policy rollback.
The worker suite separately exercises the exported MCP HTTP handler, STOP,
expired lease and task/Bot membership revocation. These are backend route/DB
checks, not a normal human signup or a complete Next/daemon/provider run.
The billing test substitutes only fixed model pricing, alert delivery and
synthetic provider receipts over real loopback HTTP. It uses the actual model
wrapper, store and complete migrated database. It does not claim a real external
provider call or real payment. The provider consumer owner separately removes
the old price-estimation lookup; the store accepts its existing four-argument
admission call. No new migration or money state machine is introduced.

## Remaining completion criteria

| Issue | Existing / newly verified coverage | Still required before closing |
| --- | --- | --- |
| #207 | Current task/Bot access, worker tokens, leased execution and actual MCP/tool-liveness route denials; task workspace CLI scope now included. Reuses existing issue visibility and membership guards. | A complete fixed-version application matrix for search pagination/count/cache, artifact/download links and background retries, with recorded revocation boundaries. The scoped tests do not establish every entry or every signed download. |
| #215 | User-directed positive-balance admission and actual-receipt settlement, one pending/unknown call per workspace, idempotent accounting, platform free-spend breaker; existing BYOS quota and E2B compute caps remain separate. The old financial-reservation requirement is superseded, not claimed as completed. | Cross-entry model/tool/native/cloud quota inventory and execution evidence; provider 429/Retry-After behavior; crash/unknown-cost receipt reconciliation and authorized overrides; real provider receipt accounting. Unknown receipts deliberately block another call until reconciled; their rows do not debit or freeze new funds. |
| #230 | Existing Agent/worker/workspace CLI composition and live revision checks; task workspace ceilings and revocation now propagate; old approvals cannot cross a policy change or rollback. | Full authenticated application/claim/daemon/child propagation evidence; the issue's signed/versioned offline-cache contract, project/default hierarchy and publication/audit acceptance have not all been implemented or validated by this patch. |

No external provider write, paid resource purchase, new IAM, production deploy,
issue closure or merge is performed by this worktree. Full restricted approval
and scope suites remain assigned to genuine GitHub Actions; their target guards
are unchanged. The parent integrator registers the new task policy DB test and
owns overall type/build/CI and independent review.

## Billing call and presentation audit, 2026-10-31

Reviewed the postpayment branch and provider-owner patches against the newer
main `50def057`. Main's card-verification `verify`/grant changes remain owned by
the integrator; this audit does not replace or edit them.

| Path | Finding / owner |
| --- | --- |
| `lib/abuse/model.ts` → `hostedModel` | Provider-owner `3cd7754e` removes Gateway price lookup and estimated maximum. Each paid generate/stream uses the postpayment store. `61f5862e` also settles known pre-provider refusals as zero, keeping actual transport failures unknown. |
| `lib/abuse/workflow-model.ts`, `lib/abuse/resolve.ts`, `lib/coordinator/group-runtime.ts`, `lib/profile/extract.ts`, `lib/suggestions/action-title-server.ts` | Hosted-model paths share that wrapper; no separate estimated-cost threshold. Provider-owner `8fef2fea` carries trusted billing identity through the relevant consumers. |
| `lib/coordinator/decide.ts`, `workflows/subagent/steps.ts`, `lib/cloud-computer/visual-model.ts`, evaluation/recovery consumers | No separate estimated-cost rule. The baseline Decision call could omit billing scope; provider-owner `8fef2fea` refuses that path and carries trusted scope into Decisions and child inference. This audit does not duplicate those consumer changes. |
| `lib/abuse/store.ts` | The ignored legacy fifth parameter is not a price gate. New pending rows carry zero reserved amounts. References to reserved-money columns preserve old already-prepaid accounting; they do not precharge new calls. No store changes in this audit. |
| `lib/billing/history.ts`, `lib/billing/hosted-usage.ts`, `components/billing/balance-section.tsx`, `components/settings/usage-settings.tsx`, `components/billing/hosted-refusal-notice.tsx` | Display the actual backend balance/refusal state. No optimistic deduction, estimated affordability check, held balance or prepayment field was found. No UI change is needed. |
| `lib/subscription-model-snapshot.ts`, `packages/daemon/src/subscription-quota.ts`, `lib/cloud-computer/thread-machine-limits.ts` | Existing provider subscription quotas and actual compute/concurrency limits are separate from Mikka balance prepayment; retained. |
| `lib/abuse/alerts.ts` | Confirmed postpayment regression: first-free-use monitoring filtered only `reservedFree > 0`, so new zero-reservation receipts were invisible. Occurrence 10 × impact 3 = 30. Include actual `freeMicroUsd > 0`, preserving legacy rows and first-use deduplication. |

The alert regression uses the actual function and PostgreSQL table definitions
on connection-local temporary tables. Baseline returned no alert; after the
query fix, two new free-use workspaces plus one legacy workspace produce one
durable signup-spike alert. A repeat receipt in the same workspace is counted
once; an old workspace's recent call is excluded. The repeat check creates no
duplicate row. Test: 1 pass, zero skips, zero external email calls; logs
`/tmp/mikka-postpay-alerts-{before,after}.log`. No existing ledger or alert rows
are changed. These are candidate source/isolated-DB results, not confirmation
of a production rollout.
