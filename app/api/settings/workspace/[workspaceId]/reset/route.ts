import { resetWorkspaceSettings } from '@/app/actions/settings'
import { settingsBody, settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'

export const POST = freshSessionRoute(withRequestLog('/api/settings/workspace/[workspaceId]/reset',
  (request: Request, context: { params: Promise<{ workspaceId: string }> }) =>
    settingsResponse(async () => resetWorkspaceSettings((await context.params).workspaceId, await settingsBody(request)))))
