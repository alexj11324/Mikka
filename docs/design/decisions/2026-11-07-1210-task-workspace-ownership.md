# Task ownership is an immutable workspace binding

- Date: 2026-11-07
- Source: Alex's delivery instructions for [#1608](https://github.com/alexj11324/Mikka/issues/1608).
- Builds on: [The workspace is the tenant](2026-11-02-0231-workspace-is-the-tenant.md), T1–T6.
- Delivery: Workspace P0 first; Team Free/Pro and Enterprise v1 are separate releases. Knowledge bases and RAG are excluded.

## Ownership and authorization

A task has one stored `workspaceId`. Personal and shared workspaces use the
same tenant boundary. `userId` records its creator; a Team is optional grouping.
Neither a creator, an assignee, an invitation nor a legacy `scope` label grants
access to a different workspace. Organization billing and administration do not
make an organization a content tenant.

The server resolves creation authority from the authenticated workspace context,
a pinned PAT/OAuth/run context, an authorized Team, or the persisted source Bot,
thread or provider binding. It checks active membership in the workspace database.
A supplied identifier is a request to select an authorized context, never proof of
membership. A scoped credential cannot select another context, even when its
owner belongs to both workspaces.

The workspace is fixed at creation. Duplicates and child tasks retain their
source task's workspace. A Team change must stay in that workspace. Runs,
artifacts and Factory tasks retain the same tenant as their source, and database
triggers reject contradictory task/Bot/run provenance or changes to a bound
workspace. Existing task UUIDs, required numbers and delivery receipts are kept.

Ordinary list, detail, search and Factory reads use the effective workspace.
Push notifications use persisted ownership and active membership when sent.
Switching a workspace does not change ownership. An aggregate view needs its own
explicit authorization contract; it must not become the default list fallback.

Linear synchronization has its own explicit policy and workspace-bound provider
configuration. A shared workspace is not an instruction to export every task to
Linear, and a personal workspace is not a reason to lose an existing verified
provider receipt.

## Historical migration

The migration adds nullable tenant columns because historical records can lack
reliable provenance. `ownershipState = pending` is quarantine, not an alternate
personal workspace. Content reads exclude pending tasks, including reads by the
original creator.

After both application and workspace database schemas are ready, the existing
migration runner executes `scripts/task-workspace-backfill.mjs`. It accepts only
consistent, persisted Team/project/Bot/thread/execution evidence referring to an
existing workspace. A deleted workspace, a malformed relation or conflicting
sources cannot be redirected to the creator's personal workspace. The old
`scope` and task text are not ownership evidence.

The backfill is bounded in batches, resumes after a partial deployment and never
moves an already-bound record. It preserves task content, UUIDs, numbers, source
links, publication generations and receipts. It does not enqueue Linear work or
perform provider writes. Runs, artifacts and Factory rows are reconciled from
verified parent/source ownership; an unresolved parent stays unresolved.

Unresolved tasks are recorded in `issue_workspace_repairs`, with one fixed
reason (`missing_evidence`, `conflicting_evidence`, or `missing_workspace`) and
source identifiers only. No task bodies or credentials go into that report.
Operators must resolve the evidence before ownership is assigned. There is no
automatic creator/scope fallback.

Discovery takes no application row locks. Each batch locks candidate workspaces
in a stable order before relation/source locks and application rows, then rereads
the evidence. If a source changes during discovery, the task stays pending and
is reported immediately; a later pass can bind it from fresh evidence. This
order also permits a normal workspace deletion to finish without a cross-database
lock cycle. Already-bound or deleted rows are excluded again after locking.

Legacy Linear team settings without a workspace binding also require an explicit,
authorized workspace selection before synchronization resumes. Existing provider
receipts are retained; their owner or old scope does not choose that binding.

## Old state to target state

