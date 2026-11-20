import { freshSessionRoute } from '@/lib/fresh-session'
import { governanceResponse, governanceSession } from '@/lib/governance/http'
import { readWorkspaceSettingsActivity } from '@/lib/settings/workspace-activity'

export const GET = freshSessionRoute(async (request: Request, { params }: { params: Promise<{ workspaceId: string }> }) => governanceResponse(async () => {
  const { workspaceId } = await params
  const session = await governanceSession(request, workspaceId)
  const query = new URL(request.url).searchParams
  return readWorkspaceSettingsActivity(session.user, workspaceId,
    { from: query.get('from'), to: query.get('to') }, query.get('groupBy'))
}))
