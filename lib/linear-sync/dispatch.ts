import 'server-only'
import { after } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, linearIssueLinks, linearTeamSyncs } from '@/lib/db/schema'
import { processLinearInboxDelivery, processLinearIssueOutbox, processLinearSyncBatch } from './worker'

export function dispatchLinearWork() {
  after(async () => {
    try { await processLinearSyncBatch() }
    catch { console.error('Linear background sync could not start') }
  })
}

export function dispatchLinearIssueSync(issueId: string) {
  after(async () => {
    try {
      // A delayed callback must recheck the task and its per-task destination.
      const [eligible] = await db.select({ id: issues.id }).from(issues).innerJoin(linearIssueLinks, eq(linearIssueLinks.issueId, issues.id)).innerJoin(linearTeamSyncs, eq(linearTeamSyncs.id, linearIssueLinks.teamSyncId))
        .where(and(eq(issues.id, issueId), eq(issues.scope, 'workspace'), eq(issues.linearSyncBlocked, false), eq(linearIssueLinks.ownerId, issues.userId), eq(linearIssueLinks.externalTargetVerified, true), eq(linearTeamSyncs.ownerId, issues.userId), eq(linearTeamSyncs.active, true))).limit(1)
      if (eligible) await processLinearIssueOutbox(issueId)
    }
    catch { console.error('Linear background issue sync could not start') }
  })
}

export function dispatchLinearWebhook(deliveryId: string) {
  after(async () => {
    try { await processLinearInboxDelivery(deliveryId) }
    catch { console.error('Linear background webhook processing could not start') }
  })
}
