import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// Settings › 账户 actions: each one reads the person from the session (never
// from its input), validates on the server and returns a coded failure.
type Session = { user: { id: string; email: string; name: string }; session: { id: string } }
let current: Session | null = null
let accounts: { providerId: string }[] = []
let authFailure: { body: { code: string } } | null = null
let mailConfigured = true
let mailOutcome: 'sent' | 'unavailable' | 'failed' = 'sent'
let reservation: { ok: true; id: string; token: string; expiresAt: Date } | { ok: false; retryAfterMinutes: number } = { ok: true, id: 'r1', token: 'mkx_token', expiresAt: new Date('2026-10-30T00:00:00Z') }
let deletion: { ok: true } | { ok: false; soleAdminOf: string[] } | { ok: false; pending: true; id: string; stage: string } = { ok: true }
let tokens: Record<string, string> = {}

const calls = {
  updateUser: mock.fn(async (_input: unknown) => ({})),
  changePassword: mock.fn(async (_input: unknown) => { if (authFailure) throw authFailure; return {} }),
  setPassword: mock.fn(async (_input: unknown) => { if (authFailure) throw authFailure; return {} }),
  revokeSession: mock.fn(async (_input: unknown) => ({ status: true })),
  revokeOtherSessions: mock.fn(async (_input: unknown) => ({ status: true })),
  signOut: mock.fn(async (_input: unknown) => ({ success: true })),
  saveAvatar: mock.fn(async (userId: string, _type: string, _bytes: Uint8Array) => `/api/avatars/${userId}/${'b'.repeat(64)}`),
  listDevices: mock.fn(async (userId: string, sessionId: string) => [
    { id: sessionId, label: 'Chrome · macOS', current: true, userId },
    { id: 'other', label: 'Mikka · iPhone', current: false, userId },
  ]),
  sendMail: mock.fn(async (_message: { to: string; subject: string; text: string }) => mailOutcome),
  releaseExport: mock.fn(async (_userId: string, _id: string) => {}),
  reserveExport: mock.fn(async (_userId: string) => reservation),
  listShared: mock.fn(async (userId: string) => [{ artifactId: 'a1', title: 'Plan', kind: 'markdown', links: 2, sharedAt: '2026-10-29T00:00:00.000Z', userId }]),
  deleteAccount: mock.fn(async (_userId: string, _email: string) => deletion),
}

const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
mock.module('next/headers', { namedExports: { headers: async () => new Headers({ cookie: 'session=x' }) } })
mock.module('next-intl/server', { namedExports: { getTranslations: async () => (key: string, values?: Record<string, unknown>) => `${key}:${JSON.stringify(values ?? {})}` } })
stub('../lib/auth.ts', { auth: { api: {
  getSession: async () => current,
  updateUser: calls.updateUser,
  listUserAccounts: async () => accounts,
  changePassword: calls.changePassword,
  setPassword: calls.setPassword,
  revokeSession: calls.revokeSession,
  revokeOtherSessions: calls.revokeOtherSessions,
  signOut: calls.signOut,
} } })
stub('../lib/mcp/resource.ts', { appOrigin: 'https://app.example.com' })
stub('../lib/account/avatar.ts', { saveAvatar: calls.saveAvatar })
stub('../lib/account/sessions.ts', { listSignedInDevices: calls.listDevices, sessionTokenFor: async (userId: string, id: string) => tokens[`${userId}:${id}`] ?? null })
stub('../lib/account/export.ts', { EXPORT_LINK_TTL_MS: 86_400_000, reserveExport: calls.reserveExport, releaseExport: calls.releaseExport })
stub('../lib/account/mail.ts', { accountMailConfigured: () => mailConfigured, sendAccountMail: calls.sendMail })
stub('../lib/account/shared-links.ts', { listSharedArtifacts: calls.listShared })
stub('../lib/account/delete.ts', { deleteAccount: calls.deleteAccount })

let account: typeof import('../app/actions/account')
before(async () => { account = await import('../app/actions/account') })

const ALICE: Session = { user: { id: 'alice', email: 'Alice@Example.com', name: 'Alice' }, session: { id: 'session-alice' } }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

beforeEach(() => {
  current = ALICE; accounts = []; authFailure = null; mailConfigured = true; mailOutcome = 'sent'; deletion = { ok: true }; tokens = {}
  reservation = { ok: true, id: 'r1', token: 'mkx_token', expiresAt: new Date('2026-10-30T00:00:00Z') }
  for (const fn of Object.values(calls)) fn.mock.resetCalls()
})

