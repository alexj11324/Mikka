# Work-domain API contract (#1687)

This is the backend integration contract for the existing #1659 UI owner.
It describes supported server behavior; interface screenshots and release
acceptance are separate evidence. The [domain ADR](decisions/2026-11-07-2300-work-domain-model.md)
defines ownership. Calls use the existing authenticated server-action/desktop
RPC transport, current Workspace selection and bearer-token scope.

## Workspace and authorization

All objects have one verified Workspace. A missing Team is **Ungrouped /
未分组** inside that Workspace. **All tasks / 所有任务** includes grouped and
ungrouped Tasks. Personal Workspace has no Team creation or grouping action.
Client headers select a context; they are never proof of membership. A PAT
pinned to one Workspace cannot select another through an input ID or cookie.

| Operation | Authority |
| --- | --- |
| Read Project, its Task links and resource configuration | Current active same-Workspace member; personal Workspace owner only |
| Create/update Project and its people/Task/Team links | Same active Workspace authority, plus optimistic revision |
| Change Workspace repository policy, Environment or Project resource bindings | Active Workspace admin |
| Team lifecycle | Current Team management authority in its Shared Workspace |
| Execute a Run | Current actor/device/GitHub/credential authority, Workspace policy and Project constraints together |

Project membership and lead are responsibility fields, not an extra private
ACL. Configuration responses expose secret reference IDs, never decrypted
secret values. Cross-tenant IDs do not reveal another tenant's contents.

## Project v2

The `projects` action group keeps `listProjects`, `saveProject`,
`updateProjectProperties`, `moveIssueToProject`, `setProjectIssues` and
`listProjectEvents`. `listProjects()` retains its zero-argument fetcher
contract and resolves only through the server's trusted current context,
never the creator. Existing SWR callers may continue to pass it directly as
their fetcher; their cache key is not a Workspace argument. Clients that
need an explicit tenant use `listWorkspaceProjects(workspaceId)` instead.
Other actions support the explicit `workspaceId` inputs shown below.

Project responses add `workspaceId`, `createdBy`, `leadUserId` and `memberIds`.
The canonical Task relation is returned through the existing `issueIds`
projection. Task responses carry `projectId` and the current display name.
`lead` and `properties.members` remain boundary compatibility projections;
new clients send actual user IDs. The input alias `me` resolves to the
authenticated actor and is validated as a current member. Free-text `team`
does not attach a Team or determine ownership.

| Action | Key inputs | Result / concurrency |
| --- | --- | --- |
| `listProjects` | No arguments | Reads the trusted current Workspace; existing zero-argument SWR contract |
| `listWorkspaceProjects` | Workspace UUID | Reads that exact Workspace after current membership / PAT scope checks |
| `saveProject` | `workspaceId`, normal Project fields, `leadUserId: string|null`, `memberIds: string[]` | New Project UUID; revision starts at 1 |
| `updateProjectProperties` | `id`, `workspaceId`, `revision`, `changes` | Stale revision refuses the write |
| `moveIssueToProject` | `issueId`, Task `revision`, `projectId: UUID|null`, `workspaceId` | Moves one canonical relation; Task and affected Project revisions advance |
| `setProjectIssues` | Project `id`, `revision`, `issueIds: UUID[]`, `workspaceId` | Replaces same-tenant canonical links; a Task already in another Project requires explicit move |
| `team-relations.setProjectTeams` | Project ID, revision, same-Workspace Team IDs, optional primary Team | 0..N Teams; primary must be one of the selected Teams |

Stored Project membership has no 100-Task JSON-array cap. Project Map retains
its explicit node/rendering budget and returns the established too-large
result instead of truncating the relation or silently hiding data.

A Team attached to a Project does not constrain the Team of each Task: a
Task may be ungrouped or in another active Team of the same Workspace.
Names are display values. Renaming a Project cannot detach Tasks or reconnect
a same-named Project. Member departure/suspension clears current lead/member
projections while preserving historical event authors.

### Project lifecycle

The `projects` group also exposes `getProjectLifecycleImpact({id,workspaceId?})`,
`archiveProject` / `restoreProject` with `{id,revision?,workspaceId?}`, and
`deleteProject({id,revision,confirmation,workspaceId?})`. The impact result
includes exact Task, Team, member, repository/environment, dependency,
milestone, event, decision and frozen execution-reference counts plus
`canDelete` and `recovery: 'restore_archive'`.

