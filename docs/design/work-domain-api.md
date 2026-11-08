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
`listProjectEvents`. Explicit `workspaceId` is supported; omission resolves
only through the server's trusted current context, never the creator.

Project responses add `workspaceId`, `createdBy`, `leadUserId` and `memberIds`.
The canonical Task relation is returned through the existing `issueIds`
projection. Task responses carry `projectId` and the current display name.
`lead` and `properties.members` remain boundary compatibility projections;
new clients send actual user IDs. The input alias `me` resolves to the
authenticated actor and is validated as a current member. Free-text `team`
does not attach a Team or determine ownership.

| Action | Key inputs | Result / concurrency |
| --- | --- | --- |
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

| Error code | Client behavior |
| --- | --- |
| `workspaceAccessDenied` | Clear inaccessible current-Workspace content; choose an authorized context |
| `projectNotFound` / `issueNotFound` | Treat the object as unavailable in this context |
| `projectResourceConflict` / `projectSaveConflict` / `issueOutdated` | Reload current revision before another explicit edit |
| `projectRepositoryDenied` | Choose a currently permitted repository/branch; a binding alone cannot fix GitHub authorization |
| `projectEnvironmentUnavailable` | Choose an active compatible Environment or update the daemon when required |
| `teamArchived` | Keep history readable; restore or choose another active Team for a new link |
| `teamPersonalWorkspace` | Personal Workspaces cannot create Teams |
| `teamDeleteReferenced` | Use archive/remove grouping or resolve the displayed references |

Both English and Chinese server error messages are registered. Do not map
all refusals to a generic network error or retry writes without a revision.

## One Task state projection

`task-domain.getTaskPresentation(issueId)` is a detail read, using the
existing authorization and live update paths. It returns:

```ts
{
  version: 1,
  primaryStatus, // existing Task business status
  factoryStage,  // current authorized Factory view or null
  runStatus,     // authorized current Run status or null
  needsAction,
  blockedReason,
  completion    // 'merged' | 'accepted' | null
}
```

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
