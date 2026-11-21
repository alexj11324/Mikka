import { scrubLocalString } from '@mikka/protocol/tracing'

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

/** Error levels an exception event may carry, from a closed set. */
const exceptionLevels = new Set(['error', 'warning', 'info', 'debug', 'log', 'fatal'])
/** A class name (`TypeError`, `DOMException`), never a message or a path. */
const EXCEPTION_TYPE = /^[A-Za-z_$][\w$.-]{0,63}$/
/** Bounds a hostile payload, not a real one: the SDK sends one entry and at
 * most 50 frames for an exception. */
const EXCEPTION_LIST_LIMIT = 5
const EXCEPTION_FRAME_LIMIT = 32
/** A credential echoed into a message. `scrubLocalString` masks URLs, webhook
 * keys, emails, IPs and home paths, but not a bare `Bearer …` or `sk-…`. */
const CREDENTIAL = /(\b(?:authorization|bearer|token|secret|password|api[_-]?key|cookie)\b\s*[:=]?\s*["']?)[\w.~+/=-]{8,}|\b(?:sk|pk|rk|ghp|gho|ghs|ghu|phc|xox[abpsr])[-_][\w-]{8,}|\beyJ[\w-]{8,}\.[\w-]{8,}(?:\.[\w-]*)?/gi

/** The SDK's bot classification, which is the only browser detail that stays:
 * its user agent, platform and screen never do. */
function browserClassification(properties: Record<string, unknown>) {
  const type = properties.$browser_type
  return type === 'bot' || type === 'browser' ? { $browser_type: type } : {}
}

/** Where an event happened, as its route: never the query string, the hash or
 * a document identifier, and never an unparseable URL's raw text. */
function route(properties: Record<string, unknown>) {
  if (typeof properties.$current_url !== 'string') return {}
  try {
    const url = new URL(properties.$current_url)
    return { $current_url: `${url.origin}${analyticsPath(url.pathname)}`, $pathname: analyticsPath(url.pathname) }
  } catch { return {} }
}

/** The allowlisted properties plus the classification and the route, so a
 * `$set` riding on the event cannot add person properties either. */
function narrow<T extends { event: string; properties: Record<string, unknown> }>(event: T, kept: Record<string, unknown> = {}): T {
  const properties = {
    ...Object.fromEntries(Object.entries(event.properties).filter(([key]) => allowedProperties.has(key))),
    ...browserClassification(event.properties), ...route(event.properties), ...kept,
  }
  const narrowed = { ...event, properties }
  for (const key of ['$set', '$set_once', '$unset']) Reflect.deleteProperty(narrowed, key)
  return narrowed
}

/** A message from this app, not the user's data: any credential it echoes is
 * masked, and so is everything `scrubLocalString` already covers. */
function scrubMessage(value: unknown): string {
  return typeof value === 'string' ? scrubLocalString(value).replace(CREDENTIAL, '$1[redacted]') : ''
}

/** One frame this app can act on: the bundle the browser loaded, its line and
 * column, and the function name. Frames the SDK cannot attribute to this app's
 * own code (extensions, other origins) are dropped rather than guessed at, and
 * so is every other frame field the SDK attaches. */
function scrubbedFrame(frame: unknown) {
  if (!frame || typeof frame !== 'object') return null
  const record = frame as Record<string, unknown>
  if (record.in_app !== true) return null
  const filename = typeof record.filename === 'string' ? scrubLocalString(record.filename) : ''
  if (!filename) return null
  return {
    platform: 'web:javascript', in_app: true, filename,
    function: typeof record.function === 'string' ? scrubLocalString(record.function).slice(0, 128) : '?',
    ...(Number.isSafeInteger(record.lineno) ? { lineno: record.lineno } : {}),
    ...(Number.isSafeInteger(record.colno) ? { colno: record.colno } : {}),
  }
}

/** One entry of PostHog's own `$exception_list`: what an issue groups by (type
 * and message), whether the SDK called it handled, and the in-app stack. Chain
 * identifiers, breadcrumbs and coercion context (`cause`, `errors`) are not
 * kept: they echo the values that made the error. */
function scrubbedException(entry: unknown) {
  if (!entry || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const type = typeof record.type === 'string' && EXCEPTION_TYPE.test(record.type) ? record.type : 'Error'
  const mechanism = record.mechanism && typeof record.mechanism === 'object' ? record.mechanism as Record<string, unknown> : {}
  const stacktrace = record.stacktrace && typeof record.stacktrace === 'object' ? record.stacktrace as Record<string, unknown> : {}
  const frames = (Array.isArray(stacktrace.frames) ? stacktrace.frames : []).map(scrubbedFrame).filter(frame => frame !== null).slice(0, EXCEPTION_FRAME_LIMIT)
  return {
    type,
    value: scrubMessage(record.value) || type,
    mechanism: {
      type: typeof mechanism.type === 'string' && EXCEPTION_TYPE.test(mechanism.type) ? mechanism.type : 'generic',
      handled: mechanism.handled !== false,
      synthetic: mechanism.synthetic === true,
    },
    ...(frames.length ? { stacktrace: { type: 'raw', frames } } : {}),
  }
}

/** PostHog's exception autocapture (`capture_exceptions`) is the product's only
 * crash telemetry: a render error, a throwing handler or an unhandled rejection
 * arrives here and nowhere else. An event without a usable entry is dropped. */
function sanitizeExceptionEvent<T extends { event: string; properties: Record<string, unknown> }>(event: T): T | null {
  const list = event.properties.$exception_list
  const entries = (Array.isArray(list) ? list.slice(0, EXCEPTION_LIST_LIMIT) : []).map(scrubbedException).filter(entry => entry !== null)
  if (!entries.length) return null
  const level = event.properties.$exception_level
  return narrow(event, {
    $exception_list: entries,
    ...(typeof level === 'string' && exceptionLevels.has(level) ? { $exception_level: level } : {}),
  })
}

export function sanitizeAnalyticsEvent<T extends { event: string; properties: Record<string, unknown> }>(event: T | null): T | null {
  if (!event) return null
  if (event.event === '$exception') return sanitizeExceptionEvent(event)
  if (event.event !== '$snapshot' && !allowedEvents.has(event.event)) return null
  // rrweb masks the DOM before serialization (instrumentation-client.ts).
  // Its transport needs the opaque snapshot payload and session identifiers;
  // every other event goes through the narrow allowlist instead.
  if (event.event === '$snapshot') {
    const browserType = event.properties.$browser_type
    const classification = browserType === 'bot' || browserType === 'browser' ? { $browser_type: browserType } : {}
    const keys = new Set(['token', 'distinct_id', '$session_id', '$window_id', '$lib', '$lib_version', '$snapshot_bytes', '$snapshot_data'])
    const snapshot = { ...event, properties: { ...Object.fromEntries(Object.entries(event.properties).filter(([key]) => keys.has(key))), ...classification } }
    for (const key of ['$set', '$set_once', '$unset']) Reflect.deleteProperty(snapshot, key)
    return snapshot
  }
  return narrow(event)
}
