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
function requestLocale(request: Request, cookies: CookieJar): Locale {
  const explicit = request.headers.get('x-mikka-locale')
  if (explicit === 'en' || explicit === 'zh-CN') return explicit
  const stored = cookies.get('NEXT_LOCALE')?.value
  if (stored === 'en' || stored === 'zh-CN') return stored
  // Nobody has chosen yet. A browser that asks for English is not a Chinese
  // user who forgot to switch: serve English. Every other case keeps the
  // previous fallback, so this only changes the outcome for English speakers.
  return prefersEnglish(request.headers.get('accept-language')) ? 'en' : 'zh-CN'
}

/** True when the browser's own preference list ranks a supported English tag
 *  above any Chinese one. Equal weights keep the first tag, as browsers mean
 *  them to, so `zh-CN,en;q=0.9` stays Chinese. */
function prefersEnglish(header: string | null): boolean {
  if (!header) return false
  let best: { weight: number; locale: Locale } | undefined
  for (const part of header.split(',')) {
    const [tag, ...params] = part.trim().toLowerCase().split(';')
    const locale: Locale | undefined = tag === 'en' || tag.startsWith('en-') ? 'en'
      : tag === 'zh' || tag.startsWith('zh-') ? 'zh-CN'
        : undefined
    if (!locale) continue
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='))
    const weight = q ? Number.parseFloat(q.slice(2)) : 1
    if (!Number.isFinite(weight) || weight <= 0) continue
    if (!best || weight > best.weight) best = { weight, locale }
  }
  return best?.locale === 'en'
}
export function createRequestScope(request: Request): RequestScope {
  const cookies = new CookieJar(request.headers.get('cookie'))
  return { request, headers: new Headers(request.headers), cookies,
    locale: requestLocale(request, cookies), after: new AfterQueue(), memo: new Map() }
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
