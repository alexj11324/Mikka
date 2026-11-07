import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { FactoryError } from '../lib/factory/contract'

test('Factory flow routes accept only a freshly verified native or browser human and retain core permission/origin checks', async t => {
  const taskId = randomUUID(), foreignTaskId = randomUUID(), origin = 'https://fixture.invalid'
  const token = 'a'.repeat(32)
  let authReads = 0, readTasks = 0, approvals = 0
  const observed: Headers[] = []
  const verifiedUsers = new WeakSet<object>()
  const tx = { query: async () => ({ rows: [] }), release: () => {} }
  const mocks = [
    mock.module(new URL('../lib/api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async (input: { headers: Headers; query: { disableCookieCache: boolean } }) => {
      authReads++
      assert.equal(input.query.disableCookieCache, true, 'every GET and approval revalidates the database session')
      observed.push(input.headers)
      const native = input.headers.get('authorization') === `Bearer ${token}`
      const browser = !input.headers.has('authorization') && input.headers.get('cookie') === 'fixture-browser=owner'
      if (!native && !browser) return null
      const user = { id: 'owner' }
      verifiedUsers.add(user)
      return { user, session: { id: native ? 'native-session' : 'browser-session' } }
    } } } } }),
    // This unit retains the actual human credential/origin/core adapters.
    // Real Workspace/APP admission and tenant refusals have a separate PG suite.
    mock.module(new URL('../lib/factory/workspace-http.ts', import.meta.url).href, { namedExports: {
      factoryHumanWorkspaceResponse: async (user: { id: string } | null | undefined, work: () => Promise<Response>) => {
        if (user) assert.equal(verifiedUsers.has(user), true, 'the route preserves the full verified user instead of reconstructing an id-only actor')
        return work()
      },
    } }),
    mock.module(new URL('../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: { connect: async () => tx } } }),
    mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_name: string, handler: unknown) => handler, noteLogUser: () => {} } }),
    mock.module(new URL('../lib/factory/server.ts', import.meta.url).href, { namedExports: {
      factoryHumanStore: { readTask: async (client: unknown, userId: string, id: string) => {
        readTasks++
        assert.equal(client, tx); assert.equal(userId, 'owner')
        if (id !== taskId) throw new FactoryError('factoryNotFound')
        return { id }
      } },
      factorySpecApproval: async (actor: { userId: string; sessionId: string }, input: { binding: { taskId: string; revision: number } }) => {
        approvals++
        assert.equal(actor.userId, 'owner')
        assert.ok(['native-session', 'browser-session'].includes(actor.sessionId))
        assert.equal(input.binding.taskId, taskId)
        return { binding: input.binding, stage: 'implement' }
      },
    } }),
    // The real approval schema imports a dispatch helper, but this adapter unit
    // supplies its own approval port above. Loading device execution is outside
    // its boundary; an unexpected dispatch remains a hard failure.
    mock.module(new URL('../lib/factory/dispatch.ts', import.meta.url).href, { namedExports: {
      factoryBinding: () => assert.fail('the HTTP adapter unit must not dispatch a real run'),
    } }),
    mock.module(new URL('../lib/factory/public-flow.ts', import.meta.url).href, { namedExports: { readFactoryFlow: async (_client: unknown, task: { id: string }) => ({ version: 2, id: task.id }) } }),
  ]
  try {
    const route = await import('../app/api/factory/tasks/[taskId]/flow/route')
    const body = { operation: 'approve_spec', input: { binding: { taskId, revision: 1 }, eventId: randomUUID() } }
    const request = (headers: Record<string, string>, method: 'GET' | 'POST' = 'GET', input: unknown = body, id = taskId) => route[method](new Request(`${origin}/mikka/api/factory/tasks/${id}/flow`, {
      method, headers: { origin, 'content-type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
    }), { params: Promise.resolve({ taskId: id }) })
    const native = { authorization: `Bearer ${token}`, cookie: 'fixture-browser=foreign' }

    await t.test('native GET and approve_spec enter the actual core handler under the verified identity', async () => {
      const get = await request(native)
      assert.equal(get.status, 200); assert.deepEqual(await get.json(), { version: 2, id: taskId })
      assert.equal(observed.at(-1)?.has('cookie'), false)
      const approve = await request(native, 'POST')
      assert.equal(approve.status, 200); assert.equal((await approve.json()).stage, 'implement')
      assert.equal(readTasks, 1); assert.equal(approvals, 1)
      assert.equal((await request({ cookie: 'fixture-browser=owner' })).status, 200, 'existing cookie-authenticated web reads remain supported')
    })
    await t.test('invalid, personal-access, delegated and anonymous credentials cannot use a browser cookie to enter', async () => {
      for (const authorization of ['Bearer short', `Bearer mkp_${'x'.repeat(43)}`, `Bearer mka_${'x'.repeat(43)}`, `Bearer mkr_${'x'.repeat(43)}`]) {
        const before = authReads
        assert.equal((await request({ authorization, cookie: 'fixture-browser=owner' })).status, 401)
        assert.equal(authReads, before, 'delegated and malformed tokens never reach the human session reader')
      }
      const before = approvals
      assert.equal((await request({ authorization: `Bearer ${'b'.repeat(32)}`, cookie: 'fixture-browser=owner' }, 'POST')).status, 401)
      assert.equal(observed.at(-1)?.has('cookie'), false)
      assert.equal((await request({})).status, 401)
      assert.equal(approvals, before)
    })
    await t.test('a fresh native actor still cannot bypass origins, owned task lookup or strict approval input', async () => {
      const before = approvals
      for (const badOrigin of ['https://foreign.invalid', 'null', '']) assert.equal((await request({ ...native, origin: badOrigin }, 'POST')).status, 403)
      assert.equal((await request(native, 'GET', undefined, foreignTaskId)).status, 404)
      assert.equal((await request(native, 'POST', { ...body, actor: { userId: 'foreign' } })).status, 422)
      assert.equal((await request(native, 'POST', { ...body, operation: 'advance' })).status, 422)
      assert.equal((await request(native, 'POST', { ...body, input: { ...body.input, binding: { taskId: foreignTaskId, revision: 1 } } })).status, 422)
      assert.equal(approvals, before)
    })
  } finally { for (const handle of mocks.reverse()) handle.restore() }
})
