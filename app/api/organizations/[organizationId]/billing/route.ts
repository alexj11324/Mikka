import { freshSessionRoute } from '@/lib/fresh-session'
import { billingManagementResponse } from '@/lib/billing/management-http'
export const runtime = 'nodejs'
type Context = { params: Promise<{ organizationId: string }> }
const handle = freshSessionRoute(async (request: Request, context: Context) =>
  billingManagementResponse(request, { kind: 'organization', id: (await context.params).organizationId }))
export const GET = handle
export const POST = handle
