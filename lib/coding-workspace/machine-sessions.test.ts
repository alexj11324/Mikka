import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { TaskReviewAuthority } from './review-authority'

const scope = { runId: 'current-run', machineKind: 'cloud' } as TaskReviewAuthority
const client = {}
let active = true
let reads = 0
mock.module('./review-authority', { namedExports: {
  ReviewAuthorityError: Error,
  withTaskReviewAuthority: async (_: Request, id: string, read: (authority: TaskReviewAuthority, connection: object) => unknown) => {
    assert.equal(id, 'task')
    return read(scope, client)
  },
} })
mock.module('./review-sessions', { namedExports: {
  readReviewSession: async (authority: TaskReviewAuthority, { kind }: { kind: string }, connection: object) => {
    assert.equal(authority, scope)
    assert.equal(connection, client)
    reads++
    return active && kind === 'terminal' ? { id: 'private-lease-id', expiresAt: '2026-01-01T00:00:00.000Z', reviewOperationId: 'private-operation' } : null
  },
} })
const { GET } = await import('../../app/api/tasks/[taskId]/review/machine-sessions/route')
const read = (query = '') => GET(new Request('https://localhost/api/tasks/task/review/machine-sessions' + query),
  { params: Promise.resolve({ taskId: 'task' }) })

test('only current-credential review leases expose their kind and absolute expiry on the locked Task', async () => {
  const result = await read()
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await result.json(), { runId: 'current-run', sessions: [{ kind: 'terminal', expiresAt: '2026-01-01T00:00:00.000Z' }] })
  active = false
  assert.deepEqual(await (await read()).json(), { runId: 'current-run', sessions: [] })
})

test('foreign selectors and local machines cannot read control-plane review leases', async () => {
  const before = reads
  assert.equal((await read('?runId=elsewhere')).status, 400)
  scope.machineKind = 'local'
  assert.equal((await read()).status, 422)
  assert.equal(reads, before)
})
