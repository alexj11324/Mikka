/**
 * The current request's headers and cookie jar.
 *
 * `headers()` is read-only: a handler cannot rewrite the request it was given.
 * `cookies()` returns the request's journal, whose `commit` writes the response
 * Set-Cookie fields at the response boundary.
 */
import { currentRequestScope } from '../../apps/api/src/context'

class ReadonlyHeaders extends Headers {
  override set(): never { throw new TypeError('API_REQUEST_HEADERS_READONLY') }
  override append(): never { throw new TypeError('API_REQUEST_HEADERS_READONLY') }
  override delete(): never { throw new TypeError('API_REQUEST_HEADERS_READONLY') }
}
export async function headers(): Promise<Headers> {
  const scope = currentRequestScope()
  if (!scope) throw new Error('`headers` was called outside a request scope.')
  return new ReadonlyHeaders(scope.headers)
}
export async function cookies() {
  const scope = currentRequestScope()
  // Better Auth's cookie plugin recognizes this boundary and leaves
  // non-request/background work alone.
  if (!scope) throw new Error('`cookies` was called outside a request scope.')
  return scope.cookies
}
