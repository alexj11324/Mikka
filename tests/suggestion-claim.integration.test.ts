import assert from 'node:assert/strict'
import { before, after as afterTests, mock, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { suggestions, coordinatorEvents } from '../lib/db/schema'

const url = new URL(process.env.MIKKA_DATABASE_URL ?? '')
if (process.env.SUGGESTION_TEST_DISPOSABLE !== '1' || url.hostname !== '127.0.0.1' || url.pathname !== '/pr371_test') throw new Error('requires disposable pr371_test on loopback')
let owner = 'owner'
const callbacks: Array<() => unknown> = []
let action: typeof import('../app/actions/coordinator').sendSuggestion
let db: typeof import('../lib/db').db
let pool: typeof import('../lib/db').pool
let claim: typeof import('../lib/suggestions/store').claimSuggestion
const id = 'b4000000-0000-4000-8000-000000000010'
const other = 'b4000000-0000-4000-8000-000000000011'
const concurrent = 'b4000000-0000-4000-8000-000000000012'
const retry = 'b4000000-0000-4000-8000-000000000013'
let release!: () => void
let signal!: () => void
before(async () => {
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => ({ user: { id: owner } }) } } } })
  mock.module('@/lib/coordinator/wake', { namedExports: { coordinatorEnabled: () => true, wakeCoordinator: () => { throw Error('must not invoke provider') } } })
  mock.module('next/server', { namedExports: { after: (fn: () => unknown) => callbacks.push(fn) } })
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  ;({ db, pool } = await import('../lib/db'))
  ;({ claimSuggestion: claim } = await import('../lib/suggestions/store'))
  ;({ sendSuggestion: action } = await import('../app/actions/coordinator'))
  await pool.query(`CREATE TABLE suggestions (id uuid primary key, "userId" text not null, source text not null, "externalId" text not null, action text not null, title text not null, url text, actor text, shown boolean not null, "decidedBy" text not null, probability real, level text, "matterKey" text, "actionTitle" text, required boolean not null default false, "occurredAt" timestamptz not null, "dismissedAt" timestamptz, "createdAt" timestamptz not null default now()); CREATE TABLE coordinator_events (id uuid primary key, "userId" text not null, "botId" uuid, kind text not null, "dedupeKey" text not null unique, "issueId" uuid, "runId" uuid, payload jsonb not null CHECK (position('fail-fixture' in payload::text) = 0), tier text, "deliveredAt" timestamptz, "createdAt" timestamptz not null default now())`)
})
afterTests(async () => { await pool?.end() })
async function seed(key: string, title = 'synthetic') { await db.insert(suggestions).values({ id: key, userId: 'owner', source: 'gmail', externalId: key, action: 'reply', title, shown: true, decidedBy: 'rule', occurredAt: new Date() }) }
function gate() { const ready = new Promise<void>(r => { signal = r }); const proceed = new Promise<void>(r => { release = r }); return { ready, proceed } }

test('a concurrent dismiss wins before send: no event or wake', async () => {
  await seed(id)
  const g = gate()
  const first = db.transaction(async tx => { assert.ok(await claim('owner', id, tx)); signal(); await g.proceed })
  await g.ready
  let settled = false
  const second = action(id).then(result => { settled = true; return result })
  const deadline = Date.now() + 5000
  let blocked = false
  while (Date.now() < deadline) {
    const { rows } = await pool.query(`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update %suggestions%'`)
    if (rows.length) { blocked = true; break }
    await new Promise(r => setTimeout(r, 10))
  }
  // Always release our own gate, including assertion failures; preserve rows and schema.
  try {
    assert.equal(blocked, true, 'second transaction reached the row lock')
    assert.equal(settled, false)
  } finally { release() }
  await first
  assert.deepEqual(await second, { error: 'suggestionNotFound', params: undefined })
  assert.equal((await db.select().from(coordinatorEvents)).length, 0); assert.equal(callbacks.length, 0)
})

test('failed insert rolls claim back; a successful send has an idempotent receipt', async () => {
  await seed(other, 'fail-fixture')
  await assert.rejects(action(other))
  assert.equal((await db.select().from(suggestions).where(eq(suggestions.id, other)))[0].dismissedAt, null)
  assert.equal(callbacks.length, 0)
  await seed(retry)
  owner = 'foreign'; assert.deepEqual(await action(retry), { error: 'suggestionNotFound', params: undefined }); owner = 'owner'
  assert.deepEqual(await action(retry), { queued: true })
  assert.deepEqual(await action(retry), { queued: true })
  assert.equal((await db.select().from(coordinatorEvents)).length, 1)
  assert.equal(callbacks.length, 2)
})

test('two concurrent sends commit one event and both receive a receipt', async () => {
  await seed(concurrent); callbacks.length = 0
  const results = await Promise.all([action(concurrent), action(concurrent)])
  assert.deepEqual(results, [{ queued: true }, { queued: true }])
  assert.equal((await db.select().from(coordinatorEvents)).length, 2)
  assert.equal(callbacks.length, 2)
})
