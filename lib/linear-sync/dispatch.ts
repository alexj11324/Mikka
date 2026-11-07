import 'server-only'
import { afterJob } from '@/lib/background'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, linearIssueLinks, linearTeamSyncs } from '@/lib/db/schema'
import { processLinearInboxDelivery, processLinearIssueOutbox, processLinearSyncBatch } from './worker'
import { linearSyncEnabled } from './flags'

export function dispatchLinearWork() {
  afterJob('after:linear-sync-batch', async () => {
    try { await processLinearSyncBatch() }
    catch { console.error('Linear background sync could not start') }
  })
}

export function dispatchLinearIssueSync(issueId: string) {
  afterJob('after:linear-issue-sync', async () => {
    try {
      if (!await linearSyncEnabled()) return
      // A delayed callback must recheck the task and its per-task destination.
      const [eligible] = await db.select({ id: issues.id }).from(issues).innerJoin(linearIssueLinks, eq(linearIssueLinks.issueId, issues.id)).innerJoin(linearTeamSyncs, eq(linearTeamSyncs.id, linearIssueLinks.teamSyncId))
        .where(and(eq(issues.id, issueId), eq(issues.ownershipState, 'bound'), eq(issues.linearSyncPolicy, 'explicit'), eq(issues.linearSyncBlocked, false), eq(linearIssueLinks.ownerId, issues.userId), eq(linearIssueLinks.externalTargetVerified, true), eq(linearTeamSyncs.ownerId, issues.userId), eq(linearTeamSyncs.workspaceId, issues.workspaceId), eq(linearTeamSyncs.active, true))).limit(1)
      if (eligible) await processLinearIssueOutbox(issueId)
    }
    catch { console.error('Linear background issue sync could not start') }
  })
}

export function dispatchLinearWebhook(deliveryId: string) {
  afterJob('after:linear-webhook', async () => {
    try { if (await linearSyncEnabled()) await processLinearInboxDelivery(deliveryId) }
    catch { console.error('Linear background webhook processing could not start') }
  })
}