| Existing state | Result |
| --- | --- |
| Valid Team/project/source evidence agrees on one existing workspace | Bind that workspace; keep the task identity and receipts |
| Shared task without a Team, with a verified Bot/thread source | Bind that workspace; Team remains optional |
| `scope = personal`, creator only, no durable source | Pending ownership; do not infer a personal tenant |
| Sources disagree, including an existing and a deleted workspace | Pending ownership with conflicting evidence |
| Only a deleted workspace is evidenced | Pending ownership with missing workspace |
| Bound task loses its Team, source Bot or a member | Keep its workspace; reevaluate access, never transfer ownership |
| Active member becomes suspended | Subsequent content access is denied; a pinned write commits before the membership change |
| Legacy verified Linear publication | Keep its receipt and explicit sync policy; do not derive tenancy from the old scope |

## Request and delivery boundaries

The optional `x-mikka-workspace-id` header selects the effective workspace of an
authenticated request. It is not a credential. An explicit malformed, inactive
or conflicting selection is refused; it does not fall back to another
workspace. Scoped PAT/OAuth/run credentials retain their server-verified pin.
The response confirms the accepted workspace so clients can discard responses
from a previous workspace or account generation.

For mobile task details, a session request without that explicit header uses the
task's persisted, bound workspace as its effective workspace. The Personal
default and a saved workspace cookie remain selection preferences, not credential
pins. The full authenticated reader first locates an ACL-visible candidate; the
handler then locks membership in that task's workspace and rereads the task and
all decorations there. A lock wait must not preserve access after membership is
revoked. An explicit header still constrains the requested detail, and actual
PAT/OAuth/Enterprise restrictions remain intact. Lists keep their selected
workspace filter. This preserves existing native task links without depending
on a later client header rollout.

Every human Factory adapter preserves the full verified user, including native
session provenance. Workspace/member admission precedes the application
transaction, and the selected workspace remains fixed through the handler.
Profile commit checks borrow that exact active membership lease, rather than
checking out another workspace connection. The collection single-flight key
includes the verified workspace, and question collections apply their workspace
predicate before the result cap.

A phone push registration stores its server-verified native session in
`mobile_push_tokens.sessionId`. The request body cannot supply that session.
A send rechecks the persisted Bot's owner, workspace and archived state, current
membership, the receiving session's owner and expiry, and the token's unchanged
session binding. Membership/session/token locks protect the accepted delivery.
The paid plan never determines whether these isolation checks apply.

The additive `20261109035002_phone_push_session.sql` migration leaves historical
session bindings NULL. Those destinations remain inactive until the existing
native registration endpoint binds them; no user-wide session guess is allowed.
A cold application launch or signing out and back in re-registers through the
current client. Its in-memory account/token cache can skip registration on a
simple foreground transition, so the separate client handoff must ensure that
a newly verified session is actually registered on the server. No session ID
or credential needs to be displayed, logged or supplied by the UI.

Provider acceptance and local delivery receipts retain their existing meaning.
If a send partially succeeds, accepted receipts commit before the provider
failure is reported; an authorization or SQL failure still rolls back.
Neither Workspace governance nor Team plans create a second Cloud billing
ledger or bypass the existing metering of explicit Cloud services.

## Rollout and recovery

Deployment applies tracked schema migrations through the normal release path.
The application may temporarily hide historical tasks whose ownership cannot be
proved. This is an intentional migration risk and must be visible in release
notes and the pending-ownership workflow. Do not repair it by widening reads.

A failed batch rolls back its application transaction; a completed batch can be
replayed. Membership/source locks are held until the application write commits,
including deployments with separate databases. Monitor migration counts and
release health before acceptance. A rollback must retain the tenant schema and
quarantine behavior; returning to creator/scope authorization would reopen the
isolation defect. Use a corrective forward release for application defects.

The backend P0 is accepted with PostgreSQL regression covering two tenants,
nonmembers, scoped credentials, ambiguous migration, immutable provenance and
membership races. Production acceptance uses the shared test account in Acme
Inc. only. PR #1615 remains the owner of the Factory PAT and MCP sharing fixes;
this work consumes that release and reruns its regression.

## Frontend handoff

Claude owns UI implementation. The PR must describe current-workspace task
creation/list/search behavior, the effective workspace on mobile task details,
optional Team grouping, explicit Linear controls and a metadata-only pending
ownership workflow. Do not expose unresolved task bodies through a fallback view.
Later Team and Enterprise PRs provide their own entitlement and administration
interfaces and acceptance criteria. No production Stripe price or charge changes
are part of these releases.
