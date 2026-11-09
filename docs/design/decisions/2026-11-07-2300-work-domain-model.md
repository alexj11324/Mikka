# Workspace owns work; teams, projects, responsibility and execution are independent

- Date: 2026-11-07
- Source: Alex, [#1687](https://github.com/alexj11324/Mikka/issues/1687), and the implementation instruction to complete end-to-end verification and merge.
- Rule: T1–T6 in [0231](2026-11-02-0231-workspace-is-the-tenant.md).
- Replaces: account/Team-Link-derived Project ownership, project names as task relationships, and the glossary clause that a shared task belongs to its Team. The existing Factory completion and frozen-run contracts remain authoritative.

## Ownership and authorization

A Workspace is the only tenant. Its storage kind remains `personal | team`
for compatibility; the product names are personal workspace / 个人工作区 and
shared workspace / 共享工作区. A Team is an optional group **inside** a shared
workspace. An ungrouped shared task stays shared when its creator leaves or
deletes an account. Neither a Team link, a Project link, account ownership,
an organization role nor a billing plan grants access to a different tenant.

Tasks use the verified `issues.workspaceId` introduced by #1608/#1636.
This change does not run a competing task ownership migration. Ambiguous
historical tasks remain quarantined by that migration and are not used as
positive evidence for Project ownership.

Projects become first-class Workspace resources. `workspaceId` is immutable
once verified. `userId` remains the historical creator field so existing
events, maps and external references retain their original identity; it is
not an authorization fallback. New Project writes require an explicit,
server-verified current workspace. A bearer token's pinned workspace cannot
be widened by a cookie, header, object ID or project creator.

The current shared-workspace policy is visible-to-active-workspace-members.
Teams and Project members organize responsibility; they do not introduce
private ACLs. Personal workspaces admit only their owner and reject Team
creation. Private teams would require a separate explicit policy and are
outside this change.

## Project relationships

Projects have nullable `leadUserId`, real Project member user IDs, optional
archive time and a revision. A lead/member must be an active member of the
same workspace at admission. A departed member does not retain an access
grant through their old Project membership; reads still check active
Workspace membership. IDs in historical events are not reassigned to a
different person.

`workspace_project_tasks` is the sole authoritative Project-to-Task relation.
A task belongs to at most one project; the relation includes its verified
workspace. An unlinked task is legal. Relation writes check both endpoints,
use the existing relation lock and optimistic revision, and never match
project names. A project can contain more than 100 tasks. Request-size and
map-rendering limits are transport bounds, not limits on stored membership.

Existing `issueIds` response fields are computed projections of this
relation. Stored JSON arrays and `metadata.project` are migration input or
display history only, never a second write path or ACL source. Changing a
project name cannot detach tasks, associate a same-named project, or move
Project Map facts. Existing Project UUIDs, dependency IDs, milestones,
versions, events and decision sources stay intact.

The existing `mikka_team_projects` table is reused for 0..N Project Teams,
including an optional primary Team. Every Team must be in the Project's
workspace. Task grouping is independent: a task in a multi-Team Project
may be ungrouped or grouped into any active Team in that same workspace.
Changing those groups never changes the tenant.

## Migration and uncertainty

Run schema and data changes through the ordinary migration runner on the
actual application and Workspace databases. They can be separate databases;
no cross-database join or fictional foreign key is assumed.

Historical Project workspace evidence must agree. An explicit Project workspace,
valid Team relations and already verified task ownership are the backfill's
structural evidence. Project decisions are preserved history; this backfill
does not use them to establish tenancy. A creator ID or a workspace/project name alone is not
enough. Missing, invalid or conflicting evidence creates a restricted
repair record containing IDs and fixed reasons, not task bodies or secrets.
An unknown project stays excluded from ordinary reads until its ownership
is established through the authorized repair flow.

The backfill preserves original UUIDs and history, locks evidence before
writing, and is safe to rerun. A task appearing in two legacy Project arrays
is not assigned arbitrarily. `lead: 'me'` and `members: ['me']` refer to the
historical creator only when that person has verified active membership in
the established workspace; they never mean the user running the migration.

After a canonical migration receipt is committed, a database fence rejects
changes to the retired task array or historical creator. Legacy lead/member
snapshots can change only in the new API's authorized transaction together
with canonical responsibility writes. Its transaction-local writer marker is
a version handshake, not an authorization mechanism. New Projects require an
explicit Workspace and an empty retired task array; existing quarantined
Projects remain available to the evidence-based backfill. During a rolling
deployment, old writers can fail closed until the new service is ready. A
successful legacy-only write must never conceal a lost relationship.

Rollback retains the new ownership and relationship records. Fix forward
instead of reverting to creator/Team/name-based authorization. Pending
records and their reason counts must be visible in operational evidence;
a successful DDL ledger alone does not establish successful backfill.

## Responsibility, execution and published identity

A human assignee is the nullable business owner of the task. An Agent
Delegate is its selected execution configuration. The reviewer/approver is
a separate Factory authority. Delegating to an Agent never grants that
Agent a person's approve/merge capability or changes the human assignee.
An existing Run retains the Agent/Profile, model, repository, environment
and credential references actually admitted for that run.

Task UUIDs never change. Existing task numbers remain compatible with
#1503, including team-scoped presentation and pinned publication branches.
History/aliases preserve numbers previously issued before a Team move or
prefix change. A published `mikka/<identifier>` branch is never republished
under a newly displayed number. See the separate stable-identity ADR for
the implementation and ambiguous-alias behavior.

## Repositories and environments

A Project may have zero, one or many approved repositories and reusable
environment configurations. A repository binding is a restriction, not a
GitHub authorization grant. Admission uses the intersection of the actor's
current GitHub authority, Workspace policy and Project bindings when that
Project has repository bindings. Unbound Projects and tasks retain the
existing explicitly authorized repository-selection flow.

An Environment describes runtime/template, setup commands, machine
requirements and existing secret references. It is not a tenant, a running
VM, or a new credential vault. Each Run freezes the actual selected
configuration; later edits and revocation affect future admissions without
rewriting prior receipts. A model-suggested repository switch passes the
same checks before creating a new run, and retains the old checkout and
publication history.

## Status and clients

Task business status, Factory stage, runtime status and derived
`needsAction`/`blockedReason` are separate fields. The server produces one
primary work-state projection. Blocked remains a derived condition under
[1600](2026-11-06-1600-blocked-board-column.md), never a new Task status.
For coding Factory work, done still requires the approved PR merge under
[2200](2026-11-04-2200-factory-flow-like-warp.md). General artifact tasks
retain their explicit business acceptance; a successful process exit alone
does not manufacture a merged PR or human acceptance.

Clients use: shared workspace / 共享工作区, Team / 团队, ungrouped / 未分组,
all tasks / 所有任务. Personal workspaces have no Team selector. Backend
contracts are delivered by #1687; visual implementation and screenshots
remain with the existing Claude owner in #1659. An API implementation is
not evidence that the corresponding interface has been accepted.

## Required evidence

Verify isolated PostgreSQL transactions and API/CLI calls for Personal A,
Shared B/C, two Teams and ungrouped work; stale revisions, concurrent
membership revocation and malicious PAT inputs; rename/regroup without
identity changes; Project 0/N teams and repositories; departing members;
archive/removal and deletion previews; and preserved historical Run/PR
receipts. Never run destructive lifecycle fixtures on production.

The merge requires the latest candidate's source and relevant database CI.
Deployment must run normal migrations and serve the actual merge commit.
Only external services that cannot be proved locally require additional
production acceptance with the existing shared smoke account. The Epic
does not close while any required migration, permission, API/CLI or UI
integration evidence remains missing.