test('every account action needs a signed-in session and touches nothing without one', async () => {
  current = null
  const form = new FormData(); form.set('avatar', new Blob([PNG], { type: 'image/png' }))
  const results = await Promise.all([
    account.uploadAvatar(form), account.getPasswordStatus(),
    account.changePassword({ currentPassword: 'old-password', newPassword: 'new-password' }),
    account.setPassword({ newPassword: 'new-password' }), account.listSessions(), account.revokeSession('other'),
    account.revokeOtherSessions(), account.requestDataExport(), account.listSharedLinks(),
    account.deleteAccount({ email: 'alice@example.com' }), account.updateDisplayName('Alice'),
  ])
  for (const result of results) assert.equal(result.error, 'authRequired')
  for (const [name, fn] of Object.entries(calls)) assert.equal(fn.mock.callCount(), 0, name)
})

test('a new avatar must be a small PNG, JPEG or WebP; it is stored for the session\'s user and set as user.image', async () => {
  const form = (blob: Blob | string) => { const data = new FormData(); data.set('avatar', blob); return data }
  assert.deepEqual(await account.uploadAvatar(form('not a file')), { error: 'avatarInvalidType', params: undefined })
  assert.equal((await account.uploadAvatar(form(new Blob(['<svg/>'], { type: 'image/svg+xml' })))).error, 'avatarInvalidType')
  assert.equal((await account.uploadAvatar(form(new Blob([PNG], { type: 'image/jpeg' })))).error, 'avatarInvalidType')
  const big = new Uint8Array(200 * 1024 + 1); big.set(PNG)
  assert.equal((await account.uploadAvatar(form(new Blob([big], { type: 'image/png' })))).error, 'avatarTooLarge')
  assert.equal(calls.saveAvatar.mock.callCount(), 0)

  const saved = await account.uploadAvatar(form(new Blob([PNG], { type: 'image/png' })))
  assert.deepEqual(saved, { image: `/api/avatars/alice/${'b'.repeat(64)}` })
  assert.equal(calls.saveAvatar.mock.calls[0].arguments[0], 'alice')
  assert.equal(calls.saveAvatar.mock.calls[0].arguments[1], 'image/png')
  assert.deepEqual(calls.updateUser.mock.calls[0].arguments[0], { body: { image: `/api/avatars/alice/${'b'.repeat(64)}` }, headers: new Headers({ cookie: 'session=x' }) })
})

test('password: change needs the current one, accounts without one set one, and failures come back coded', async () => {
  assert.deepEqual(await account.getPasswordStatus(), { hasPassword: false })
  accounts = [{ providerId: 'google' }, { providerId: 'credential' }]
  assert.deepEqual(await account.getPasswordStatus(), { hasPassword: true })

  assert.equal((await account.changePassword({ currentPassword: 'old-password', newPassword: 'short' })).error, 'passwordTooShort')
  assert.equal((await account.changePassword({ currentPassword: 'old-password', newPassword: 'x'.repeat(129) })).error, 'passwordTooLong')
  assert.equal((await account.changePassword({ currentPassword: '', newPassword: 'new-password' })).error, 'passwordIncorrect')
  assert.equal(calls.changePassword.mock.callCount(), 0)

  assert.deepEqual(await account.changePassword({ currentPassword: 'old-password', newPassword: 'new-password', revokeOtherSessions: true }), { revokedOtherSessions: true })
  assert.deepEqual((calls.changePassword.mock.calls[0].arguments[0] as { body: unknown }).body, { currentPassword: 'old-password', newPassword: 'new-password', revokeOtherSessions: true })
  assert.deepEqual(await account.changePassword({ currentPassword: 'old-password', newPassword: 'new-password' }), { revokedOtherSessions: false })

  authFailure = { body: { code: 'INVALID_PASSWORD' } }
  assert.equal((await account.changePassword({ currentPassword: 'wrong-password', newPassword: 'new-password' })).error, 'passwordIncorrect')
  authFailure = { body: { code: 'CREDENTIAL_ACCOUNT_NOT_FOUND' } }
  assert.equal((await account.changePassword({ currentPassword: 'old-password', newPassword: 'new-password' })).error, 'passwordNotSet')
  authFailure = { body: { code: 'PASSWORD_ALREADY_SET' } }
  assert.equal((await account.setPassword({ newPassword: 'new-password' })).error, 'passwordAlreadySet')
  authFailure = { body: { code: 'SOMETHING_ELSE' } }
  await assert.rejects(account.setPassword({ newPassword: 'new-password' }))
  authFailure = null
  assert.deepEqual(await account.setPassword({ newPassword: 'new-password' }), { hasPassword: true })
  assert.equal((await account.setPassword({ newPassword: '1234567' })).error, 'passwordTooShort')
})

