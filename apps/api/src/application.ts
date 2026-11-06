import { Hono } from 'hono'
import { H3, onDispose } from 'h3'
import { NextRequest } from '../compat/server'
import { NavigationResponse } from '../compat/navigation'
import { allowedMethods, routeMatcher, routerPath, type ApiRoute } from './routes'
import { createRequestScope, requireRequestScope, runRequestScope } from './context'
import { trailingSlashRedirect } from '../runtime/http-policy.mjs'

type Trace = { run<T>(work: () => T): T; finish(status: number, error?: unknown): void }
type TraceFactory = (request: Request, route: string) => Trace
const noTrace: TraceFactory = () => ({ run: work => work(), finish() {} })
const failure = (status: number) => Response.json({ error: status === 404 ? 'Not found' : 'Request failed' }, { status, headers: { 'cache-control': 'no-store' } })

/** Hono owns route dispatch; H3 owns real Node/Web-stream disposal. Neither
 * resolving a handler nor Nitro's onResponse means the body has finished. */
export function createApiHandler(routes: ApiRoute[], beginTrace: TraceFactory = noTrace) {
  const matchers = routes.map(routeMatcher)
  const router = new Hono({ strict: true })
  for (const route of routes) {
    const match = routeMatcher(route)
    router.all(routerPath(route.path), async context => {
      const original = context.req.raw
      const matched = match(new URL(original.url).pathname)
      if (!matched) return failure(404)
      const method = original.method.toUpperCase()
      if (method === 'OPTIONS' && !route.methods.includes('OPTIONS')) {
        return new Response(null, { status: 204, headers: { allow: allowedMethods(route).join(', ') } })
      }
      const selected = method === 'HEAD' && !route.methods.includes('HEAD') && route.methods.includes('GET') ? 'GET' : method
      if (!route.methods.includes(selected)) return new Response(null, { status: 405, headers: { allow: allowedMethods(route).join(', ') } })
      const module = await route.load()
      const handler = module[selected]
      if (typeof handler !== 'function') throw new Error('API_ROUTE_EXPORT_MISSING')
      const response: unknown = await handler(new NextRequest(original), { params: Promise.resolve(matched.params) })
      if (!(response instanceof Response)) throw new TypeError('API_ROUTE_RESPONSE_REQUIRED')
      if (method !== 'HEAD') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers })
    })
  }
  router.notFound(() => failure(404))
  // Keep failures in the outer scope, where tracing and cookie commitment are
  // shared by all dispatch outcomes. Never expose stack traces or raw errors.
  router.onError(error => { throw error })
  const app = new H3()
  app.all('/**', async event => {
    const original = event.req
    const canonical = trailingSlashRedirect(original)
    if (canonical) return canonical
    const scope = createRequestScope(original)
    let template = '/unmatched', result: Response | undefined, caught: unknown
    try {
      const path = new URL(original.url).pathname
      for (const match of matchers) {
        const found = match(path)
        if (found) { template = found.route.template; break }
      }
    } catch { return failure(400) }
    const trace = beginTrace(original, template)
    // Register before work/output: Node and Vercel retain the entire lifetime,
    // including tasks registered during handler execution and nested after().
    event.waitUntil(scope.after.lifetime)
    onDispose(event, reason => {
      trace.finish(result?.status ?? 500, caught ?? reason)
      return scope.after.finish()
    })
    return runRequestScope(scope, () => trace.run(async () => {
      try { result = await router.fetch(original) }
      catch (error) {
        if (error instanceof NavigationResponse) {
          result = error.location ? new Response(null, { status: error.status, headers: { location: error.location } }) : failure(error.status)
        } else {
          caught = error
          console.error('api_route_failed', { name: error instanceof Error ? error.name : 'UnknownError', route: template })
          result = failure(500)
        }
      }
      const headers = new Headers(result.headers)
      requireRequestScope().cookies.commit(headers)
      return new Response(result.body, { status: result.status, statusText: result.statusText, headers })
    }))
  })
  return app
}
