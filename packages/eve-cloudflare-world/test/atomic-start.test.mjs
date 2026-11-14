import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, encode } from 'cbor-x'
import { build } from 'esbuild'
import { ulid } from 'ulid'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { atomicStartHookConformance } from '@workflow/world/test-support/atomic-start-hook-conformance.js'
import { admissionCapabilities, createAdmissionStorage } from '../src/storage-client.mjs'

const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(realpathSync(require.resolve('wrangler/package.json')))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire('miniflare')
let runtime
let config
let directory
let namespace
let advanceMs = 0
const newRunId = () => 'wrun_' + ulid(Date.now() + advanceMs)

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('driver.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'],
  })
  directory = await mkdtemp(join(tmpdir(), 'mikka-eve-world-'))
  config = convertV4MiniflareOptions({
    cf: false, host: '127.0.0.1', port: 0, resourcePersistencePath: directory,
    workers: [{ name: 'authority', modules: true, compatibilityDate: '2026-10-22',
      script: bundle.outputFiles[0].text, durableObjects: { WORLD: { className: 'ClockedAuthority', useSQLite: true } } }],
  })
  runtime = new Miniflare(config)
  await runtime.ready
})

afterAll(async () => {
  await runtime?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

function client() {
  async function call(method, ...args) {
    const response = await fetch((await runtime.ready).origin, {
      method: 'POST', body: encode([namespace, method, Date.now() + advanceMs, args]),
    })
    if (!response.ok) throw new Error('workerd RPC failed: ' + await response.text())
    return decode(new Uint8Array(await response.arrayBuffer()))
  }
  return createAdmissionStorage({
    create: (...args) => call('create', ...args), run: id => call('run', id), hook: id => call('hook', id),
    hookByToken: token => call('hookByToken', token), events: (...args) => call('events', ...args),
  })
}

atomicStartHookConformance({
  name: 'Cloudflare SQL Durable Object',
  storage: () => { namespace = randomUUID(); return client() },
  capabilities: () => admissionCapabilities, newRunId, secondEvents: () => client().events,
  advanceClock: ms => { advanceMs = ms }, retentionReadsAdvanceClock: true,
})

test('a restarted workerd preserves the winner and the other candidate’s refusal', async () => {
  namespace = randomUUID()
  const storage = client()
  const winner = newRunId()
  const contender = newRunId()
  const request = { eventType: 'run_created', specVersion: 8, eventData: {
    deploymentId: 'worker-test', workflowName: 'workflow//eve//session', input: new Uint8Array([1]),
    startHook: { token: 'restart-proof' },
  } }
  await storage.events.create(winner, request)
  await expect(storage.events.create(contender, request)).rejects.toMatchObject({ conflictingRunId: winner })
  await runtime.dispose()
  runtime = new Miniflare(config)
  expect((await storage.runs.get(winner)).status).toBe('pending')
  expect((await storage.hooks.getByToken('restart-proof')).runId).toBe(winner)
  await expect(storage.events.create(contender, request)).rejects.toMatchObject({ conflictingRunId: winner })
  await expect(storage.runs.get(contender)).rejects.toMatchObject({ name: 'WorkflowRunNotFoundError' })
})

test('hook mutation reads the parent status and preserves durable receipt replay', async () => {
  namespace = randomUUID()
  const storage = client(), runId = 'wrun_' + ulid(), correlationId = 'hook_status'
  const input = new Uint8Array(64 * 1024).fill(9)
  await storage.events.create(runId, {specVersion:8,eventType:'run_created',eventData:{deploymentId:'fixture',workflowName:'fixture',input}})
  await storage.events.create(runId, {specVersion:8,eventType:'run_started'})
  const measure = async (eventType,eventData,options,hookId = correlationId) => {
    const reply = await fetch((await runtime.ready).origin, {method:'POST',body:encode([namespace,'measureHook',Date.now(),
      [runId,{eventType,specVersion:8,correlationId:hookId,eventData},options]])})
    expect(reply.status).toBe(200)
    return decode(new Uint8Array(await reply.arrayBuffer()))
  }
  const created = await measure('hook_created',{token:'status-only'})
  const conflict = await measure('hook_created',{token:'status-only'},undefined,'hook_contender')
  expect(conflict.result.event.eventType).toBe('hook_conflict')
  expect(conflict.parentRows).toBe(1)
  const received = await measure('hook_received',{token:'status-only',payload:Uint8Array.of(3)},{resumeId:'req-1'})
  const disposed = await measure('hook_disposed',{})
  expect([created,received,disposed].map(v=>[v.result.ok,v.parentRows])).toEqual([[true,1],[true,1],[true,1]])
  await storage.events.create(runId, {specVersion:8,eventType:'run_completed',eventData:{output:Uint8Array.of(4)}})
  const replay = await measure('hook_received',{token:'status-only',payload:Uint8Array.of(3)},{resumeId:'req-1'})
  expect(replay.result.event.eventId).toBe(received.result.event.eventId)
  expect((await measure('hook_created',{token:'other'})).result.code).toBe('RUN_EXPIRED')
  expect((await storage.runs.get(runId)).input).toEqual(input)
  const bytes = [created,received,disposed,replay].map(v=>v.parentBytes)
  console.info('SQLite parent bytes (hook create, receive, dispose and durable replay):',bytes.join(', '))
  expect(bytes.every(size=>size<128)).toBe(true)
})
