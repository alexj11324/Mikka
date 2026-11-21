import { getWorkspaceSettings, patchWorkspaceSettings } from '@/app/actions/settings'
import { settingsBody, settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'

type Context = { params: Promise<{ workspaceId: string }> }
export const GET = withRequestLog('/api/settings/workspace/[workspaceId]', (request: Request, context: Context) =>
  settingsResponse(async () => getWorkspaceSettings((await context.params).workspaceId)))
export const PATCH = freshSessionRoute(withRequestLog('/api/settings/workspace/[workspaceId]', (request: Request, context: Context) =>
  settingsResponse(async () => patchWorkspaceSettings((await context.params).workspaceId, await settingsBody(request)))))
