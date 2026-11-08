import { ActionFailureError } from '@/lib/action-error'
import 'server-only'
import type { PoolClient } from 'pg'
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { db, withDatabaseClient } from '@/lib/db'
import { issues, runPublications } from '@/lib/db/schema'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { publicationBranch } from '@/lib/run-publication-policy'
import { admitRepositoryTask, type RepositoryAdmission } from '@/lib/repository-admission'
/**
 * A cloud run's task branch, admitted the way a local run's is: a github.com
 * repository gets a receipt and a publication on its task branch. Pushing
 * needs no grant in Mikka; the run works with its owner's own GitHub
 * credential (decision 2026-11-02-1600). Call inside the queueing transaction.
 */
export async function admitCloudPush(client: PoolClient, input: {
  userId: string; issueId: string; agentId: string; deviceId: string; deviceRepoId: string; workspaceId?: string; baseBranch?: string | null; now: Date
}): Promise<{ admission: RepositoryAdmission; publication: Omit<typeof runPublications.$inferInsert, 'runId'> } | null> {
  const { rows: [repo] } = await client.query<{ repoPath: string; remoteUrl: string | null; baseBranch: string | null }>('SELECT "repoPath","remoteUrl","baseBranch" FROM device_repos WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3 FOR SHARE', [input.deviceRepoId, input.userId, input.deviceId])
  if (!repo?.remoteUrl || !repo.repoPath.startsWith('v2/github.com/') || !repositoryBindingMatches(repo.repoPath, repo.remoteUrl)) return null
  return withDatabaseClient(client, async () => {
    const tx = db
    const [task] = await tx.select({ id: issues.id, userId: issues.userId, workspaceId: issues.workspaceId, ownershipState: issues.ownershipState, scope: issues.scope, scopeVersion: issues.scopeVersion, title: issues.title, issuedIdentifier: issues.issuedIdentifier, content: issueAttrsContent }).from(issues).where(eq(issues.id, input.issueId)).for('update')
    if (!task) return null
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + task.id}, 0))`)
    const [previous] = await tx.select().from(runPublications).where(and(eq(runPublications.issueId, task.id), eq(runPublications.remoteKey, repo.repoPath), sql`${runPublications.branch} is not null`)).orderBy(asc(runPublications.createdAt)).limit(1)
    if (previous && input.baseBranch !== undefined && previous.baseBranch !== input.baseBranch) throw new ActionFailureError('projectRepositoryDenied')
    const identifier = previous?.identifier ?? (await taskIdentifiers([{ id: task.id, ownerId: task.userId, scope: task.scope, number: readIssueMetadata(task.content).number, issuedIdentifier: task.issuedIdentifier }], tx)).get(task.id) ?? null
    const branch = previous?.branch ?? publicationBranch(identifier)
    if (!branch) return null
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'repository-branch:' + repo.repoPath + ':' + branch}, 0))`)
    const [collision] = await tx.select({ runId: runPublications.runId }).from(runPublications).where(and(eq(runPublications.remoteKey, repo.repoPath), eq(runPublications.branch, branch), ne(runPublications.issueId, task.id))).limit(1)
    if (collision) return null
    const admission = admitRepositoryTask({ userId: input.userId, issueId: task.id, deviceId: input.deviceId, agentId: input.agentId, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl!, targetBranch: branch, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), now: input.now })
    if (!admission) return null
    return { admission, publication: { userId: input.userId, issueId: task.id, scopeVersion: task.scopeVersion, issueTitle: task.title, remoteUrl: repo.remoteUrl!, remoteKey: repo.repoPath, identifier, branch, baseBranch: input.baseBranch !== undefined ? input.baseBranch : previous?.baseBranch ?? repo.baseBranch, pushApproved: true } }
  })
}
