import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createBoundFetch } from '../src/bound-fetch.mjs'
import { authenticateDelivery, bodyDigest, deliveryHeaders } from '../src/queue-auth.mjs'
import { createNodeWorld } from '../src/node-world.mjs'

const require = createRequire(import.meta.url)
const { Miniflare, convertV4MiniflareOptions } = createRequire(realpathSync(require.resolve('wrangler/package.json')))('miniflare')
let runtime, directory, world, outbound, business
const deploymentId = 'aaa1111-10-1'
const signingKey = randomBytes(32).toString('hex')
const spec = { specVersion: 8 }
const capability = randomBytes(32).toString('hex')
const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'jwk' }).x
const publicMaterial = 'ed25519-public:' + Buffer.from(publicKey, 'base64url').toString('base64')
const privateMaterial = 'ed25519-pkcs8:' + keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eve-node-world-'))
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/authority.mjs', import.meta.url))], bundle: true,
    write: false, platform: 'browser', format: 'esm', external: ['cloudflare:workers', 'node:*'] })
  const common = { modules: true, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat','enable_request_signal'] }
  runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0, resourcePersistencePath: directory, workers: [
    { ...common, name: 'authority', script: bundle.outputFiles[0].text, bindings: { EVE_WORLD_NAMESPACE: 'qualification' },
      durableObjects: { EVE_WORLD: { className: 'EveWorldAuthority', useSQLite: true }, EVE_STREAMS: { className: 'EveWorldStream', useSQLite: true } } },
    { ...common, name: 'product', script: bundle.outputFiles[0].text,
      bindings: { EVE_WORLD_NAMESPACE: 'qualification', WORLD_WORKLOAD: 'business' },
      durableObjects: {
        EVE_WORLD: { scriptName: 'authority', className: 'EveWorldAuthority', useSQLite: true },
        EVE_STREAMS: { scriptName: 'authority', className: 'EveWorldStream', useSQLite: true },
      } },
    { ...common, name: 'product-outbound', script: `export default {fetch(request, env) {
      if (request.headers.get('x-mikka-world-capability') !== env.TOKEN) return new Response(null, { status: 403 })
      const safe = new Request(request)
      safe.headers.delete('x-mikka-world-capability')
      return env.PRODUCT.fetch(safe)
    }}`, bindings: { TOKEN: capability }, serviceBindings: { PRODUCT: { name: 'product', entrypoint: 'BusinessWorldService' } } },
    { ...common, name: 'outbound', script: 'export default {fetch(request, env) { return env.PRIVATE.fetch(request) }}',
      serviceBindings: { PRIVATE: { name: 'authority', entrypoint: 'WorldService' } } },
  ] }))
  await runtime.ready
  outbound = await runtime.getWorker('outbound')
  const businessOutbound = await runtime.getWorker('product-outbound')
  business = createNodeWorld({ workload: 'business', deploymentId, verificationKey: publicMaterial,
    fetchBound: createBoundFetch(capability, (input, init) => businessOutbound.fetch(input, init)) })
  world = createNodeWorld({ deploymentId, signingKey, fetchBound: (url, options) => outbound.fetch(url, options) })
})
afterAll(async () => {
  await runtime?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function start(workflowName, input = Uint8Array.of(7)) {
  const { run } = await world.events.create(null, { ...spec, eventType: 'run_created', eventData: { workflowName, deploymentId, input } })
  await world.events.create(run.runId, { ...spec, eventType: 'run_started' })
  return run.runId
}

test('the Node World crosses only its bound private service for catalogues, attributed events, and independent hook deliveries', async () => {
  const a = await start('private-a')
  const b = await start('private-b')
  expect((await world.runs.list({ workflowName: 'private-a', status: ['running','failed'], resolveData: 'none' })).data.map(r => [r.runId,r.input])).toEqual([[a,undefined]])
  expect((await world.runs.list({ status: [] })).data).toEqual([])
  const change = { ...spec, eventType: 'attr_set', correlationId: 'request-attributes',
    eventData: { writer: { type: 'workflow' }, changes: [{ key: 'label', value: 'active' }] } }
  expect((await world.events.create(a, change)).run.attributes.label).toBe('active')
  await expect(world.events.create(a, change)).rejects.toMatchObject({ name:'EntityConflictError' })
  const hook = await world.events.create(a, { ...spec, eventType: 'hook_created', correlationId: 'hook_a',
    eventData: { token: 'bound-hook', metadata: Uint8Array.of(7) } })
  expect(hook.hook.runId).toBe(a)
  expect((await world.hooks.list({ runId:b })).data).toEqual([])
  expect((await world.hooks.list({ runId:a, resolveData:'none' })).data.map(h=>[h.hookId,h.metadata])).toEqual([['hook_a',undefined]])
  const resume = { ...spec, eventType: 'hook_received', correlationId:'hook_a', eventData: { token:'bound-hook', payload:Uint8Array.of(8) } }
  const receipts = await Promise.all(Array.from({length:4},()=>world.events.create(a,resume,{resumeId:'same-resume',resumePayloadDigest:'same-digest'})))
  expect(new Set(receipts.map(x=>x.event.eventId)).size).toBe(1)
  await expect(world.events.create(a,resume,{resumeId:'same-resume',resumePayloadDigest:'changed'})).rejects.toMatchObject({ name:'EntityConflictError' })
  await expect(world.events.create(b,resume)).rejects.toMatchObject({ name:'HookNotFoundError' })
  expect((await world.events.listByCorrelationId({runId:a,correlationId:'hook_a'})).data.map(x=>x.eventType)).toEqual(['hook_created','hook_received'])
  expect((await world.events.get(a,receipts[0].event.eventId,{resolveData:'none'})).eventData?.payload).toBeUndefined()
})

test('terminal snapshots wake through the Durable Object, and byte streams use isolated per-run storage', async () => {
  const run = await start('terminal')
  expect((await world.runs.waitForTerminalStatus(run,{timeoutMs:30})).status).toBe('running')
  const pending = world.runs.waitForTerminalStatus(run,{timeoutMs:5000})
  await world.streams.write(run,'events',Uint8Array.of(2,1))
  await world.streams.close(run,'events')
  expect(await world.streams.list(run)).toEqual(['events'])
  expect(await world.streams.list('other-run')).toEqual([])
  const info = await world.streams.getInfo(run,'events')
  expect(info.done).toBe(true)
  expect(Array.from((await world.streams.getChunks(run,'events')).data[0].data)).toEqual([2,1])
  expect(Array.from(await new Response(await world.streams.get(run,'events')).bytes())).toEqual([2,1])
  await world.events.create(run,{...spec,eventType:'run_completed',eventData:{output:Uint8Array.of(4)}})
  const runResult=await pending
  expect(runResult.status).toBe('completed')
  expect(runResult.output).toEqual(Uint8Array.of(4))
  expect((await world.runs.waitForTerminalStatus(run,{timeoutMs:0,resolveData:'none'})).output).toBeUndefined()
  expect((await outbound.fetch('https://untrusted.invalid/world/run-terminal?runId='+run)).status).toBe(404)
  expect((await (await runtime.getWorker('authority')).fetch('https://world.internal/world/run-terminal?runId='+run)).status).toBe(404)
})

test('business and Eve scopes isolate identically named streams and workflow catalogs even on shared physical storage', async () => {
  const eveRun = await start('eve-only')
  await expect(business.runs.get(eveRun)).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' })
  expect((await business.runs.list({})).data).toEqual([])
  await world.streams.write(eveRun, 'same', Uint8Array.of(3))
  await business.streams.write(eveRun, 'same', Uint8Array.of(9))
  expect((await world.streams.getChunks(eveRun, 'same')).data[0].data).toEqual(Uint8Array.of(3))
  expect((await business.streams.getChunks(eveRun, 'same')).data[0].data).toEqual(Uint8Array.of(9))
  const interceptor = await runtime.getWorker('product-outbound')
  expect((await interceptor.fetch('https://world.internal/world/rpc', { method: 'POST' })).status).toBe(403)
  const foreign = createBoundFetch(capability, () => { throw new Error('unexpected network call') })
  expect(() => foreign('https://untrusted.invalid/world/rpc')).toThrow('Invalid private World origin')
  const observed = {}
  const restricted = createBoundFetch(capability, (url, init) => Object.assign(observed, { url, init }))
  restricted('https://world.internal/world/rpc', { redirect: 'follow' })
  expect(observed.init.redirect).toBe('error')
  expect(observed.init.headers.get('x-mikka-world-capability')).toBe(capability)
})

test('a verify-only business Node accepts a Worker Ed25519 receipt bound to the exact body, revision and retry', async () => {
  const body = JSON.stringify({ queueName: '__wkf_workflow_work', messageId: 'local-proof' })
  const headers = new Headers(await deliveryHeaders(privateMaterial, deploymentId, 2, await bodyDigest(body), 'business'))
  expect(await authenticateDelivery(publicMaterial, deploymentId, headers, body, 'business')).toBe(true)
  expect(await authenticateDelivery(publicMaterial, deploymentId, headers, body, 'eve')).toBe(false)
  const eve = new Headers(await deliveryHeaders(privateMaterial, deploymentId, 2, await bodyDigest(body), 'eve'))
  expect(await authenticateDelivery(publicMaterial, deploymentId, eve, body, 'business')).toBe(false)
  expect(await authenticateDelivery(publicMaterial, deploymentId, headers, body + 'x', 'business')).toBe(false)
  expect(await authenticateDelivery(publicMaterial, 'bbb2222-11-1', headers, body, 'business')).toBe(false)
  headers.set('CF-Queue-Retry-Count', '0')
  expect(await authenticateDelivery(publicMaterial, deploymentId, headers, body, 'business')).toBe(false)
  const symmetric = new Headers(await deliveryHeaders(signingKey, deploymentId, 2, await bodyDigest(body), 'business'))
  expect(await authenticateDelivery(publicMaterial, deploymentId, symmetric, body, 'business')).toBe(false)
  await expect(deliveryHeaders(publicMaterial, deploymentId, 2, await bodyDigest(body), 'business')).rejects.toThrow()
})
