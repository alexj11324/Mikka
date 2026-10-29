// Diagnostics are fixed categories, never browser text, credentials or URLs.
// The ordinary runtime guard still decides failure; this only explains it.
const ROUTES = new Map([
  ['/mikka', 'workspace'], ['/mikka/sign-in', 'sign-in'], ['/mikka/sign-up', 'sign-up'],
  ['/mikka/api/auth/get-session', 'auth-session'], ['/mikka/api/auth/sign-out', 'auth-sign-out'],
  ['/mikka/api/workspace', 'workspace-api'], ['/mikka/api/test-environment', 'test-environment'],
  ['/mikka/api/coordinator/messages', 'coordinator-messages'],
  ['/mikka/api/integrations/linear/status', 'linear-status'],
])
const NETWORK_ERRORS = new Set([
  'ERR_BLOCKED_BY_CLIENT', 'ERR_FAILED', 'ERR_ABORTED', 'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_EMPTY_RESPONSE',
  'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT',
])
const TEST_FILES = new Set([
  'tests/mvp/core-loop.spec.ts', 'tests/mvp/accounts.ts',
  'tests/e2e/test-account-fixtures.ts', 'tests/e2e/test-account-pool.spec.ts',
  'tests/e2e/settings-surface.spec.ts', 'tests/e2e/linear-sync-disabled.spec.ts',
])

export function browserRouteClass(value, origin) {
  try {
    const url = new URL(value)
    if (url.username || url.password) return 'credential-url'
    if (url.origin !== origin) return 'other-origin'
    const path = url.pathname.replace(/\/$/, '')
    if (ROUTES.has(path)) return ROUTES.get(path)
    if (/^\/mikka\/_next\/static\/chunks\/[^/]+\.js$/.test(path)) return 'next-chunk'
    if (path.startsWith('/mikka/_next/static/')) return 'next-static'
    if (/^\/mikka\/api\/conversations\/[^/]+\/read$/.test(path)) return 'conversation-read'
    return 'same-origin-other'
  } catch { return 'unknown-location' }
}

export function browserConsoleDiagnostic(message, location, origin) {
  const text = typeof message === 'string' ? message : ''
  const route = browserRouteClass(location, origin)
  const http = /^Failed to load resource: the server responded with a status of ([45]\d\d)(?: \([A-Za-z ]*\))?$/.exec(text)
  if (http) return { category: 'resource-http', status: Number(http[1]), route }
  const network = /^Failed to load resource: net::(ERR_[A-Z_]+)$/.exec(text)
  if (network && NETWORK_ERRORS.has(network[1])) return { category: 'resource-network', code: network[1], route }
  const react = /^Minified React error #(\d{1,4});/.exec(text)
  if (react) return { category: 'react-minified', code: Number(react[1]), route }
  return { category: 'console-error', route }
}

export function browserResponseDiagnostic(status, location, origin) {
  return { category: 'http-response', status: Number.isInteger(status) && status >= 400 && status < 600 ? status : null, route: browserRouteClass(location, origin) }
}

export function browserTestErrorDiagnostic(error) {
  const message = typeof error?.message === 'string' ? error.message : ''
  const stack = typeof error?.stack === 'string' ? error.stack : ''
  const category = /\btimeout\b|\btimed out\b/i.test(message) ? 'timeout'
    : /\bexpect\(|\bAssertionError\b/.test(message) ? 'assertion' : 'test-error'
  let location = null
  for (const match of stack.replaceAll('\\', '/').matchAll(/\b(tests\/(?:mvp|e2e)\/[A-Za-z0-9.-]+\.ts):(\d{1,6}):(\d{1,5})\b/g)) {
    if (TEST_FILES.has(match[1])) { location = { file: match[1], line: Number(match[2]), column: Number(match[3]) }; break }
  }
  return { category, location }
}
