const allowedEvents = new Set(['$pageview', '$identify', '$feature_flag_called', 'mikka_team_created', 'mikka_team_updated', 'mikka_live_socket', 'mikka_live_received', 'mikka_live_skipped', 'mikka_live_read'])
const allowedProperties = new Set([
  'token', 'distinct_id', '$device_id', '$user_id', '$session_id', '$window_id',
  '$lib', '$lib_version', '$browser', '$browser_version', '$os', '$os_version', '$device_type',
  '$screen_width', '$screen_height', '$viewport_width', '$viewport_height', '$is_identified', '$process_person_profile',
  '$feature_flag', '$feature_flag_response', '$feature_flag_request_id', '$feature_flag_reason', '$feature_flag_error', '$active_feature_flags',
  'app', 'environment', 'runtime', 'section', 'test_account',
  'live_state', 'live_reason', 'live_kind', 'live_entity_id', 'live_revision', 'read_key', 'read_key_hash',
  // A heartbeat's round trip in whole milliseconds: a bounded integer from a
  // monotonic clock, carrying no user data, message text or identifier.
  'live_rtt_ms',
])

/** Replay also uses this callback for its navigation metadata. Keep the
 * sanitized route, while request/response content and credentials stay out. */
export function redactReplayRequest<T extends { name: string }>(request: T): T | null {
  try {
    const url = new URL(request.name)
    const sanitized = { ...request, name: `${url.origin}${analyticsPath(url.pathname)}` }
    for (const key of ['requestBody', 'responseBody', 'requestHeaders', 'responseHeaders']) Reflect.deleteProperty(sanitized, key)
    return sanitized
  } catch { return null }
}

export function analyticsPath(pathname: string) {
  return pathname.replace(/^\/invite\/[^/]+/, '/invite/:token').replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:id')
}

export function sanitizeAnalyticsEvent<T extends { event: string; properties: Record<string, unknown> }>(event: T | null): T | null {
  if (!event) return null
  // rrweb masks the DOM before serialization (instrumentation-client.ts).
  // Its transport needs the opaque snapshot payload and session identifiers;
  // ordinary event properties still go through the narrow allowlist below.
  if (event.event === '$snapshot') {
    const keys = new Set(['token', 'distinct_id', '$session_id', '$window_id', '$lib', '$lib_version', '$snapshot_bytes', '$snapshot_data'])
    const snapshot = { ...event, properties: Object.fromEntries(Object.entries(event.properties).filter(([key]) => keys.has(key))) }
    for (const key of ['$set', '$set_once', '$unset']) Reflect.deleteProperty(snapshot, key)
    return snapshot
  }
  if (!allowedEvents.has(event.event)) return null
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
