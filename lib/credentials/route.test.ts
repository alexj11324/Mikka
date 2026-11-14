import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, mock, test } from 'node:test'
import { CredentialError, type BrowserCaller } from './contracts'

const actor = { userId: 'fixture-owner', workspaceId: randomUUID() }
const botId = randomUUID(), runId = randomUUID(), subagentId = randomUUID()
const site = 'https://fixture.example'
const calls: string[] = []
let owned = true, allowed = true
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  query: async (_sql: string, values: unknown[]) => {
    assert.deepEqual(values, [runId, actor.userId])
    calls.push('run')
    return { rows: owned ? [{ botId }] : [] }
  },
} } })
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  credentialActor: async () => { calls.push('actor'); return actor },
  credentialStore: {
    authorize: async (caller: BrowserCaller) => {
      calls.push('authorize')
      assert.equal(caller.userId, actor.userId)
      assert.equal(caller.workspaceId, actor.workspaceId)
      assert.equal(caller.botId, botId)
      if (!allowed) throw new CredentialError('credential_denied', 404)
    },
    challenge: async () => { calls.push('challenge'); return { origin: site } },
  },
  resolveCredentialBrowser: async () => { calls.push('browser'); return { origin: site } },
  login: async () => { throw Error('unexpected login') },
  executeCredentialLease: async () => { throw Error('unexpected lease') },
} })
let routes: typeof import('./route')
before(async () => { routes = await import('./route') })
function request() {
  return new Request('https://mikka.example/api/credentials', { method: 'POST',
    headers: { origin: 'https://mikka.example', 'content-type': 'application/json', 'x-mikka-credential': '1' },
    body: JSON.stringify({ site }) })
}
test('thread and subagent challenges resolve the request actor once and authorize the bound browser', async () => {
  calls.length = 0
  assert.equal((await routes.threadCredentialRoute(request(), runId, 'challenge')).status, 200)
  assert.deepEqual(calls, ['actor', 'run', 'authorize', 'browser', 'challenge'])
  calls.length = 0
  assert.equal((await routes.subagentCredentialRoute(request(), botId, subagentId, 'challenge')).status, 200)
  assert.deepEqual(calls, ['actor', 'authorize', 'browser', 'challenge'])
})
test('missing run or rejected current binding stops before browser resolution', async () => {
  try {
    owned = false; calls.length = 0
    assert.equal((await routes.threadCredentialRoute(request(), runId, 'challenge')).status, 404)
    assert.deepEqual(calls, ['actor', 'run'])
    owned = true; allowed = false; calls.length = 0
    assert.equal((await routes.threadCredentialRoute(request(), runId, 'challenge')).status, 404)
    assert.deepEqual(calls, ['actor', 'run', 'authorize'])
  } finally { owned = true; allowed = true }
})
