import { cronUnauthorized } from '@/lib/cron-auth'
import { cronJob } from '@/lib/background'
import { deliverWorkspaceAudits } from '@/lib/audit/delivery'
import { sweepAuditRetention } from '@/lib/audit/retention'
import { retryMemberLifecycleOutbox } from '@/lib/governance/member-outbox'
export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try {
    const delivery = await deliverWorkspaceAudits()
    const memberLifecycle = await retryMemberLifecycleOutbox()
    return Response.json({ ...await sweepAuditRetention(), delivery, memberLifecycle }, { headers })
  }
  catch { return Response.json({ error: 'auditRetentionUnavailable' }, { status: 503, headers }) }
}

export const GET = cronJob('audit-retention', handleGET)
