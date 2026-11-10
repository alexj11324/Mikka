import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

mock.module('../secrets/e2b-runtime', { namedExports: {
  e2bApiKey: async () => 'synthetic-provider-key',
  withE2BErrors: async (_owner: string, _creating: boolean, operation: () => Promise<unknown>) => operation(),
} })
const { Sandbox } = await import('e2b')
const { threadLifecycleProvider, threadSnapshotName, threadSnapshotsEnabled } = await import('./thread-lifecycle-provider')
const metadata = { application: 'mikka-thread', workspaceId: 'workspace', runId: 'run', operationId: 'operation' }
const startedAt = new Date('2026-11-07T00:00:00Z'), endAt = new Date('2026-11-07T00:15:00Z')
const allocation = (state: 'running' | 'paused' = 'running') => ({ sandboxId: 'vm', state, metadata, startedAt, endAt })

test('lost-create recovery searches the exact persisted operation without connecting or allocating', async () => {
  const connect = mock.method(Sandbox, 'connect', async () => { assert.fail('maintenance must not resume'); })
  const create = mock.method(Sandbox, 'create', async () => { assert.fail('recovery must not allocate'); })
  const list = mock.method(Sandbox, 'list', (options: Parameters<typeof Sandbox.list>[0]) => {
    assert.deepEqual(options?.query, { metadata, state: ['running', 'paused'] })
    assert.equal(options?.limit, 2)
    assert.equal(options?.requestTimeoutMs, 15_000)
    return { nextItems: async () => [allocation()], hasNext: false } as never
  })
  try {
    assert.deepEqual(await threadLifecycleProvider.findCreated('run', 'workspace', 'operation', 'owner'),
      { sandboxId: 'vm', state: 'running', startedAt: startedAt.getTime(), endAt: endAt.getTime() })
    assert.equal(connect.mock.callCount(), 0)
    assert.equal(create.mock.callCount(), 0)
  } finally { list.mock.restore(); connect.mock.restore(); create.mock.restore() }
})

test('an observed paused allocation stays paused, and an absent allocation is not a kill receipt', async () => {
  let rows: ReturnType<typeof allocation>[] = [allocation('paused')]
  const list = mock.method(Sandbox, 'list', () => ({ nextItems: async () => rows, hasNext: false }) as never)
  try {
    assert.deepEqual(await threadLifecycleProvider.findCreated('run', 'workspace', 'operation', 'owner'),
      { sandboxId: 'vm', state: 'paused', startedAt: startedAt.getTime(), endAt: null })
    rows = []
    assert.equal(await threadLifecycleProvider.findCreated('run', 'workspace', 'operation', 'owner'), null)
  } finally { list.mock.restore() }
})

test('ambiguous, partial or cross-operation provider results cannot establish ownership', async () => {
  for (const result of [
    { rows: [allocation(), { ...allocation(), sandboxId: 'second-vm' }], hasNext: false },
    { rows: [allocation()], hasNext: true },
    { rows: [{ ...allocation(), metadata: { ...metadata, operationId: 'another-operation' } }], hasNext: false },
    { rows: [{ ...allocation(), metadata: { ...metadata, workspaceId: 'another-workspace' } }], hasNext: false },
  ]) {
    const list = mock.method(Sandbox, 'list', () => ({ nextItems: async () => result.rows, hasNext: result.hasNext }) as never)
    try { await assert.rejects(threadLifecycleProvider.findCreated('run', 'workspace', 'operation', 'owner'), /identity unavailable/) }
    finally { list.mock.restore() }
  }
})

test('an unavailable provider lookup preserves its original failure for durable retry', async () => {
  const failure = new Error('synthetic transport failure')
  const list = mock.method(Sandbox, 'list', () => ({ nextItems: async () => { throw failure }, hasNext: true }) as never)
  try { await assert.rejects(threadLifecycleProvider.findCreated('run', 'workspace', 'operation', 'owner'), error => error === failure) }
  finally { list.mock.restore() }
})

test('snapshots are opt-in and use the exact per-run name', () => {
  assert.equal(threadSnapshotsEnabled({}), false)
  assert.equal(threadSnapshotsEnabled({ MIKKA_THREAD_SNAPSHOTS: '0' }), false)
  assert.equal(threadSnapshotsEnabled({ MIKKA_THREAD_SNAPSHOTS: '1' }), true)
  assert.equal(threadSnapshotName('a-b-c'), 'mikka-thread-abc')
})

test('createSnapshot prefers filesystem mode and falls back to a full image only when documented', async () => {
  const calls: Record<string, unknown>[] = []
  const snapshot = mock.method(Sandbox, 'createSnapshot', async (_id: string, opts: Record<string, unknown>) => {
    calls.push(opts)
    if (calls.length === 1) throw Object.assign(new Error('snapshot_filesystem_only_disabled'), { statusCode: 400 })
    return { snapshotId: 'snap', names: ['project/snap:latest'] }
  })
  try {
    assert.deepEqual(await threadLifecycleProvider.createSnapshot('vm', 'owner', 'name'), { snapshotId: 'snap', names: ['project/snap:latest'] })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].mode, 'filesystem'); assert.equal(calls[1].mode, undefined)
    for (const opts of calls) { assert.equal(opts.name, 'name'); assert.equal(opts.requestTimeoutMs, 15_000) }
  } finally { snapshot.mock.restore() }
})

test('listSnapshots filters by sandbox and exact name across pages', async () => {
  let pages = 0
  const paginator = { get hasNext() { return pages < 2 }, nextItems: async () => ++pages === 1 ? [{ snapshotId: 'a', names: [] }] : [{ snapshotId: 'b', names: [] }] }
  const list = mock.method(Sandbox, 'listSnapshots', (opts: Record<string, unknown>) => {
    assert.equal(opts.sandboxId, 'vm'); assert.equal(opts.name, 'name'); return paginator as never
  })
  try {
    assert.deepEqual(await threadLifecycleProvider.listSnapshots('vm', 'owner', 'name'),
      [{ snapshotId: 'a', names: [] }, { snapshotId: 'b', names: [] }])
  } finally { list.mock.restore() }
})

test('createFromSnapshot rejects an invalid id and creates on the owner key', async () => {
  await assert.rejects(threadLifecycleProvider.createFromSnapshot('/etc/passwd\n', 'op', {}, 'owner'), /filesystem snapshot unavailable/)
  const create = mock.method(Sandbox, 'create', async (template: string, opts: Record<string, unknown>) => {
    assert.equal(template, 'snap-1'); assert.equal(opts.idempotencyKey, 'op')
    assert.deepEqual(opts.metadata, { application: 'mikka-thread' })
    return { sandboxId: 'restored' }
  })
  try {
    assert.deepEqual(await threadLifecycleProvider.createFromSnapshot('snap-1', 'op', { application: 'mikka-thread' }, 'owner'), { sandboxId: 'restored' })
  } finally { create.mock.restore() }
})

test('deleteSnapshot reports the provider acknowledgement', async () => {
  const del = mock.method(Sandbox, 'deleteSnapshot', async (id: string) => id === 'snap-1')
  try {
    assert.equal(await threadLifecycleProvider.deleteSnapshot('snap-1', 'owner'), true)
    assert.equal(await threadLifecycleProvider.deleteSnapshot('snap-2', 'owner'), false)
  } finally { del.mock.restore() }
})
