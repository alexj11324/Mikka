import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { z } from 'zod'
import { gitPushRestriction } from '@mikka/protocol/agent-policy'

/** Immutable evidence of one accepted task's repository authority. */
const receipt = z.object({
  userId: z.string().min(1), issueId: z.uuid(), deviceId: z.uuid(), agentId: z.uuid(), remoteKey: z.string().min(1),
  remoteUrl: z.string().min(1), permission: z.literal('push_to_origin'),
  targetBranch: z.string().regex(/^mikka\/[a-z0-9-]+-[1-9][0-9]*$/),
  workspaceId: z.uuid().optional(),
  workspaceLinked: z.boolean().optional(),
  requestEventId: z.uuid().optional(),
  approvedAt: z.iso.datetime().optional(), acceptedAt: z.iso.datetime(),
  // `github_app`: the App's installation granted contents:write and the person
  // may write (decision 2026-11-01-1215); `approvedAt` is when that was checked.
  // `repository_approval` receipts came from the earlier per-repository approval.
  // `configured_allow` parses only so old rows stay readable. Such a receipt
  // never carried a repository approval and grants nothing (see matches below).
  authority: z.enum(['github_app', 'repository_approval', 'configured_allow']).optional(),
}).strict()
export type RepositoryAdmission = z.infer<typeof receipt>

/**
 * Whether policy lets a task push at all. The repository authority itself is
 * the GitHub App grant (lib/github/push-grant.ts); this only reads the `git_push`
 * restriction a workspace policy or a read-only mode sets. `deny` on either
 * layer denies; anything else does not ask the person again.
 */
export function effectiveRepositoryPush(permissions: unknown, workspacePermissions?: unknown): 'allow' | 'deny' {
  return gitPushRestriction(workspacePermissions) === 'deny' || gitPushRestriction(permissions) === 'deny' ? 'deny' : 'allow'
}

/** Call only in the admission transaction, with the recorded GitHub App grant. */
export function admitRepositoryTask(input: {
  userId: string; issueId: string; deviceId: string; agentId: string; remoteKey: string; remoteUrl: string
  targetBranch: string; grant: { grantedAt: string } | null; permissions?: unknown; workspacePermissions?: unknown; workspaceId?: string; workspaceLinked?: boolean; requestEventId?: string; now: Date
}): RepositoryAdmission | null {
  if (!input.grant || effectiveRepositoryPush(input.permissions, input.workspacePermissions) !== 'allow') return null
  const candidate = receipt.safeParse({
    userId: input.userId, issueId: input.issueId, deviceId: input.deviceId, agentId: input.agentId, remoteKey: input.remoteKey,
    remoteUrl: input.remoteUrl, targetBranch: input.targetBranch, permission: 'push_to_origin',
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceLinked !== undefined ? { workspaceLinked: input.workspaceLinked } : {}),
    ...(input.requestEventId ? { requestEventId: input.requestEventId } : {}),
    approvedAt: input.grant.grantedAt, authority: 'github_app', acceptedAt: input.now.toISOString(),
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
