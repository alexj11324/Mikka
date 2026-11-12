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
