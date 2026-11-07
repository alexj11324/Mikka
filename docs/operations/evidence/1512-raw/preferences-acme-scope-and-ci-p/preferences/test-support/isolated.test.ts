import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, mock, test } from 'node:test'
import { engine, db, pool } from './lib/db'
import * as schema from './lib/db/schema'
import * as drizzle from 'drizzle-orm'
const m = { db, pool, schema, drizzle }
const dbTest = test
before(async () => {
  await engine.waitReady
  await engine.exec(`
    CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL, "emailVerified" boolean, "createdAt" timestamptz, "updatedAt" timestamptz);
    CREATE TABLE user_preferences (
      "userId" text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      "pushDecide" boolean NOT NULL DEFAULT true,
      "pushReview" boolean NOT NULL DEFAULT true,
      "pushFinished" boolean NOT NULL DEFAULT true,
      "pushBriefing" boolean NOT NULL DEFAULT true,
      "pushWhen" text NOT NULL DEFAULT 'always',
      "memoryEnabled" boolean NOT NULL DEFAULT true,
      "sendKey" text NOT NULL DEFAULT 'enter',
      "personalInstructions" text NOT NULL DEFAULT '',
      "dailySuggestions" boolean NOT NULL DEFAULT true,
      "suggestionSources" jsonb NOT NULL DEFAULT '{}',
      "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE attention_settings ("userId" text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true, locale text, "updatedAt" timestamptz NOT NULL DEFAULT now());
  `)
})
after(async () => {
  try {
    const result = await engine.query('SELECT (SELECT count(*)::int FROM "user") AS users, (SELECT count(*)::int FROM user_preferences) AS preferences, (SELECT count(*)::int FROM attention_settings) AS attention')
    assert.deepEqual(result.rows, [{ users: 0, preferences: 0, attention: 0 }], 'owned fixture rows are removed on red and green')
  } finally {
    await engine.close()
    assert.equal(engine.closed, true, 'owned PGlite engine is closed')
  }
})

dbTest('preferences read both optional owner rows in one statement without losing defaults or isolation', async t => {
  const { readPreferences, DEFAULT_PREFERENCES } = await import('@/lib/preferences')
  const { withDatabaseClient } = await import('@/lib/db')
  const { db, pool, schema } = m
  const owner = 'test-preference-read-' + randomUUID(), peer = 'test-preference-peer-' + randomUUID()
  const client = await pool.connect()
  const counts: number[] = []
  const read = async (id: string) => {
    const observed = mock.method(client, 'query')
    try {
      const value = await readPreferences(id)
      counts.push(observed.mock.callCount())
      return value
    } finally { observed.mock.restore() }
  }
  const stored = {
    pushDecide: false, pushReview: false, pushFinished: false, pushBriefing: false,
    pushWhen: schema.PUSH_WHEN.find(value => value !== 'always')!,
    memoryEnabled: false, sendKey: 'modEnter' as const, personalInstructions: 'Synthetic owner preference',
    dailySuggestions: true,
  }
  const shown = { ...stored, dailySuggestions: false, proactive: true }
  try {
    await withDatabaseClient(client, async () => {
      await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now()),($3,$3,$4,true,now(),now())',
        [owner, owner + '@example.invalid', peer, peer + '@example.invalid'])
      await db.insert(schema.userPreferences).values({ userId: peer, ...stored, personalInstructions: 'Synthetic peer preference' })
      await db.insert(schema.attentionSettings).values({ userId: peer, enabled: false })
      assert.deepEqual(await read(owner), DEFAULT_PREFERENCES, 'neither owner row must not borrow the peer rows')
      await db.insert(schema.attentionSettings).values({ userId: owner, enabled: false })
      assert.deepEqual(await read(owner), { ...DEFAULT_PREFERENCES, proactive: false }, 'attention-only preserves the disabled switch')
      await db.delete(schema.attentionSettings).where(m.drizzle.eq(schema.attentionSettings.userId, owner))
      await db.insert(schema.userPreferences).values({ userId: owner, ...stored, suggestionSources: { synthetic: false } })
      assert.deepEqual(await read(owner), shown, 'preferences-only preserves every flag and the attention default')
      await db.insert(schema.attentionSettings).values({ userId: owner, enabled: false })
      assert.deepEqual(await read(owner), { ...shown, proactive: false }, 'both rows preserve independent switches')
      await db.update(schema.attentionSettings).set({ enabled: true }).where(m.drizzle.eq(schema.attentionSettings.userId, owner))
      await db.update(schema.userPreferences).set({ memoryEnabled: true }).where(m.drizzle.eq(schema.userPreferences.userId, owner))
      assert.deepEqual(await read(owner), { ...shown, memoryEnabled: true, dailySuggestions: true }, 'the next read sees both writes without a cache')
      assert.deepEqual(await read(peer), { ...shown, personalInstructions: 'Synthetic peer preference', proactive: false }, 'another owner stays isolated')
      assert.deepEqual(await read("missing' OR '1'='1"), DEFAULT_PREFERENCES, 'the owner remains a bound text parameter')
      t.diagnostic(JSON.stringify({ kind: 'preferences_statement_count', readCases: counts.length, queryCounts: counts }))
      assert.deepEqual(counts, Array.from({ length: counts.length }, () => 1), 'each complete authorized owner snapshot uses one database statement')
      const failure = new Error('synthetic_preferences_query_failure')
      const rejected = mock.method(client, 'query', async () => { throw failure })
      try {
        await assert.rejects(readPreferences(owner), error => error === failure || (error as { cause?: unknown }).cause === failure)
        assert.equal(rejected.mock.callCount(), 1, 'database errors are not retried or converted to defaults')
      } finally { rejected.mock.restore() }
    })
  } finally {
    try {
      await client.query('DELETE FROM attention_settings WHERE "userId"=ANY($1::text[])', [[owner, peer]])
      await client.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
    } finally { client.release() }
  }
})
