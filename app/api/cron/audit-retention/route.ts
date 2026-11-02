import { cronUnauthorized } from '@/lib/cron-auth'
import { deliverWorkspaceAudits } from '@/lib/audit/delivery'
import { sweepAuditRetention } from '@/lib/audit/retention'
export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
export async function GET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try {
    const delivery = await deliverWorkspaceAudits()
    return Response.json({ ...await sweepAuditRetention(), delivery }, { headers })
  }
  catch { return Response.json({ error: 'auditRetentionUnavailable' }, { status: 503, headers }) }
}
