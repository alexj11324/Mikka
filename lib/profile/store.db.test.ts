import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'

// R-73: a profile belongs to one person. Teammates in the same workspace never
// see, delete or correct each other's facts; repeats merge; corrections stick.
// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

const seen = (at: string, suggestionId: string, fields: Record<string, unknown> = {}) => ({
  kind: 'interest' as const, subject: '川菜调料', value: { topic: '川菜', purchases: [{ merchant: 'Weee', items: ['花椒'], amount: 12, currency: 'USD', date: at }] },
  evidence: [{ source: 'gmail', suggestionId, externalId: `m-${suggestionId}`, at }], confidence: 0.6, seenAt: new Date(at), expiresAt: null, ...fields,
})

dbTest('facts stay with their person, merge on repeat, and keep the person\'s corrections', async t => {
  const [{ createRequestDatabaseScope, db }, schema, { workspaces, workspaceMembers }, store, preferences, { and, eq, inArray, sql }] = await Promise.all([
    import('../db'), import('../db/schema'), import('../db/workspace-schema'), import('./store'), import('../preferences'), import('drizzle-orm'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const alex = `test-facts-alex-${randomUUID()}`
  const dana = `test-facts-dana-${randomUUID()}`
  const outsider = `test-facts-outsider-${randomUUID()}`
  const workspaceId = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.userFacts).where(inArray(schema.userFacts.userId, [alex, dana, outsider]))
      await db.delete(schema.userFactConsolidations).where(inArray(schema.userFactConsolidations.userId, [alex, dana, outsider]))
      await db.delete(schema.userPreferences).where(inArray(schema.userPreferences.userId, [alex, dana]))
      await db.delete(schema.proactiveUsage).where(inArray(schema.proactiveUsage.userId, [alex, dana]))
      await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      await db.delete(schema.users).where(inArray(schema.users.id, [alex, dana]))
    })
    await scope.close()
  })
  await scope.run(async () => {
    for (const id of [alex, dana]) await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${id}, ${id}, ${`${id}@example.com`}, false, now(), now())`)
    await db.insert(workspaces).values({ id: workspaceId, userId: alex, name: 'Shared' })
    await db.insert(workspaceMembers).values([
      { workspaceId, userId: alex, name: 'Alex', email: `${alex}@example.com`, role: 'admin' },
      { workspaceId, userId: dana, name: 'Dana', email: `${dana}@example.com`, role: 'member' },
    ])

    assert.equal(await store.recordFacts(alex, [seen('2026-10-01T01:00:00Z', 's1')]), 1)
    assert.equal(await store.recordFacts(alex, [seen('2026-10-08T01:00:00Z', 's2', { subject: '  川菜调料。' })]), 1, 'the same fact, spelt differently, merges')
    const [fact] = await store.listFacts(alex)
    assert.equal((await store.listFacts(alex)).length, 1)
    assert.ok(fact.confidence > 0.6, 'a repeat raises confidence')
    assert.equal(fact.lastSeenAt.toISOString(), '2026-10-08T01:00:00.000Z')
    assert.equal((fact.value.purchases as unknown[]).length, 2)

    // Teammates: nothing of Alex's shows to Dana, and Dana cannot change it.
    assert.deepEqual(await store.listFacts(dana), [])
    assert.equal(await store.deleteFact(dana, fact.id), false)
    assert.equal(await store.correctFact(dana, fact.id, 'Dana was here'), false)
    assert.equal((await store.listFacts(alex))[0].subject, '川菜调料')
    await store.recordFacts(dana, [seen('2026-10-02T01:00:00Z', 'd1')])
    assert.equal((await store.listFacts(dana)).length, 1, 'the same fact for Dana is Dana\'s own row')
    assert.equal((await store.listFacts(alex)).length, 1)

    // A correction is the person's: the model only moves lastSeenAt.
    assert.equal(await store.correctFact(alex, fact.id, '四川菜调料'), true)
    assert.equal(await store.recordFacts(alex, [seen('2026-10-15T01:00:00Z', 's3', { subject: '四川菜调料', confidence: 0.1 })]), 0)
    const [corrected] = await store.listFacts(alex)
    assert.deepEqual([corrected.subject, corrected.userEdited, corrected.confidence], ['四川菜调料', true, 1])
    assert.equal((corrected.value.purchases as unknown[]).length, 2, 'the model adds nothing to a corrected fact')

    // A deleted fact is not learnt again and keeps no details.
    assert.equal(await store.deleteFact(alex, fact.id), true)
    await store.recordFacts(alex, [seen('2026-10-16T01:00:00Z', 's4', { subject: '四川菜调料' })])
    assert.deepEqual(await store.listFacts(alex), [])
    const [tombstone] = await db.select().from(schema.userFacts).where(eq(schema.userFacts.id, fact.id))
    assert.deepEqual([tombstone.state, tombstone.value, tombstone.evidence], ['deleted', {}, []])

    // The daily cap and usage (proactive.md § 3).
    const day = store.usageDay(new Date('2026-10-28T12:00:00Z'))
    const claims = await Promise.all([1, 2, 3].map(() => store.claimExtractionCall(alex, day, 2)))
    assert.equal(claims.filter(Boolean).length, 2, 'the cap holds under concurrent calls')
    assert.equal(await store.claimExtractionCall(alex, store.usageDay(new Date('2026-10-29T00:00:00Z')), 2), true, 'a new day has a new budget')
    await store.recordExtractionTokens(alex, day, 120, 30)
    await store.recordExtractionTokens(alex, day, 80, 20)
    const [usage] = await db.select().from(schema.proactiveUsage).where(and(eq(schema.proactiveUsage.userId, alex), eq(schema.proactiveUsage.day, day)))
    assert.deepEqual([usage.calls, usage.inputTokens, usage.outputTokens], [2, 200, 50])
    assert.equal(await store.claimExtractionCall(dana, day, 0), false)
    assert.equal(store.PROFILE_DAILY_CALLS, 200)

    // Nightly merge: due once per local day from 04:00, never for someone with 记忆 off.
    await store.recordFacts(alex, ['2026-10-01', '2026-10-08', '2026-10-15'].map((day, index) => seen(`${day}T01:00:00Z`, `p${index}`, { subject: `调料 ${index}` })))
    // One 记忆 switch: what web and mobile Settings write (lib/preferences.ts) is what extraction and the merge read.
    assert.equal(await store.memoryEnabled(dana), true, 'no preferences row: on')
    await preferences.savePreferences(dana, { memoryEnabled: false })
    assert.equal((await preferences.readPreferences(dana)).memoryEnabled, false)
    const morning = new Date('2026-10-28T04:30:00Z')
    // Entitlement comes from PostHog (lib/profile/entitlement.ts); here Alex and Dana are entitled, a third person is not.
    await store.recordFacts(outsider, [seen('2026-10-01T01:00:00Z', 'o1')])
    // The DB is shared with other suites (lib/account/store.db.test.ts also writes user_facts), and the
    // nightly merge reads every user. Only this test's people count; anyone else is treated as not entitled.
    const mine = new Set([alex, dana, outsider])
    const entitled = async (userId: string) => mine.has(userId) && userId !== outsider
    const first = await store.consolidateDueFacts({ entitled, now: morning })
    assert.equal(first.written, 1, 'only Alex: Dana has 记忆 off, the outsider is not entitled')
    assert.ok((await store.listFacts(alex)).some(item => item.kind === 'interest' && item.subject === '川菜'), 'scattered purchases become an interest')
    assert.equal((await store.listFacts(dana)).some(item => item.subject === '川菜'), false)
    const [settings] = await db.select().from(schema.userFactConsolidations).where(eq(schema.userFactConsolidations.userId, alex))
    assert.equal(settings.consolidatedOn, '2026-10-28')
    assert.equal((await db.select().from(schema.userFactConsolidations).where(eq(schema.userFactConsolidations.userId, outsider))).length, 0, 'not entitled: not merged or claimed')
    const again = await store.consolidateDueFacts({ entitled, now: morning })
    assert.equal(again.written, 0, 'once per local day')
    assert.equal(again.due - again.skipped, 0, 'whoever is still due is skipped (the outsider and other suites\' users), nobody is merged twice')
    assert.equal((await db.select().from(schema.userFactConsolidations).where(eq(schema.userFactConsolidations.userId, outsider))).length, 0, 'the outsider stays unclaimed')
    assert.equal(await store.memoryEnabled(dana), false)
    assert.equal(await store.memoryEnabled(alex), true)
  })
})
