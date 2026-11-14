import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { seedCoordinator } from '../../tests/support/coordinator-bot'
import { seedUser } from '../../tests/support/workspace-admin-db'
import type { WriteProvider } from '../operations/write-contract'

const target = process.env.E2E_DATABASE_URL
const ready = Boolean(target && disposableDatabase(process.env, target) && process.env.DATABASE_URL === target && process.env.MIKKA_DATABASE_URL === target)
if (process.env.REQUIRE_DB === '1') assert.ok(ready, 'matching isolated loopback *_e2e databases are required')

test('welcome and approved-write decisions wake through their stored event', { skip: !ready, timeout: 60_000 }, async t => {
  const jobs: Promise<unknown>[] = []
  const next = await import('next/server')
  t.mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<unknown>) => { jobs.push(work()) } } })
  const { pool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const { coordinatorWakeTransport } = await import('./wake-after-commit')
  const { overrideDeploymentSwitch } = await import('../deployment-switches')
  const owner = await seedUser(pool, 'owner-event-wake'), sessionId = randomUUID()
  const { botId, workspaceId } = await seedCoordinator(owner)
  await pool.query('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, owner, randomUUID()])
  const committed: string[] = [], direct: string[] = []
  let observed: (() => void) | undefined
  const wake = () => new Promise<void>(resolve => { observed = resolve })
  coordinatorWakeTransport.wake = async userId => {
    committed.push(userId)
    observed?.()
  }
  overrideDeploymentSwitch('personalWrites', true)
  t.after(async () => {
    delete coordinatorWakeTransport.wake
    overrideDeploymentSwitch('personalWrites', undefined)
    // The real operation ledger is immutable. Other operation DB suites also
    // retain its owner and operation in this disposable, fully migrated DB.
    t.diagnostic(JSON.stringify({ retainedOwner: owner, reason: 'immutable personal operation ledger' }))
    await Promise.all([pool.end(), workspacePool.end()])
  })
  let viewer: { user: { id: string; email: string; name: string }; session: { id: string } } | null = null
  const authenticated = { user: { id: owner, email: owner + '@example.invalid', name: 'Fixture' }, session: { id: sessionId } }
  let configured = true
  const realAuth = await import('../auth')
  t.mock.module('../auth', { namedExports: { ...realAuth, auth: { api: { getSession: async () => viewer } } } })
  t.mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: (key: string) => key === 'mikka-workspace' ? { value: workspaceId } : undefined }) } })
  t.mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
  const existingWake = await import('./wake')
  t.mock.module('./wake', { namedExports: { ...existingWake, coordinatorEnabled: async () => configured, wakeCoordinator: async (userId: string) => { direct.push(userId) } } })
  let sends = 0
  const provider: WriteProvider = {
    name: 'isolated-approval-wake',
    prepare: async () => ({ accountId: 'synthetic-account', version: 'v1', context: null }),
    execute: async request => { await request.beforeSend(); sends++; return { providerObjectId: 'test-receipt', evidenceDigest: 'a'.repeat(64) } },
    lookup: async () => { throw Error('the settled result should be read from the ledger') },
  }
  t.mock.module('../operations/write-provider', { namedExports: { composioWriteProvider: () => provider } })
  const { welcomeCoordinator } = await import('../../app/actions/coordinator')
  const { POST } = await import('../../app/api/approved-writes/route')
  const submit = async (body: object) => POST(new Request('https://fixture.invalid/api/approved-writes', {
    method: 'POST', headers: { origin: 'https://fixture.invalid', cookie: 'fixture=one' }, body: JSON.stringify({ action: 'append_notion_paragraph', ...body }),
  }))
  await t.test('a ready, authenticated empty Bot receives one welcome', async () => {
    assert.equal((await welcomeCoordinator(botId)).error, 'authRequired')
    viewer = authenticated
    configured = false
    assert.deepEqual(await welcomeCoordinator(botId), { queued: false })
    configured = true
    const delivered = wake()
    assert.deepEqual(await welcomeCoordinator(botId), { queued: true })
    await delivered
    await Promise.all(jobs.splice(0))
    const row = await pool.query('SELECT "botId",payload->>\'source\' AS source FROM coordinator_events WHERE "userId"=$1 AND kind=$2', [owner, 'user_message'])
    assert.deepEqual(row.rows, [{ botId, source: 'coordinator_welcome' }])
    assert.deepEqual(committed, [owner])
    assert.deepEqual(direct, [])
  })
  await t.test('approval and its replay send once and notify once; a new decline is independent', async () => {
    viewer = authenticated
    direct.length = 0
    committed.length = 0
    async function propose() {
      const response = await submit({ op: 'propose', input: { page_id: randomUUID(), text: 'Local offline fixture' }, intentId: randomUUID() })
      assert.equal(response.status, 200)
      const proposed = await response.json()
      assert.equal(proposed.status, 'awaiting_approval')
      return proposed.actionId as string
    }
    const accepted = await propose(), declined = await propose()
    for (const [id, approve] of [[accepted, true], [accepted, true], [declined, false]] as const) {
      const expected = id === accepted ? 'done' : 'declined'
      const delivered = (id === accepted && sends === 0) || id === declined ? wake() : null
      const response = await submit({ op: 'decide', id, approve })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).status, expected)
      if (delivered) await delivered
    }
    await Promise.all(jobs.splice(0))
    const rows = await pool.query('SELECT "dedupeKey" FROM coordinator_events WHERE "userId"=$1 AND "dedupeKey" LIKE $2 ORDER BY "dedupeKey"', [owner, 'approved_write_decided:%'])
    assert.deepEqual(rows.rows.map(row => row.dedupeKey), [`approved_write_decided:${accepted}:done`, `approved_write_decided:${declined}:declined`].sort())
    assert.equal(sends, 1)
    assert.deepEqual(committed, [owner, owner])
    assert.deepEqual(direct, [])
  })
})
