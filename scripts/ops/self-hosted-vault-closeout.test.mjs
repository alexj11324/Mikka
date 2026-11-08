import test from 'node:test'
import assert from 'node:assert/strict'
import { ownedMachine, ownHttps, loginMatches } from './self-hosted-vault-closeout.mjs'
const actor = { userId: 'fixture', workspaceId: '00000000-0000-4000-8000-000000000001' }
const row = { ...actor, ownerId: actor.userId, sandboxId: 'owned123456789', operationId: '00000000-0000-4000-8000-000000000002' }
const metadata = { application: 'mikka', workspaceId: actor.workspaceId }
test('cleanup requires both exact owner/workspace row and provider metadata', () => {
  assert.equal(ownedMachine(row, actor, metadata), row.sandboxId)
  for (const bad of [{ ...row, ownerId: 'foreign' }, { ...row, workspaceId: 'foreign' }, { ...row, operationId: '' }]) assert.throws(() => ownedMachine(bad, actor, metadata))
  assert.throws(() => ownedMachine(row, actor, { ...metadata, workspaceId: 'foreign' }))
  assert.throws(() => ownedMachine(row, actor, { ...metadata, application: 'other' }))
})
test('fixture origin rejects credentials, query, path and arbitrary domains', () => {
  assert.equal(ownHttps('https://owned-site.trycloudflare.com'), 'https://owned-site.trycloudflare.com')
  for (const value of ['http://owned-site.trycloudflare.com', 'https://example.com', 'https://u@owned.trycloudflare.com', 'https://owned.trycloudflare.com/?token=x', 'https://owned.trycloudflare.com/x']) assert.throws(() => ownHttps(value))
})
test('site accepts exactly the expected disposable fields and rejects ambiguity', () => {
  assert.equal(loginMatches('username=owned&password=secret', 'owned', 'secret'), true)
  for (const body of ['username=owned&password=other', 'username=foreign&password=secret', 'username=owned&password=secret&password=secret', 'username=owned']) assert.equal(loginMatches(body, 'owned', 'secret'), false)
})
