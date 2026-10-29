import { normalizeRepository, repositoryBindingMatches } from '@mikka/protocol/repository'
import { z } from 'zod'

/** The exact repository and permission that a person must see before deciding. */
export const repositoryApprovalInput = z.object({ repo: z.string().trim().min(1).max(4000) }).strict()
export const repositoryApprovalReceipt = z.object({
  repo: z.string().min(1).max(4000), remoteKey: z.string().min(1).max(4000),
  permission: z.literal('push_to_origin'),
}).strict()

/** This only prepares a request; it never grants permission. */
export function prepareRepositoryApproval(input: unknown) {
  const parsed = repositoryApprovalInput.safeParse(input)
  if (!parsed.success) return null
  try {
    const repository = normalizeRepository(parsed.data.repo)
    return { repo: repository.remoteUrl, remoteKey: repository.key, permission: 'push_to_origin' as const }
  } catch { return null }
}

/** Validate the stored request again before an authenticated person decides. */
export function validateRepositoryApproval(input: unknown) {
  const parsed = repositoryApprovalReceipt.safeParse(input)
  if (!parsed.success || !repositoryBindingMatches(parsed.data.remoteKey, parsed.data.repo)) return null
  return parsed.data
}
