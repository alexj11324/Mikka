import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { z } from 'zod'
import { repositoryPushApproved, type RepositoryPushApproval } from './run-publication-policy'
import { resolveAgentSettings } from '@mikka/protocol/agent-policy'

/** Immutable evidence of one accepted task's repository authority. */
const receipt = z.object({
  userId: z.string().min(1), issueId: z.uuid(), deviceId: z.uuid(), agentId: z.uuid(), remoteKey: z.string().min(1),
  remoteUrl: z.string().min(1), permission: z.literal('push_to_origin'),
  targetBranch: z.string().regex(/^mikka\/[a-z0-9-]+-[1-9][0-9]*$/),
  workspaceId: z.uuid().optional(),
  workspaceLinked: z.boolean().optional(),
  requestEventId: z.uuid().optional(),
  approvedAt: z.iso.datetime().optional(), acceptedAt: z.iso.datetime(),
  // `configured_allow` parses only so old rows stay readable. Such a receipt
  // never carried a repository approval and grants nothing (see matches below).
  authority: z.enum(['repository_approval', 'configured_allow']).optional(),
}).strict()
export type RepositoryAdmission = z.infer<typeof receipt>

/**
 * Whether a task may be admitted to push this repository. Two gates, both
 * required: the owner's per-repository push approval (which repositories)
 * and the `git_push` action permission (whether a person confirms the push).
 * `git_push: allow` only drops that confirmation; it never stands in for the
 * repository approval. Returns `allow` (admit), `ask` (the repository still
 * needs the owner's approval) or `deny`. Resolves only persisted server
 * settings and a human receipt; malformed settings inherit ask.
 */
export function effectiveRepositoryPush(permissions: unknown, push: RepositoryPushApproval | null | undefined, userId: string, workspacePermissions?: unknown): 'allow' | 'ask' | 'deny' {
  const workspace = resolveAgentSettings({ permissions: workspacePermissions }).policy.permissions.git_push
  const configured = permissions !== null && typeof permissions === 'object' && Object.hasOwn(permissions, 'git_push')
  const decision = configured ? resolveAgentSettings({ permissions }).policy.permissions.git_push : workspace
  if (workspace === 'deny') return 'deny'
  if (decision === 'deny' || push?.approved === false) return 'deny'
  return repositoryPushApproved(push, userId) ? 'allow' : 'ask'
}

/** Call only under the repository-approval lock, in the admission transaction. */
export function admitRepositoryTask(input: {
  userId: string; issueId: string; deviceId: string; agentId: string; remoteKey: string; remoteUrl: string
  targetBranch: string; push: RepositoryPushApproval | null | undefined; permissions?: unknown; workspacePermissions?: unknown; workspaceId?: string; workspaceLinked?: boolean; requestEventId?: string; now: Date
}): RepositoryAdmission | null {
  const decision = effectiveRepositoryPush(input.permissions, input.push, input.userId, input.workspacePermissions)
  if (decision !== 'allow') return null
  if (!repositoryPushApproved(input.push, input.userId)) return null
  const candidate = receipt.safeParse({
    userId: input.userId, issueId: input.issueId, deviceId: input.deviceId, agentId: input.agentId, remoteKey: input.remoteKey,
    remoteUrl: input.remoteUrl, targetBranch: input.targetBranch, permission: 'push_to_origin',
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceLinked !== undefined ? { workspaceLinked: input.workspaceLinked } : {}),
    ...(input.requestEventId ? { requestEventId: input.requestEventId } : {}),
    approvedAt: input.push!.approvedAt, authority: 'repository_approval', acceptedAt: input.now.toISOString(),
  })
  if (!candidate.success || !repositoryBindingMatches(candidate.data.remoteKey, candidate.data.remoteUrl, { allowFile: true })) return null
  return candidate.data
}

/**
 * A retry may retain only the original owner, issue and repository authority.
 * Only a receipt that recorded the owner's repository approval matches; an
 * old `configured_allow` receipt (no approval) is treated as not admitted.
 */
export function matchesRepositoryAdmission(value: unknown, scope: {
  userId: string; issueId: string; deviceId: string; agentId: string; remoteKey: string; remoteUrl: string; targetBranch: string
  workspaceId?: string; workspaceLinked?: boolean; requestEventId?: string
}): value is RepositoryAdmission {
  const parsed = receipt.safeParse(value)
  return parsed.success && parsed.data.authority !== 'configured_allow' && Boolean(parsed.data.approvedAt) && parsed.data.userId === scope.userId && parsed.data.issueId === scope.issueId && parsed.data.deviceId === scope.deviceId && parsed.data.agentId === scope.agentId
    && parsed.data.workspaceId === scope.workspaceId && parsed.data.workspaceLinked === scope.workspaceLinked && parsed.data.requestEventId === scope.requestEventId
    && parsed.data.remoteKey === scope.remoteKey && parsed.data.targetBranch === scope.targetBranch
    && repositoryBindingMatches(scope.remoteKey, scope.remoteUrl, { allowFile: true })
    && repositoryBindingMatches(scope.remoteKey, parsed.data.remoteUrl, { allowFile: true })
}
