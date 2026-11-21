import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { Sandbox } from 'e2b'
import { startExternalServices } from '../../tests/fakes/external-services.mjs'
import { LOCAL_E2B_KEY } from '../../tests/fakes/e2b.mjs'
import type { TaskReviewAuthority } from './review-authority'

const fixture = {
  taskId: 'task', runId: 'run', workspaceId: 'workspace', ownerId: 'owner', sandboxId: 'sandbox',
  machineKind: 'cloud', bindingId: 'binding', runStartedAt: new Date(Math.floor(Date.now() / 1000) * 1000 - 30_000).toISOString(),
} as TaskReviewAuthority
let scope = fixture
let rebinding = false
let services: Awaited<ReturnType<typeof startExternalServices>>
const calls = () => services.e2b.requests.filter((request: { path: string }) => request.path.endsWith('/metrics')).length
const saved = Object.fromEntries(['E2B_API_URL', 'E2B_SANDBOX_URL', 'E2B_HTTP_VERSION', 'HTTPS_PROXY', 'https_proxy'].map(key => [key, process.env[key]]))
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
mock.module('../secrets/e2b-runtime', { namedExports: {
  e2bApiKey: async (ownerId: string) => {
    assert.equal(ownerId, fixture.ownerId)
    return LOCAL_E2B_KEY
  },
  withE2BErrors: async (_owner: string, _creating: boolean, operation: () => Promise<unknown>) => operation(),
  computerTemplate: () => 'desktop', sandboxKeyOwner: async () => fixture.ownerId,
} })
before(async () => {
  services = await startExternalServices()
  Object.assign(process.env, { E2B_API_URL: services.e2bOptions.apiUrl, E2B_SANDBOX_URL: services.e2bOptions.sandboxUrl,
    E2B_HTTP_VERSION: '1.1', HTTPS_PROXY: '', https_proxy: '' })
  fixture.sandboxId = (await Sandbox.create('base', services.e2bOptions)).sandboxId
  services.e2b.state.metrics = ({ sandbox, url }: { sandbox: { id: string }; url: URL }) => {
    assert.equal(sandbox.id, fixture.sandboxId)
    const start = new Date(Number(url.searchParams.get('start')) * 1000), end = new Date(Number(url.searchParams.get('end')) * 1000)
    assert.equal(start.toISOString(), fixture.runStartedAt)
    const sample = { cpuCount: 2, cpuUsedPct: 20, memUsed: 5, memTotal: 10, memCache: 0, diskUsed: 5, diskTotal: 12 }
    return [
      { ...sample, timestamp: new Date(start.getTime() - 1000) },
      { ...sample, timestamp: new Date(end.getTime() - 1000), cpuUsedPct: 14, internal: 'omit' },
      { ...sample, timestamp: new Date(end.getTime() - 2000), cpuUsedPct: 13 },
      { ...sample, timestamp: new Date(end.getTime() + 1000) },
    ]
  }
})
after(async () => {
  await services?.close()
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
})
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
  assert.equal(calls(), 2)
})

test('invalid selectors and unsupported providers never make a provider request', async () => {
  const previous = calls()
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
  assert.equal(calls(), previous)
})

test('a reclaimed E2B sandbox is reported through the real SDK as review_machine_gone', async () => {
  services.e2b.expire(fixture.sandboxId!)
  const response = await read()
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'review_machine_gone' })
})
