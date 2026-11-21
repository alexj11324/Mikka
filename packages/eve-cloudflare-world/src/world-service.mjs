import { WorkerEntrypoint } from 'cloudflare:workers'
import { decodeRecord } from './records.mjs'
import { serveQueueRequest } from './queue-service.mjs'
import { createStreamStorage, serveStreamRequest } from './streams.mjs'
import { cbor, waitForTerminal } from './terminal.mjs'

// These named methods are the only operations accessible from a hosted Eve
// container's private outbound intercept. No caller selects an authority shard.
const storageMethods = new Set(['create', 'run', 'runs', 'hook', 'hookByToken', 'hooks', 'event', 'events', 'step', 'steps'])
const streamMethods = new Set(['write', 'close', 'list', 'getChunks', 'getInfo'])

async function serveBoundWorld(request, env, workload) {
  if ((env.WORLD_WORKLOAD ?? 'eve') !== workload) return new Response(null, { status: 404 })
  const { pathname, hostname } = new URL(request.url)
  if (hostname !== 'world.internal') return new Response(null, { status: 404 })
  if (pathname.startsWith('/world/queue/')) return serveQueueRequest(request, env)
  if (pathname === '/world/stream') return serveStreamRequest(request, env.EVE_STREAMS, workload)
  const namespace = env.EVE_WORLD_NAMESPACE
  if (typeof namespace !== 'string' || !namespace) return new Response(null, { status: 503 })
  const authority = () => env.EVE_WORLD.getByName(workload === 'eve' ? namespace : JSON.stringify([workload, namespace]))
  if (pathname === '/world/run-terminal' && request.method === 'GET') return waitForTerminal(authority(), request)
  if (pathname !== '/world/rpc' || request.method !== 'POST') return new Response(null, { status: 404 })
  const [method, ...args] = decodeRecord(await request.arrayBuffer())
  if (storageMethods.has(method)) return cbor(await authority()[method](...args))
  if (streamMethods.has(method)) return cbor(await createStreamStorage(env.EVE_STREAMS, { workload })[method](...args))
  return new Response(null, { status: 404 })
}

export class WorldService extends WorkerEntrypoint {
  fetch(request) { return serveBoundWorld(request, this.env, 'eve') }
}

export class BusinessWorldService extends WorkerEntrypoint {
  fetch(request) { return serveBoundWorld(request, this.env, 'business') }
}
