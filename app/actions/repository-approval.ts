'use server'

import { z } from 'zod'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { db } from '@/lib/db'
import { repositorySettings } from '@/lib/db/schema'
import { getSession } from '@/lib/session'
import { verifyGitHubRepositoryAccess, PublicationError } from '@/lib/github/run-pull-request'
import { linkedGitHubAccountId, saveRepositoryInstallation } from '@/lib/github/repository-installation'

/**
 * Human-session-only backend. The proposed chat approval entry point is still
 * awaiting Alex; this action is deliberately absent from Coordinator/MCP tools.
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
  const push = { approved: parsed.data.approved, remote: 'origin', approvedByUserId: userId, approvedAt: new Date().toISOString() }
  await db.insert(repositorySettings).values({ userId, remoteKey: key, push }).onConflictDoUpdate({
    target: [repositorySettings.userId, repositorySettings.remoteKey], set: { push, updatedAt: new Date() },
  })
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
