import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

mock.module('../secrets/e2b-runtime', { namedExports: {
  e2bApiKey: async () => 'synthetic-provider-key',
  withE2BErrors: async (_owner: string, _creating: boolean, operation: () => Promise<unknown>) => operation(),
} })
const { Sandbox } = await import('e2b')
const { threadLifecycleProvider } = await import('./thread-lifecycle-provider')
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
