import { WorkerEntrypoint } from 'cloudflare:workers'
import { liteLlmRequest } from '../../api/ingress/services.mjs'
import { productRequest } from '../runtime/product.mjs'
import { singletonContainerName } from '../runtime/config.mjs'
export { EveRuntime } from './index.mjs'
export { ContainerProxy } from '@cloudflare/containers'

const missing = () => new Response(null, { status: 404 })

export class LiteLlmOutbound extends WorkerEntrypoint {
  fetch(request) { return liteLlmRequest(request, this.env.LITELLM) }
}

export class EveProductOutbound extends WorkerEntrypoint {
  fetch(request) {
    return productRequest(request, this.env.BUSINESS_API, this.env.EVE_PUBLIC_ORIGIN, this.ctx.props.capability, this.ctx)
  }
}

function forward(request, env, headers) {
  const source = new URL(request.url)
  const target = new URL(env.EVE_PUBLIC_ORIGIN)
  target.pathname = source.pathname
  target.search = source.search
  headers.set('x-forwarded-host', target.host)
  headers.set('x-forwarded-proto', 'https')
  const forwarded = new Request(target, {
    method: request.method, headers, signal: request.signal, redirect: 'manual',
    ...(request.body ? { body: request.body, duplex: 'half' } : {}),
  })
  const { EVE_RELEASE_ID: name = singletonContainerName } = env
  return env.EVE_RUNTIME.getByName(name).fetch(forwarded)
}

export class EveService extends WorkerEntrypoint {
  fetch(request) {
    const url = new URL(request.url)
    if (url.origin !== 'https://eve.internal' || !url.pathname.startsWith('/eve/v1/') || /%2e|%2f|%5c/i.test(url.pathname)) return missing()
    const headers = new Headers(request.headers)
    for (const name of ['forwarded', 'host', 'cf-container-target-port', 'proxy-authorization', 'x-real-ip', 'x-mikka-world-capability', 'x-mikka-product-capability']) headers.delete(name)
    for (const name of request.headers.keys()) {
      if (name.startsWith('x-forwarded-') || name.startsWith('x-vercel-') || name.startsWith('cf-')) headers.delete(name)
    }
    headers.delete('x-mikka-eve-binding-scope')
    const scope = headers.get('x-mikka-eve-scope')
    headers.delete('x-mikka-eve-scope')
    if (scope) headers.set('x-mikka-eve-binding-scope', scope)
    return forward(request, this.env, headers)
  }
}

export default { fetch: missing }
