import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { exportWorkspaceUsage, readWorkspaceUsage } from '@/lib/governance/usage'
export const runtime = 'nodejs'
type Context = { params: Promise<{ workspaceId: string }> }

export const GET = freshSessionRoute(async (request: Request, context: Context) => governanceResponse(async () => {
  const { workspaceId } = await context.params
  const session = await governanceSession(request, workspaceId)
  const params = new URL(request.url).searchParams
  const range = { from: params.get('from'), to: params.get('to') }
  if (params.get('format') === 'csv') return new Response(await exportWorkspaceUsage(workspaceId, session.user, range), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="workspace-usage.csv"', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  })
  return readWorkspaceUsage(workspaceId, session.user, range)
}))
