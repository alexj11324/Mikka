import { getSettingsSchema } from '@/app/actions/settings'
import { settingsResponse } from '@/lib/settings/http'
import { withRequestLog } from '@/lib/request-log'

export const GET = withRequestLog('/api/settings/schema', () => settingsResponse(getSettingsSchema))
