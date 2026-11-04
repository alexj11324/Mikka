import assert from 'node:assert/strict'
import test from 'node:test'
import { withTemporaryFlashCredential } from './proactive-test-credentials.mjs'

const env = { SMOKE_OWNER_EMAIL: 'alexjiang20232024+mikka-smoke-owner@gmail.com', SMOKE_OWNER_PASSWORD: 'synthetic-fixture', DEEPSEEK_API_KEY: 'synthetic-key' }
const workspaceId = '00000000-0000-4000-8000-000000000001'
function fixture(existing = false, cloudConfigured = false) {
  const calls = [], keys = existing ? [{ id: 'existing', provider: 'deepseek' }] : []
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname, action = init.headers?.['next-action']
    calls.push({ path, action })
    if (path.endsWith('/sign-in/email')) return new Response('{}', { headers: { 'set-cookie': 'synthetic-session=value; HttpOnly' } })
    if (path.endsWith('/get-session')) return Response.json({ user: { email: env.SMOKE_OWNER_EMAIL } })
    if (path.endsWith('/api/bots')) return Response.json([{ workspaceId }])
    if (path.endsWith('/api-keys')) return Response.json({ keys })
    if (path.endsWith('/e2b-key')) return Response.json({ configured: cloudConfigured, canEdit: true })
    if (action === 'create') { keys.push({ id: 'new-fixture', provider: 'deepseek' }); return new Response('0:{"a":"$@1"}\n1:{"id":"new-fixture","provider":"deepseek"}\n') }
    if (action === 'delete') { assert.deepEqual(JSON.parse(init.body), ['new-fixture', workspaceId]); return new Response('1:{"removed":true}\n') }
    if (action === 'save-cloud') { cloudConfigured = true; return new Response('1:{"configured":true,"byoEnabled":true}\n') }
    if (action === 'delete-cloud') { assert.deepEqual(JSON.parse(init.body), [workspaceId]); cloudConfigured = false; return new Response('1:{"removed":true}\n') }
    if (path.endsWith('/sign-out')) return Response.json({ success: true })
    throw Error('unexpected_fixture_request')
  }
  return { calls, fetchImpl, discover: async () => ({ createApiKey: 'create', deleteApiKey: 'delete', saveE2BKey: 'save-cloud', deleteE2BKey: 'delete-cloud' }) }
}
test('unauthorized test identity cannot sign in or inspect credentials', async () => {
  let requests = 0
  await assert.rejects(() => withTemporaryFlashCredential(() => {}, { env: { ...env, SMOKE_OWNER_EMAIL: 'unrelated@example.com' }, fetchImpl: async () => { requests++; throw Error('unexpected') } }), /acceptance_account_required/)
  assert.equal(requests, 0)
})
test('an existing personal key is neither replaced nor deleted', async () => {
  const f = fixture(true)
  await withTemporaryFlashCredential(cleanup => { assert.equal(cleanup.created, false) }, { env, ...f })
  assert.equal(f.calls.filter(call => call.action).length, 0)
  assert.ok(f.calls.at(-1).path.endsWith('/sign-out'))
})
test('an unsuccessful acceptance still removes only its newly returned key and signs out', async () => {
  const f = fixture()
  let receipt
  await assert.rejects(() => withTemporaryFlashCredential(cleanup => { receipt = cleanup; throw Error('fixture_acceptance_failed') }, { env, ...f }), /fixture_acceptance_failed/)
  assert.deepEqual(receipt, { created: true, removed: true })
  assert.deepEqual(f.calls.flatMap(call => call.action ? [call.action] : []), ['create', 'delete'])
  assert.ok(f.calls.at(-1).path.endsWith('/sign-out'))
})
test('cloud acceptance preserves an existing runtime credential', async () => {
  const f = fixture(true, true)
  await withTemporaryFlashCredential(() => {}, { env, ...f, cloudExecution: true })
  assert.equal(f.calls.filter(call => call.action).length, 0)
})
test('a failed cloud acceptance cleans both newly configured credentials', async () => {
  const f = fixture()
  let receipt
  await assert.rejects(() => withTemporaryFlashCredential(cleanup => { receipt = cleanup; throw Error('fixture_failed') }, { env: { ...env, E2B_API_KEY: 'synthetic-cloud-key' }, ...f, cloudExecution: true }), /fixture_failed/)
  assert.deepEqual(receipt, { created: true, removed: true, cloudCreated: true, cloudRemoved: true })
  assert.deepEqual(f.calls.flatMap(call => call.action ? [call.action] : []), ['create', 'save-cloud', 'delete-cloud', 'delete'])
  assert.ok(f.calls.at(-1).path.endsWith('/sign-out'))
})
