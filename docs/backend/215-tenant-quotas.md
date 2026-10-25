# Tenant execution budgets and quotas (#215)

Backend candidate on `codex/215-tenant-quota-20261025`, based on main `40cbaff`.
This is implementation and isolated system evidence, not production acceptance.
No frontend design, subscription credential, commercial plan, price, cloud
resource purchase, IAM grant, production migration or merge is included.

## Units and authorization

The ledger counts **admission units**, an operator-defined execution allowance.
It does not debit subscription credits, collect money, infer remaining provider
credits, or guarantee a dollar cost. Tokens, when available from the Coordinator
model, are stored as usage observations independently from the allowance.

No allowance is seeded. Missing configuration fails closed. A platform operator
must first authorize a finite `quota_allocations` grant in the application DB,
with workspace, fixed per-resource units, maximum lifetime budget, concurrency,
rate and fixed rate window, expiry, grantor and reason. Tenant window rollover
cannot reset this platform lifetime cap; only an operator can increase it. There is deliberately no public grant endpoint.
A workspace administrator may set a policy or temporary override only within
that existing allocation. They cannot approve unknown resources, lower resource
weights to zero, expand an allocation, or move an owner's existing tenant binding.
Overrides record the actual authenticated admin, reason and expiry, and cannot
outlive the policy or allocation. Changing an active window cannot reset usage.
An allocation can be revoked without modifying subscription credentials.

Execution ownership in current main is person-scoped. Each owner is explicitly
bound to one workspace tenant; several owners can share that workspace's
budget. Execution never accepts a workspace cookie or model-provided tenant as
billing authority. Every reservation and activation checks the owner's current
active membership against the existing workspace database after the tenant lock
has been acquired. Heartbeat renewal repeats these checks. Completion can release
resources after revocation, without permitting a new effect. Main and workspace
DBs may be different: authorization is a current directory read, not a distributed
transaction or a provider-side revocation guarantee. #207 remains the current
run/tool authorization authority; this does not replace it.

## State and concurrency

All ledger mutations lock tenant then reservation. Admission reserves the full
resource allowance atomically against spent plus reserved amounts, global tenant
concurrency and a sliding rate window. All owners, resources and entry points use
the same tenant lock. Resource-level provider backoff is durable and shared by
that tenant. The rate count includes refunded attempts, preventing refund loops.

`reserved -> executing -> settled | refunded | uncertain` is immutable once
terminal. A key is owner-scoped and bound to a canonical payload fingerprint.
Ten identical callers can obtain one reservation, but only one activates it.
Changed parameters conflict. Settled or uncertain operations cannot resend just
because the HTTP response was lost. The existing explicit Agent retry/regenerate
action creates a new server attempt and is charged separately; transport replays
retain the original turn key. Reconciliation or a new explicit logical
operation is needed; the quota ledger does not pretend to cache a model reply.

Expiry while still reserved, or a confirmed pre-send failure before expiry,
refunds the allowance. An executing lease that has already become uncertain
retains its allowance, including when its old preparation later fails. An explicit initial
401/402/403/429 rejection refunds it; transport loss, cancellation after dispatch,
worker death, or unknown partial work consumes the full reserved allowance.
A later 429 in a multi-step Agent turn cannot refund earlier accepted work.
Unknown outcomes never retry automatically. Expiry releases concurrency, while
retaining the uncertain allowance. Repeated settlement does not charge or extend
backoff again. Late contradictory outcomes cannot overwrite a terminal result.
There is no exactly-once claim for external effects.

Concurrency counts active reservations, including nested work: an Agent turn
and an external tool invoked by it can occupy two slots. Provision the approved
allocation accordingly. This is an execution safety limit, not a commercial tier.
Models have zero SDK retries and bounded generation time below the quota lease.
Ordinary Agent output retains its existing provider-controlled token limit. Daemon quota leases match existing run leases; expired/revoked
claims cannot be renewed and must be retried through normal fenced run recovery.
Claim reservation creation, activation and the queued-to-preparing run CAS
share one PostgreSQL transaction and one persisted deadline. A SQL error or
process death inside that transaction leaves no reservation and a queued run,
permitting one safe retry even after a long restart delay. Once committed, the bound run prevents reissuing an ambiguous payload.