Archiving preserves the UUID, delivery status, Task links and history. Reads
remain authorized by the same Workspace; new writes, bindings, decisions,
Run admission and claim are refused until restore. Tasks may be explicitly
moved out of an archived Project. Restore advances revision and records an
event. `projectArchived` is distinct from `projectNotFound`.

Hard deletion is an admin operation, requires matching revision and typed
name, and refuses any relationship or historical reference with
`projectDeleteNotEmpty`. A normal Project already has its creation event,
so archive is the normal retirement path. Only truly unused legacy/imported
rows can satisfy the strict deletion predicate. The deletion audit remains
at Workspace scope. The UI must not relabel hard delete as archive or hide
its real impact behind a generic confirmation.

## Human responsibility and Agent delegation

Task metadata has two independent nullable fields:

```ts
assignee: { kind: 'member'; id: string; name: string; image: string | null } | null
delegate: { kind: 'agent' | 'bot' | 'profile'; id: string; name: string; image: string | null } | null
```

The input/read schema temporarily accepts legacy `assignee.kind='agent'`.
That value projects and migrates to `delegate`; it never becomes a human
assignee. The legacy MCP `assigneeAgentId` adapter changes only delegation;
clearing it does not clear a separately selected person. Modern metadata
patches can change either field independently.

Detail/list/poll resolve a human assignee against active membership in the
Task's exact Workspace. Departed/suspended people do not remain active
assignees through stale JSON. The poll signature includes membership and
Project relation changes so an unchanged Task timestamp cannot conceal a
revocation. "Assigned to me" uses human responsibility or the existing
explicit follow relation, never an Agent owned by that person. Reviewer and
approver permissions continue to come from the Factory approval contract.

Clients should render delegation from `metadata.delegate`, not the legacy
Agent-assignee union. Existing Runs retain their admitted Agent/Profile and
credential references when the current Task delegation changes.

## Repository and Environment actions

| RPC action | Input / output |
| --- | --- |
| `project-resources.listProjectResources` | Workspace ID and optional Project ID; returns policy, environments, repository bindings and environment bindings |
| `project-resources.saveWorkspaceRepositoryPolicy` | `{workspaceId, revision, mode:'inherit'|'restricted', repositoryKeys}` → new revision |
| `project-resources.saveEnvironment` | `{workspaceId, id?, revision?, name, configuration, archived?}` → saved Environment identity and revision |
| `project-resources.saveProjectResources` | `{workspaceId, projectId, revision, repositories, environmentIds, defaultEnvironmentId}` → new Project revision |

Repository keys use the existing `v2/host/owner/repo` identity. A repository
binding contains `repositoryKey`, optional `baseBranch`, optional
`environmentId`, and `isPrimary`. At most one primary repository/default
environment is allowed. A selected per-repository environment must also be
bound to that Project. Composite database keys reject cross-Workspace links.

No Workspace policy row, or `inherit`, preserves existing authorization.
`restricted` intersects its allow-list with that authority; an empty list
denies repository work but does not ban a non-repository Task. A Project
without repository bindings inherits the same authorized selection flow.
A binding does not install a GitHub App, grant a repository, or create a key.

Environment configuration supports `runtime: any|local|cloud`, the existing
official execution `harness: any|claude_code|codex|cursor`, a controlled
`setup` recipe, non-reserved `variables`, existing Workspace `secretIds`, and
optional repository checkout constraints. The selected official harness and
existing runtime provider determine the actual image/template; the API does
not accept arbitrary Docker images or provisioning instructions. It creates
configuration, not a running machine or an additional credential store.

Run admission freezes versioned Project selection, Workspace policy revision,
repository key, actual target branch and Environment configuration. Actual
checkout commit and publication receipts remain in the existing execution
and publication records. Secret **values** are resolved at claim, never
copied into the snapshot or audit event. Approved setup executes on the
selected fresh worktree through the existing tool policy. A continuation
retains its original checkout and does not rerun bootstrap blindly.

Claim rechecks current membership, Workspace repository policy, Project
binding and exact frozen Environment identity/revision under the resource
lease. Revocation, archival or a changed target refuses execution without
rewriting history. Older daemons must advertise `x-mikka-project-environment: 1`
to execute a Run with a configured Environment. Old Runs with no Environment
snapshot keep their original behavior only while still permitted; they do
not silently acquire a new setup recipe.

