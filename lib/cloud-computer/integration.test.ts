import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

const actor = { userId: 'owner', workspaceId: 'workspace', botId: 'bot', subagentId: 'subagent' }
const login = mock.fn(async (_caller: typeof actor, _site: string) => ({ status: 'submitted' as const }))
const query = mock.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ sandboxId: 'synthetic-sandbox', targetId: 'target' }] }))
let guarded = false
const runtimeRequest = mock.fn(async () => ({ guarded, targetId: 'target', url: 'https://example.test/login' }))
const grant = mock.fn(async () => ({ endpoint: 'https://example.invalid', expiresAt: 123 }))
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../credentials/runtime.ts', { login })
stub('../db/index.ts', { pool: { query } })
stub('../computer/e2b-provider.ts', { connectComputer: async () => ({}) })
stub('./runtime.ts', { runtimeRequest, grant })
let requestBrowserLogin: typeof import('./login-provider').requestBrowserLogin
let resolveSubagentBrowserTarget: typeof import('./subagent-browser').resolveSubagentBrowserTarget
before(async () => {
  requestBrowserLogin = (await import('./login-provider')).requestBrowserLogin
  resolveSubagentBrowserTarget = (await import('./subagent-browser')).resolveSubagentBrowserTarget
})

test('combined login seam calls the real credential service contract with the bound actor', async () => {
  assert.deepEqual(await requestBrowserLogin(actor, 'https://example.test'), { status: 'submitted' })
  assert.deepEqual(login.mock.calls[0].arguments, [actor, 'https://example.test', undefined, undefined])
})

test('combined browser seam binds all actor dimensions and refuses guarded targets', async () => {
  guarded = false
  const result = await resolveSubagentBrowserTarget(actor)
  assert.equal(result.targetId, 'target')
  assert.equal(result.origin, 'https://example.test')
  assert.deepEqual(query.mock.calls[0].arguments[1], [actor.subagentId, actor.userId, actor.workspaceId, actor.botId])
  assert.equal(grant.mock.callCount(), 1)
  guarded = true
  await assert.rejects(resolveSubagentBrowserTarget(actor), /Browser target unavailable/)
  assert.equal(grant.mock.callCount(), 1, 'guarded targets never receive a broker capability')
})
