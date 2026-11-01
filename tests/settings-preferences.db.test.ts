import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, mock, test } from 'node:test'
import { seedCoordinator } from './support/coordinator-bot'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Settings backend actions (docs/settings-backend/prefs.md) against a real,
// disposable Postgres. Only the session and Composio are stubbed. Runs against a
// loopback *_e2e database whose URL is also MIKKA_DATABASE_URL and DATABASE_URL.
// Skipped otherwise; REQUIRE_DB=1 makes that fail.
const target = process.env.E2E_DATABASE_URL
const databaseUrl = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target ? target : undefined
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires a matching loopback e2e database')
const dbTest = databaseUrl ? test : test.skip

let sessionUser: { id: string; name: string; email: string } | null = null
let connected: string[] = []
const people = { alex: `test-prefs-alex-${randomUUID()}`, dana: `test-prefs-dana-${randomUUID()}` }
const as = (id: string | null) => { sessionUser = id ? { id, name: id, email: `${id}@example.com` } : null }

type Modules = Awaited<ReturnType<typeof load>>
let m: Modules
async function load() {
  const [preferences, memory, db, schema, drizzle, suggestionsStore, timeZone, sourceSettings, personal] = await Promise.all([
    import('@/app/actions/preferences'), import('@/app/actions/memory'), import('@/lib/db'), import('@/lib/db/schema'), import('drizzle-orm'),
    import('@/lib/suggestions/store'), import('@/lib/suggestions/time-zone'), import('@/lib/suggestions/source-settings'), import('@/lib/coordinator/personal-instructions'),
  ])
  return { preferences, memory, db: db.db, pool: db.pool, schema, drizzle, suggestionsStore, timeZone, sourceSettings, personal }
}

