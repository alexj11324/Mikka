import { Hono } from 'hono'
import { H3, onDispose } from 'h3'
import { NextRequest } from '../compat/server'
import { NavigationResponse } from '../compat/navigation'
import { allowedMethods, routeMatcher, routerPath, type ApiRoute } from './routes'
import { createRequestScope, requireRequestScope, runRequestScope } from './context'
import { trailingSlashRedirect } from '../runtime/http-policy.mjs'
import type { PrepareWebTransport, WebTransport } from '../../../lib/web-connection/transport'

type Trace = { run<T>(work: () => T): T; finish(status: number, error?: unknown): void }
type TraceFactory = (request: Request, route: string) => Trace
const noTrace: TraceFactory = () => ({ run: work => work(), finish() {} })
const failure = (status: number) => Response.json({ error: status === 404 ? 'Not found' : 'Request failed' }, { status, headers: { 'cache-control': 'no-store' } })

/** Hono owns route dispatch; H3 owns real Node/Web-stream disposal. Neither
 * resolving a handler nor Nitro's onResponse means the body has finished. */
export function createApiHandler(routes: ApiRoute[], beginTrace: TraceFactory = noTrace, prepareWebTransport?: PrepareWebTransport) {
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
    let template = '/unmatched', result: Response | undefined, caught: unknown
    try {
      const path = new URL(original.url).pathname
      for (const match of matchers) {
        const found = match(path)
        if (found) { template = found.route.template; break }
      }
    } catch { return failure(400) }
    const trace = beginTrace(original, template)
    // Authentication and transport refusals are part of the original request.
    // Register trace disposal before preparation can return or reject.
    onDispose(event, reason => {
      trace.finish(result?.status ?? 500, caught ?? reason)
    })
    return trace.run(async () => {
      let prepared: WebTransport | Response | null | undefined
      const serviceBearer = /^Bearer\s+mksvc_/i.test(original.headers.get('authorization') ?? '')
      const serviceProjectRead = template === '/api/service-identity/projects'
        || (template === '/api/service-identity/projects/[projectId]' && original.method === 'GET')
      if (serviceBearer && !serviceProjectRead) {
        result = failure(401)
        return result
      }
      // Service authentication consumes its original bearer; a selected web
      // connection or ambient human cookie cannot substitute for that principal.
      try { prepared = serviceBearer ? null : await prepareWebTransport?.(original, template) }
      catch (error) {
        caught = error
        throw error
      }
      if (prepared instanceof Response) { result = prepared; return prepared }
      const transport: WebTransport | null = prepared ?? null
      const request = transport?.request ?? original
      const scope = createRequestScope(request)
      // The adapted request owns the business scope. H3 invokes disposal in
      // registration order: end its trace, then drain after work and nested after().
      event.waitUntil(scope.after.lifetime)
      onDispose(event, () => scope.after.finish())
      const dispatch = () => runRequestScope(scope, async () => {
        try { result = await router.fetch(request) }
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
        const response = new Response(result.body, { status: result.status, statusText: result.statusText, headers })
        return transport ? transport.response(response) : response
      })
      return transport ? transport.run(dispatch) : dispatch()
    })
  })
  return app
}
