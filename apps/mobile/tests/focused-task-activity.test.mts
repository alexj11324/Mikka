import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const issue = '00000000-0000-4000-8000-000000000001', workspace = '00000000-0000-4000-8000-000000000002'
const factoryId = '00000000-0000-4000-8000-000000000003'
let combined = false, context = 'origin', capability = true, entitled = true, revoked = false, swap = false
let requests: { path: string; body?: Record<string, unknown> }[] = []
const source = { version: 1, task: { id: factoryId, issueId: issue }, events: [{ kind: 'evidence', sourceId: 'immutable-version' }] }
class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: {
  ApiError, apiConnection: () => ({ context }), api: async (path: string, config: { body?: Record<string, unknown> }, connection: { context: string }) => {
    assert.equal(connection.context, 'origin')
    requests.push({ path, body: config.body })
    if (path === '/task?work=1') return { ...(combined ? { work: {version: 1, connections: [], conversations: [], pullRequests: []} } : {}), task: { id: issue }, live: { workspaceId: workspace, ...(capability ? { factoryActivityVersion: 1 } : {}) } }
    if (path === '/api/mobile/task-presentations') {
      if (swap) context = 'other'
      return { version: 1, workspaceId: workspace, items: { [issue]: { primaryStatus: 'todo', ...(capability && entitled ? { factoryTaskId: factoryId } : {}) } } }
    }
    assert.equal(path, '/api/factory/tasks/' + factoryId + '/activity')
    if (revoked) throw new ApiError(404, 'factoryNotFound')
    return source
  },
} })
mock.module(new URL('../lib/api-cache.ts', import.meta.url).href, { namedExports: { apiCache: { context: () => context } } })
const { readPresentedTask } = await import('../features/tasks/model/task-presentation-read.ts')

test('only the selected Task with a confirmed Factory identity reads evidence, on its original account', async () => {
  let result = await readPresentedTask('/task')
  assert.deepEqual(result.factoryEvents, source.events)
  assert.equal(result.task.factoryTaskId, factoryId)
  assert.equal(requests.length, 3)
  assert.equal(requests[1].body?.includeFactoryIdentity, true)
  requests = []; entitled = false
  result = await readPresentedTask('/task')
  assert.equal(requests.length, 2)
  assert.equal(result.factoryEvents, undefined)
  requests = []; capability = false
  await readPresentedTask('/task')
  assert.equal(requests[1].body?.includeFactoryIdentity, undefined, 'older strict schemas receive their existing input')
  requests = []; capability = true; entitled = true; revoked = true
  result = await readPresentedTask('/task')
  assert.equal(result.task.id, issue)
  assert.equal(result.task.factoryTaskId, undefined)
  assert.equal(result.factoryEvents, undefined)
  requests = []; revoked = false; swap = true
  await assert.rejects(() => readPresentedTask('/task'), /workspaceAccessDenied/)
  assert.equal(requests.length, 2, 'no evidence request after an account change')
})

test('the versioned task work response needs only the authorized detail request', async () => {
  context = 'origin'; swap = false; combined = true; requests = []
  try {
    const result = await readPresentedTask('/task')
    assert.deepEqual(result.work, { version: 1, connections: [], conversations: [], pullRequests: [] })
    assert.deepEqual(requests.map(request => request.path), ['/task?work=1'])
  } finally { combined = false }
})
