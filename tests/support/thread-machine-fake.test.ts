import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test, { mock } from 'node:test'
import { CLOUD_WORKER_COMMAND } from '../../lib/computer/worker-command'
import type { Pool } from 'pg'

type Upload = { path: string; data: string }
type Sandbox = {
  files: { write(path: string | Upload[], body?: unknown): Promise<void> }
  commands: { run(command: string): Promise<unknown> }
}
const provider = {
  create: async (_template: string, _operationId: string): Promise<Sandbox> => assert.fail('fake provider not installed'),
  connect: async (_sandboxId: string): Promise<Sandbox> => assert.fail('fake provider not installed'),
  kill: async () => {},
}
mock.module(new URL('../../lib/cloud-computer/thread-machines.ts', import.meta.url).href, { namedExports: {
  threadMachineProvider: provider,
  ensureThreadMachine: async () => assert.fail('offline fixture test must not provision a machine'),
  parkThreadMachine: async () => assert.fail('offline fixture test must not park a machine'),
} })
mock.module(new URL('../../lib/factory/automatic-dispatch.ts', import.meta.url).href, { namedExports: {
  factoryAutomaticRuntime: { enqueue: async () => {}, park: async () => {} },
} })
const { fakeThreadMachines } = await import('./thread-machine-fake')

const path = '/run/mikka-viewer/thread-41600000-0000-4000-8000-000000000001.json'
const identity = { deviceId: 'fixture-device', credential: 'fixture-worker-credential' }
const body = JSON.stringify(identity)
const harnesses = [{ harness: 'codex', installed: true, models: ['fixture-model'] }]

async function fixture(tokenAvailable = true) {
  // The real helper's upload/start boundary is under test. Its callers retain
  // their separate real-PG coverage for token and device mutations.
  const queries: { sql: string; values: unknown[] }[] = []
  const pool = { query: async (sql: string, values: unknown[]) => {
    queries.push({ sql, values })
    if (sql.startsWith('UPDATE device_tokens ')) return { rowCount: tokenAvailable ? 1 : 0 }
    if (sql.startsWith('UPDATE devices ')) return { rowCount: 1 }
    assert.fail(`Unexpected fixture query: ${sql}`)
  } } as unknown as Pool
  const control = await fakeThreadMachines(pool, harnesses)
  return { box: await provider.create('codex', 'fixture'), queries, restore: control.restore }
}

function assertRegistered(queries: { sql: string; values: unknown[] }[]) {
  assert.equal(queries.length, 2)
  assert.match(queries[0].sql, /^UPDATE device_tokens .*"boundDeviceId"=\$1 AND "tokenHash"=\$2 AND "revokedAt" IS NULL RETURNING id$/)
  assert.deepEqual(queries[0].values, [identity.deviceId, createHash('sha256').update(identity.credential).digest('hex')])
  assert.match(queries[1].sql, /^UPDATE devices SET "lastSeenAt"=/)
  assert.deepEqual(queries[1].values, [identity.deviceId, JSON.stringify(harnesses)])
}

test('legacy single-file bootstrap registers only after the worker start command', async (t) => {
  const f = await fixture(); t.after(f.restore)
  await f.box.files.write(path, body)
  await f.box.commands.run('git status --short')
  assert.deepEqual(f.queries, [])
  await f.box.commands.run(CLOUD_WORKER_COMMAND)
  assertRegistered(f.queries)
})

for (const order of ['primary-first', 'sidecar-first', 'maintenance'] as const) {
  test(`multipart ${order} consumes only the primary bootstrap`, async (t) => {
    const f = await fixture(); t.after(f.restore)
    const primary = { path, data: body }
    const sidecar = { path: `${path}.run`, data: order === 'maintenance' ? '' : JSON.stringify({ version: 1, runId: 'locator-only', bootstrapSha256: 'a'.repeat(64) }) }
    await f.box.files.write(order === 'sidecar-first' ? [sidecar, primary] : [primary, sidecar], { user: 'root', useOctetStream: false })
    assert.deepEqual(f.queries, [], 'upload alone cannot register a worker')
    await f.box.commands.run(CLOUD_WORKER_COMMAND)
    assertRegistered(f.queries)
  })
}

test('sidecar and similar filenames cannot stand in for the primary bootstrap', async (t) => {
  const f = await fixture(); t.after(f.restore)
  await f.box.files.write([
    { path: `${path}.run`, data: body },
    { path: `${path}.next`, data: body },
    { path: `${path}/child`, data: body },
    { path: '/tmp/thread-41600000-0000-4000-8000-000000000001.json', data: body },
  ])
  await assert.rejects(f.box.commands.run(CLOUD_WORKER_COMMAND), /Fixture worker started without a bootstrap/)
  assert.deepEqual(f.queries, [])
})

test('multipart does not bypass the existing unavailable-token refusal', async (t) => {
  const f = await fixture(false); t.after(f.restore)
  await f.box.files.write([{ path, data: body }, { path: `${path}.run`, data: '' }])
  await assert.rejects(f.box.commands.run(CLOUD_WORKER_COMMAND), /Fixture worker credential unavailable/)
  assert.equal(f.queries.length, 1, 'a refused token cannot mark the device seen')
  assert.deepEqual(f.queries[0].values, [identity.deviceId, createHash('sha256').update(identity.credential).digest('hex')])
})

test('invalid primary JSON still fails instead of registering a worker', async (t) => {
  const f = await fixture(); t.after(f.restore)
  await assert.rejects(f.box.files.write([{ path, data: '{' }]), SyntaxError)
  await assert.rejects(f.box.commands.run(CLOUD_WORKER_COMMAND), /Fixture worker started without a bootstrap/)
  assert.deepEqual(f.queries, [])
})
