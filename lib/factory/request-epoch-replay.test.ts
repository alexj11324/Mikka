import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { Pool } from 'pg'
import { FactoryError } from './contract'

const sourceEventId = '00000000-0000-4000-8000-000000000001'
const taskId = '00000000-0000-4000-8000-000000000002'
const runId = '00000000-0000-4000-8000-000000000003'
let status = 'running'
let expectedPool: Pool
let workspaceAllowed = true
let workspaceChecks = 0
const completions: [string, string][] = []
const task = () => ({ id: taskId, userId: 'owner', botId: null, issueId: 'issue',
  sourceEventId, stage: 'execute', status, route: { flowVersion: 2 } })

// This replay unit supplies the host boundary explicitly; the real tenant and
// resource leases are covered by factory-background-workspace.db.test.ts.
mock.module('./background-workspace.ts', { namedExports: {
  withFactoryBackgroundWorkspace: async (pool: Pool, owner: string, target: unknown, work: () => Promise<unknown>) => {
    assert.equal(pool, expectedPool)
    assert.equal(owner, 'owner')
    assert.deepEqual(target, { kind: 'task', id: taskId, botId: null })
    workspaceChecks++
    if (!workspaceAllowed) throw new FactoryError('factoryNotFound')
    return work()
  },
} })
mock.module('../db/index.ts', { namedExports: { db: {} } })
mock.module('../run-control.ts', { namedExports: { stopOwnedRun: async () => {
  throw Error('Replaying the accepted event must not stop its current executor')
} } })
mock.module('../run-completion-effects.ts', { namedExports: { afterRunEnded: async (owner: string, id: string) => {
  completions.push([owner, id])
} } })
mock.module('../live/factory.ts', { namedExports: { factoryChanged: async () => {} } })
mock.module('../device-gateway-notify.ts', { namedExports: { runControlChanged: () => {} } })
mock.module('./runtime.ts', { namedExports: { factoryRuntimeForBot: () => ({ store: {
  lockTask: async (_tx: unknown, owner: string, id: string) => {
    assert.equal(owner, 'owner'); assert.equal(id, taskId)
    return task()
  },
} }) } })
const { continueActiveFactoryRequest } = await import('./request-epoch')

function fixture(allowEventWrite = false, admitted = true) {
  const writes: string[] = [], boundaries: string[] = []
  let released = false, connections = 0
  workspaceAllowed = admitted
  workspaceChecks = 0
  completions.length = 0
  const client = {
    async query(sql: string) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) { boundaries.push(sql); return { rows: [] } }
      if (sql.startsWith('SELECT e.payload')) return { rows: [{ payload: { text: 'The original accepted request' } }] }
      if (/^INSERT|^UPDATE|^DELETE/.test(sql)) {
        writes.push(sql)
        if (!allowEventWrite) throw Error('Accepted owner event was incorrectly promoted to a new epoch')
        return { rows: [] }
      }
      throw Error('Unexpected storage read')
    },
    release() { released = true },
  }
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      assert.match(sql, /^SELECT t\.id,t\."botId",t\."issueId" FROM factory_attempts a/)
      assert.deepEqual(params, [runId, 'owner'])
      return { rows: [{ id: taskId, botId: null, issueId: 'issue' }] }
    },
    connect: async () => { connections++; return client },
  } as unknown as Pool
  expectedPool = pool
  return { pool, writes, boundaries, released: () => released, connections: () => connections }
}

test('forwarding the already accepted owner event keeps the current executor and request epoch', async () => {
  status = 'running'
  const f = fixture()
  assert.equal(await continueActiveFactoryRequest(f.pool, 'owner', runId,
    'Coordinator forwarding note does not create new user authority', sourceEventId), true)
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.boundaries, ['BEGIN', 'COMMIT'])
  assert.equal(f.released(), true)
  assert.equal(workspaceChecks, 1)
  assert.deepEqual(completions, [['owner', runId]])
})

test('replaying an accepted event cannot resume a cancelled or revoked task', async () => {
  for (status of ['cancelled', 'revoked']) {
    const f = fixture(true)
    await assert.rejects(continueActiveFactoryRequest(f.pool, 'owner', runId, 'Original request', sourceEventId), { code: 'factoryStopped' })
    assert.equal(f.boundaries.at(-1), 'ROLLBACK')
    assert.equal(f.released(), true)
    assert.equal(workspaceChecks, 1)
    assert.deepEqual(completions, [])
  }
})

test('a rejected Workspace boundary stops replay before transaction or executor side effects', async () => {
  status = 'running'
  const f = fixture(false, false)
  await assert.rejects(continueActiveFactoryRequest(f.pool, 'owner', runId, 'Original request', sourceEventId), { code: 'factoryNotFound' })
  assert.equal(workspaceChecks, 1)
  assert.equal(f.connections(), 0)
  assert.deepEqual(f.boundaries, [])
  assert.deepEqual(f.writes, [])
  assert.deepEqual(completions, [])
  assert.equal(f.released(), false)
})
