import 'server-only'
import type { PoolClient } from 'pg'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { db, withDatabaseClient } from '@/lib/db'
import { issues, runPublications } from '@/lib/db/schema'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { publicationBranch } from '@/lib/run-publication-policy'
import { admitRepositoryTask, type RepositoryAdmission } from '@/lib/repository-admission'
import { recordedPushGrant } from '@/lib/github/push-grant'
/**
 * A cloud run's push authority, admitted the way a local run's is: when this
 * person's GitHub App grant is recorded for a github.com repository (decision
 * 2026-11-01-1215), the run gets a `github_app` receipt and an approved
 * publication on its task branch. Without one the cloud run still queues; it
 * simply cannot push (claim sends deny). Call inside the queueing transaction.
 */
export async function admitCloudPush(client: PoolClient, input: {
  userId: string; issueId: string; agentId: string; deviceId: string; deviceRepoId: string; workspaceId?: string; now: Date
}): Promise<{ admission: RepositoryAdmission; publication: Omit<typeof runPublications.$inferInsert, 'runId'> } | null> {
  const { rows: [repo] } = await client.query<{ repoPath: string; remoteUrl: string | null; baseBranch: string | null }>('SELECT "repoPath","remoteUrl","baseBranch" FROM device_repos WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3', [input.deviceRepoId, input.userId, input.deviceId])
  if (!repo?.remoteUrl || !repo.repoPath.startsWith('v2/github.com/') || !repositoryBindingMatches(repo.repoPath, repo.remoteUrl)) return null
  const grant = await recordedPushGrant(client, input.userId, repo.repoPath, input.now)
  if (!grant) return null
  return withDatabaseClient(client, async () => {
    const tx = db
    const [task] = await tx.select().from(issues).where(eq(issues.id, input.issueId)).for('share')
    if (!task) return null
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + task.id}, 0))`)
    const [previous] = await tx.select().from(runPublications).where(and(eq(runPublications.issueId, task.id), eq(runPublications.remoteKey, repo.repoPath), sql`${runPublications.branch} is not null`)).orderBy(asc(runPublications.createdAt)).limit(1)
    const identifiers = await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number }], tx)
    const identifier = previous?.identifier ?? identifiers.get(task.id) ?? null
    const branch = previous?.branch ?? publicationBranch(identifier)
    if (!branch) return null
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'repository-branch:' + repo.repoPath + ':' + branch}, 0))`)
    const [collision] = await tx.select({ runId: runPublications.runId }).from(runPublications).where(and(eq(runPublications.remoteKey, repo.repoPath), eq(runPublications.branch, branch), ne(runPublications.issueId, task.id))).limit(1)
    if (collision) return null
    const admission = admitRepositoryTask({ userId: input.userId, issueId: task.id, deviceId: input.deviceId, agentId: input.agentId, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl!, targetBranch: branch, grant, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), now: input.now })
    if (!admission) return null
    return { admission, publication: { userId: input.userId, issueId: task.id, scopeVersion: task.scopeVersion, issueTitle: task.title, remoteUrl: repo.remoteUrl!, remoteKey: repo.repoPath, identifier, branch, baseBranch: repo.baseBranch, pushApproved: true } }
  })
}
