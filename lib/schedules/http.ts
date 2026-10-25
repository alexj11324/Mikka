/** Next standalone may normalize Request.url to an internal host. Bind browser
 * requests to the configured public origin AND the actual Host header, never
 * a client-controlled forwarded host. */
export function scheduleOriginAllowed(request: Request, configuredOrigin?: string) {
  if (!request.headers.get('cookie')) return true
  try {
    const expected = new URL(configuredOrigin ?? request.url)
    const actual = new URL(request.headers.get('origin') ?? '')
    return actual.origin === expected.origin && request.headers.get('host') === expected.host
  } catch { return false }
}
