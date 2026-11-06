import { AsyncLocalStorage } from 'node:async_hooks'
import { AfterQueue } from './after'
import { CookieJar } from './cookies'

export type Locale = 'zh-CN' | 'en'
type Memo = { children: Map<unknown, Memo>; result?: { value: unknown; error: boolean } }
export type RequestScope = {
  request: Request
  headers: Headers
  cookies: CookieJar
  locale: Locale
  after: AfterQueue
  memo: Map<Function, Memo>
}
const storage = new AsyncLocalStorage<RequestScope>()
export function currentRequestScope(): RequestScope | undefined { return storage.getStore() }
export function requireRequestScope(): RequestScope {
  const scope = currentRequestScope()
  if (!scope) throw new Error('API_REQUEST_SCOPE_REQUIRED')
  return scope
}
export function requestLocale(request: Request): Locale {
  const explicit = request.headers.get('x-mikka-locale')
  if (explicit === 'en' || explicit === 'zh-CN') return explicit
  return new CookieJar(request.headers.get('cookie')).get('NEXT_LOCALE')?.value === 'en' ? 'en' : 'zh-CN'
}
export function createRequestScope(request: Request): RequestScope {
  return { request, headers: new Headers(request.headers), cookies: new CookieJar(request.headers.get('cookie')),
    locale: requestLocale(request), after: new AfterQueue(), memo: new Map() }
}
export function runRequestScope<T>(scope: RequestScope, work: () => T): T { return storage.run(scope, work) }
export function bindRequestCallback<T>(work: () => T): () => T {
  requireRequestScope()
  // Capture all ALS, including tracing and a retained database request scope.
  return AsyncLocalStorage.bind(work)
}
export function requestCache<Args extends unknown[], Result>(work: (...args: Args) => Result): (...args: Args) => Result {
  return (...args) => {
    const scope = currentRequestScope()
    if (!scope) return work(...args)
    let entry = scope.memo.get(work)
    if (!entry) { entry = { children: new Map() }; scope.memo.set(work, entry) }
    for (const argument of args) {
      let child = entry.children.get(argument)
      if (!child) { child = { children: new Map() }; entry.children.set(argument, child) }
      entry = child
    }
    if (!entry.result) {
      try { entry.result = { value: work(...args), error: false } }
      catch (error) { entry.result = { value: error, error: true } }
    }
    if (entry.result.error) throw entry.result.value
    return entry.result.value as Result
  }
}
