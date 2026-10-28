import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { z } from 'zod'
import { repositoryPushApproved, type RepositoryPushApproval } from './run-publication-policy'

/** Immutable evidence of one accepted task's repository authority. */
const receipt = z.object({
  userId: z.string().min(1), issueId: z.uuid(), deviceId: z.uuid(), agentId: z.uuid(), remoteKey: z.string().min(1),
  remoteUrl: z.string().min(1), permission: z.literal('push_to_origin'),
  targetBranch: z.string().regex(/^mikka\/[a-z0-9-]+-[1-9][0-9]*$/),
  approvedAt: z.iso.datetime(), acceptedAt: z.iso.datetime(),
}).strict()
export type RepositoryAdmission = z.infer<typeof receipt>

/** Call only under the repository-approval lock, in the admission transaction. */
export function admitRepositoryTask(input: {
  userId: string; issueId: string; deviceId: string; agentId: string; remoteKey: string; remoteUrl: string
  targetBranch: string; push: RepositoryPushApproval | null | undefined; now: Date
}): RepositoryAdmission | null {
  if (!repositoryPushApproved(input.push, input.userId)) return null
  const candidate = receipt.safeParse({
    userId: input.userId, issueId: input.issueId, deviceId: input.deviceId, agentId: input.agentId, remoteKey: input.remoteKey,
    remoteUrl: input.remoteUrl, targetBranch: input.targetBranch, permission: 'push_to_origin',
    approvedAt: input.push!.approvedAt, acceptedAt: input.now.toISOString(),
  })
  if (!candidate.success || !repositoryBindingMatches(candidate.data.remoteKey, candidate.data.remoteUrl, { allowFile: true })) return null
  return candidate.data
}

/** A retry may retain only the original owner, issue and repository authority. */
export function matchesRepositoryAdmission(value: unknown, scope: {
  userId: string; issueId: string; deviceId: string; agentId: string; remoteKey: string; remoteUrl: string; targetBranch: string
}): value is RepositoryAdmission {
  const parsed = receipt.safeParse(value)
  return parsed.success && parsed.data.userId === scope.userId && parsed.data.issueId === scope.issueId && parsed.data.deviceId === scope.deviceId && parsed.data.agentId === scope.agentId
    && parsed.data.remoteKey === scope.remoteKey && parsed.data.targetBranch === scope.targetBranch
    && repositoryBindingMatches(scope.remoteKey, scope.remoteUrl, { allowFile: true })
    && repositoryBindingMatches(scope.remoteKey, parsed.data.remoteUrl, { allowFile: true })
}
