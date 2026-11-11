# Collaboration and resource governance

This contract guides #1849 implementers and reviewers through the accepted
resource, privacy and cost boundaries. Per-PR evidence establishes what is
implemented and deployed; this document alone is not an acceptance receipt.

- **Status:** accepted requirements, implementation in progress.
- **Issue:** [#1849](https://github.com/alexj11324/Mikka/issues/1849).
- **Decision:** [Shared collaboration and explicit resource ownership](decisions/2026-11-10-0017-collaboration-governance.md).
- **Owner:** the #1849 implementation owner; dependent modules retain their existing owners.

## What the person does

Members work together in shared Projects, Tasks and Threads. Owners restrict
private work and decide who may contribute. Organization administrators manage
organizational connections, capacity, budget and billing without reading private
conversations. Personal subscriptions, machines and Secrets remain personal.

## Authority matrix

Every content capability also requires active membership in the resource's
Workspace, the current Enterprise/session policy and every parent restriction:

| Principal and context | Discover/content | Comment/steer | Manage/transfer | Private usage metadata | Personal credentials/machines |
| --- | --- | --- | --- | --- | --- |
| Resource Owner, authorized parent | Allowed | Allowed subject to execution budget | Owner management; transfer audited | Own usage | Their own authorized resources |
| Shared Workspace member, shared resource | Allowed | Contribution policy; execution authorization separately | Denied without explicit capability | Their authorized usage | No borrowed personal resources |
| Explicit private collaborator | Granted capability and parent intersection | Explicit contribution capability | Denied unless explicitly granted | Scope-limited | Separate resource grant and provider policy |
| Workspace/Organization Admin without content grant | No private discovery/content | Denied | Management projection only; controlled transfer separate | Allowlisted identifiers, attribution and amounts | No access to member credentials or shell |
| Member of another Workspace | Denied | Denied | Denied | Only separate Org billing projection if authorized | Denied |
| Removed/suspended/expired principal | Denied | Denied; affected execution stopped | Denied | Denied | Denied |
| Service principal | Explicit Workspace/Project grant and resource ACL | Scoped capabilities and budget | No implicit human authority | Scoped reporting | Dedicated authorized connection only |

An inaccessible private resource is absent from ordinary lists, counts, search,
notifications and live payloads. Administrative projections exclude content-
bearing fields. Giving a child a shared policy cannot widen a private parent.

## Ownership and cost contract

The existing execution identity snapshot records separate roles:

| Role | Meaning |
| --- | --- |
| Actor | Principal that sent the message or authorized the operation |
| Thread Owner | Account that owns that Thread's access and execution policy |
| Executor | Actual admitted human/service/worker principal |
| Credential Owner | Personal account or Organization owning the selected connection |
| Model payer | Subscription quota, external API account or platform billing account |
| Compute payer | Owner's E2B account, their device, or an explicitly offered platform resource |

The same-model fallback records source, reason, consent/budget revision and the
next Run's frozen identity. It does not rewrite an earlier Run. Unknown external
amounts are represented explicitly; zero platform credits does not establish a
zero external bill. Existing ledger entries and balances never change owner as
a side effect of attaching a Workspace to an Organization.

## Implementation batches and acceptance

Each row is an implementation boundary, not a completion claim:

| Batch | Reused modules | Required evidence |
| --- | --- | --- |
| 1. ACL and migration | Task Workspace authority, Enterprise principal, Project v2 identity, existing audit/live delivery | Split PG databases; owner/member/admin/external/removed/service matrix; private parent; revision race; historical data preserved |
| 2. Content surfaces | Thread chain, Bot chat, Artifact/Capture/Factory/Coding Workspace | Real read/send/download/search/Live/API/MCP/PAT paths; Actor attribution; no private ID/title/count leakage; revoked cache/media |
| 3. Connections | Personal credential vault, model ordering, native harness, frozen execution identity | Cross-member subscription denied everywhere; Org key shared/revoked; explicit paid fallback; native Claude Code and Codex |
| 4. Billing | Stripe webhook, entitlement grants, credit ledger, usage readers | Repeated/out-of-order events, cancellation/refund/retry; capped recharge; no BYO double charge; no implicit balance transfer |
| 5. Lifecycle | #1712 Secret capabilities, devices, member/SCIM outbox | Synthetic Secret precedence; protected egress; revoked in-flight work; preserved private and Org resources; transfer audit |
| 6. Clients and release | Official hosted Web/Desktop and Expo iOS UI | Real local production screenshots/recording; matching APIs; READY/served SHA; external-service receipts; cleanup |

For every result record the source SHA, test invocation, fixed application and
database environment, CI run and deployment SHA. Distinguish local fixtures,
test providers and authorized real providers. No mock result establishes
production acceptance. The full Issue checklist remains authoritative.

## Existing UI integration

Use the existing Project/Task/Bot access controls and the settings hierarchy for
Organization members, connections, usage and billing. A Shared/Private choice
uses the existing menu/dialog components; task conversation uses
`IssueThreadPanel` and Bot chat uses the existing Coordinator chat. The official
build combines public code and `mikka-hosted-ui`; there is no second fallback
design. Paid blocks retain their shipped structure, with product data and text.

Private content, contribution denied, revoked access, quota exhausted,
paid-fallback confirmation and external cost Unknown are distinct states. Live
revision invalidation clears revoked content. No idle polling is introduced.
R-26, R-62, R-76, R-84 and R-90 apply with this decision's supersessions.

## Rollout and recovery

Migrate historical grants without publishing private content. Keep unknown
ownership quarantined and historical finance entries intact. Enable shared
creation only after the corresponding content entry points enforce the ACL.
Each batch documents the last safe code revision and the retained additive
schema. After private resources are created, recovery must preserve ACL checks;
reverting to membership-only readers is not safe.

No production Stripe price, purchase, customer balance transfer or irreversible
private ownership transfer is authorized by implementation alone. Report any
unexecuted financial operation precisely, while completing code, isolated E2E,
CI and the independently authorized production checks.
