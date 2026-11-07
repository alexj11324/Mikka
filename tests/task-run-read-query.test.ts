import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'

// Execute the real actions and Drizzle SQL/result mapping. Only authenticated
// identity, Live's separate database boundary, and PostgreSQL transport are fake.
// PostgreSQL evaluates the same queries in action-read-egress.db.test.ts.
const OWNER = 'task-read-owner', PEER = 'task-read-peer'
const ISSUE = '42100000-0000-4000-8000-000000000001'
const RUN = '42100000-0000-4000-8000-000000000002'
const BOT = '42100000-0000-4000-8000-000000000003'
const EXPIRY = new Date('2099-01-31T00:00:00.000Z')
const SIGNATURE = '1'.repeat(32), ROW_SIGNATURE = '2'.repeat(32)
const look = { id: BOT, name: 'Fixture bot', color: 'blue', shape: 'circle' }
const queries: { text: string; params: unknown[] }[] = []
const order: string[] = [], liveReads: { owner: string; expiries: unknown[] }[] = []
let viewer: string | null = OWNER, taskRows = true, threadRows = false
let expiry: Date | null = EXPIRY

const client = { query: async (config: { text: string; rowMode?: string }, params: unknown[] = []) => {
  queries.push({ text: config.text, params }); order.push('query')
  const text = config.text.replace(/\s+/g, ' ').trim()
  if (text.includes('select distinct on ("agent_runs"."issueId")')) {
    if (!taskRows) return { rows: [] }
    const base = [ISSUE, RUN, 'Fixture issue', 'Codex', 'running', null]
    if (text.includes('"latest_task_runs"')) {
      return { rows: [[...base, EXPIRY, ['codex'], ...Object.values(look)],
        [ISSUE.replace(/1$/, '4'), RUN.replace(/2$/, '5'), ...base.slice(2), EXPIRY, ['codex'], null, null, null, null]] }
    }
    return { rows: [[...base, BOT, EXPIRY, ['codex']],
      [ISSUE.replace(/1$/, '4'), RUN.replace(/2$/, '5'), ...base.slice(2), null, EXPIRY, ['codex']]] }
  }
  if (text.includes('from "bots"')) return { rows: [Object.values(look)] }
  if (text.includes('string_agg(md5(to_jsonb(snapshot)::text)')) return { rows: [{ version: SIGNATURE, expiresAt: expiry }] }
  if (text.startsWith('select min(')) return { rows: [[expiry]] }
  if (text.includes('md5(to_jsonb(thread_list_expiry)::text)')) return { rows: threadRows ? [[RUN, ROW_SIGNATURE]] : [] }
  if (text.includes('"thread_list_expiry"')) return { rows: [[RUN, null, 'Fixture agent', ISSUE, 'Fixture task', 'running',
    '2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z', 'Fixture reply', null, null, null, null, null, false, 'codex', null]] }
  throw Error('Unexpected fixture query')
} }
const database = drizzle(client as unknown as Pool)
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
let actions: typeof import('../app/actions/task-runs')
before(async () => {
  mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
  stub('../lib/auth.ts', { auth: { api: { getSession: async () => { order.push('auth'); return viewer ? { user: { id: viewer } } : null } } } })
  stub('../lib/db/index.ts', { db: database })
  stub('../lib/db/request-scope.ts', { inDatabaseTransaction: () => false })
  stub('../lib/device-presence.ts', { deviceOnlineStates: async () => new Map() })
  stub('../lib/db/egress-sample.ts', { withDatabaseOperation: async (_route: string, work: () => unknown) => work() })
  stub('../lib/live/revision-read.ts', { beginOwnerListRead: async () => { order.push('revision'); return { revisions: {} } } })
  stub('../lib/live/list-read-server.ts', { ownerListRead: async (owner: string, expiries: unknown[]) => {
    liveReads.push({ owner, expiries }); return { ownerId: owner, workspaceId: null }
  } })
  stub('../lib/live/presence-read.ts', { withDevicePresence: (live: unknown) => live })
  actions = await import('../app/actions/task-runs')
})
beforeEach(() => {
  viewer = OWNER; taskRows = true; threadRows = false; expiry = EXPIRY
  queries.length = 0; order.length = 0; liveReads.length = 0
})

