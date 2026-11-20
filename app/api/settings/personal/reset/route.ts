import { resetPersonalSettings } from '@/app/actions/settings'
import { settingsBody, settingsResponse, settingsWorkspaceQuery } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'

export const POST = freshSessionRoute(withRequestLog('/api/settings/personal/reset', request =>
  settingsResponse(async () => resetPersonalSettings(await settingsBody(request), settingsWorkspaceQuery(request)))))
