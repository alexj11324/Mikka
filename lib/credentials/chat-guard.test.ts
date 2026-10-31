import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { fingerprint, type SecretFingerprint } from './fingerprint'

const oldEnabled = process.env.CREDENTIAL_VAULT_ENABLED, oldAuth = process.env.BETTER_AUTH_SECRET
const calls: { sql: string; values?: string[] }[] = []
let present = true, unavailable = false
const entries = new Map<string, SecretFingerprint[]>()
mock.module(new URL('../db/index.ts', import.meta.url).href, { exports: { pool: {
  async query(sql: string, values?: string[]) {
    calls.push({ sql, values })
    if (unavailable) throw new Error('database unavailable')
    if (sql.includes('to_regclass')) return { rows: [{ present }] }
    assert.match(sql, /JOIN credentials c ON c.id=s.credential_id WHERE c.user_id=\$1/)
    return { rows: entries.get(values![0]) ?? [] }
  },
} } })
let assertCredentialSafeChat: typeof import('./chat-guard')['assertCredentialSafeChat']
before(async () => {
  delete process.env.CREDENTIAL_VAULT_ENABLED
  process.env.BETTER_AUTH_SECRET = 'offline-chat-guard-fixture-auth-secret'
  entries.set('owner', [fingerprint('owner', 'fixture-password')])
  ;({ assertCredentialSafeChat } = await import('./chat-guard'))
})
after(() => {
  if (oldEnabled === undefined) delete process.env.CREDENTIAL_VAULT_ENABLED; else process.env.CREDENTIAL_VAULT_ENABLED = oldEnabled
  if (oldAuth === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = oldAuth
})

test('the default-on guard blocks nested saved secrets and binds the authenticated owner', async () => {
  await assert.rejects(assertCredentialSafeChat('owner', { tool: ['prefix fixture-password suffix'] }), { code: 'credential_secret_detected' })
  await assertCredentialSafeChat('peer', 'fixture-password')
  assert.deepEqual(calls.filter(call => call.values).map(call => call.values), [['owner'], ['peer']])
})

test('database failure fails closed while a pre-migration schema has no secrets', async () => {
  unavailable = true
  try { await assert.rejects(assertCredentialSafeChat('owner', 'ordinary chat'), /database unavailable/) }
  finally { unavailable = false }
  present = false
  try { await assertCredentialSafeChat('owner', 'fixture-password') }
  finally { present = true }
})

test('an explicit incident kill switch closes availability without accessing the database', async () => {
  process.env.CREDENTIAL_VAULT_ENABLED = '0'
  const before = calls.length
  try { await assertCredentialSafeChat('owner', 'ordinary chat'); assert.equal(calls.length, before) }
  finally { delete process.env.CREDENTIAL_VAULT_ENABLED }
})