Composio has a 270-second whole-operation deadline within its 300-second lease.
The AbortSignal reaches actual account, schema and execution HTTP requests;
pagination rejects repeated cursors and more than 50 pages. Its final SDK
`beforeExecute` hook runs after the SDK's internal schema/file preflight and
atomically rechecks the original executing lease, allocation, membership and
backoff immediately before dispatch. It cannot renew an expired lease.
Cancellation after a confirmed local HTTP effect leaves an uncertain charge and
blocks replay. No background operation is abandoned by a timeout race.

## Actual call sites

| Entry | Enforcement |
| --- | --- |
| `POST /api/agent` | Stable turn key; pre-stream admission; bounded streaming lifecycle; terminal checkpoint settlement; partial-work-aware failure accounting |
| `WorkflowAgent` Coordinator generation | Serializable `QuotaWorkflowModel`; checks inside actual model execution step, not merely when the workflow is enqueued; stable workflow/round/step key |
| Coordinator summary | Stable durable step key, bounded `generateText`, no SDK retry |
| Coordinator HTTP/action/MCP user submissions | Shared `recordCoordinatorEvent` gate before user-message enqueue; system completion events remain deliverable |
| Decision Gateway | Owner/event key and tenant gate, while preserving existing dedicated Gateway key budget and fixed-rule fallback; absent tenant context uses rules |
| Agent web tools | Gate before the existing bounded Gateway tool operation; preserves DNS/URL restrictions and cancellation |
| Composio | Shared wrapper for existing callers, including approved actions; admission before service access, bounded transport cancellation, final SDK pre-send fence, known preflight refunds, provider rejection/backoff observation |
| App/action/MCP/Coordinator run dispatch | Shared `queueRun` admission; current domain validation preserved |
| Daemon claim/heartbeat/complete/recovery | Separate per-run execution reservation, same-transaction activation/run CAS, no losing-claim payload, renewable bounded lease, idempotent terminal settlement and uncertain crash settlement |
| Administrative policy | `PUT /api/workspaces/:workspaceId/quota`; authenticated same-origin active admin; operator grant cap; immutable live window; append-only policy events |
| Usage query | `GET /api/workspaces/:workspaceId/quota`; active member only, shared usage totals and limits, no credential or model payload disclosure |

#191 still owns durable domain dispatch idempotency, and #208 owns external
operation identity/outcome reconciliation. Their draft implementations are not
copied into main or represented as merged here. When integrating their candidates,
keep the quota wrapper around the final authorized domain transaction. Schedule
#179 and cloud/BYOS #172 candidates must invoke these same gates at their actual
execution boundary. Current main has no persistent schedule executor or cloud
resource provisioner to falsely claim tested. Subscription quota snapshots and
credential custody are untouched. No fallback to a separately billed API is added.

## Validation and evidence

All new DB tests require an explicit loopback `QUOTA_TEST_DATABASE_URL` with a
synthetic database name. They never default to either production database URL.
`lib/quota/store.test.ts` uses a real PostgreSQL schema, SQL state reads, ten-way
contention, multiple owners/tenants, immutable refunds/settlement, Retry-After,
rate persistence, expired pre/post-send leases, membership changes while waiting
on locks, and actual separate workers killed by SIGKILL before and after a local
HTTP effect. Records are retained. The local HTTP effect is an isolated fixture,
not a paid provider or a production acceptance claim.

`tests/quota-api.test.mjs` boots the actual built Next app, real Better Auth
sessions, real application/workspace tables and actual HTTP handlers. It uses
synthetic identities and a fail-only external-network sentinel: attempted
external requests fail and are recorded, never simulated as successes. It tests
ordinary Agent denials, Coordinator enqueue/model boundary, administrator
restrictions, ten competing daemon claims, duplicate completion, and subsequent
admission. No actual harness, provider credential or paid execution is permitted.
A JSON evidence artifact records SHA, migration, environment, UTC and results.