test('task runs fetch owner bot looks with the bounded latest issue rows in one SQL statement', async () => {
  const result = await actions.pollTaskRuns()
  assert.deepEqual(result.items.map(item => item.bot), [look, null], 'an unmatched bot is null, not a null-valued object')
  assert.deepEqual(result.items.map(item => item.issueId), [ISSUE, ISSUE.replace(/1$/, '4')])
  assert.equal(queries.length, 1, 'bot looks must not need another main-database read')
  assert.deepEqual(order, ['auth', 'revision', 'query'], 'Live revision is observed before rows')
  const { text, params } = queries[0]
  assert.match(text, /from \(select distinct on \("agent_runs"\."issueId"\)/)
  assert.match(text, /order by "agent_runs"\."issueId", "agent_runs"\."createdAt" desc, "agent_runs"\."id" desc limit \$\d+\) "latest_task_runs" left join "bots"/)
  assert.match(text, /left join "bots" on \("bots"\."id" = "botId" and "bots"\."ownerId" = \$\d+\)/)
  assert.equal(params.filter(value => value === OWNER).length, 2, 'both the latest rows and bot looks are owner constrained')
  assert.ok(params.includes(200), 'the original issue-row cap is applied before bot decoration')
  assert.match(text, /where \("agent_runs"\."userId" = \$\d+ and "agent_runs"\."issueId" is not null and "agent_runs"\."createdAt" > now\(\) - interval '30 days'\)/)
  const binding = text.indexOf('from computer_run_bindings crb'), direct = text.indexOf('from bots b where b.id="agent_runs"."botId"')
  const runtime = text.indexOf('from bot_cloud_runtimes bcr')
  assert.ok(binding >= 0 && direct > binding && runtime > direct, 'the original binding → dispatch bot → runtime bot fallback remains')
  assert.deepEqual(liveReads, [{ owner: OWNER, expiries: [EXPIRY, EXPIRY] }])
  assert.ok(result.items.every(item => !('expiresAt' in item) && !('botId' in item)))
})

test('empty task rows do not add a read or leak another owner into the bot join', async () => {
  viewer = PEER; taskRows = false
  assert.deepEqual((await actions.pollTaskRuns()).items, [])
  assert.equal(queries.length, 1)
  assert.ok(queries.every(query => !query.params.includes(OWNER)))
  assert.deepEqual(liveReads, [{ owner: PEER, expiries: [] }])
})

test('an unchanged thread list reads its exact fingerprint and expiry in one aggregate', async () => {
  const version = createHash('sha256').update(JSON.stringify([OWNER, SIGNATURE])).digest('hex').slice(0, 32)
  const result = await actions.syncThreadList(version)
  assert.ok('snapshot' in result)
  assert.deepEqual(result.snapshot, { unchanged: true, version, live: { ownerId: OWNER, workspaceId: null }, presenceFallback: false })
  assert.equal(queries.length, 1, 'expiry must share the fingerprint snapshot and statement')
  assert.deepEqual(order, ['auth', 'revision', 'query'])
  assert.match(queries[0].text, /md5\(coalesce\(string_agg\(md5\(to_jsonb\(snapshot\)::text\), ',' order by md5\(to_jsonb\(snapshot\)::text\)\), ''\)\)/)
  assert.match(queries[0].text, /min\(snapshot\."createdAt"\)\+interval '30 days'/)
  assert.match(queries[0].text, /"agent_runs"\."createdAt" > now\(\) - interval '30 days'/)
  assert.ok(queries[0].params.includes(OWNER) && queries[0].params.includes(200))
  assert.deepEqual(liveReads, [{ owner: OWNER, expiries: [EXPIRY] }])
})

test('changed thread rows keep their manifest, owner hash and ordered data read after the aggregate', async () => {
  threadRows = true
  const result = await actions.syncThreadList()
  assert.ok('snapshot' in result)
  assert.equal(queries.length, 3, 'one aggregate, one manifest, one changed-row query')
  assert.equal(result.snapshot.items?.length, 1)
  assert.equal(result.snapshot.items?.[0].id, RUN)
  assert.equal(result.snapshot.items?.[0].createdAt, '2099-01-01T00:00:00.000Z')
  assert.deepEqual(result.snapshot.positions, [{ id: RUN, version: createHash('sha256').update(`${OWNER}:${ROW_SIGNATURE}`).digest('hex').slice(0, 32) }])
  assert.ok(queries[0].text.includes('string_agg('))
  assert.ok(queries[1].text.includes('md5(to_jsonb(thread_list_expiry)::text)'))
  assert.ok(queries[2].params.includes(RUN))
  assert.match(queries[2].text, /order by greatest\("thread_list_expiry"\."lastReplyAt", "thread_list_expiry"\."updatedAt"\) desc, "thread_list_expiry"\."createdAt" desc, "thread_list_expiry"\."id" desc/)
})

test('an empty thread snapshot keeps null expiry and no changed-row query', async () => {
  expiry = null
  const result = await actions.syncThreadList()
  assert.ok('snapshot' in result)
  assert.deepEqual(result.snapshot.items, [])
  assert.deepEqual(result.snapshot.positions, [])
  assert.equal(queries.length, 2)
  assert.deepEqual(liveReads, [{ owner: OWNER, expiries: [null] }])
})

test('authentication failures still precede every revision or main-database read', async () => {
  viewer = null
  await assert.rejects(actions.pollTaskRuns(), { code: 'authRequired' })
  assert.deepEqual(await actions.syncThreadList(), { error: 'authRequired', params: undefined })
  assert.deepEqual(order, ['auth', 'auth'])
  assert.deepEqual(queries, [])
  assert.deepEqual(liveReads, [])
})
