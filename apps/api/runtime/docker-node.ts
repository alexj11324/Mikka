import type { IncomingMessage, ServerResponse } from 'node:http'
import { serve } from 'srvx/node'
import type { ServerRequest } from 'srvx'
import { dockerRequestUrl } from '../../../scripts/test-accounts/docker-ingress.mjs'
import { dockerOrigin } from '../../../scripts/test-accounts/docker-target.mjs'

type Application = { fetch(request: ServerRequest): Response | Promise<Response> }
type Options = { origin: string; onClose: () => void | Promise<void> }

function assertOrigin(origin: string): void {
  const match = /^https:\/\/3000-([a-z0-9]+)\.sbx\.sandboxes-cloud\.docker\.com$/.exec(origin)
  if (!match || dockerOrigin(`sbx_${match[1]}`, 3000) !== origin) throw new Error('DOCKER_RUNTIME_ORIGIN_INVALID')
}

/** Embeds the entire compiled Nitro application in the separately attested
 * Docker HTTP owner. This factory never listens or installs signal handlers.
 * The owner retains HTTP/WS ingress, descriptor/DB proof and server shutdown;
 * only its exact gateway allowlist may handle upgrades outside this adapter. */
export function createDockerNodeRuntime(application: Application, { origin, onClose }: Options) {
  assertOrigin(origin)
  if (typeof onClose !== 'function') throw new Error('DOCKER_RUNTIME_CLOSE_REQUIRED')
  const urls = new WeakMap<IncomingMessage, string>()
  const active = new Set<Promise<void>>()
  let closing: Promise<void> | undefined
  const runtime = serve({
    manual: true, gracefulShutdown: false, silent: true,
    hostname: '127.0.0.1', port: 0, trustProxy: false,
    fetch(request) {
      const node = request.runtime?.node
      const absolute = node && urls.get(node.req as IncomingMessage)
      if (!absolute || !node?.res || typeof request.waitUntil !== 'function') throw new Error('DOCKER_RUNTIME_NODE_CONTEXT_REQUIRED')
      // This is srvx's documented parsed-URL property. It is set before any
      // application read; the same real NodeRequest retains body, abort signal,
      // req/res disposal and the SDK's server-owned waitUntil implementation.
      request._url = new URL(absolute)
      if (request.url !== absolute) throw new Error('DOCKER_RUNTIME_REQUEST_URL_MISMATCH')
      return application.fetch(request)
    },
  })
  const node = runtime.node
  if (!node?.handler || !node.server || node.server.listening) throw new Error('DOCKER_RUNTIME_EMBEDDING_INVALID')
  const nodeHandler = node.handler

  function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) {
      response.writeHead(503, { 'Cache-Control': 'no-store' }); response.end()
      return Promise.resolve()
    }
    let absolute: string
    try { absolute = dockerRequestUrl(request, origin) }
    catch {
      response.writeHead(400, { 'Cache-Control': 'no-store' }); response.end()
      return Promise.resolve()
    }
    urls.set(request, absolute)
    // A handler resolving is not proof that its stream reached completion.
    // Keep the real response close and its invocation in the close barrier.
    const closed = response.destroyed ? Promise.resolve() : new Promise<void>(resolve => response.once('close', resolve))
    let dispatched: Promise<void>
    try { dispatched = Promise.resolve(nodeHandler(request, response)) }
    catch (error) { dispatched = Promise.reject(error) }
    const completed = Promise.all([closed, dispatched]).then(() => undefined)
    active.add(completed)
    void completed.catch(() => {}).finally(() => { active.delete(completed); urls.delete(request) })
    return dispatched
  }

  function close(): Promise<void> {
    if (closing) return closing
    closing = (async () => {
      try {
        // The owning HTTP server stops accepting and closes/drains its exact
        // sockets first. Request scopes register after lifetimes before output;
        // await actual response disposal before draining the SDK's pending set.
        await Promise.all(active)
        await runtime.close()
      } finally {
        await onClose()
      }
    })()
    return closing
  }

  return Object.freeze({ handle, close })
}