Selected Environments use the same Task Secret delivery boundary as ordinary
Tasks ([Secret delivery](../security/task-secret-delivery.md)). Workspace and
repository values are limited to the selected `secretIds` and their current
Workspace/repository scope. Environment variables are applied first, followed
by the selected values and the existing personal-owner override order; an
Environment variable cannot downgrade a selected protected Secret. Only ordinary
`kind=env` and explicitly approved `direct` values enter `taskEnv`. `protected`
values use the existing sealed capability and trusted local SDK bridge. A
protected entry without a supported HTTP delivery policy is reported as
`unavailable`; it never falls back to plaintext delivery.

The daemon's `x-mikka-task-secrets: 1` capability is independent of
`x-mikka-project-environment: 1`. A selected Environment containing protected
or unavailable Secrets still requires Task Secret support; the Environment
header alone cannot opt into direct delivery. GitHub and the selected CLI
model/subscription credentials retain their existing native delivery.

The final claim response rechecks the effective Secret metadata/revisions and
the selected Environment variables/reference IDs, in addition to the resource
lease's current Environment identity/revision check. A removed reference,
changed selection or revoked authority refuses the response. Heartbeat renewal
and Secret invalidation retain the admitted selection/effective-name precedence.
Output masking uses its canonical Workspace/owner and retains the existing
broader redaction set; masking never grants access. Secret values and capabilities
remain outside persisted Project/Run configuration snapshots.

| Error code | Client behavior |
| --- | --- |
| `workspaceAccessDenied` | Clear inaccessible current-Workspace content; choose an authorized context |
| `projectNotFound` / `issueNotFound` | Treat the object as unavailable in this context |
| `projectResourceConflict` / `projectSaveConflict` / `issueOutdated` | Reload current revision before another explicit edit |
| `projectRepositoryDenied` | Choose a currently permitted repository/branch; a binding alone cannot fix GitHub authorization |
| `projectEnvironmentUnavailable` | Choose an active compatible Environment or update the daemon when required |
| `daemonUpgradeRequired` | Update the daemon to support protected Task Secrets; Environment support alone is insufficient |
| `task_secret_unavailable` | Refresh the current Secret configuration or selected references; never retry with plaintext fallback |
| `teamArchived` | Keep history readable; restore or choose another active Team for a new link |
| `teamPersonalWorkspace` | Personal Workspaces cannot create Teams |
| `teamDeleteReferenced` | Use archive/remove grouping or resolve the displayed references |

Both English and Chinese server error messages are registered. Do not map
all refusals to a generic network error or retry writes without a revision.

## One Task state projection

`task-domain.getTaskPresentation(issueId)` retains its detail signature and
returns the same projection as the batch reader:

```ts
{
  version: 1,
  state,         // shared taskStateOf(): one display state
  reason,        // fixed reason code or null, never provider prose
  blockedBy,     // readable dependency's issued identifier, otherwise null
  group,         // derived from state only
  primaryStatus, // existing Task business status
  factoryStage,  // current authorized Factory view or null
  runStatus,     // authorized current Run status or null
  needsAction,
  blockedReason,
  completion    // 'merged' | 'accepted' | null
}
```

`state` is `waiting | blocked | failed | running | queued | todo | done |
canceled | duplicate`. `reason` is `needs_input | approval | pr_review |
blocked | quota | offline | blocked_by | flagged | null`. The shared
`lib/task-state.ts::taskStateOf()` introduced by #1696 owns this classification;
the canonical reader supplies the current authorized Factory context to the
same function. No client should reconstruct another display state from
`primaryStatus`, `runStatus`, or the presence of `needsAction`.

| Shared state | Group | Meaning |
| --- | --- | --- |
| `waiting` | `pending` | A reply, approval or review is needed; only this state raises the hand count. |
| `blocked`, `failed` | `pending` | Execution is unavailable or failed; neither state raises a hand. |
| `running`, `queued` | `running` | An active attempt or a pending scheduled execution. |
| `todo` | `todo` | An open Task without a more specific current execution state. |
| `done`, `canceled`, `duplicate` | `done` | The Task's own business status closes it. |

Dependency and manual-flag reasons retain the Task's own display state/group.
`blocked_by` does not grant access to the dependency: its issued identifier is
returned only when the same reader can read that dependency in this Workspace.
An unknown or inaccessible dependency stays unresolved with `blockedBy: null`.

