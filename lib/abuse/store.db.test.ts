import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Pool } from 'pg'
import { HostedUsageStore } from './store'
import { signupRateLimit as configuredSignupRateLimit } from './signup'
const signupRateLimit = (
  ...args: Parameters<typeof configuredSignupRateLimit>
) => configuredSignupRateLimit(args[0], args[1], args[2], args[3], args[4], {})
const url = process.env.E2E_DATABASE_URL
if (!url && process.env.REQUIRE_DB === '1')
  throw Error('E2E_DATABASE_URL required')
if (url) {
  const target = new URL(url)
  if (target.hostname !== '127.0.0.1' || !target.pathname.endsWith('_e2e'))
    throw Error('isolated loopback database required')
}
test('hosted controls on isolated PostgreSQL', { skip: !url }, async (t) => {
  const schema = `abuse_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({
    connectionString: url,
    max: 8,
    options: `-c search_path=${schema}`,
  })
  t.after(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  await pool.query(`CREATE TABLE "user" (id text primary key,email text not null);
    CREATE TABLE workspace_credit_grants (id uuid primary key,"workspaceId" uuid not null,points integer not null,bucket text not null);
    CREATE TABLE workspace_audit_events (id uuid primary key,"workspaceId" uuid,"actorType" text,"actorName" text,action text,category text,metadata jsonb);
    CREATE TABLE mikka_workspaces(id uuid primary key)`)
  const old = randomUUID()
  await pool.query('INSERT INTO mikka_workspaces VALUES ($1)', [old])
  await pool.query(
    readFileSync('drizzle/20261030230000_hosted_usage.sql', 'utf8'),
  )
  await pool.query(readFileSync('drizzle/20261031004200_card_verification_checkout.sql', 'utf8'))
  await pool.query(
    readFileSync('drizzle/20261030230001_legacy_hosted_workspaces.sql', 'utf8'),
  )
  const store = new HostedUsageStore(pool)
  const verified = async () => {
    const id = randomUUID()
    await store.verify(id, 'cus_fixture', `card_${id}`)
    return id
  }
  await t.test(
    'legacy snapshot contains existing workspaces only',
    async () => {
      const fresh = randomUUID()
      await pool.query('INSERT INTO mikka_workspaces VALUES ($1)', [fresh])
      assert.deepEqual(
        (await pool.query('SELECT * FROM hosted_legacy_workspaces')).rows,
        [{ workspaceId: old }],
      )
    },
  )
  await t.test(
    'unverified refused; same card concurrent claims one allowance, retained after workspace deletion',
    async () => {
      await assert.rejects(
        store.reserve(randomUUID(), 'fixture', randomUUID()),
        /verification_required/,
      )
      const a = randomUUID(),
        b = randomUUID(),
        card = randomUUID()
      const result = await Promise.all([
        store.verify(a, 'cus_a', card),
        store.verify(b, 'cus_b', card),
      ])
      assert.equal(result.filter(Boolean).length, 1)
      assert.equal(
        (await store.balance(a)).free + (await store.balance(b)).free,
        1e6,
      )
      const winner = result[0] ? a : b
      await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [winner])
      assert.equal(await store.verify(randomUUID(), 'cus_c', card), false)
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) AS n FROM workspace_audit_events WHERE action='billing.card_verified'",
            )
          ).rows[0].n,
        ),
        3,
      )
    },
  )
  await t.test(
    'free then purchased; plan ignored; replay and parallel settlement idempotent; zero refused',
    async () => {
      const id = await verified()
      await pool.query(
        "INSERT INTO workspace_credit_grants VALUES ($1,$2,100,'purchased'),($3,$2,99999,'plan')",
        [randomUUID(), id, randomUUID()],
      )
      const call = randomUUID()
      await store.reserve(id, 'fixture', call)
      await Promise.all([
        store.settle(call, 1_200_000, 20, 4),
        store.settle(call, 1_200_000, 20, 4),
      ])
      assert.deepEqual(await store.balance(id), {
        verified: true,
        free: 0,
        purchased: 800_000,
      })
      const call2 = randomUUID()
      await store.reserve(id, 'fixture', call2)
      await store.settle(call2, 800_000)
      assert.equal((await store.balance(id)).purchased, 0)
      await assert.rejects(
        store.reserve(id, 'fixture', randomUUID()),
        /free_allowance_used/,
      )
      await store.settle(call2, 800_000)
      assert.equal((await store.recent(id)).length, 2)
    },
  )
  await t.test(
    'only one in-flight provider call per workspace; unknown cost holds reservation',
    async () => {
      const id = await verified()
      const calls = [randomUUID(), randomUUID()]
      const results = await Promise.allSettled(
        calls.map((call) => store.reserve(id, 'fixture', call)),
      )
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
      const call = calls[results.findIndex((r) => r.status === 'fulfilled')]
      await store.settle(call, null)
      await assert.rejects(
        store.reserve(id, 'fixture', randomUUID()),
        /usage_in_progress/,
      )
      await store.settle(call, 100)
      assert.equal((await store.balance(id)).free, 999_900)
    },
  )
  await t.test(
    'rolling cap serializes concurrent workspaces; purchased calls bypass pause; clears after window',
    async () => {
      await pool.query(
        'UPDATE hosted_usage SET "createdAt"=now()-interval \'25 hours\'',
      )
      const a = await verified(),
        b = await verified()
      const cap = { MIKKA_FREE_MODEL_DAILY_CENTS: '10' }
      const call = randomUUID()
      await store.reserve(a, 'fixture', call, cap)
      await assert.rejects(
        store.reserve(b, 'fixture', randomUUID(), cap),
        /platform_paused/,
      )
      await store.settle(call, 100_000)
      await pool.query(
        "INSERT INTO workspace_credit_grants VALUES ($1,$2,100,'purchased')",
        [randomUUID(), b],
      )
      const paid = randomUUID()
      await store.reserve(b, 'fixture', paid, cap)
      await store.settle(paid, 10_000)
      assert.equal(
        (await store.balance(b)).free,
        1e6,
        'paused call uses purchased balance only',
      )
      await pool.query(
        'UPDATE hosted_usage SET "createdAt"=now()-interval \'25 hours\'',
      )
      await store.reserve(a, 'fixture', randomUUID(), cap)
    },
  )
  await t.test(
    'concurrent workspace admissions cannot both take the final free-budget slot',
    async () => {
      await pool.query(
        `UPDATE hosted_usage SET "createdAt"=now()-interval '25 hours'`,
      )
      const a = await verified(),
        b = await verified()
      const results = await Promise.allSettled(
        [a, b].map((ws) =>
          store.reserve(ws, 'fixture', randomUUID(), {
            MIKKA_FREE_MODEL_DAILY_CENTS: '10',
          }),
        ),
      )
      assert.equal(
        results.filter((row) => row.status === 'fulfilled').length,
        1,
      )
      assert.equal(
        results.filter(
          (row) =>
            row.status === 'rejected' &&
            row.reason.message === 'platform_paused',
        ).length,
        1,
      )
    },
  )
  await t.test(
    'atomic normalized uniqueness and per-IP/global mail quotas',
    async () => {
      const results = await Promise.allSettled([
        pool.query('INSERT INTO "user" VALUES ($1,$2)', [
          randomUUID(),
          'test.abuse+one@gmail.com',
        ]),
        pool.query('INSERT INTO "user" VALUES ($1,$2)', [
          randomUUID(),
          't.e.s.t.abuse+two@googlemail.com',
        ]),
      ])
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
      for (let n = 0; n < 5; n++)
        await signupRateLimit(pool, 'signup', 'ip-a', `x${n}@example.com`)
      await assert.rejects(
        signupRateLimit(pool, 'signup', 'ip-a', 'fresh@example.com'),
        /SIGNUP_RATE_LIMITED/,
      )
      await signupRateLimit(pool, 'signup', 'ip-b', 'fresh@example.com')
      await pool.query(
        'UPDATE "rateLimit" SET count=300 WHERE key LIKE \'abuse:verification:global:%\'',
      )
      await signupRateLimit(pool, 'verification', 'ip-a', 'a@example.com')
      await pool.query(
        'UPDATE "rateLimit" SET count=300 WHERE key LIKE \'abuse:verification:global:%\'',
      )
      await assert.rejects(
        signupRateLimit(pool, 'verification', 'ip-b', 'b@example.com'),
        /SIGNUP_RATE_LIMITED/,
      )
    },
  )
})
