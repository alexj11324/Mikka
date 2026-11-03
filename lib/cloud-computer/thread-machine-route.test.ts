import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { before, mock } from 'node:test'

// Goes through the real app/api/threads/[runId]/machine/route.ts. The session,
// workspace and machine actions are stubbed, so no database or E2B is reached.
// Run with --experimental-test-module-mocks.

const calls: string[] = []
let route: typeof import('../../app/api/threads/[runId]/machine/route')

before(async () => {
  mock.module(new URL('../api-auth.ts', import.meta.url).href, {
    namedExports: { auth: { api: { getSession: async () => ({ user: { id: 'alice' }, session: { id: 's' } }) } } },
  })
  mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {}, db: null } })
  mock.module(new URL('../workspace-access.ts', import.meta.url).href, {
    namedExports: { loadWorkspaceContext: async () => ({ workspace: { id: 'workspace-a' } }) },
  })
  mock.module(new URL('./thread-machines.ts', import.meta.url).href, {
    namedExports: { threadMachineAction: async (_pool: unknown, _actor: unknown, runId: string, action: string) => { calls.push(action); return { runId, state: action } } },
  })
  route = await import('../../app/api/threads/[runId]/machine/route')
})

const origin = 'https://mikka.example'
const post = (runId: string, body: unknown) => route.POST(
  new Request(`${origin}/api/threads/${runId}/machine`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ runId }) },
)

// Nobody watches a thread's desktop (decision 2026-11-02-1050, #958): no action issues a view grant.
test('the thread machine route refuses a desktop view and issues no grant', async () => {
  const response = await post(randomUUID(), { action: 'desktop' })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'Invalid request' })
  assert.deepEqual(calls, [], 'the request never reaches a machine action')
})

test('pause, resume, end and authorized runtime refresh reach the thread machine', async () => {
  calls.length = 0
  for (const action of ['pause', 'resume', 'end', 'refresh_runtime']) {
    const runId = randomUUID()
    const response = await post(runId, { action })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { runId, state: action })
  }
  assert.deepEqual(calls, ['pause', 'resume', 'end', 'refresh_runtime'])
})


test('runtime refresh retains the same-origin request boundary', async () => {
  calls.length = 0
  const runId = randomUUID()
  const response = await route.POST(new Request(`${origin}/api/threads/${runId}/machine`, {
    method: 'POST', headers: { origin: 'https://foreign.example', 'content-type': 'application/json' }, body: JSON.stringify({action:'refresh_runtime'}),
  }), {params:Promise.resolve({runId})})
  assert.equal(response.status,403)
  assert.deepEqual(calls,[])
})
