import { randomBytes, randomUUID } from 'node:crypto'
import { once, EventEmitter } from 'node:events'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { withSessionControlDelivery } from '../../../lib/eve/session-control-delivery.mjs'
import { createNodeQueue } from '../src/node-queue.mjs'
import { consumeWorldQueue } from '../src/queue-transport.mjs'
import { WORKFLOW_FLOW_ROUTE } from '@workflow/world/queue.js'

const require = createRequire(import.meta.url)
const { Miniflare, convertV4MiniflareOptions } = createRequire(realpathSync(require.resolve('wrangler/package.json')))('miniflare')
const events = new EventEmitter()
const suspended = new Map()
const signingKey = randomBytes(32).toString('hex')
const seen = []
const revisions = ['aaa1111-10-1', 'bbb2222-11-1']
const topic = '__wkf_workflow_session'
let runtime, directory, outbound
const api = revision => createNodeQueue({ deploymentId: revision, signingKey, fetchBound: (url, init) => outbound.fetch(url, init) })
function host(revision) {
  return async request => {
    let handled
    const response = await api(revision).createQueueHandler('__wkf_workflow_', async (message, meta) => {
      const delivery = { revision, message, meta }
      seen.push(delivery)
      events.emit(message.id, delivery)
      if (message.once && seen.filter(x => x.message.id === message.id).length === 1) throw new Error('Transient handler failure')
      if (suspended.has(message.id)) await suspended.get(message.id)
      handled = message.id
    })(request)
    if (response.ok && handled) events.emit('handled:' + handled)
    return response
  }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eve-queue-'))
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/authority.mjs', import.meta.url))],
    format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:*'], bundle: true, write: false })
  const common = { modules: true, compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'] }
  runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0, resourcePersistencePath: directory, workers: [
    { ...common, name: 'broker', script: bundle.outputFiles[0].text,
      durableObjects: { EVE_CLAIMS: { className: 'EveQueueClaim', useSQLite: true } }, r2Buckets: ['EVE_QUEUE_PAYLOADS'],
      queueProducers: { EVE_QUEUE: 'eve-world-test', EVE_CONTROL_QUEUE: 'eve-world-control' },
      queueConsumers: { 'eve-world-control': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1, deadLetterQueue: 'eve-world-dead' },
        'eve-world-test': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1, deadLetterQueue: 'eve-world-dead' } },
      bindings: { EVE_RELEASES: { [revisions[0]]: 'OLD', [revisions[1]]: 'NEW' }, EVE_QUEUE_SIGNING_KEY: signingKey },
      serviceBindings: { OLD: host(revisions[0]), NEW: host(revisions[1]) } },
    { ...common, name: 'outbound', script: 'export default {fetch(request, env) {return env.PRIVATE.fetch(request)}}',
      serviceBindings: { PRIVATE: { name: 'broker', entrypoint: 'WorldQueueService' } } },
    { ...common, name: 'dead', script: 'export default {async queue(batch, env) { for (const m of batch.messages) {await env.SINK.fetch("https://sink.internal/", {method:"POST",body:JSON.stringify(m.body)}); m.ack()} }}',
      queueConsumers: { 'eve-world-dead': { maxBatchSize: 1, maxBatchTimeout: 0 } },
      serviceBindings: { SINK: async request => { const entry = await request.json(); events.emit('dlq:' + entry.revision, entry); return new Response(null, { status: 204 }) } } },
  ] }))
  await runtime.ready
  outbound = await runtime.getWorker('outbound')
})

