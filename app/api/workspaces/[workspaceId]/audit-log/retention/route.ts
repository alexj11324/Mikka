import { z } from 'zod'
import { auth } from '@/lib/auth'
import { WorkspaceError } from '@/lib/workspace-access'
import { auditRetentionInput, configureAuditRetention, readAuditRetention } from '@/lib/audit/retention'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ workspaceId: string }> }
const headers = { 'cache-control': 'private, no-store' }
async function access(request: Request, context: Context) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user || !session.session) return { response: Response.json({ error: 'authRequired' }, { status: 401, headers }) }
  const { workspaceId } = await context.params
  if (!z.uuid().safeParse(workspaceId).success) return { response: new Response(null, { status: 404, headers }) }
  return { actorId: session.user.id, workspaceId }
}
export async function GET(request: Request, context: Context) {
  const identity = await access(request, context)
  if (identity.response) return identity.response
  try { return Response.json(await readAuditRetention(identity.actorId!, identity.workspaceId!), { headers }) }
  catch (error) {
    if (error instanceof WorkspaceError) return new Response(null, { status: 404, headers })
    return Response.json({ error: 'auditRetentionUnavailable' }, { status: 503, headers })
  }
}
export async function PUT(request: Request, context: Context) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403, headers })
  const identity = await access(request, context)
  if (identity.response) return identity.response
  const input = auditRetentionInput.safeParse(await request.json().catch(() => null))
  if (!input.success) return Response.json({ error: 'invalidAuditRetention' }, { status: 400, headers })
  try { return Response.json(await configureAuditRetention(identity.actorId!, identity.workspaceId!, input.data), { headers }) }
  catch (error) {
    if (error instanceof WorkspaceError) return new Response(null, { status: 404, headers })
    return Response.json({ error: 'auditRetentionUnavailable' }, { status: 503, headers })
  }
}
