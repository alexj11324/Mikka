import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { TaskReviewAuthority } from './review-authority'

const fixture = {
  taskId: 'task', runId: 'run', workspaceId: 'workspace', ownerId: 'owner', sandboxId: 'sandbox',
  machineKind: 'cloud', bindingId: 'binding', runStartedAt: new Date(Date.now() - 30_000).toISOString(),
} as TaskReviewAuthority
let scope = fixture
let rebinding = false
let calls = 0
class AuthorityFailure extends Error {
  code = 'review_binding_changed'
  status = 409
}
mock.module('./review-authority', { namedExports: {
  ReviewAuthorityError: AuthorityFailure,
  taskReviewAuthority: async (_request: Request, id: string, expected?: object) => {
    assert.equal(id, fixture.taskId)
    if (expected) {
      assert.deepEqual(expected, { workspaceId: fixture.workspaceId, runId: fixture.runId, bindingId: fixture.bindingId })
      if (rebinding) throw new AuthorityFailure()
    }
    return scope
  },
} })
mock.module('../computer/e2b-provider', { namedExports: {
  computerGone: () => false,
  readComputerMetrics: async (ownerId: string, sandboxId: string, start: Date, end: Date) => {
    calls++
    assert.equal(ownerId, fixture.ownerId)
    assert.equal(sandboxId, fixture.sandboxId)
    assert.equal(start.toISOString(), fixture.runStartedAt)
    const sample = { cpuCount: 2, cpuUsedPct: 20, memUsed: 5, memTotal: 10, memCache: 0, diskUsed: 5, diskTotal: 12 }
    return [
      { ...sample, timestamp: new Date(start.getTime() - 1) },
      { ...sample, timestamp: new Date(end.getTime() - 10), cpuUsedPct: 14, internal: 'omit' },
      { ...sample, timestamp: new Date(end.getTime() - 20), cpuUsedPct: 13 },
      { ...sample, timestamp: new Date(end.getTime() + 1) },
    ]
  },
} })
const { GET } = await import('../../app/api/tasks/[taskId]/review/machine-metrics/route')
const read = (search = '') => GET(new Request('https://fixture.example.test/api/tasks/task/review/machine-metrics' + search),
  { params: Promise.resolve({ taskId: fixture.taskId }) })

test('only a server-bound BYO machine yields the latest sample of this Run after reauthorization', async () => {
  const response = await read()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const body = await response.json()
  assert.equal(body.runId, fixture.runId)
  assert.equal(body.sample.cpuUsedPct, 14)
  assert.equal(body.sample.internal, undefined)
  rebinding = true
  const changed = await read()
  assert.equal(changed.status, 409)
  assert.deepEqual(await changed.json(), { error: 'review_binding_changed' })
  rebinding = false
  assert.equal(calls, 2)
})

test('invalid selectors and unsupported providers never make a provider request', async () => {
  const previous = calls
  assert.equal((await read('?sandboxId=elsewhere')).status, 400)
  scope = { ...fixture, machineKind: 'local' }
  assert.equal((await read()).status, 404)
  scope = { ...fixture, sponsoredPlacement: { operationId: 'operation', repositoryKey: 'repository' } }
  assert.equal((await read()).status, 404)
  scope = { ...fixture, runStartedAt: null }
  const unavailable = await read()
  assert.equal(unavailable.status, 200)
  assert.equal((await unavailable.json()).sample, null)
  scope = fixture
  assert.equal(calls, previous)
})
