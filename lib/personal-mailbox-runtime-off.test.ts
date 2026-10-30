import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mock, test } from 'node:test'
import type PgModule from 'pg'

// Not a DB suite: it asserts zero Postgres touches. The pg driver is loaded only to spy on
// its prototypes (same CommonJS instance the app imports), so the DB runner's import marker
// does not classify this pure gate as database-backed.
const pg = createRequire(import.meta.url)('pg') as typeof PgModule

// #438 (2): with the personal mailbox flag off the worker entry answers 503 before any
// database work, including the run lookup and the secret-set read behind masking.
// Spies on every pg Pool/Client entry point, and points the pools at an unreachable database.
process.env.DATABASE_URL = 'postgresql://mailbox-off@127.0.0.1:1/mailbox_off_never_e2e'
process.env.MIKKA_DATABASE_URL = process.env.DATABASE_URL
// The BYO secrets flag is on, so masking would read the run's workspace secret set if it ran.
process.env.MIKKA_BYO_E2B_KEY = '1'
const touched: string[] = []
for (const [name, proto] of [['Pool', pg.Pool.prototype], ['Client', pg.Client.prototype]] as const)
  for (const method of ['connect', 'query'] as const)
    mock.method(proto, method, function () { touched.push(`${name}.${method}`); return Promise.reject(new Error('database touched while the mailbox is off')) })

test('personal worker mailbox with the flag off returns 503 and never touches the database or the secret set', async () => {
  const saved = process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
  delete process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
  try {
    const { personalWorkerMailbox } = await import('./personal-mailbox-runtime')
    const result = await personalWorkerMailbox('owner', '00000000-0000-4000-8000-000000000001', { action: 'send', to: 'peer', key: 'k', text: 'sk-synthetic-only' }, 'synthetic-token')
    assert.deepEqual(result, { status: 503, body: { error: 'personal_mailbox_unavailable' } })
    assert.deepEqual(touched, [])
  } finally { if (saved === undefined) delete process.env.MIKKA_PERSONAL_MAILBOX_ENABLED; else process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = saved }
})
