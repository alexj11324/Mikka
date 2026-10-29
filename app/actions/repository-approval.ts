'use server'

import { z } from 'zod'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { writeRepositoryPushApproval } from '@/lib/repository-approval-write'
import { getSession } from '@/lib/session'
import { verifyGitHubRepositoryAccess, PublicationError } from '@/lib/github/run-pull-request'
import { linkedGitHubAccountId, saveRepositoryInstallation } from '@/lib/github/repository-installation'

/**
 * Human-session-only backend for direct repository approval or revocation.
 * Coordinator tools can only create a separate pending confirmation.
 */
export async function setRepositoryPushApproval(input: { repo: string; approved: boolean }) {
  const session = await getSession()
  if (!session?.user) return { error: 'authRequired' as const }
  const parsed = z.object({ repo: z.string().trim().min(1).max(4000), approved: z.boolean() }).strict().safeParse(input)
  if (!parsed.success) return { error: 'repositoryInvalid' as const }
  let key: string
  try { key = normalizeRepository(parsed.data.repo, { allowFile: daemonTestMode(process.env) }).key }
  catch { return { error: 'repositoryInvalid' as const } }
  const userId = session.user.id
  await writeRepositoryPushApproval(userId, key, parsed.data.approved)
  return { success: true as const }
}

/** Verify and save only non-secret installation identity; no App token reaches the browser. */
export async function verifyRepositoryInstallation(input: { repo: string }) {
  const session = await getSession()
  if (!session?.user) return { error: 'authRequired' as const }
  const parsed = z.object({ repo: z.string().trim().min(1).max(4000) }).strict().safeParse(input)
  if (!parsed.success) return { error: 'repositoryInvalid' as const }
  let key: string
  try { key = normalizeRepository(parsed.data.repo).key }
  catch { return { error: 'repositoryInvalid' as const } }
  try {
    const binding = await verifyGitHubRepositoryAccess({ remoteKey: key, githubAccountId: await linkedGitHubAccountId(session.user.id) })
    await saveRepositoryInstallation(session.user.id, key, binding)
    return { success: true as const }
  } catch (error) {
    if (error instanceof PublicationError) return { error: error.code }
    throw error
  }
}
