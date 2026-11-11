import { timingSafeEqual } from 'node:crypto'
import { apiRequest } from './request.mjs'

const no = status => new Response(null, { status, headers: { 'cache-control': 'no-store' } })
const eveProductHeaders = new Set([
  'x-mikka-bot-id', 'x-mikka-submission-id', 'x-mikka-evaluation-id', 'x-mikka-workspace-id', 'x-mikka-locale',
])
const flowPath = '/.well-known/workflow/v1/flow'
const worldMethods = new Map([
  ['/world/rpc', ['POST']], ['/world/run-terminal', ['GET']], ['/world/stream', ['GET', 'DELETE']],
  ['/world/queue/publish', ['POST']], ['/world/queue/claim', ['POST']], ['/world/queue/release', ['POST']],
])

export function businessWorldRequest(request, binding, capability) {
  const url = new URL(request.url)
  if (url.origin !== 'https://world.internal' || url.username || url.password || url.hash
      || !worldMethods.get(url.pathname)?.includes(request.method)) return no(404)
  const presented = request.headers.get('x-mikka-world-capability') ?? ''
  if (!capability || presented.length !== capability.length || !/^[a-zA-Z0-9-]+$/.test(presented)
      || !timingSafeEqual(new TextEncoder().encode(presented), new TextEncoder().encode(capability))) return no(403)
  if (!binding) return no(503)
  const headers = new Headers()
  for (const name of ['accept', 'content-type']) if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  if (request.headers.get('accept-encoding') === 'identity') headers.set('accept-encoding', 'identity')
  return binding.fetch(new Request(request, { headers, redirect: 'manual' }))
}

export function eveServiceRequest(request, binding) {
  const url = new URL(request.url)
  if (url.origin !== 'https://eve.internal' || url.username || url.password || url.hash
      || !url.pathname.startsWith('/eve/v1/') || /%2f|%5c|%2e/i.test(url.pathname)) return no(404)
  if (!binding) return no(503)
  const headers = new Headers(request.headers)
  for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim())
  for (const name of [...headers.keys()]) {
    if (['connection', 'forwarded', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te',
      'trailer', 'transfer-encoding', 'upgrade', 'cf-connecting-ip', 'cf-container-target-port', 'x-real-ip'].includes(name)
        || name.startsWith('x-forwarded-') || name.startsWith('x-vercel-')
        || (name.startsWith('x-mikka-') && !eveProductHeaders.has(name))) headers.delete(name)
  }
  return binding.fetch(new Request(request, { headers, redirect: 'manual' }))
}

export async function businessWorkflowDelivery(request, env, send) {
  const url = new URL(request.url)
  if (url.href !== 'https://business-workflow.internal' + flowPath || request.method !== 'POST') return no(404)
  if (!env.BUSINESS_WORLD) return no(503)
  const revision = env.MIKKA_DEPLOYMENT_ID
  if (!revision || request.headers.get('x-mikka-eve-release') !== revision) return no(409)
  const headers = new Headers()
  for (const name of ['content-type', 'x-mikka-eve-release', 'cf-queue-retry-count', 'x-mikka-queue-time', 'x-mikka-queue-signature']) {
    const value = request.headers.get(name)
    if (!value) return no(403)
    headers.set(name, value)
  }
  // The official World adapter in this exact Node image checks the signature
  // against the original bytes. The queue consumer checks the returned revision.
  const internal = new Request(new URL(flowPath, env.PUBLIC_ORIGIN), request)
  const forwarded = apiRequest(new Request(internal, { headers, redirect: 'manual' }), env.PUBLIC_ORIGIN)
  if (!forwarded) return no(503)
  return send(forwarded)
}

export function publicWorkflowDispatch(url) {
  let path
  try { path = decodeURIComponent(new URL(url).pathname) } catch { return true }
  return /^\/(?:mikka\/)?\.well-known\/workflow\/v1\/(?:flow|step)\/?$/.test(path)
}