before(async () => {
  if (!databaseUrl) return
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => sessionUser ? { user: sessionUser } : null } } } })
  mock.module('@/lib/session', { namedExports: { getSession: async () => sessionUser ? { user: sessionUser } : null } })
  mock.module('@/lib/suggestions/sources', { namedExports: { connectedComposioApps: async () => connected } })
  m = await load()
  const { db, drizzle: { sql } } = m
  for (const id of Object.values(people)) await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${id}, ${id}, ${`${id}@example.com`}, false, now(), now())`)
})

after(async () => {
  if (!databaseUrl) return
  const { db, schema, drizzle: { inArray } } = m
  const ids = Object.values(people)
  await db.delete(schema.userFacts).where(inArray(schema.userFacts.userId, ids))
  await db.delete(schema.attentionMatters).where(inArray(schema.attentionMatters.userId, ids))
  await db.delete(schema.attentionSettings).where(inArray(schema.attentionSettings.userId, ids))
  await db.delete(schema.userTimeZones).where(inArray(schema.userTimeZones.userId, ids))
  await db.delete(schema.briefings).where(inArray(schema.briefings.userId, ids))
  await db.delete(schema.users).where(inArray(schema.users.id, ids))
  await m.pool.end()
})

dbTest('every action needs a session', async () => {
  as(null)
  const { preferences, memory } = m
  assert.deepEqual(await preferences.updatePreferences({ sendKey: 'modEnter' }), { error: 'authRequired', params: undefined })
  for (const result of [
    await preferences.getTimeZoneSetting(), await preferences.setTimeZone('UTC'), await preferences.getAttentionToday(),
    await preferences.listSuggestionSources(), await preferences.setSuggestionSource('gmail', false), await memory.clearMemory(),
  ]) assert.equal(result.error, 'authRequired')
  await assert.rejects(memory.getMemory(), { code: 'authRequired' })
})

dbTest('preferences: send key, personal instructions and daily suggestions save with their rules', async () => {
  as(people.alex)
  const { preferences } = m
  const defaults = await preferences.getPreferences()
  assert.equal(defaults.sendKey, 'enter')
  assert.equal(defaults.personalInstructions, '')
  assert.equal(defaults.dailySuggestions, true)
  const saved = await preferences.updatePreferences({ sendKey: 'modEnter', personalInstructions: '  回答用中文  ' })
  assert.equal(saved.error, undefined)
  assert.equal(!saved.error && saved.sendKey, 'modEnter')
  assert.equal(!saved.error && saved.personalInstructions, '回答用中文')
  assert.equal((await preferences.updatePreferences({ personalInstructions: '字'.repeat(2001) })).error, 'personalInstructionsTooLong')
  assert.equal((await preferences.updatePreferences({ sendKey: 'tab' })).error, 'validationGeneric')
  assert.equal((await preferences.getPreferences()).personalInstructions, '回答用中文', 'a refused patch changes nothing')

  // 每日建议 needs 记忆.
  const memoryOff = await preferences.updatePreferences({ memoryEnabled: false })
  assert.equal(!memoryOff.error && memoryOff.dailySuggestions, false, 'turning 记忆 off turns 每日建议 off')
  assert.equal((await preferences.updatePreferences({ dailySuggestions: true })).error, 'dailySuggestionsNeedMemory')
  assert.equal((await preferences.updatePreferences({ dailySuggestions: true, memoryEnabled: false })).error, 'dailySuggestionsNeedMemory')
  assert.equal((await preferences.getPreferences()).dailySuggestions, false)
  const memoryOn = await preferences.updatePreferences({ memoryEnabled: true })
  assert.equal(!memoryOn.error && memoryOn.dailySuggestions, false, 'turning 记忆 back on leaves 每日建议 for the person to turn on')
  const both = await preferences.updatePreferences({ memoryEnabled: true, dailySuggestions: true })
  assert.equal(!both.error && both.dailySuggestions, true)
  assert.equal((await preferences.getPreferences()).sendKey, 'modEnter', 'other settings are kept')
})

dbTest('personal instructions reach the next prompt for the Coordinator and Bots, and leave it when cleared', async () => {
  as(people.alex)
  const { preferences, personal } = m
  await preferences.updatePreferences({ personalInstructions: 'Always answer in haiku.' })
  const prompt = await personal.withPersonalInstructions(people.alex, 'BASE RULES')
  assert.ok(prompt.startsWith('BASE RULES\n\n## The person\'s own instructions'))
  assert.match(prompt, /<personal_instructions>\nAlways answer in haiku\.\n<\/personal_instructions>/)
  assert.equal(await personal.withPersonalInstructions(people.dana, 'BASE RULES'), 'BASE RULES', 'another person\'s instructions stay theirs')
  await preferences.updatePreferences({ personalInstructions: '' })
  assert.equal(await personal.withPersonalInstructions(people.alex, 'BASE RULES'), 'BASE RULES')
})

dbTest('the Coordinator\'s and a Bot\'s turn prompt (preparePrompt) carry the saved instructions and drop them once cleared', async () => {
  as(people.alex)
  const { preferences } = m
  const { preparePrompt } = await import('@/workflows/coordinator/steps')
  const botId = randomUUID()
  // The Coordinator is an ordinary bot row; its prompt keeps the Coordinator's rules.
  const coordinator = (await seedCoordinator(people.alex)).botId
  await preferences.updatePreferences({ personalInstructions: 'Sign every reply with 🐧.' })
  for (const bot of [coordinator, botId]) {
    const { instructions } = await preparePrompt(people.alex, bot)
    assert.match(instructions, /You are the Coordinator in Mikka/, 'the rules come first')
    assert.match(instructions, /<personal_instructions>\nSign every reply with 🐧\.\n<\/personal_instructions>/)
    assert.ok(instructions.indexOf('<personal_instructions>') > instructions.indexOf('You are the Coordinator in Mikka'))
  }
  await preferences.updatePreferences({ personalInstructions: '' })
  for (const bot of [coordinator, botId]) assert.doesNotMatch((await preparePrompt(people.alex, bot)).instructions, /personal_instructions|Sign every reply/)
})

dbTest('time zone: a picked zone survives browser and IP reports until 自动', async () => {
  as(people.alex)
  const { preferences, suggestionsStore: { recordTimeZone }, timeZone: { manualTimeZone } } = m
  assert.deepEqual(await preferences.getTimeZoneSetting(), { timeZone: null, source: 'auto', detected: null })
  await recordTimeZone(people.alex, 'Asia/Shanghai')
  assert.deepEqual(await preferences.getTimeZoneSetting(), { timeZone: 'Asia/Shanghai', source: 'auto', detected: 'Asia/Shanghai' })
  for (const bad of ['Mars/Base', 'asia/shanghai', '', 42, null]) assert.equal((await preferences.setTimeZone(bad)).error, 'timeZoneInvalid', String(bad))
  assert.deepEqual(await preferences.setTimeZone('America/New_York'), { timeZone: 'America/New_York', source: 'manual', detected: 'Asia/Shanghai' })
  await recordTimeZone(people.alex, 'Europe/Paris')
  await recordTimeZone(people.alex, 'Asia/Tokyo', { replace: false })
  assert.deepEqual(await preferences.getTimeZoneSetting(), { timeZone: 'America/New_York', source: 'manual', detected: 'Europe/Paris' })
  assert.equal(await manualTimeZone(people.alex), 'America/New_York')
  assert.deepEqual(await preferences.setTimeZone('auto'), { timeZone: 'Europe/Paris', source: 'auto', detected: 'Europe/Paris' })
  assert.equal(await manualTimeZone(people.alex), null)
  await recordTimeZone(people.alex, 'Asia/Shanghai')
  assert.deepEqual(await preferences.getTimeZoneSetting(), { timeZone: 'Asia/Shanghai', source: 'auto', detected: 'Asia/Shanghai' }, 'under 自动 the browser decides again')

  as(people.dana)
  assert.deepEqual(await preferences.setTimeZone('UTC'), { timeZone: 'UTC', source: 'manual', detected: null })
  await recordTimeZone(people.dana, 'Asia/Tokyo', { replace: false })
  assert.deepEqual(await preferences.getTimeZoneSetting(), { timeZone: 'UTC', source: 'manual', detected: 'Asia/Tokyo' }, 'an IP guess fills the missing detected zone only')
  await m.db.delete(m.schema.userTimeZones).where(m.drizzle.eq(m.schema.userTimeZones.userId, people.dana))
  await preferences.setTimeZone('Europe/Berlin')
  assert.deepEqual(await preferences.setTimeZone('auto'), { timeZone: null, source: 'auto', detected: null }, '自动 with nothing detected yet forgets the zone')
})

dbTest('提醒: notified counts the notify budget\'s spends in the last 24 hours', async () => {
  as(people.alex)
  const { preferences, db, schema } = m
  assert.deepEqual(await preferences.getAttentionToday(), { notified: 0, limit: 24 }) // the runaway cap; whether to interrupt is the Decisions API's answer
  const matterId = randomUUID()
  await db.insert(schema.attentionMatters).values({ id: matterId, userId: people.alex, matterKey: `test:${matterId}`, source: 'gmail', title: 't', level: 'high', assessment: {}, evidence: {}, state: 'notified' })
  const now = Date.now()
  await db.insert(schema.attentionLog).values([
    { id: randomUUID(), userId: people.alex, matterId, action: 'notify', spends: true, createdAt: new Date(now - 60_000) },
    { id: randomUUID(), userId: people.alex, matterId, action: 'notify', spends: true, createdAt: new Date(now - 23 * 3600_000) },
    { id: randomUUID(), userId: people.alex, matterId, action: 'notify', spends: true, createdAt: new Date(now - 25 * 3600_000) },
    { id: randomUUID(), userId: people.alex, matterId, action: 'notify', spends: false, createdAt: new Date(now - 60_000) },
    { id: randomUUID(), userId: people.alex, matterId, action: 'handoff', spends: true, createdAt: new Date(now - 60_000) },
  ])
  assert.deepEqual(await preferences.getAttentionToday(), { notified: 2, limit: 24 })
  as(people.dana)
  assert.deepEqual(await preferences.getAttentionToday(), { notified: 0, limit: 24 }) // the runaway cap; whether to interrupt is the Decisions API's answer
})

dbTest('删除全部记忆 removes only the person\'s facts and getMemory counts them', async () => {
  const { memory, db, schema } = m
  const fact = (userId: string, subject: string, state: 'active' | 'expired' = 'active') => ({
    id: randomUUID(), userId, kind: 'interest' as const, subject, subjectKey: subject, value: { a: 1 }, evidence: [], confidence: 0.6,
    firstSeenAt: new Date(), lastSeenAt: new Date(), state,
  })
  await db.insert(schema.userFacts).values([fact(people.alex, 'tea'), fact(people.alex, 'coffee'), fact(people.alex, 'old', 'expired'), fact(people.dana, 'tea')])
  as(people.alex)
  const before = await memory.getMemory()
  assert.equal(before.total, 2)
  assert.equal(before.facts.length, 2)
  assert.deepEqual(await memory.clearMemory(), { removed: 2 })
  const cleared = await memory.getMemory()
  assert.equal(cleared.total, 0)
  assert.deepEqual(cleared.facts, [])
  const rows = await db.select().from(schema.userFacts).where(m.drizzle.eq(schema.userFacts.userId, people.alex))
  assert.ok(rows.every(row => row.state === 'deleted' && Object.keys(row.value).length === 0), 'soft-deleted with details cleared, like removeFact')
  assert.deepEqual(await memory.clearMemory(), { removed: 0 })
  as(people.dana)
  assert.equal((await memory.getMemory()).total, 1, 'another person\'s memory is untouched')
})

dbTest('数据来源: connected apps are listed with their switch, and a turned-off app is not read', async () => {
  as(people.alex)
  const { preferences, sourceSettings: { keepEnabledSources } } = m
  connected = ['gmail', 'slack']
  const listed = await preferences.listSuggestionSources()
  assert.ok(!listed.error)
  assert.deepEqual(listed.sources, [
    { app: 'gmail', connected: true, enabled: true }, { app: 'googlecalendar', connected: false, enabled: true },
    { app: 'notion', connected: false, enabled: true }, { app: 'slack', connected: true, enabled: true },
  ])
  assert.deepEqual(await preferences.setSuggestionSource('gmail', false), { app: 'gmail', enabled: false })
  assert.deepEqual(await preferences.setSuggestionSource('notion', false), { app: 'notion', enabled: false })
  assert.deepEqual(await preferences.setSuggestionSource('notion', true), { app: 'notion', enabled: true })
  assert.equal((await preferences.setSuggestionSource('github', false)).error, 'suggestionSourceInvalid')
  assert.equal((await preferences.setSuggestionSource('gmail', 'no')).error, 'validationGeneric')
  const after = await preferences.listSuggestionSources()
  assert.ok(!after.error)
  assert.deepEqual(after.sources.map(source => [source.app, source.enabled]), [['gmail', false], ['googlecalendar', true], ['notion', true], ['slack', true]])
  assert.equal((await preferences.getPreferences()).sendKey, 'modEnter', 'the source switch leaves the other settings alone')

  const items = [
    { userId: people.alex, source: 'gmail', id: 1 }, { userId: people.alex, source: 'slack', id: 2 },
    { userId: people.alex, source: 'github', id: 3 }, { userId: people.dana, source: 'gmail', id: 4 },
  ]
  assert.deepEqual((await keepEnabledSources(items)).map(item => item.id), [2, 3, 4])
})

dbTest('每日建议 off: the briefings cron, the lazy read and the first briefing skip the person', async () => {
  as(people.dana)
  const { preferences, suggestionsStore: { dailySuggestionsOn, writeDueBriefings, writeFirstBriefing }, db, schema, drizzle: { and, eq } } = m
  await preferences.setTimeZone('UTC')
  const now = new Date()
  now.setUTCHours(9, 0, 0, 0)
  const todays = async () => db.select().from(schema.briefings).where(and(eq(schema.briefings.userId, people.dana), eq(schema.briefings.localDate, now.toISOString().slice(0, 10))))
  await db.delete(schema.briefings).where(eq(schema.briefings.userId, people.dana))

  assert.equal(await dailySuggestionsOn(people.dana), true, 'on by default')
  await preferences.updatePreferences({ dailySuggestions: false })
  assert.equal(await dailySuggestionsOn(people.dana), false)
  await writeDueBriefings({ now })
  assert.equal((await todays()).length, 0, 'the cron skips them')
  assert.equal(await writeFirstBriefing(people.dana, 'UTC'), false)

  await preferences.updatePreferences({ dailySuggestions: true })
  await writeDueBriefings({ now })
  assert.equal((await todays()).length, 1, 'back on, the cron writes it again')

  await db.delete(schema.briefings).where(eq(schema.briefings.userId, people.dana))
  await preferences.updatePreferences({ memoryEnabled: false })
  assert.equal(await dailySuggestionsOn(people.dana), false, '记忆 off keeps it off')
  await writeDueBriefings({ now })
  assert.equal((await todays()).length, 0)
})

dbTest('the 线程完成 migration turns stored offs on, defaults new rows on, and a member can still turn it off', async () => {
  const { readFile } = await import('node:fs/promises')
  const migration = await readFile(new URL('../drizzle/20261031151353_push_finished_default_on.sql', import.meta.url), 'utf8')
  const client = await m.pool.connect()
  try {
    await client.query('begin')
    const schema = `push_finished_${randomUUID().replaceAll('-', '')}`
    await client.query(`create schema "${schema}"`)
    await client.query(`set local search_path to "${schema}"`)
    // The table as drizzle/20261027203647_mobile_push.sql created it, without the user foreign key.
    await client.query(`create table user_preferences ("userId" text primary key, "pushDecide" boolean not null default true, "pushReview" boolean not null default true, "pushFinished" boolean not null default false, "pushBriefing" boolean not null default true, "pushWhen" text not null default 'always', "memoryEnabled" boolean not null default true, "updatedAt" timestamptz not null default now())`)
    await client.query(`insert into user_preferences ("userId", "pushFinished") values ('old-default', false), ('already-on', true)`)
    await client.query(migration)
    await client.query(migration)
    await client.query(`insert into user_preferences ("userId") values ('new-member')`)
    const rows = await client.query(`select "userId", "pushFinished" from user_preferences order by "userId"`)
    assert.deepEqual(rows.rows, [{ userId: 'already-on', pushFinished: true }, { userId: 'new-member', pushFinished: true }, { userId: 'old-default', pushFinished: true }])
  } finally {
    await client.query('rollback')
    client.release()
  }
  // On the migrated app database: a member with no row reads on; turning it off sticks.
  as(people.dana)
  assert.equal((await m.preferences.getPreferences()).pushFinished, true)
  assert.equal((await m.preferences.updatePreferences({ pushFinished: false }) as { pushFinished: boolean }).pushFinished, false)
  assert.equal((await m.preferences.getPreferences()).pushFinished, false)
  await m.preferences.updatePreferences({ pushFinished: true })
})
