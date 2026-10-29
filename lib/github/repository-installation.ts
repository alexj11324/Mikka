import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { githubRepositoryInstallations } from '@/lib/db/schema'
import type { GitHubRepositoryBinding } from './run-pull-request'

/** Better Auth owns account. Read the durable provider subject, never OAuth tokens. */
export async function linkedGitHubAccountId(userId: string): Promise<string | null> {
  const result = await db.execute<{ accountId: string }>(sql`select "accountId" from account where "userId" = ${userId} and "providerId" = 'github' order by "createdAt" limit 1`)
  return result.rows[0]?.accountId ?? null
}

export async function saveRepositoryInstallation(userId: string, remoteKey: string, binding: GitHubRepositoryBinding): Promise<void> {
  const values = { userId, remoteKey, githubAccountId: binding.githubAccountId, installationId: binding.installationId, repositoryId: binding.repositoryId, verifiedAt: new Date() }
  await db.insert(githubRepositoryInstallations).values(values).onConflictDoUpdate({
    target: [githubRepositoryInstallations.userId, githubRepositoryInstallations.remoteKey], set: values,
  })
}
