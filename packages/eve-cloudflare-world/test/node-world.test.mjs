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
import { decodeRecord, encodeRecord } from '../src/records.mjs'

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

test('metadata-only run reads omit workflow bytes on the private connection and support older Workers', async () => {
  const input = new Uint8Array(64 * 1024).fill(7)
  const runId = await start('metadata-only', input)
  const replies = []
  const measured = createNodeWorld({ deploymentId, signingKey, async fetchBound(url, options) {
    const response = await outbound.fetch(url, options)
    const bytes = await response.clone().arrayBuffer()
    replies.push({ bytes: bytes.byteLength, record: decodeRecord(bytes) })
    return response
  } })
  const full = await measured.runs.get(runId)
  expect(full.input).toEqual(input)
  expect((await measured.runs.get(runId, { resolveData: 'none' })).input).toBeUndefined()
  expect((await measured.runs.list({ workflowName: 'metadata-only', resolveData: 'none' })).data[0].input).toBeUndefined()
  expect((await measured.runs.waitForTerminalStatus(runId, {timeoutMs: 0, resolveData: 'none'})).input).toBeUndefined()
  console.info('Run RPC response bytes (full, metadata, list, immediate wait):', replies.map(r => r.bytes).join(', '))
  expect(replies[1].record.input).toBeUndefined()
  expect(replies[2].record.data[0].input).toBeUndefined()
  expect(replies[3].record.input).toBeUndefined()
  await measured.runs.waitForTerminalStatus(runId, {timeoutMs: 20, resolveData: 'none'})
  expect(replies.at(-1).record.input).toBeUndefined()
  await world.events.create(runId, {...spec,eventType:'run_completed',eventData:{output:input}})
  await measured.runs.waitForTerminalStatus(runId, {timeoutMs: 500, resolveData: 'none'})
  expect(replies.at(-1).record.input).toBeUndefined()
  expect(replies.at(-1).record.output).toBeUndefined()
  const olderWorker = createNodeWorld({ deploymentId, signingKey, fetchBound: async () => new Response(encodeRecord(full)) })
  expect((await olderWorker.runs.get(runId, { resolveData: 'none' })).input).toBeUndefined()
})

test('metadata-only hook and history reads retain cursors without sending hook payloads', async () => {
  const runId = await start('hook-and-history')
  const payload = new Uint8Array(64 * 1024).fill(7)
  const hookId = 'hook_metadata', token = 'private-metadata'
  await world.events.create(runId, { ...spec, eventType: 'hook_created', correlationId: hookId, eventData: {token,metadata:payload} })
  const receipt = await world.events.create(runId, { ...spec, eventType: 'hook_received', correlationId: hookId, eventData: {token,payload} })
  const sizes = []
  const measured = createNodeWorld({deploymentId,signingKey,async fetchBound(url,options) {
    const response = await outbound.fetch(url,options)
    sizes.push((await response.clone().arrayBuffer()).byteLength)
    return response
  }})
  const none = {resolveData:'none'}
  const hook = await measured.hooks.get(hookId)
  const event = await measured.events.get(runId,receipt.event.eventId)
  expect(hook.metadata).toEqual(payload)
  expect(event.eventData.payload).toEqual(payload)
  expect((await measured.hooks.get(hookId,none)).token).toBe(token)
  expect((await measured.hooks.getByToken(token,none)).metadata).toBeUndefined()
  expect((await measured.hooks.list({runId,...none})).data.map(h=>h.hookId)).toEqual([hookId])
  expect((await measured.events.get(runId,event.eventId,none)).eventData?.payload).toBeUndefined()
  const listed = await measured.events.list({runId,...none})
  const correlated = await measured.events.listByCorrelationId({runId,correlationId:hookId,pagination:{limit:1},...none})
  expect(listed.data.at(-1).eventId).toBe(event.eventId)
  expect(correlated.hasMore).toBe(true)
  expect((await measured.events.listByCorrelationId({runId,correlationId:hookId,pagination:{cursor:correlated.cursor},...none})).data.map(e=>e.eventId)).toEqual([event.eventId])
  console.info('Hook/history private response bytes (two full then seven metadata reads):', sizes.join(', '))
  expect(sizes.slice(2).every(size=>size < 4096)).toBe(true)
  const priorWorld = createNodeWorld({deploymentId,signingKey,async fetchBound(url,options) {
    const [method] = decodeRecord(options.body)
    return new Response(encodeRecord(method === 'hook' ? hook : event))
  }})
  expect((await priorWorld.hooks.get(hookId,none)).metadata).toBeUndefined()
  expect((await priorWorld.events.get(runId,event.eventId,none)).eventData?.payload).toBeUndefined()
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

test('both workloads read and append to streams persisted under their original names', async () => {
  const binding = await runtime.getDurableObjectNamespace('EVE_STREAMS', 'authority')
  const run = 'existing-run'
  const name = 'events'
  const stream = JSON.stringify(['stream', run, name])
  const registry = JSON.stringify(['run-streams', run])
  for (const [client, streamKey, registryKey, firstByte] of [
    [world, stream, registry, 5],
    [business, JSON.stringify(['business', stream]), JSON.stringify(['business', registry]), 8],
  ]) {
    const persisted = binding.get(binding.idFromName(streamKey))
    await persisted.writeChunk(Uint8Array.of(firstByte))
    await binding.get(binding.idFromName(registryKey)).registerStream(name)
    expect(await client.streams.list(run)).toEqual([name])
    await client.streams.write(run, name, Uint8Array.of(firstByte + 1))
    const { chunks } = await persisted.getChunks({ startIndex: 0, limit: 2 })
    expect(chunks.map(chunk => chunk[0])).toEqual([firstByte, firstByte + 1])
    expect((await client.streams.getChunks(run, name)).data.map(chunk => chunk.data[0])).toEqual([firstByte, firstByte + 1])
  }
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


test('the native spec-8 run_started replay observer stays in Node across real World RPC', async () => {
  const { run } = await world.events.create(null, { ...spec, eventType: 'run_created', eventData: {
    workflowName: 'native-replay-observer', deploymentId, input: Uint8Array.of(1),
  } })
  const observed = []
  const result = await world.events.create(run.runId, { ...spec, eventType: 'run_started' }, {
    replayEventObserver(event) { observed.push(event.eventId) },
  })
  expect(result.run.status).toBe('running')
  // Worlds may omit replay preloads. The runtime then reads the durable log.
  expect(observed).toEqual((result.events ?? []).map(event => event.eventId))
  const log = await world.events.list({ runId: run.runId })
  expect(log.data.map(event => event.eventType)).toEqual(['run_created', 'run_started'])
})
