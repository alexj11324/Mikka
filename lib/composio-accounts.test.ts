import assert from 'node:assert/strict'
import test from 'node:test'
import { accountUpdateSchema, composioConnectRedirect, disconnectComposioAccount, isDuplicateAliasError, pickDefaultAccountId, PROVIDER_IDENTITY, safeReturnPath, sanitizeEmail, slackUserEmail, slackUserId, toConnectedAccountView, withAccountRecords } from './composio-accounts'
import { decodeComposioFlow, encodeComposioFlow } from './composio-flow'

const account = { id: 'ca_1', status: 'ACTIVE', isDisabled: false, alias: null as string | null, createdAt: '2026-10-28T10:00:00.000Z', toolkit: { slug: 'gmail' } }

test('shows only real accounts on our apps, without credentials', () => {
  const withSecrets = { ...account, alias: '  Work  ', state: { val: { access_token: 'secret' } } }
  assert.deepEqual(toConnectedAccountView(withSecrets), {
    id: 'ca_1', toolkit: 'gmail', status: 'ACTIVE', enabled: true, alias: 'Work', createdAt: '2026-10-28T10:00:00.000Z', email: null, isDefault: false,
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
  assert.equal(accountUpdateSchema.safeParse({ accountId: 'ca_1', default: true }).success, true)
  assert.equal(accountUpdateSchema.safeParse({ accountId: 'ca_1', default: false }).success, false)
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

test('the default account is the chosen usable one, else the oldest usable one', () => {
  const a = { id: 'a', status: 'ACTIVE', isDisabled: false, createdAt: '2026-09-01T00:00:00Z' }
  const b = { id: 'b', status: 'ACTIVE', isDisabled: false, createdAt: '2026-10-01T00:00:00Z' }
  assert.equal(pickDefaultAccountId([b, a], 'b'), 'b')
  assert.equal(pickDefaultAccountId([b, a], null), 'a')
  assert.equal(pickDefaultAccountId([b, a], 'gone'), 'a')
  assert.equal(pickDefaultAccountId([{ ...b, isDisabled: true }, a], 'b'), 'a')
  assert.equal(pickDefaultAccountId([b, { ...a, status: 'EXPIRED' }], null), 'b')
  assert.equal(pickDefaultAccountId([{ ...a, status: 'EXPIRED' }], null), null)
})

test('stored emails and the chosen default are joined per toolkit', () => {
  const view = (id: string, toolkit: string, createdAt: string) => toConnectedAccountView({ ...account, id, toolkit: { slug: toolkit }, createdAt })!
  const accounts = [view('g1', 'gmail', '2026-09-01T00:00:00Z'), view('g2', 'gmail', '2026-10-01T00:00:00Z'), view('n1', 'notion', '2026-10-01T00:00:00Z')]
  const joined = withAccountRecords(accounts, [{ accountId: 'g2', email: 'me@example.com', emailChecked: true, isDefault: true }, { accountId: 'other-user', email: 'x@example.com', emailChecked: true, isDefault: true }])
  assert.deepEqual(joined.map(item => [item.id, item.email, item.isDefault]), [['g1', null, false], ['g2', 'me@example.com', true], ['n1', null, true]])
  const fallback = withAccountRecords(accounts, [])
  assert.deepEqual(fallback.filter(item => item.isDefault).map(item => item.id), ['g1', 'n1'])
})

test('only a plain email address is kept', () => {
  assert.equal(sanitizeEmail(' Alex@Example.COM '), 'alex@example.com')
  assert.equal(sanitizeEmail('a.b+tag@mail.example.co'), 'a.b+tag@mail.example.co')
  for (const bad of ['', 'not-an-email', 'a@b', '<a@example.com>', 'a@example.com\nBcc: x@y.z', 'a b@example.com', `${'a'.repeat(65)}@example.com`, 42, null]) assert.equal(sanitizeEmail(bad), null)
})

test('reads each provider\'s identity from where it puts it', () => {
  assert.equal(PROVIDER_IDENTITY.gmail.email({ emailAddress: 'me@gmail.com', messagesTotal: 3 }), 'me@gmail.com')
  assert.equal(PROVIDER_IDENTITY.googlecalendar.email({ id: 'me@gmail.com', summary: 'Me' }), 'me@gmail.com')
  assert.equal(PROVIDER_IDENTITY.notion.email({ object: 'user', type: 'bot', bot: { owner: { type: 'user', user: { person: { email: 'me@notion.so' } } } } }), 'me@notion.so')
  assert.equal(PROVIDER_IDENTITY.notion.email({ bot: { owner: { type: 'workspace', workspace: true } } }), undefined)
  assert.equal(slackUserId(PROVIDER_IDENTITY.slack.email({ ok: true, user_id: 'U012ABCDEF' })), 'U012ABCDEF')
  assert.equal(slackUserId('U01&x=1'), null)
  assert.equal(slackUserEmail({ ok: true, user: { profile: { email: 'me@slack.com' } } }), 'me@slack.com')
  assert.equal(PROVIDER_IDENTITY.gmail.email(null), undefined)
})

test('return paths stay inside the app and off the API', () => {
  assert.equal(safeReturnPath('/?section=plugins&app=gmail'), '/?section=plugins&app=gmail')
  assert.equal(safeReturnPath('/en/settings?section=integrations#top'), '/en/settings?section=integrations')
  for (const bad of ['https://evil.test/', '//evil.test/x', '/\\evil.test', 'evil', '/api/integrations/composio', '/en/api/x', '/x\ny', 'x'.repeat(10), `/${'a'.repeat(512)}`, undefined, 3]) assert.equal(safeReturnPath(bad), null, String(bad))
})

test('the connect flow cookie round-trips and drops a bad return path', () => {
  const flow = { link: 'ca_new', replace: 'ca_old', returnTo: '/?section=plugins&app=gmail' }
  assert.deepEqual(decodeComposioFlow(encodeComposioFlow(flow)), flow)
  assert.deepEqual(decodeComposioFlow(encodeComposioFlow({ link: 'ca_new', returnTo: '//evil.test' })), { link: 'ca_new', returnTo: undefined })
  assert.equal(decodeComposioFlow('not-base64-json'), null)
  assert.equal(decodeComposioFlow(Buffer.from(JSON.stringify({ link: 'x', extra: 1 })).toString('base64url')), null)
  assert.equal(decodeComposioFlow(undefined), null)
})

test('recognises Composio refusing a duplicate alias', () => {
  assert.equal(isDuplicateAliasError({ status: 409, message: 'Conflict' }), true)
  assert.equal(isDuplicateAliasError(new Error('alias must be unique per user and toolkit')), true)
  assert.equal(isDuplicateAliasError({ status: 500, message: 'boom' }), false)
  assert.equal(isDuplicateAliasError(null), false)
})
