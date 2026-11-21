import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import test, { mock } from 'node:test'
import type { PoolClient } from 'pg'
import { internalEveAuthorization } from '../eve/auth'
import { overrideDeploymentSwitch } from '../deployment-switches'
import { currentExecutionAuthority, withEveProductAuthority } from './execution-authority'

const scope = { ownerId: 'eve-authority-owner', workspaceId: '10000000-0000-4000-8000-000000000001', botId: '10000000-0000-4000-8000-000000000002', surface: 'web' as const }
const input = { sessionId: 'session-fixture', turnId: 'turn-fixture', executionId: '10000000-0000-4000-8000-000000000003' }

test('Eve product authority requires the signed service scope and a current persisted session/execution binding', async t => {
  const original = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'synthetic-eve-authority-key-0000000000000000'
  overrideDeploymentSwitch('agentKit', true)
  t.after(() => {
    overrideDeploymentSwitch('agentKit', undefined)
    if (original === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = original
  })
  let persisted = true, calls = 0
  const query = { query: async (sql: string, values: unknown[]) => {
    calls++
    assert.match(sql, /JOIN bots b/)
    assert.match(sql, /b\."archivedAt" IS NULL/)
    assert.match(sql, /e\.status='running'/)
    assert.deepEqual(values, [input.sessionId, scope.ownerId, scope.workspaceId, scope.botId, scope.surface, input.executionId, `${input.sessionId}:${input.turnId}:0`])
    return { rows: persisted ? [{}] : [] }
  } } as unknown as Pick<PoolClient, 'query'>
  const gate = () => currentExecutionAuthority(scope.ownerId, scope.workspaceId, query)
  assert.equal(await gate(), undefined, 'plain app calls cannot construct execution authority')
  await assert.rejects(withEveProductAuthority(null, input, gate), /workspaceAccessDenied/)
  await assert.rejects(withEveProductAuthority(new Request('https://app.example', {headers:{authorization:'Bearer invalid'}}), input, gate), /workspaceAccessDenied/)
  const signed = new Request('https://app.example', {headers:{authorization:internalEveAuthorization(scope)}})
  let escaped!: () => Promise<boolean | undefined>
  await withEveProductAuthority(signed, input, async () => {
    assert.equal(await gate(), true)
    escaped = AsyncLocalStorage.bind(gate)
    persisted = false
    assert.equal(await gate(), false, 'session removal or execution end revokes current authority')
    persisted = true
    assert.equal(await currentExecutionAuthority('another-owner', scope.workspaceId, query), false)
    assert.equal(await currentExecutionAuthority(scope.ownerId, 'another-workspace', query), false)
  })
  assert.equal(await escaped(), false, 'authority is retired when the gateway callback completes')
  assert.equal(await gate(), undefined)
  assert.equal(calls, 2)
  assert.equal(await withEveProductAuthority(signed, { ...input, executionId: null }, gate), false, 'enabled agent kit requires its persisted execution')
  const now = Date.now()
  mock.method(Date, 'now', () => now + 61_000)
  try { await assert.rejects(withEveProductAuthority(signed, input, gate), /workspaceAccessDenied/) }
  finally { mock.restoreAll() }
})

test('the signature is rechecked at each gate, including expiry during one tool callback', async t => {
  const original = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'synthetic-eve-expiry-key-000000000000000000'
  t.after(() => { if (original === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = original })
  const now = Date.now()
  const signed = new Request('https://app.example', {headers:{authorization:internalEveAuthorization(scope, now)}})
  await withEveProductAuthority(signed, input, async () => {
    mock.method(Date, 'now', () => now + 61_000)
    try {
      const query = { query: async () => { throw new Error('expired credentials must fail before SQL') } } as unknown as Pick<PoolClient, 'query'>
      assert.equal(await currentExecutionAuthority(scope.ownerId, scope.workspaceId, query), false)
    } finally { mock.restoreAll() }
  })
})

test('Cloudflare product authority uses binding provenance and current database authority after the old token deadline', async t => {
  t.mock.property(process, 'env', { ...process.env, MIKKA_API_INGRESS: 'cloudflare', BETTER_AUTH_SECRET: '' })
  const request = new Request('https://app.example/mikka/api/internal/eve/tools', {headers:{'x-mikka-eve-binding-scope':JSON.stringify(scope)}})
  let current = true
  const query = {query: async (_sql: string, values: unknown[]) => {
    assert.deepEqual(values, [input.sessionId, scope.ownerId, scope.workspaceId, scope.botId, scope.surface, input.executionId, `${input.sessionId}:${input.turnId}:0`])
    return {rows: current ? [{}] : []}
  }} as unknown as Pick<PoolClient, 'query'>
  const gate = () => currentExecutionAuthority(scope.ownerId, scope.workspaceId, query)
  const now = Date.now()
  await withEveProductAuthority(request, input, async () => {
    t.mock.method(Date, 'now', () => now + 61_000)
    assert.equal(await gate(), true)
    current = false
    assert.equal(await gate(), false)
    t.mock.method(Date, 'now', () => now + 5 * 60_000)
    assert.equal(await gate(), false)
  })
  assert.equal(await gate(), undefined)
})
