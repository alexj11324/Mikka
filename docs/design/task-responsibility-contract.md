# Task responsibility and Agent delegation compatibility

This is the backend/client contract for [#1687](https://github.com/alexj11324/Mikka/issues/1687).
It accompanies the [work domain model](decisions/2026-11-07-2300-work-domain-model.md)
and [stable Task identity ADR](decisions/2026-11-07-2301-stable-task-identity.md).

## Fields and current projection

| Field | Meaning | Current read/write contract |
| --- | --- | --- |
| `metadata.assignee` | Human responsible for the work / 人类负责人 | `null` or `{ kind: 'member', id, name, image }`; the person must be an active member of the Task's exact Workspace. |
| `metadata.delegate` | Selected execution reference / Agent Delegate | `null` or `{ kind: 'agent' \| 'bot' \| 'profile', id, name, image }`. It is independent of the human assignee. |
| `subscriberUserIds` | Explicit following / 关注 | Identifies followers. Owning a Bot or Agent is not following and does not make its owner the assignee. |
| Factory reviewer / approver | Verification and human acceptance authority | Existing Factory permissions remain independent of either metadata field. |
| Run execution definition | What actually ran | The admitted Agent/Profile, model, repository, environment and credentials remain frozen for that Run. A metadata edit does not rewrite them. |

The server resolves a human's current name and image. If the membership is
suspended or removed, the Workspace no longer exists, or the Account row is
gone, current detail/list/poll projections return `assignee: null`. Stored task
metadata and historical versions retain the prior assignment for audit. A
corrupt extra membership in a personal workspace cannot make another person its
assignee. “Assigned to me” tests the current human field only; explicit following
has its own predicate.

List and detail versions include the dependencies of these projections. A
membership change, current human profile change, or canonical Project relation
change cannot be acknowledged as an unchanged view while retaining stale data.

## Writes and authorization

A human assignment is admitted under the actor's current Task Workspace lease
and the target person's active membership lease, acquired before the APP task
lock. The leases remain held through the APP commit. Suspension therefore
cannot race a successful assignment. A PAT's pinned Workspace cannot be widened
by an assignee or task reference. The property picker lists active members of
the same Workspace.

The legacy invitation field remains owner-only and requires an existing active
Workspace member; it cannot invite a new tenant member as a side effect of
changing a Task property. Task creation, Workspace invitation and Task
responsibility remain distinct operations.

Delegate references are validated server-side, and their names/images are not
accepted from the request. An Agent reference must belong to the task's recorded
owner. A Bot or mutable Profile must belong to the current actor in the same
Workspace, remain unarchived, and, for a Profile, be enabled. The existing
immutable `default` Agent Profile reference is also accepted. Delegation itself
does not dispatch a Run, grant credentials, alter content access or approve work.
Actual execution continues through ordinary live admission and frozen receipts.

Duplicating another person's Task clears its human assignee and execution
delegate. Copying a reference does not admit a private Agent/Profile for the new
creator. A child that retains the original creator may retain those relations;
normal runtime admission still applies to every new Run.

## Legacy compatibility

| Input/history | Result |
| --- | --- |
| Stored `assignee.kind = 'agent'`, with no separate delegate | Read as `assignee: null` plus the old reference in `delegate`; migration recognizes existing Bot references as `kind: 'bot'`. |
| Legacy Agent assignee with an explicit separate delegate, including `null` | The separate delegate wins; stale legacy assignment cannot resurrect a cleared delegate. |
| Agent-authenticated legacy `patch.assignee = { kind: 'agent', id }` | Updates only `delegate`; preserves an existing human assignee. The existing actor restriction remains. |
| A request contains both a legacy Agent assignee and a modern delegate | Rejected as ambiguous. |
| Modern `patch.assignee = null` | Clears the human assignee only. |
| Modern `patch.delegate = null` | Clears delegation only. |
| MCP `assigneeAgentId` / legacy Agent assignment adapter | Maps to the delegate field, including explicit clearing. |

The shared TypeScript DTO retains the legacy assignee union during the client
rollout so an older client can deserialize historical payloads. That type
compatibility does not change the runtime rule: current server projections emit
only an active human or `null` in the assignee field. Frontends read Delegate
from `metadata.delegate`; they must not infer a human assignee from a Bot's
ownership or from a currently running Agent.

Project names in legacy metadata are display compatibility data. The server
projects `projectId` and `metadata.project` from the canonical Workspace Project
relation. A legacy name patch may echo that relation's current name, but a
different name is rejected; changing the relation uses `moveIssueToProject`.

## Migration and rollback

The APP migration separates current metadata fields without rewriting Task
version history or Run/publication receipts. Readers also understand the old
`orvilo` metadata key. New writes store the canonical `mikka` representation.
Rollback retains the delegate field; an older version that drops unknown
metadata would erase delegation and is not a compatible rollback target.
Factory acceptance still follows its own existing authorization and verification
contract. The delegation migration provides no bypass for those gates.
