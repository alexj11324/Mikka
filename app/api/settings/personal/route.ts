import { getSettings, patchPersonalSettings } from '@/app/actions/settings'
import { settingsBody, settingsResponse, settingsWorkspaceQuery } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'
import { freshSessionRoute } from '@/lib/fresh-session'

export const GET = withRequestLog('/api/settings/personal', request => settingsResponse(() => getSettings(settingsWorkspaceQuery(request))))
export const PATCH = freshSessionRoute(withRequestLog('/api/settings/personal', request =>
  settingsResponse(async () => patchPersonalSettings(await settingsBody(request), settingsWorkspaceQuery(request)))))
