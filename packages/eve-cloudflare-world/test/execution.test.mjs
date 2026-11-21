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
import { createWorld, initDataDir } from '@workflow/world-local'
import { createAdmissionStorage } from '../src/storage-client.mjs'

const require = createRequire(import.meta.url)
const { Miniflare, convertV4MiniflareOptions } = createRequire(realpathSync(require.resolve('wrangler/package.json')))('miniflare')
let runtime, directory, reference, native

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'eve-world-execution-'))
  const dataDir = join(directory, 'official')
  await initDataDir(dataDir)
  reference = createWorld({ dataDir, recoverActiveRuns: false })
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('execution-driver.mjs', import.meta.url))],
    format: 'esm', platform: 'browser', external: ['cloudflare:workers', 'node:*'], bundle: true, write: false })
  runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0, resourcePersistencePath: join(directory, 'cloudflare'),
    workers: [{ modules: true, name: 'execution', script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-22',
      compatibilityFlags: ['nodejs_compat'], durableObjects: { WORLD: { className: 'EveWorldAuthority', useSQLite: true } } }] }))
  const url = (await runtime.ready).origin
  const call = async (op, ...args) => {
    const response = await fetch(url, { method: 'POST', body: encode([op, ...args]) })
    if (!response.ok) throw new Error('World authority failed: ' + await response.text())
    return decode(new Uint8Array(await response.arrayBuffer()))
  }
  native = createAdmissionStorage({ create: (...args) => call('create', ...args), step: (...args) => call('step', ...args),
    steps: (...args) => call('steps', ...args), events: (...args) => call('events', ...args) })
})
afterAll(async () => {
  await runtime?.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function start(world, run) {
  await world.events.create(run, { eventType: 'run_created', specVersion: 8,
    eventData: { workflowName: 'workflow//eve//session', deploymentId: 'aaa1111-10-1', input: Uint8Array.of(7) } })
  await world.events.create(run, { eventType: 'run_started', specVersion: 8 })
}
const write = (world, run, eventType, id, fields) => world.events.create(run,
  { eventType, specVersion: 8, correlationId: id, ...(fields ? { eventData: fields } : {}) })

async function transcript(world, run) {
  await start(world, run)
  const started = await Promise.allSettled(Array.from({ length: 3 }, () => write(world, run, 'step_started', 'step_a',
    { stepName: 'read', input: Uint8Array.of(3), ownerMessageId: 'message-a' })))
  const owner = started.find(x => x.status === 'fulfilled').value
  const refusals = started.filter(x => x.status === 'rejected').map(x => x.reason.name)
  const retryAfter = new Date(Date.now() + 60_000)
  await write(world, run, 'step_retrying', 'step_a', { error: Uint8Array.of(9, 8), retryAfter })
  const early = await write(world, run, 'step_started', 'step_a').then(() => 'accepted', e => e.name)
  await write(world, run, 'step_retrying', 'step_a', { error: Uint8Array.of(9, 8), retryAfter: new Date(Date.now() - 1000) })
  const retry = await write(world, run, 'step_started', 'step_a')
  const ended = await write(world, run, 'step_completed', 'step_a', { result: Uint8Array.of(1, 2) })
  const late = await write(world, run, 'step_failed', 'step_a', { error: Uint8Array.of(4) }).then(() => 'accepted', e => e.name)
  await write(world, run, 'step_created', 'step_b', { stepName: 'failed', input: Uint8Array.of(3) })
  await write(world, run, 'step_started', 'step_b')
  const failure = await write(world, run, 'step_failed', 'step_b', { error: Uint8Array.of(255, 0, 128) })
  const wait = await write(world, run, 'wait_created', 'wait_a', { resumeAt: new Date(Date.now() + 100) })
  const resume = await write(world, run, 'wait_completed', 'wait_a')
  const already = await write(world, run, 'wait_completed', 'wait_a').then(() => 'accepted', e => e.name)
  const empty = await world.steps.get(run, 'step_a', { resolveData: 'none' })
  const page = await world.steps.list({ runId: run, pagination: { limit: 1, sortOrder: 'asc' } })
  const next = await world.steps.list({ runId: run, pagination: { limit: 1, sortOrder: 'asc', cursor: page.cursor } })
  const log = await world.events.list({ runId: run, pagination: { limit: 100, sortOrder: 'asc' } })
  return { refused: refusals, owner: owner.stepCreated, early, attempt: retry.step.attempt,
    unchangedStart: retry.step.startedAt.getTime() === owner.step.startedAt.getTime(),
    completed: ended.step.status, result: Array.from(ended.step.output), late, failed: Array.from(failure.step.error),
    wait: [wait.wait.status, resume.wait.status, already], noData: [empty.input, empty.output],
    page: [page.data[0].stepId, next.data[0].stepId, page.hasMore, next.hasMore],
    events: log.data.map(e => [e.eventType, e.correlationId, Boolean(e.eventData?.input)]) }
}

test('real SQL workerd matches the pinned official World for spec 8 lazy step ownership, retry, binary outcomes, wait and replay', async () => {
  const run = 'wrun_' + ulid()
  const oracle = await transcript(reference, run)
  expect(oracle.owner).toBe(true)
  expect(oracle.refused).toEqual(['EntityConflictError', 'EntityConflictError'])
  expect(oracle.early).toBe('TooEarlyError')
  expect(oracle.attempt).toBe(2)
  expect(oracle.failed).toEqual([255, 0, 128])
  expect(await transcript(native, run)).toEqual(oracle)
})

test('an existing executing step can finish after cancellation, while a fresh lazy step cannot be admitted', async () => {
  const run = 'wrun_' + ulid()
  for (const world of [reference, native]) {
    await start(world, run)
    await write(world, run, 'step_started', 'active', { stepName: 'active', input: Uint8Array.of(1) })
    await world.events.create(run, { eventType: 'run_cancelled', specVersion: 8 })
    await expect(write(world, run, 'step_started', 'fresh', { stepName: 'fresh', input: Uint8Array.of(1) })).rejects.toMatchObject({ name: 'EntityConflictError' })
    const finished = await write(world, run, 'step_completed', 'active', { result: Uint8Array.of(8) })
    expect(finished.step.output).toEqual(Uint8Array.of(8))
  }
})
