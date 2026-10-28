import assert from 'node:assert/strict'
import test from 'node:test'
import { accountUpdateSchema, composioConnectRedirect, disconnectComposioAccount, toConnectedAccountView } from './composio-accounts'

const account = { id: 'ca_1', status: 'ACTIVE', isDisabled: false, alias: null as string | null, createdAt: '2026-10-28T10:00:00.000Z', toolkit: { slug: 'gmail' } }

test('shows only real accounts on our apps, without credentials', () => {
  const withSecrets = { ...account, alias: '  Work  ', state: { val: { access_token: 'secret' } } }
  assert.deepEqual(toConnectedAccountView(withSecrets), {
    id: 'ca_1', toolkit: 'gmail', status: 'ACTIVE', enabled: true, alias: 'Work', createdAt: '2026-10-28T10:00:00.000Z',
  })
  assert.equal(toConnectedAccountView({ ...account, toolkit: { slug: 'github' } }), null)
  for (const status of ['INITIALIZING', 'INITIATED', 'REVOKED']) assert.equal(toConnectedAccountView({ ...account, status }), null)
  assert.equal(toConnectedAccountView({ ...account, status: 'EXPIRED' })?.status, 'EXPIRED')
})

test('the on/off switch follows Composio isDisabled, not the status', () => {
  assert.equal(toConnectedAccountView({ ...account, isDisabled: true })?.enabled, false)
  assert.equal(toConnectedAccountView({ ...account, status: 'INACTIVE' })?.enabled, true)
  assert.equal(toConnectedAccountView({ ...account, alias: '   ' })?.alias, null)
})

test('only Composio hosted connect pages over HTTPS are followed', () => {
  assert.equal(composioConnectRedirect('https://connect.composio.dev/link/lk_1')?.href, 'https://connect.composio.dev/link/lk_1')
  assert.equal(composioConnectRedirect('http://connect.composio.dev/link/lk_1'), null)
  assert.equal(composioConnectRedirect('https://connect.composio.dev.evil.test/'), null)
  assert.equal(composioConnectRedirect('javascript:alert(1)'), null)
  assert.equal(composioConnectRedirect('not a url'), null)
  assert.equal(composioConnectRedirect(undefined), null)
})

test('an update either switches an account or renames it, never both', () => {
  assert.equal(accountUpdateSchema.safeParse({ accountId: 'ca_1', enabled: false }).success, true)
  assert.deepEqual(accountUpdateSchema.parse({ accountId: 'ca_1', alias: ' Work ' }), { accountId: 'ca_1', alias: 'Work' })
  assert.equal(accountUpdateSchema.safeParse({ accountId: 'ca_1', alias: '   ' }).success, false)
  assert.equal(accountUpdateSchema.safeParse({ accountId: 'ca_1', alias: 'x'.repeat(61) }).success, false)
  assert.equal(accountUpdateSchema.safeParse({ accountId: 'ca_1', enabled: true, alias: 'Work' }).success, false)
  assert.equal(accountUpdateSchema.safeParse({ accountId: 'ca_1' }).success, false)
})

test('disconnect revokes, and deletes only when the account cannot be revoked', async () => {
  const calls: string[] = []
  const api = (revoke: () => Promise<unknown>) => ({ revoke: async (id: string) => { calls.push(`revoke ${id}`); return revoke() }, delete: async (id: string) => { calls.push(`delete ${id}`) } })
  class CannotRevoke extends Error {}

  await disconnectComposioAccount(api(async () => ({})), 'ca_1', error => error instanceof CannotRevoke)
  assert.deepEqual(calls.splice(0), ['revoke ca_1'])

  await disconnectComposioAccount(api(async () => { throw new CannotRevoke() }), 'ca_2', error => error instanceof CannotRevoke)
  assert.deepEqual(calls.splice(0), ['revoke ca_2', 'delete ca_2'])

  await assert.rejects(disconnectComposioAccount(api(async () => { throw new Error('network') }), 'ca_3', error => error instanceof CannotRevoke), /network/)
  assert.deepEqual(calls.splice(0), ['revoke ca_3'])
})
