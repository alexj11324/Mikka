import 'server-only'
import { Client } from 'pg'
import { and, eq, isNull } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { issueDocuments, issues, linearIssueLinks, linearIssuePublications, linearSyncOutbox, linearTeamSyncs } from '@/lib/db/schema'
import { readIssueMetadata } from '@/lib/issue-metadata'

export interface OutboxFence { id: string; claimToken: string; scopeVersion: number }
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<typeof db, 'select'>
export class RetiredPublicationError extends Error {
  constructor() { super('Linear publication is no longer current'); this.name = 'RetiredPublicationError' }
}

/** This reservation commits before any HTTP call. Never derive a retry ID
 * from a response that may be lost, or reuse a retired generation's identity. */
export async function reserveLinearPublication(issueId: string, fence?: OutboxFence, expectedScopeVersion = fence?.scopeVersion) {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(eq(issues.id, issueId)).for('update')
    if (!issue || issue.scope !== 'workspace' || readIssueMetadata(issue.content).deletedAt || (expectedScopeVersion !== undefined && issue.scopeVersion !== expectedScopeVersion)) return null
    if (fence && !await claimCurrent(fence, tx)) return null
    const [linked] = await tx.select({ link: linearIssueLinks, team: linearTeamSyncs }).from(linearIssueLinks)
      .innerJoin(linearTeamSyncs, eq(linearTeamSyncs.id, linearIssueLinks.teamSyncId)).where(eq(linearIssueLinks.issueId, issue.id)).limit(1)
    const team = linked?.team ?? (await tx.select().from(linearTeamSyncs).where(and(eq(linearTeamSyncs.ownerId, issue.userId), eq(linearTeamSyncs.active, true))).limit(1))[0]
    if (!team) throw new Error('Connect and enable a Linear team before syncing this issue')
    if (!team.active || linked?.link.remoteRemovedAt) return null
    let [publication] = await tx.select().from(linearIssuePublications).where(and(eq(linearIssuePublications.issueId, issue.id), eq(linearIssuePublications.scopeVersion, issue.scopeVersion))).limit(1)
    if (!publication) {
      ;[publication] = await tx.insert(linearIssuePublications).values({
        id: crypto.randomUUID(), issueId: issue.id, ownerId: issue.userId, teamSyncId: team.id, scopeVersion: issue.scopeVersion,
        linearIssueId: linked?.link.linearIssueId ?? (issue.scopeVersion === 1 ? issue.id : crypto.randomUUID()),
      }).returning()
    }
    if (publication.retiredAt || publication.ownerId !== issue.userId || team.ownerId !== issue.userId || publication.teamSyncId !== team.id || (linked && linked.link.linearIssueId !== publication.linearIssueId)) throw new RetiredPublicationError()
    if (linked && linked.link.publicationId !== publication.id) await tx.update(linearIssueLinks).set({ publicationId: publication.id }).where(eq(linearIssueLinks.id, linked.link.id))
    const [document] = await tx.select({ state: issueDocuments.state }).from(issueDocuments).where(and(eq(issueDocuments.issueId, issue.id), eq(issueDocuments.userId, issue.userId))).limit(1)
    return { issue, publication, team, link: linked ? { ...linked.link, publicationId: publication.id } : null, documentState: document?.state ?? null, fence }
  })
}
export type Publication = NonNullable<Awaited<ReturnType<typeof reserveLinearPublication>>>

async function claimCurrent(fence: OutboxFence, executor: Reader) {
  const [row] = await executor.select({ id: linearSyncOutbox.id }).from(linearSyncOutbox).where(and(
    eq(linearSyncOutbox.id, fence.id), eq(linearSyncOutbox.claimToken, fence.claimToken), eq(linearSyncOutbox.scopeVersion, fence.scopeVersion), eq(linearSyncOutbox.status, 'processing'),
  )).limit(1)
  return Boolean(row)
}

export async function requireCurrentPublication(snapshot: Publication, executor: Reader = db) {
  const [row] = await executor.select({ id: issues.id }).from(issues)
    .innerJoin(linearIssuePublications, eq(linearIssuePublications.issueId, issues.id))
    .where(and(eq(issues.id, snapshot.issue.id), eq(issues.userId, snapshot.issue.userId), eq(issues.scope, 'workspace'), eq(issues.scopeVersion, snapshot.publication.scopeVersion),
      eq(linearIssuePublications.id, snapshot.publication.id), isNull(linearIssuePublications.retiredAt))).limit(1)
  if (!row || (snapshot.fence && !await claimCurrent(snapshot.fence, executor))) throw new RetiredPublicationError()
}

/** DB-only effects hold the scope row lock; no provider IO is allowed here. */
export async function withCurrentPublication<T>(snapshot: Publication, effect: (tx: Transaction) => Promise<T>) {
  return db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, snapshot.issue.id)).for('update')
    if (snapshot.fence) await tx.select({ id: linearSyncOutbox.id }).from(linearSyncOutbox).where(eq(linearSyncOutbox.id, snapshot.fence.id)).for('update')
    await requireCurrentPublication(snapshot, tx)
    return effect(tx)
  })
}

/** Serialize writers to one remote identity, without holding a transaction or
 * issue row across HTTP. A new generation uses a different lock and can publish
 * while an old response is delayed. A dedicated short-lived connection keeps
 * these HTTP waits out of the request's query pool and preserves its DB target. */
export async function withPublicationWriter<T>(publicationId: string, work: () => Promise<T>) {
  const client = new Client({ ...pool.options })
  try {
    await client.connect()
    await client.query('select pg_advisory_lock(hashtextextended($1, 184))', [publicationId])
    return await work()
  } finally { await client.end().catch(() => undefined) }
}
