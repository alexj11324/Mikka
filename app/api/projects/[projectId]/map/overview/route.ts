import { withRequestLog } from '@/lib/request-log'
import { projectMapHttp } from '@/lib/project-map/read-http'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const GET = withRequestLog('/api/projects/[projectId]/map/overview', async (request: Request, context: { params: Promise<{ projectId: string }> }) => {
  const params = await context.params
  return projectMapHttp(request, params.projectId, 'overview')
})
