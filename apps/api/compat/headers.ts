import { currentRequestScope } from '../src/context'

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
  // Better Auth's official nextCookies integration recognizes this original
  // boundary and leaves non-request/background work alone.
  if (!scope) throw new Error('`cookies` was called outside a request scope.')
  return scope.cookies
}