Run facts include the real pause reason, current unexpired approvals, bounded
failure codes, replacement and device presence, plus the actor's explicitly
linked schedule. A human-control pause is `waiting/approval`, not quota.
Current Factory `question`, `spec_review`, `pr_review`, `blocked` and `failed`
attention supplies the same classification before an old Run reason. Closed
Tasks take precedence over both. A successful Run, a historical merged PR or
a Factory receipt does not rewrite Task business status. Current candidate
receipts remain independently available as `completion: merged | accepted`.

The existing `needsAction` and `blockedReason` fields retain their names and
value sets. They are compatibility labels from this same classification,
including dependency/flag annotations and explicit clearing of a board block.
Generic approval has no old `needsAction` value and therefore leaves it null;
Factory spec review retains `spec_review`. Clients use `state/reason` to choose
the main icon and attention count. A stale Run quota label cannot coexist with
a current Factory request for a reply or approval.

Lists use one `task-domain.getTaskPresentations({ workspaceId, issueIds })`
read for up to 200 requested Task UUIDs:

```ts
{
  version: 1,
  workspaceId,
  items: { [issueId]: TaskPresentation }
}
```

iOS uses its existing Cookie-authenticated mobile transport:

```ts
api('/api/mobile/task-presentations', {
  method: 'POST',
  body: { workspaceId, issueIds },
})
```

This read-only endpoint returns the same DTO, accepts at most 16 KiB of JSON,
and keeps the original authenticated principal when invoking the batch action.
It requires neither a desktop Bearer token nor browser RPC headers. Native
requests with no Origin follow the existing mobile origin policy. Responses
are `private, no-store`; errors are `401 authRequired`, `400 invalidRequest`,
`403 workspaceAccessDenied`, `403 originNotAllowed`, or `413 bodyTooLarge`.
The existing mobile list/detail fields remain compatible; the UI owner consumes
this projection in the current list/live lifecycle without rewriting stored
Task status or adding another timer.

The legacy `GET /api/mobile/tasks` and `GET /api/mobile/tasks/:id` reuse the
shared state mapper with their existing Run/schedule facts. They do not read
the current Factory context, so their compatibility state is not guaranteed
to equal the canonical presentation for a Factory-managed Task. The #1714
Web/Desktop/iOS integration must consume this bounded batch once per existing
list/live update to display current Factory handoffs consistently. Supplying
the backend contract does not complete that UI integration.

The server validates the Workspace against the authenticated principal and
current membership, including an empty batch. Duplicate IDs are read once.
Missing, deleted, inaccessible and other-Workspace Tasks are all omitted from
`items`; callers must not infer which case caused an omission. A readable
Shared Task exposes only the current reader's authorized Run and Factory
state. Sharing a Task does not share another member's private execution.

Task metadata, dependency status, the newest same-actor Run and Factory evidence
are read in batches. If the newest Factory row has an unavailable source, its
Factory fields are null; the batch never falls back to an older Factory. The
existing detail call retains its canonical Factory refusal behavior. The
reader reuses the existing public Factory state
projection, with the application data read in one consistent snapshot. It
does not query a full detail or report for each row. APP and Workspace database
connections remain independent.

The UI owner should attach this one batch read to the existing list and live
update lifecycle. Reuse current Task, Run and Factory invalidation; do not add
per-row detail requests, timers or another status writer. Keep the current
list/mobile response fields compatible while moving their state consumers to
this contract. A batch response is useful only with its returned Workspace;
clear it when the active Workspace changes or access is revoked.

`Blocked` remains derived from dependencies, explicit flags, run outcome or
Factory state. A Run succeeding does not set the Task to done. Coding work
keeps the existing approved PR-merge completion rule; explicit non-PR
acceptance uses the existing Factory `accepted` receipt. This projection
does not introduce another status writer or broaden approval authority.

## Client acceptance ownership

The #1659 owner implements Web/Desktop/iOS surfaces using these contracts:
current Workspace, optional Team, real lead/member identities, separate
assignee/delegate, resource selection and explanatory unavailable states.
Required screenshots cover current local production build, Chinese/English,
light/dark, narrow layout, loading/empty/error and keyboard operation.
Backend CI alone does not prove these interface states. The final PR/Issue
must record both exact backend SHA and the UI owner's tested SHA/evidence.
