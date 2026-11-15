import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('the hosted billing key reaches the workspace and the card owner, after the real Stripe writers commit', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<void>) => { pending.push(work) } } })
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-billing-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = wireKeys(JSON.parse(String(options?.body)), 'a key carries a kind and an id only')
    const billing = events.filter(event => event.kind === 'hosted_billing')
    if (billing.length) sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events: billing })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `billing_live_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, name, 'template0')
  const target = new URL(url!); target.pathname = `/${name}`
  const database = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(database)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { createRequestDatabaseScope } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  const home = randomUUID(), team = randomUUID(), peerHome = randomUUID()
  const label = (id: string) => id === home ? 'home' : id === team ? 'team' : id === peerHome ? 'peerHome' : id
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())) }
  const deliveries = async () => { await drain(); return sent.splice(0).map(value => `${value.scope.ownerId}@${label(value.scope.workspaceId)}:${value.events.map(event => `${event.kind}:${label(event.id)}`).join(',')}`).sort() }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@billing.example.invalid',true,now(),now())`, [userId])
      for (const workspaceId of [home, team, peerHome]) { const value = { ownerId: userId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value) }
    }
    for (const [id, owner, kind] of [[home, 'owner', 'personal'], [team, 'owner', 'team'], [peerHome, 'peer', 'personal']]) {
      await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,$2,'Fixture',$3)`, [id, owner, kind])
    }
    for (const [workspace, userId] of [[home, 'owner'], [team, 'owner'], [team, 'peer'], [peerHome, 'peer']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [workspace, userId])
    }
    const { HostedUsageStore } = await import('../abuse/store')
    const store = new HostedUsageStore(database)

    await t.test('a verified card reaches its owner in every workspace they are in, never the teammate; a repeat sends nothing', async () => {
      assert.equal(await scope.run(() => store.verify(home, 'cus_fixture', 'fp_owner', '4242')), true)
      assert.deepEqual(await deliveries(), ['owner@home:hosted_billing:home', 'owner@team:hosted_billing:team'])
      assert.equal(await scope.run(() => store.verify(home, 'cus_fixture', 'fp_owner', '4242')), false)
      assert.deepEqual(await deliveries(), [], 'nothing changed: no key')
    })

    await t.test('a verification whose COMMIT fails sends nothing', async () => {
      await database.query(`CREATE FUNCTION reject_verification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'verification rejected'; END $$`)
      await database.query(`CREATE CONSTRAINT TRIGGER reject_verification AFTER INSERT ON hosted_verifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_verification()`)
      try {
        await assert.rejects(scope.run(() => store.verify(peerHome, 'cus_peer', 'fp_peer', '1111')), /verification rejected/)
        assert.deepEqual(await deliveries(), [], 'a failed COMMIT discards the registered key')
      } finally {
        await database.query('DROP TRIGGER reject_verification ON hosted_verifications')
        await database.query('DROP FUNCTION reject_verification()')
      }
    })

    const { applyStripeEvent } = await import('../billing/service')
    const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`
    const purchase = { id: id('cs'), mode: 'payment', payment_status: 'paid', payment_intent: id('pi'), amount_total: 1000, currency: 'usd', metadata: { workspaceId: team, points: '1000', purpose: 'points_purchase' } }
    const stripe = (async () => Response.json({ latest_charge: { receipt_url: null, balance_transaction: { fee: 59, currency: 'usd' } } })) as typeof fetch
    const options = { env: { MIKKA_EDITION: 'cloud', STRIPE_SECRET_KEY: 'sk_test_fixture' }, fetchImpl: stripe }

    await t.test('purchased points reach every active member of the team, and a refund does too', async () => {
      assert.equal(await scope.run(() => applyStripeEvent({ id: id('evt'), type: 'checkout.session.completed', data: { object: purchase } }, options)), true)
      assert.deepEqual(await deliveries(), ['owner@team:hosted_billing:team', 'peer@team:hosted_billing:team'])
      assert.equal(await scope.run(() => applyStripeEvent({ id: id('evt'), type: 'checkout.session.completed', data: { object: purchase } }, options)), true)
      assert.deepEqual(await deliveries(), [], 'a purchase already credited sends nothing')
      const refunded = { id: id('ch'), payment_intent: purchase.payment_intent, currency: 'usd', metadata: purchase.metadata, refunds: { data: [{ id: id('re'), amount: 250, currency: 'usd', status: 'succeeded' }], has_more: false } }
      await scope.run(() => applyStripeEvent({ id: id('evt'), type: 'charge.refunded', data: { object: refunded } }, options))
      assert.deepEqual(await deliveries(), ['owner@team:hosted_billing:team', 'peer@team:hosted_billing:team'])
    })

    await t.test('a purchase whose COMMIT fails sends nothing, and a suspended member is not told', async () => {
      await database.query(`CREATE FUNCTION reject_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'grant rejected'; END $$`)
      await database.query(`CREATE CONSTRAINT TRIGGER reject_grant AFTER INSERT ON workspace_credit_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_grant()`)
      const failed = { ...purchase, id: id('cs'), payment_intent: id('pi') }
      try {
        await assert.rejects(scope.run(() => applyStripeEvent({ id: id('evt'), type: 'checkout.session.completed', data: { object: failed } }, options)), (error: unknown) => String((error as { cause?: unknown }).cause ?? error).includes('grant rejected'))
        assert.deepEqual(await deliveries(), [], 'a failed COMMIT discards the registered key')
      } finally {
        await database.query('DROP TRIGGER reject_grant ON workspace_credit_grants')
        await database.query('DROP FUNCTION reject_grant()')
      }
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='peer'`, [team])
      await scope.run(() => applyStripeEvent({ id: id('evt'), type: 'checkout.session.completed', data: { object: { ...purchase, id: id('cs'), payment_intent: id('pi') } } }, options))
      assert.deepEqual(await deliveries(), ['owner@team:hosted_billing:team'])
      assert.deepEqual(unexpected, [])
    })
  } finally {
    await drain().catch(() => {})
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    globalDb.workspacePool = previousWorkspace
    await scope.close(); await database.end()
    await dropTestDatabase(admin, name); await admin.end()
    mock.restoreAll()
  }
})
