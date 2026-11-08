import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { Pool } from 'pg'

const sourceEventId = '00000000-0000-4000-8000-000000000001'
const taskId = '00000000-0000-4000-8000-000000000002'
const runId = '00000000-0000-4000-8000-000000000003'
let status = 'running'
const task = () => ({ id: taskId, userId: 'owner', botId: null, issueId: 'issue',
  sourceEventId, stage: 'execute', status, route: { flowVersion: 2 } })

mock.module('../live/factory.ts', { namedExports: { factoryChanged: async () => {} } })
mock.module('../device-gateway-notify.ts', { namedExports: { runControlChanged: () => {} } })
mock.module('./runtime.ts', { namedExports: { factoryRuntimeForBot: () => ({ store: {
  lockTask: async (_tx: unknown, owner: string, id: string) => {
    assert.equal(owner, 'owner'); assert.equal(id, taskId)
    return task()
  },
} }) } })
const { continueActiveFactoryRequest } = await import('./request-epoch')

function fixture(allowEventWrite = false) {
  const writes: string[] = [], boundaries: string[] = []
  let released = false
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
    query: async () => ({ rows: [{ id: taskId, botId: null, issueId: 'issue' }] }),
    connect: async () => client,
  } as unknown as Pool
  return { pool, writes, boundaries, released: () => released }
}

test('forwarding the already accepted owner event keeps the current executor and request epoch', async () => {
  status = 'running'
  const f = fixture()
  assert.equal(await continueActiveFactoryRequest(f.pool, 'owner', runId,
    'Coordinator forwarding note does not create new user authority', sourceEventId), true)
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.boundaries, ['BEGIN', 'COMMIT'])
  assert.equal(f.released(), true)
})

test('replaying an accepted event cannot resume a cancelled or revoked task', async () => {
  for (status of ['cancelled', 'revoked']) {
    const f = fixture(true)
    await assert.rejects(continueActiveFactoryRequest(f.pool, 'owner', runId, 'Original request', sourceEventId), { code: 'factoryStopped' })
    assert.equal(f.boundaries.at(-1), 'ROLLBACK')
    assert.equal(f.released(), true)
  }
})
