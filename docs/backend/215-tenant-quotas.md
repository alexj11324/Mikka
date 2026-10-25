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
with workspace, fixed per-resource units, maximum window budget, concurrency,
rate, expiry, grantor and reason. There is deliberately no public grant endpoint.
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
because the HTTP response was lost. Reconciliation or a new explicit logical
operation is needed; the quota ledger does not pretend to cache a model reply.

Before-send failure or expiry refunds the allowance. An explicit initial
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
Models have zero SDK retries, bounded generation time below the quota lease, and
bounded output. Daemon quota leases match existing run leases; expired/revoked
claims cannot be renewed and must be retried through normal fenced run recovery.

## Actual call sites

| Entry | Enforcement |
| --- | --- |
| `POST /api/agent` | Stable turn key; pre-stream admission; bounded streaming lifecycle; terminal checkpoint settlement; partial-work-aware failure accounting |
| `WorkflowAgent` Coordinator generation | Serializable `QuotaWorkflowModel`; checks inside actual model execution step, not merely when the workflow is enqueued; stable workflow/round/step key |
| Coordinator summary | Stable durable step key, bounded `generateText`, no SDK retry |
| Coordinator HTTP/action/MCP user submissions | Shared `recordCoordinatorEvent` gate before user-message enqueue; system completion events remain deliverable |
| Decision Gateway | Owner/event key and tenant gate, while preserving existing dedicated Gateway key budget and fixed-rule fallback; absent tenant context uses rules |
| Agent web tools | Gate before the existing bounded Gateway tool operation; preserves DNS/URL restrictions and cancellation |
| Composio | Shared wrapper for existing callers, including approved actions; admission before service access, known preflight refunds, provider rejection/backoff observation |
| App/action/MCP/Coordinator run dispatch | Shared `queueRun` admission; current domain validation preserved |
| Daemon claim/heartbeat/complete/recovery | Separate per-run execution reservation, CAS claim, no losing-claim payload, renewable bounded lease, idempotent terminal settlement and uncertain crash settlement |
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