Cloud Linux evidence directory: `/workspace/evidence-215/` (private environment).
The initial PG suite passed 13/13 with zero skips at
`2026-10-25T17:01:04Z`; the later operator-allocation test exposed a fixture that
expected an owner-binding error before the live-window check. The fixture was
corrected to keep the same target window; failures remain in the evidence logs.
Expanded local PG regression passed 16/16 with zero skips at
`2026-10-25T17:23:43Z`, including allocation lifetime/window-reset and rate-window
evasion, expired overrides at activation, operator revocation at renewal, and a
real SQL trigger write fault. Initial clean-CI actual Next HTTP regression passed
6/6 at `88787cd` with zero external network attempts:
https://github.com/alexj11324/Mikka/actions/runs/40215373894 .
Source regression passed 29/29, migration checks 11/11 and all 33 migration names
passed. Exact candidate SHA, final HTTP results and CI links are recorded in the
PR after execution. Earlier build failures are retained: native SWC cache
ownership in this container; an initially missing workflow step directive;
Turbopack refusing external dependency symlinks. Local webpack and the existing
SWC 1.15.3 build tool are used for the environment; clean CI uses the pinned lockfile
and ordinary repository build. No repository Next configuration is changed.

## Release gates retained for the parent

- Parent coordinates integration of #191/#208/#172/#179 and #207, freezes one SHA,
  provisions an explicitly approved non-production operator allocation, and runs
  real user/provider-safe acceptance and usage readback.
- No policy/allowance exists for production. Deploying this fail-closed candidate
  before parent-approved allocation/policy provisioning will deny execution.
- Actual provider billing/usage reconciliation, connected-subscription revocation,
  cloud resources, and production acceptance have not been run. The user's
  instruction forbids spending real credits or creating billable resources here.
- Existing Claude frontend may consume the backend policy/usage/error contract;
  no new configuration UI or design is included.
- Pure backend HTTP/log/DB evidence is applicable here. There is no genuine UI or
  production-flow video to claim. A parent-authorized integrated user acceptance
  recording remains a release artifact, not a reason to fabricate a demo.
- #215 remains open until applicable integrated acceptance and independent review.

### Measurement inventory

| Existing source | What can be measured | Limitation / admission policy |
| --- | --- | --- |
| Ordinary Agent / Coordinator SDK | Model requests, bounded steps/output; Coordinator returned token observations | No current verified per-request price/remaining spend source. Operator-approved admission units, not inferred currency. |
| Decision Gateway | Existing dedicated key budget and fixed-rule fallback | Keep #128's provider-side cap. No new shared Gateway budget or price assumption. |
| Gateway web and Composio | Bounded requested operations, explicit rejection status / Retry-After when available | Tool/service charge and provider completion after transport loss are not authoritative billing readback. Unknown cost requires operator allocation. |
| Daemon subscription quota protocol | Vendor, source, `ok`/`unknown`, used window fraction, reset time and observation time | This is a numeric observation, not a monetary ledger or authorization to extract a credential. It cannot establish exact per-run dollar cost; readers and subscription semantics remain unchanged. |
| Native daemon run | Claim, heartbeat lease, run completion / uncertain loss | Admission units do not represent the provider's actual subscription debit. Live provider exhaustion, disconnected custody and balance reconciliation remain integrated #172/#207 acceptance gates. |
| Cloud computer / persistent schedules | Candidate #172/#179 own actual resource and occurrence lifecycle | Current main lacks these executors. Parent must wire the same gate at the final boundary; no cloud/provider execution was purchased or presumed tested. |

A failed local acceptance launch exposed a driver cleanup bug after an already
exited child. The driver now bounds readiness probes, retains child output as it
arrives, records startup failure, and cleans up on test cancellation without
waiting for an exit event that already happened. The failed launch and font
fetch errors remain in the private evidence directory.

### Independent review corrections (2026-10-25)

The old candidate `905fea22` passed its CI but had two independently identified
pre-send gaps. New isolated regressions first reproduced both before correction:

- A real `agent_runs` BEFORE UPDATE trigger forced the claim CAS to fail after
  separately committed quota activation. HTTP returned 500 and left a queued run
  with no reservation binding; same-key retries returned 409 even after expiry.
  The first correction returned 503 with queued/reserved state and allowed an
  immediate retry, but a new actual HTTP regression showed late retry still
  failed after reservation expiry. The final handler rolls reservation creation
  back too, returning 503 with queued/no-reservation state; retry binds the
  preparing run and quota atomically. A separate worker killed
  by SIGKILL inside the combined transaction verifies rollback and recovery.
