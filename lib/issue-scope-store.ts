import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, issueVersions, linearIssueLinks, linearIssuePublications, linearSyncOutbox } from '@/lib/db/schema'
import { activityActor } from '@/lib/activity-actor'
import { issueView } from '@/lib/task-identifier-server'
import type { TaskScope } from '@/lib/task-identifier'

/** Local half of the two-way transition. The linked path remains gated at the
 * action boundary until #184's archive/unlink decision is confirmed.
 * No provider request is made here. The DB trigger atomically detaches the link,
 * cancels outgoing work and revokes other people's runs before commit. */
export async function changeIssueScopeLocally(userId: string, input: { id: string; revision: number; scope: TaskScope }, options: { allowLinkedPersonal: boolean }) {
  for (let attempt = 0; ; attempt++) {
    try { return await changeScopeTransaction(userId, input, options) }
    catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      // Run writes can already hold a run row when its scope fence is reached.
      // Only a rolled-back local transaction is retried; no provider IO occurs.
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
    }
  }
}

async function changeScopeTransaction(userId: string, input: { id: string; revision: number; scope: TaskScope }, options: { allowLinkedPersonal: boolean }) {
  return db.transaction(async tx => {
    // Imports reserve the remote UUID before looking up or creating an issue.
    // Take that lock before the local row lock to avoid import/detach deadlocks.
    const [link] = await tx.select({ remoteId: linearIssueLinks.linearIssueId }).from(linearIssueLinks).where(eq(linearIssueLinks.issueId, input.id)).limit(1)
    if (link) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${link.remoteId}, 0))`)
    const [latest] = await tx.select().from(issues).where(eq(issues.id, input.id)).for('update')
    if (!latest || latest.userId !== userId) return { error: 'issueScopeOwnerOnly' as const }
    if (latest.revision !== input.revision) return { error: 'issueStale' as const }
    if (input.scope === 'personal' && !options.allowLinkedPersonal) {
      const [currentLink] = await tx.select({ id: linearIssueLinks.id }).from(linearIssueLinks).where(eq(linearIssueLinks.issueId, input.id)).limit(1)
      const [outgoing] = await tx.select({ id: linearSyncOutbox.id }).from(linearSyncOutbox).where(and(eq(linearSyncOutbox.issueId, input.id), inArray(linearSyncOutbox.status, ['queued', 'processing', 'failed']))).limit(1)
      // A committed reservation can have reached the provider even if every
      // response/lookup was lost. Terminal jobs and absent links prove nothing
      // about remote existence; keep disposition unresolved and fail closed.
      const [publication] = await tx.select({ id: linearIssuePublications.id }).from(linearIssuePublications).where(eq(linearIssuePublications.issueId, input.id)).limit(1)
      if (currentLink || outgoing || publication) return { error: 'issueScopeInLinear' as const }
    }
    const [saved] = await tx.update(issues).set({ scope: input.scope, scopeSetBy: 'user', scopeConfidence: null, revision: latest.revision + 1, updatedAt: new Date() })
      .where(and(eq(issues.id, latest.id), eq(issues.userId, userId), eq(issues.revision, input.revision))).returning()
    await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...activityActor(userId) })
    return { issue: await issueView(saved, tx) }
  })
}
