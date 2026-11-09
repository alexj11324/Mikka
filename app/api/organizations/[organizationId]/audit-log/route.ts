import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceJson, governanceResponse } from '@/lib/governance/http'
import { createOrganizationAuditExport, readOrganizationAuditExport } from '@/lib/governance/audit-export'
import { AuditExportError } from '@/lib/audit/export'
import { organizationSession } from '@/lib/enterprise/http'

export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
async function exported(work: () => Promise<unknown>) {
  try { return await work() }
  catch (error) {
    if (error instanceof AuditExportError) return Response.json({ error: { code: error.code } }, { status: error.status, headers: { 'cache-control': 'private, no-store' } })
    throw error
  }
}
export const POST = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId, true)
  const input = await governanceJson(request)
  return exported(() => createOrganizationAuditExport(organizationId, session.user.id, input))
}))
export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { organizationId } = await context.params
  const session = await organizationSession(request, organizationId, true)
  const query = new URL(request.url).searchParams
  return exported(() => readOrganizationAuditExport(organizationId, session.user.id, query.get('exportId') ?? '', Number(query.get('offset') ?? 0), Number(query.get('limit') ?? 100)))
}))
