import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { configureQuota, quotaPolicySchema } from '@/lib/quota/config'
import { QuotaError, quotaResponse } from '@/lib/quota/errors'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ workspaceId: string }> }

export async function PUT(request: Request, { params }: Context) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401 })
  if (request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'originDenied' }, { status: 403 })
  const { workspaceId } = await params
  if (!z.uuid().safeParse(workspaceId).success) return Response.json({ error: 'invalidWorkspace' }, { status: 400 })
  if (Number(request.headers.get('content-length')) > 100000) return Response.json({ error: 'policyTooLarge' }, { status: 413 })
  const text = await request.text()
  if (text.length > 100000) return Response.json({ error: 'policyTooLarge' }, { status: 413 })
  const policy = quotaPolicySchema.safeParse((() => { try { return JSON.parse(text) } catch { return null } })())
  if (!policy.success) return Response.json({ error: 'invalidQuotaPolicy' }, { status: 400 })
  try {
    await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, workspaceId, session.user.id, true)
      // Locks remain held through the policy write, so a concurrent suspension
      // cannot pass on a stale directory result while adding a binding.
      const members = await tx.select({ id: workspaceMembers.userId }).from(workspaceMembers)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, policy.data.owners), eq(workspaceMembers.status, 'active'))).for('update')
      if (new Set(members.map(m => m.id)).size !== new Set(policy.data.owners).size) throw new QuotaError('quotaAccessDenied', 403)
      await configureQuota(pool, workspaceId, session.user.id, policy.data)
    })
    return Response.json({ configured: true, unit: 'admission_unit' }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof WorkspaceError) return Response.json({ error: error.code }, { status: 403 })
    return quotaResponse(error)
  }
}

export async function GET(request: Request, { params }: Context) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401 })
  const { workspaceId } = await params
  if (!z.uuid().safeParse(workspaceId).success) return Response.json({ error: 'invalidWorkspace' }, { status: 400 })
  try {
    return await workspaceDb.transaction(async tx => {
      await requireWorkspace(tx, workspaceId, session.user.id)
      const { rows: [usage] } = await pool.query(`SELECT t.window_start,t.window_end,t.paused,
        LEAST(CASE WHEN t.override_until > clock_timestamp() THEN t.override_units ELSE t.budget_units END,a.max_budget_units) AS budget,
        a.max_budget_units AS allocation_budget,a.expires_at AS allocation_expires_at,(a.revoked_at IS NULL AND a.expires_at > clock_timestamp()) AS allocation_active,
        COALESCE(sum(CASE WHEN r.state='reserved' AND r.expires_at <= clock_timestamp() THEN 0 ELSE COALESCE(r.settled_units,r.units) END),0) AS lifetime_used,
        COALESCE(sum(CASE WHEN r.state='reserved' AND r.expires_at <= clock_timestamp() THEN 0 ELSE COALESCE(r.settled_units,r.units) END)
          FILTER (WHERE r.created_at >= t.window_start AND r.created_at < t.window_end),0) AS used,
        count(r.id) FILTER (WHERE r.state IN ('reserved','executing') AND r.expires_at > clock_timestamp()) AS active,
        t.concurrency_limit,t.rate_limit,t.rate_window_seconds
        FROM quota_tenants t LEFT JOIN quota_allocations a ON a.workspace_id=t.workspace_id LEFT JOIN quota_reservations r ON r.workspace_id=t.workspace_id
        WHERE t.workspace_id=$1 GROUP BY t.workspace_id,a.workspace_id`, [workspaceId])
      if (!usage) throw new QuotaError('quotaNotConfigured', 503, 60)
      return Response.json({ unit: 'admission_unit', ...usage }, { headers: { 'Cache-Control': 'private, no-store' } })
    })
  } catch (error) {
    if (error instanceof WorkspaceError) return Response.json({ error: error.code }, { status: 403 })
    return quotaResponse(error)
  }
}