- The real Composio SDK used controlled loopback HTTP for accounts, schema and
  execution, with actual PG allowance/HTTP-effect records. Delayed preflight
  formerly dispatched after a competing request expired its lease; a timeout
  formerly left the HTTP request running and dispatched later. Corrected tests
  cover ordinary preflight, the SDK's additional internal schema fetch, actual
  socket cancellation, a successful execution control and response loss after
  one confirmed effect. That last case remains uncertain and cannot resend.

`tests/quota-claim-fault.test.mjs` boots the real Next HTTP handler against
synthetic application tables. `lib/quota/composio.test.ts` uses the installed
SDK with a loopback base URL, synthetic key and tracking disabled; it does not
replace handlers or manufacture SDK successes. Test-only PG expiry advancement
models a delayed host without waiting five minutes; the separate deadline case
uses a real timer and verifies that the actual HTTP socket closes. These tests
run in the quota CI workflow alongside the existing actual-app HTTP suite.
Failures and corrected results remain in `/workspace/evidence-215/`; final SHA
and CI links are recorded in the PR after execution, with runner parent counts
distinguished from independent scenarios. No production/provider acceptance is
implied by these regressions.

The controlled SDK suite also exposed a wrapped-HTTP-429 observation gap: its
HTTP API error carries `status` and `Headers` inside `cause`. Bounded error-cause
inspection now recognizes that explicit rejection, refunds the allowance and
persists Retry-After; a different logical request is denied without another
HTTP execution. A 500 or unknown/cyclic error remains uncertain. The real SDK
regression first failed with an uncertain charge, then passed after correction.

The broader `pnpm check` additionally exposed an old candidate output-cap
regression; the extra ordinary-Agent 8192-token cap was removed to preserve
existing provider output semantics. Two unrelated source-layout assertions at
`tests/agent-ui.test.mjs:39` and `:433` still fail identically in a clean detached
base `40cbaff` worktree (hydration preload and conversation Popover expectations).
Their source files are unchanged here. These baseline failures are retained for
parent/Claude coordination; no frontend layout or assertion is changed to hide
them. Individual remaining standard checks are run and recorded separately.

A third base-reproduced source assertion is
`tests/acceptance.test.mjs:7`: it expects only `NODE_ENV === development` before
partitioned-cookie options, while unchanged base auth also requires HTTPS. The
new quota work does not change auth or weaken that condition. The broader check
remains red for these three verified baseline assertions; the other 18 remaining
script groups pass, including types/lint. This differs from the repository CI
workflow, which does not run those two source-test files.

Legacy claim compatibility preserves terminal history: an expired reserved
record becomes refunded once; a trusted same-transaction run read must prove
queued status and null quota binding, startedAt and leaseExpiresAt before a
new `quota-unsent:<old reservation id>` attempt can be admitted. The old refund
is never reopened or charged again. New admission still checks current budget,
concurrency, rate, membership and allocation. A child attempt is unique and
immutable, so uncertain/settled/executing work cannot replay. Actual HTTP tests
also prove that an ambiguous non-null startedAt refuses this recovery. A
separate worker is SIGKILLed after legacy reservation commit, its lease is
advanced past expiry in the isolated PG, and a restarted store binds exactly
one new charge while retaining the zero-unit old refund.

The locked Composio client `2.0.0-rc.19` removed its manual caller-signal bridge
after HTTP headers, leaving body decoding outside cancellation. A new real SDK
HTTP test first failed when the server flushed headers/partial JSON and stalled
the body. The checked-in pnpm patch composes the caller signal directly with
the attempt signal sent to fetch, keeping the caller's whole-operation deadline
connected through response-body I/O. It changes no dependency versions and
introduces no global fetch hook or abandoned Promise race. Frozen-lockfile
installation and exact-head CI verify patch application. The regression checks
actual socket closure before the delayed body, no execution POST and a safe
pre-send refund. SDK per-attempt header timeout is not treated as a substitute
for this caller deadline.
