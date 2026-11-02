import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { z } from 'zod'

/** Immutable evidence of one accepted task's repository and branch binding. */
const receipt = z.object({
  userId: z.string().min(1), issueId: z.uuid(), deviceId: z.uuid(), agentId: z.uuid(), remoteKey: z.string().min(1),
  remoteUrl: z.string().min(1), permission: z.literal('push_to_origin'),
  targetBranch: z.string().regex(/^mikka\/[a-z0-9-]+-[1-9][0-9]*$/),
  workspaceId: z.uuid().optional(),
  workspaceLinked: z.boolean().optional(),
  requestEventId: z.uuid().optional(),
  approvedAt: z.iso.datetime().optional(), acceptedAt: z.iso.datetime(),
  // `owner_credential`: the run works with its owner's own GitHub credential
  // (decision 2026-11-02-1600); nothing else is approved for it. `github_app`
  // and `repository_approval` receipts came from earlier push grants and stay
  // readable. `configured_allow` parses only so old rows stay readable; such a
  // receipt is not matched (see matches below).
  authority: z.enum(['owner_credential', 'github_app', 'repository_approval', 'configured_allow']).optional(),
}).strict()
export type RepositoryAdmission = z.infer<typeof receipt>

/** Call only in the admission transaction. Pushing needs no grant in Mikka: the run uses its owner's own GitHub credential. */
export function admitRepositoryTask(input: {
  userId: string; issueId: string; deviceId: string; agentId: string; remoteKey: string; remoteUrl: string
  targetBranch: string; workspaceId?: string; workspaceLinked?: boolean; requestEventId?: string; now: Date
}): RepositoryAdmission | null {
  const candidate = receipt.safeParse({
    userId: input.userId, issueId: input.issueId, deviceId: input.deviceId, agentId: input.agentId, remoteKey: input.remoteKey,
    remoteUrl: input.remoteUrl, targetBranch: input.targetBranch, permission: 'push_to_origin',
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceLinked !== undefined ? { workspaceLinked: input.workspaceLinked } : {}),
    ...(input.requestEventId ? { requestEventId: input.requestEventId } : {}),
    authority: 'owner_credential', acceptedAt: input.now.toISOString(),
  })
  if (!candidate.success || !repositoryBindingMatches(candidate.data.remoteKey, candidate.data.remoteUrl, { allowFile: true })) return null
  return candidate.data
}

/**
 * A retry may retain only the original owner, issue, repository and branch.
 * An old `configured_allow` receipt is treated as not admitted.
 */
export function matchesRepositoryAdmission(value: unknown, scope: {
  userId: string; issueId: string; deviceId: string; agentId: string; remoteKey: string; remoteUrl: string; targetBranch: string
  workspaceId?: string; workspaceLinked?: boolean; requestEventId?: string
}): value is RepositoryAdmission {
  const parsed = receipt.safeParse(value)
  return parsed.success && parsed.data.authority !== 'configured_allow' && parsed.data.userId === scope.userId && parsed.data.issueId === scope.issueId && parsed.data.deviceId === scope.deviceId && parsed.data.agentId === scope.agentId
    && parsed.data.workspaceId === scope.workspaceId && parsed.data.workspaceLinked === scope.workspaceLinked && parsed.data.requestEventId === scope.requestEventId
    && parsed.data.remoteKey === scope.remoteKey && parsed.data.targetBranch === scope.targetBranch
    && repositoryBindingMatches(scope.remoteKey, scope.remoteUrl, { allowFile: true })
    && repositoryBindingMatches(scope.remoteKey, parsed.data.remoteUrl, { allowFile: true })
}