afterAll(async () => {
  await runtime?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('a delayed previous-revision message reaches only its signed Node executor and survives a retry with the same message ID', async () => {
  const id = randomUUID()
  const delivered = new Promise(resolve => events.on(id, item => { if (item.meta.attempt === 2) resolve(item) }))
  const start = Date.now()
  const { messageId } = await api(revisions[1]).queue(topic, { id, once: true, bytes: Uint8Array.of(2, 8) },
    { deploymentId: revisions[0], idempotencyKey: id, delaySeconds: 1 })
  const item = await delivered
  expect(Date.now() - start).toBeGreaterThanOrEqual(900)
  expect(item.revision).toBe(revisions[0])
  expect(item.message.bytes).toEqual(Uint8Array.of(2, 8))
  expect(seen.filter(x => x.message.id === id).map(x => [x.revision, x.meta.messageId, x.meta.attempt])).toEqual([
    [revisions[0], messageId, 1], [revisions[0], messageId, 2],
  ])
})

test('a response-body reset cannot change the pinned executor acknowledgement', async () => {
  const revision = revisions[1]
  for (const [status, returnedRevision, accepted] of [
    [200, revision, true], [503, revision, false], [200, revisions[0], false],
  ]) {
    const outcome = []
    const message = {
      body: { revision, dueAt: 0, body: '{}' },
      attempts: 2,
      ack() { outcome.push('ack') },
      retry(options) { outcome.push(options) },
    }
    const env = { EVE_RELEASES: { [revision]: 'TARGET' }, EVE_QUEUE_SIGNING_KEY: signingKey,
      TARGET: { fetch() {
        const body = new ReadableStream({ start(controller) { controller.error(new Error('response reset')) } })
        return new Response(body, { status, headers: { 'x-mikka-eve-release': returnedRevision } })
      } },
    }
    await consumeWorldQueue({ messages: [message] }, env)
    expect(outcome).toEqual(accepted ? ['ack'] : [{ delaySeconds: 2 }])
  }
})

test('a payload larger than the native queue message limit is preserved through R2', async () => {
  const id = randomUUID()
  const bytes = randomBytes(145 * 1024)
  const delivered = once(events, id)
  await api(revisions[1]).queue(topic, { id, bytes: new Uint8Array(bytes) })
  const [item] = await delivered
  expect(Buffer.from(item.message.bytes).equals(bytes)).toBe(true)
  const bucket = await runtime.getR2Bucket('EVE_QUEUE_PAYLOADS', 'broker')
  expect((await bucket.list({ prefix: 'eve-queue/' })).objects.length).toBeGreaterThan(0)
})

test('an unknown pinned revision survives retries into the real queue DLQ without calling a current revision', async () => {
  const unknown = 'ccc3333-12-1'
  const id = randomUUID()
  const dead = once(events, 'dlq:' + unknown)
  const { messageId } = await api(revisions[1]).queue(topic, { id }, { deploymentId: unknown })
  const [entry] = await dead
  expect(JSON.parse(entry.body).messageId).toBe(messageId)
  expect(seen.some(item => item.message.id === id)).toBe(false)
})

test('the public worker rejects storage operations and a forged direct Node delivery cannot execute', async () => {
  const publicWorker = await runtime.getWorker('broker')
  expect((await publicWorker.fetch('https://external.invalid/world/queue/publish', { method: 'POST' })).status).toBe(404)
  const id = randomUUID()
  const direct = await host(revisions[1])(new Request('https://eve.internal' + WORKFLOW_FLOW_ROUTE, {
    method: 'POST', headers: { 'x-mikka-eve-release': revisions[1] }, body: JSON.stringify({ queueName: topic, message: { id } }),
  }))
  expect(direct.status).toBe(403)
  expect(seen.some(item => item.message.id === id)).toBe(false)
})

test('concurrent keyed producers receive the winning ID before the delayed native delivery and can reuse the key after completion', async () => {
  const key = randomUUID()
  const id = randomUUID()
  const first = once(events, 'handled:' + id)
  const published = await Promise.all(Array.from({ length: 8 }, () =>
    api(revisions[1]).queue(topic, { id }, { idempotencyKey: key, delaySeconds: 1 })))
  expect(new Set(published.map(x => x.messageId)).size).toBe(1)
  await first
  expect(seen.filter(x => x.message.id === id)).toHaveLength(1)
  const next = randomUUID()
  const done = once(events, next)
  const again = await api(revisions[1]).queue(topic, { id: next }, { idempotencyKey: key })
  expect(again.messageId).not.toBe(published[0].messageId)
  await done
})

test('a scoped native cancel or end reaches its pinned executor while its regular queue is still occupied', async () => {
  const sessionId = randomUUID()
  const running = randomUUID()
  const started = once(events, running)
  const release = Promise.withResolvers()
  suspended.set(running, release.promise)
  const controls = []
  const client = createNodeQueue({ deploymentId: revisions[1], signingKey, fetchBound(url, init) {
    controls.push(new URL(url).searchParams.has('control'))
    return outbound.fetch(url, init)
  } })
  try {
    await client.queue(topic, { id: running })
    await started
    for (const action of ['cancel', 'end']) {
      const id = randomUUID()
      const delivered = once(events, id)
      await withSessionControlDelivery({method:'POST', path:'/eve/v1/session/:sessionId/' + action}, sessionId, () =>
        client.queue(topic, {id, runId:sessionId, hookResumeTiming:{}}, {deploymentId:revisions[0]}))
      const [item] = await delivered
      expect(item.revision).toBe(revisions[0])
    }
    expect(controls).toEqual([false, true, true])
  } finally {
    release.resolve()
    suspended.delete(running)
  }
  const cancel = { method:'POST', path:'/eve/v1/session/:sessionId/cancel' }
  for (const [route, message] of [
    [cancel, {runId:randomUUID(), hookResumeTiming:{}}],
    [cancel, {runId:sessionId}],
    [{method:'GET', path:cancel.path}, {runId:sessionId, hookResumeTiming:{}}],
    [{method:'POST', path:'/eve/v1/session/:sessionId'}, {runId:sessionId, hookResumeTiming:{}}],
  ]) {
    await withSessionControlDelivery(route, sessionId, () => client.queue(topic, {id:randomUUID(), ...message}))
    expect(controls.at(-1)).toBe(false)
  }
})
