# Shared collaboration, private content and explicit resource ownership

- Date: 2026-11-10 00:17 UTC (2026-11-09 in America/New_York).
- Source: Alex's [#1849](https://github.com/alexj11324/Mikka/issues/1849) and its implementation assignment: “团队内默认协作、私人内容真正私有、个人订阅不作为其他成员可直接选择的资源池”.
- Status: accepted product decision; deployment and acceptance are recorded per PR in #1849.
- Rule: R-26, R-62, R-76; orchestration §§ 1, 2, 6, 7.
- Replaces: the view-only/shared-chat parts of [2026-11-01-2300](2026-11-01-2300-thread-visibility-follows-warp.md), cross-member personal subscription sharing, implicit single-member Shared Workspace personal-credit fallback in [2026-11-02-1500](2026-11-02-1500-personal-first-team-needs-two.md), and seat-based Cloud Team admission and checkout. Independent Workspace tenancy, native Agent execution and protected Secrets remain authoritative.

## Tenant and content authority

Organization owns organizational membership, resource policies, connections and
platform billing. Each Workspace remains an independent content tenant. Joining
an Organization, being its administrator or funding its work grants no Workspace
content access. Team remains optional grouping; Project reuses the existing
Project v2 identity and repository/environment bindings.

In a Shared Workspace, newly created collaborative Projects, Tasks and their
Threads are shared by default. An explicit personal or organizational default
may make them private. The creation and sharing controls show that scope.
Personal Workspaces remain private. Every content read must satisfy the active
Workspace membership and Enterprise principal, the resource access control list
(ACL), and every restrictive parent. Private Project and private child policies
intersect. A resource owner does not bypass an inaccessible parent.

Discovery, administrative metadata, content, comment, steering, approval, access
management, transfer, credential use, machine use, usage and billing are separate
capabilities. A member's content access is not an execution or payment grant.
Only the owner and explicitly authorized people can read private content.
Administrators may inspect necessary usage/management metadata through a
separate allowlisted projection, without titles, prompts, filenames, messages,
tool output, screenshots, private memory or Secret values.

The same authority applies to Web, Desktop, iOS, API, MCP, PAT, search, live
delivery, caches, downloads, PR associations, Factory and background consumers.
ACL revocation ends subsequent reads and writes, invalidates retained views and
stops execution whose authority has been withdrawn. It does not add a remote
permission round trip to every native model/tool invocation.

## Resource and payment authority

Personal Claude Code/Codex subscriptions are Account-owned. They cannot enter
another member's model pool. An owner can use their own subscription in each
Workspace they are authorized to use. Sharing a Thread does not grant its
participants the owner's subscription, GitHub account, device, private API key,
personal Secrets or private memory. Provider terms are an independent necessary
condition; owner consent alone cannot authorize prohibited account sharing.

Organization connections hold organizational API keys, gateways and custom
endpoints. Connection selection considers the authorized owner's ordered
connections, organizational connections and platform Credits, subject to model
restrictions and explicit paid-fallback policy. Exhausted quota, temporary rate
limiting and revoked authentication are distinct failures. Switching a model or
introducing a new paid source requires the applicable explicit authorization
and budget; a continuation records a new frozen identity.

Every Run preserves Actor, Thread Owner, executor, credential owner, model,
Agent, model payer and compute payer. A participant's message retains its true
Actor. Official Claude Code and Codex keep native direct provider execution,
ordinary HOME/Git and selected credentials under the existing machine boundary.

Organization platform plans are based on Credits and resource capacity, not
member seats. Stripe subscription events, effective entitlements and the
existing ledger have one idempotent source-to-projection chain. Organization
budgets allocate spending authority without moving historical balances. A
legacy Workspace or personal balance keeps its owner and complete receipts.
An unconfigured resource-based Stripe price is unavailable; an old per-seat
price is not silently repurposed. Existing subscriptions remain historical
financial obligations until explicitly changed through an authorized flow.

Mikka charges only its own metered services. Personal subscriptions, BYO API
keys and personal E2B retain external billing. An unavailable external invoice
amount is Unknown, not $0. Paid fallback, auto-recharge and funding require
explicit scope, caps, idempotency and audit. Implementation authorization does
not authorize production prices, real charges or customer balance transfers.

## Secrets, machines and lifecycle

Shared, Personal and Thread are product scopes over the existing Secret vault
and #1712 capabilities. Authorized Thread values override Personal values,
which override Shared values. Scope precedence cannot grant missing authority.
A private Secret is not injected merely because someone may operate a shared
Thread. Protected egress remains protected; direct-env compatibility reports
its actual machine-readable exposure.

Personal devices and E2B remain owner-only by default. Shared execution requires
explicit owner consent and independent execution identity/isolation. Until a
runner can enforce that separation, it refuses cross-owner execution. Removing
or suspending membership revokes related session/token/resource authority and
stops affected work through existing lifecycle delivery. Organization resources
are retained. Private transfers require an explicit audited process; metadata
administration is not permission to read private work before transfer.

## Migration and rollout

Migrations are additive and replayable. Existing shared Tasks retain their
proved authorization. Historical private chats, Threads, Artifacts and memory
stay private, even when a parent is shared. Missing or conflicting provenance
is quarantined. No legacy scope label is permission to publish content.

Implement in dependency order: ACL/migration; content surfaces; connections;
billing and quotas; Secrets/devices/lifecycle; official client integration.
Each batch has isolated PostgreSQL/API/CLI evidence, current required CI,
merge-risk analysis and a forward/revert recovery path. Do not roll back to a
binary that ignores ACLs after accepting private resources. External service
acceptance is separate from source and isolated test results. The complete
matrix and evidence are maintained in [the feature contract](../collaboration-governance.md).

## External references and deliberate differences

Checked on 2026-11-09 America/New_York:

- [Capy security](https://docs.capy.ai/admin/security) documents shared defaults,
  private parents and restricted admin content. Mikka also hides private titles
  and filenames in administrative projections and filters associated PRs.
- [Capy connections](https://docs.capy.ai/models-and-pricing) separates personal
  subscriptions from organizational keys and uses Thread Owner connections.
  Mikka requires separate execution/payment authorization and provider policy.
- [Capy API authentication](https://docs.capy.ai/api-reference/authentication)
  documents live principal checks and scoped service users. These are necessary
  authority checks, not permission to bypass Workspace isolation.
- [Capy billing](https://docs.capy.ai/admin/billing) describes organizational
  Credits, unlimited members and capped auto-reload. It does not establish
  Mikka's internal Stripe/ledger transactional guarantees.
- [Capy Secrets](https://docs.capy.ai/secrets) describes scope precedence and
  machine-readable plaintext. Mikka retains its stronger protected-secret
  boundary rather than copying that exposure.
- [Claude Code legal terms](https://code.claude.com/docs/en/legal-and-compliance)
  require unmodified native execution and each end user's own authentication.
  [OpenAI account sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy)
  distinguishes personal remote use from giving an account to another person.

Capy is a product reference. Mikka's independent tenants, BYO E2B, self-hosting,
secret protection, private-data migration and financial invariants are explicit
Mikka decisions; the reference is not evidence that those internals exist in Capy.
