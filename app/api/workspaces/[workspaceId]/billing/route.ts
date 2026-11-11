import { freshSessionRoute } from '@/lib/fresh-session'
import { billingManagementResponse } from '@/lib/billing/management-http'
export const runtime = 'nodejs'
type Context = { params: Promise<{ workspaceId: string }> }
const handle = freshSessionRoute(async (request: Request, context: Context) =>
  billingManagementResponse(request, { kind: 'workspace', id: (await context.params).workspaceId }))
export const GET = handle
export const POST = handle
