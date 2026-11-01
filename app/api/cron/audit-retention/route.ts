import { verifyBearer } from '@/lib/linear-sync/webhook'
import { deliverWorkspaceAudits } from '@/lib/audit/delivery'
import { sweepAuditRetention } from '@/lib/audit/retention'
export const runtime = 'nodejs'
export const maxDuration = 60
const headers = { 'cache-control': 'no-store' }
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ error: 'Cron is not configured' }, { status: 503, headers })
  if (!await verifyBearer(request.headers.get('authorization'), secret)) return new Response(null, { status: 401, headers })
  try {
    const delivery = await deliverWorkspaceAudits()
    return Response.json({ ...await sweepAuditRetention(), delivery }, { headers })
  }
  catch { return Response.json({ error: 'auditRetentionUnavailable' }, { status: 503, headers }) }
}