test('devices: listed for the session\'s user; another device signs out by id, this one never does', async () => {
  const listed = await account.listSessions()
  assert.ok(!listed.error)
  assert.equal(listed.sessions.length, 2)
  assert.deepEqual(calls.listDevices.mock.calls[0].arguments, ['alice', 'session-alice'])

  assert.equal((await account.revokeSession('session-alice')).error, 'sessionIsCurrent')
  // Bob's session id is not Alice's to end: it looks like no session at all.
  tokens = { 'bob:bob-session': 'bob-token', 'alice:other': 'alice-other-token' }
  assert.equal((await account.revokeSession('bob-session')).error, 'sessionNotFound')
  assert.equal((await account.revokeSession('')).error, 'sessionNotFound')
  assert.equal(calls.revokeSession.mock.callCount(), 0)
  assert.deepEqual(await account.revokeSession('other'), { revoked: true })
  assert.deepEqual((calls.revokeSession.mock.calls[0].arguments[0] as { body: unknown }).body, { token: 'alice-other-token' })

  assert.deepEqual(await account.revokeOtherSessions(), { revoked: 1 })
  assert.equal(calls.revokeOtherSessions.mock.callCount(), 1)
})

test('data export: emailed to the account\'s address, offered as a download when mail is off, once an hour', async () => {
  const sent = await account.requestDataExport()
  assert.deepEqual(sent, { email: 'Alice@Example.com', expiresAt: '2026-10-30T00:00:00.000Z' })
  assert.equal(calls.reserveExport.mock.calls[0].arguments[0], 'alice')
  const message = calls.sendMail.mock.calls[0].arguments[0]
  assert.equal(message.to, 'Alice@Example.com')
  assert.match(message.text, /https:\/\/app\.example\.com\/api\/account\/export\/mkx_token/)

  mailConfigured = false
  const sendsBefore = calls.sendMail.mock.callCount()
  assert.deepEqual(await account.requestDataExport(), { email: 'Alice@Example.com', expiresAt: '2026-10-30T00:00:00.000Z', downloadPath: '/api/account/export/mkx_token' })
  assert.equal(calls.sendMail.mock.callCount(), sendsBefore)
  mailConfigured = true

  mailOutcome = 'failed'
  assert.equal((await account.requestDataExport()).error, 'emailDeliveryFailed')
  assert.deepEqual(calls.releaseExport.mock.calls.at(-1)?.arguments, ['alice', 'r1'])
  mailOutcome = 'unavailable'
  assert.equal((await account.requestDataExport() as { downloadPath?: string }).downloadPath, '/api/account/export/mkx_token')

  reservation = { ok: false, retryAfterMinutes: 42 }
  assert.deepEqual(await account.requestDataExport(), { error: 'dataExportRateLimited', params: { minutes: 42 } })
})

test('shared links are the session user\'s own', async () => {
  const listed = await account.listSharedLinks()
  assert.ok(!listed.error)
  assert.equal(listed.links.length, 1)
  assert.deepEqual(calls.listShared.mock.calls[0].arguments, ['alice'])
})

test('deleting the account needs the account\'s own email typed again, and a sole admin is refused', async () => {
  assert.equal((await account.deleteAccount({ email: 'bob@example.com' })).error, 'accountEmailMismatch')
  assert.equal((await account.deleteAccount({ email: '' })).error, 'accountEmailMismatch')
  assert.equal((await account.deleteAccount({} as { email: string })).error, 'accountEmailMismatch')
  assert.equal(calls.deleteAccount.mock.callCount(), 0)

  deletion = { ok: false, soleAdminOf: ['Acme', 'Beta'] }
  assert.deepEqual(await account.deleteAccount({ email: 'alice@example.com' }), { error: 'accountSoleAdmin', params: { workspaces: 'Acme, Beta', count: 2 } })
  assert.equal(calls.signOut.mock.callCount(), 0)

  deletion = { ok: false, pending: true, id: 'job', stage: 'storage_pending' }
  assert.equal((await account.deleteAccount({ email: 'alice@example.com' })).error, 'accountDeletionPending')
  assert.equal(calls.signOut.mock.callCount(), 0)

  deletion = { ok: true }
  assert.deepEqual(await account.deleteAccount({ email: '  ALICE@example.com ' }), { deleted: true })
  assert.deepEqual(calls.deleteAccount.mock.calls.at(-1)?.arguments, ['alice', 'Alice@Example.com'])
  assert.equal(calls.signOut.mock.callCount(), 1)
})
