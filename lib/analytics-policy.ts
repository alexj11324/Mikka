const allowedEvents = new Set(['$pageview', '$identify', '$feature_flag_called', 'mikka_team_created', 'mikka_team_updated'])
const allowedProperties = new Set([
  'token', 'distinct_id', '$device_id', '$user_id', '$session_id', '$window_id',
  '$lib', '$lib_version', '$browser', '$browser_version', '$os', '$os_version', '$device_type',
  '$screen_width', '$screen_height', '$viewport_width', '$viewport_height', '$is_identified', '$process_person_profile',
  '$feature_flag', '$feature_flag_response', '$feature_flag_request_id', '$feature_flag_reason', '$feature_flag_error', '$active_feature_flags',
  'app', 'environment', 'runtime', 'section', 'test_account',
])

export function analyticsPath(pathname: string) {
  return pathname.replace(/^\/invite\/[^/]+/, '/invite/:token').replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
}

export function sanitizeAnalyticsEvent<T extends { event: string; properties: Record<string, unknown> }>(event: T | null): T | null {
  if (!event || !allowedEvents.has(event.event)) return null
  const properties: Record<string, unknown> = Object.fromEntries(Object.entries(event.properties).filter(([key]) => allowedProperties.has(key)))
  if (typeof event.properties.$current_url === 'string') {
    try {
      const url = new URL(event.properties.$current_url)
      properties.$current_url = `${url.origin}${analyticsPath(url.pathname)}`
      properties.$pathname = analyticsPath(url.pathname)
    } catch { /* 丢弃无法解析的 URL，避免将原始字符串发送给分析服务。 */ }
  }
  const sanitized = { ...event, properties }
  for (const key of ['$set', '$set_once', '$unset']) Reflect.deleteProperty(sanitized, key)
  return sanitized
}
