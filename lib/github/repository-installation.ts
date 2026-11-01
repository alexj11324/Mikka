import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { githubConnections, githubRepositoryInstallations } from '@/lib/db/schema'
import type { GitHubRepositoryBinding } from './run-pull-request'

/** The Plugins → GitHub connection. Signing in with GitHub is not one. Durable provider subject only, never OAuth tokens. */
export async function linkedGitHubAccountId(userId: string): Promise<string | null> {
  const [row] = await db.select({ githubAccountId: githubConnections.githubAccountId }).from(githubConnections).where(eq(githubConnections.userId, userId)).limit(1)
  return row?.githubAccountId ?? null
}

export async function saveRepositoryInstallation(userId: string, remoteKey: string, binding: GitHubRepositoryBinding): Promise<void> {
  const values = { userId, remoteKey, githubAccountId: binding.githubAccountId, installationId: binding.installationId, repositoryId: binding.repositoryId, verifiedAt: new Date() }
  await db.insert(githubRepositoryInstallations).values(values).onConflictDoUpdate({
    target: [githubRepositoryInstallations.userId, githubRepositoryInstallations.remoteKey], set: values,
  })
}
