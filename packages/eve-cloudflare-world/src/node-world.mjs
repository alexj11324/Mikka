import { createBoundFetch } from './bound-fetch.mjs'
import { createNodeQueue } from './node-queue.mjs'
import { createNodeStreamReader } from './node-stream-reader.mjs'
import { decodeRecord, encodeRecord } from './records.mjs'
import { admissionCapabilities, createAdmissionStorage } from './storage-client.mjs'

/** The official Workflow loader calls createWorld() in the shared Node host.
 * Outbound interception binds world.internal to the private WorldService.
 * The release service owns the namespace; no HTTP client supplies it. */
export function createNodeWorld({ deploymentId, signingKey, verificationKey, fetchBound, workload = 'eve' }) {
  const invoke = async (method, ...args) => {
    const reply = await fetchBound('https://world.internal/world/rpc', {
      method: 'POST', headers: { 'content-type': 'application/cbor' }, body: encodeRecord([method, ...args]),
    })
    if (!reply.ok) throw new Error('Private World RPC failed: ' + reply.status)
    return decodeRecord(await reply.arrayBuffer())
  }
  const methods = Object.fromEntries(['run', 'runs', 'hook', 'hookByToken', 'hooks', 'step', 'steps', 'create', 'event', 'events']
    .map(method => [method, (...args) => invoke(method, ...args)]))
  methods.waitTerminal = async (runId, options) => {
    const url = new URL('https://world.internal/world/run-terminal')
    url.search = new URLSearchParams({ runId, timeoutMs: String(options.timeoutMs ?? 10_000) })
    const reply = await fetchBound(url, { signal: options.signal })
    if (!reply.ok) throw new Error('Private World terminal subscription failed: ' + reply.status)
    return decodeRecord(await reply.arrayBuffer())
  }
  return {
    specVersion: 8,
    capabilities: { ...admissionCapabilities, deploymentAffinity: true, hookRetention: { active: true } },
    ...createAdmissionStorage(methods),
    ...createNodeQueue({ deploymentId, signingKey, verificationKey, fetchBound, workload }),
    streams: {
      get: createNodeStreamReader(fetchBound),
      write: (run, name, chunk) => invoke('write', run, name, chunk),
      close: (run, name) => invoke('close', run, name),
      list: run => invoke('list', run),
      getChunks: (run, name, options) => invoke('getChunks', run, name, options),
      getInfo: (run, name) => invoke('getInfo', run, name),
    },
  }
}

export function createWorld() {
  return createNodeWorld({ deploymentId: process.env.MIKKA_DEPLOYMENT_ID,
    signingKey: process.env.EVE_QUEUE_SIGNING_KEY,
    verificationKey: process.env.MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY ? 'ed25519-public:' + process.env.MIKKA_WORKFLOW_QUEUE_PUBLIC_KEY : undefined,
    fetchBound: createBoundFetch(process.env.MIKKA_EVE_WORLD_TOKEN) })
}
