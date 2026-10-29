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
  'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT', 'ERR_BLOCKED_BY_ORB', 'ERR_BLOCKED_BY_RESPONSE',
  'ERR_INVALID_RESPONSE', 'ERR_INSUFFICIENT_RESOURCES',
])
// Fixed CDP response-block reasons and Chromium's shortened console names.
const BLOCKED_RESPONSE_REASONS = new Set([
  'CoepFrameResourceNeedsCoepHeader', 'CoopSandboxedIFrameCannotNavigateToCoopPage',
  'CorpNotSameOrigin', 'CorpNotSameOriginAfterDefaultedToSameOriginByCoep',
  'CorpNotSameOriginAfterDefaultedToSameOriginByDip', 'CorpNotSameOriginAfterDefaultedToSameOriginByCoepAndDip',
  'CorpNotSameSite', 'SRIMessageSignatureMismatch',
  'NotSameOrigin', 'NotSameOriginAfterDefaultedToSameOriginByCoep', 'NotSameSite',
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
    if (url.origin === 'https://github.com' && url.pathname === '/favicon.ico') return 'github-favicon'
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
  const text = typeof message === 'string' ? message.slice(0, 8192) : ''
  const route = browserRouteClass(location, origin)
  const http = /^Failed to load resource: the server responded with a status of ([45]\d\d)(?: \([A-Za-z ]*\))?$/.exec(text)
  if (http) return { category: 'resource-http', status: Number(http[1]), route }
  const network = /^Failed to load resource: net::(ERR_[A-Z_]+)(?:\.([A-Za-z]+))?$/.exec(text)
  if (network && NETWORK_ERRORS.has(network[1]) && (!network[2] || (network[1] === 'ERR_BLOCKED_BY_RESPONSE' && BLOCKED_RESPONSE_REASONS.has(network[2])))) {
    return { category: 'resource-network', code: network[1], ...(network[2] ? { reason: network[2] } : {}), route }
  }
  const react = /^Minified React error #(\d{1,4});/.exec(text)
  if (react) return { category: 'react-minified', code: Number(react[1]), route }
  if (text.startsWith('Mixed Content:')) return { category: 'mixed-content', route }
  if (/^Unsafe attempt to load URL\b/.test(text)) return { category: 'unsafe-resource-url', route }
  if (/\bCross-Origin-Resource-Policy\b/.test(text)) return { category: 'cross-origin-resource-policy', route }
  if (/\bContent Security Policy\b/.test(text)) return { category: 'content-security-policy', route }
  if (/\bblocked by CORS policy:|^Cross-Origin Request Blocked:/.test(text)) return { category: 'cors-policy', route }
  if (/^(?:Refused to (?:execute script|apply style)|Failed to load module script:)[\s\S]*\bMIME type\b/.test(text)) return { category: 'resource-mime', route }
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
