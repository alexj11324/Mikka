import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { issueVisibilityPredicate } from '../lib/issue-visibility-policy'

// Execute the real actions and Drizzle SQL/result mapping. Only authenticated
// identity, Workspace/Live database boundaries and PostgreSQL transport are fake.
// The real Workspace predicate and application query/result mapping stay in use.
// PostgreSQL evaluates the same queries in action-read-egress.db.test.ts.
const OWNER = 'task-read-owner', PEER = 'task-read-peer'
const WORKSPACE = '42100000-0000-4000-8000-000000000009'
const ISSUE = '42100000-0000-4000-8000-000000000001'
const RUN = '42100000-0000-4000-8000-000000000002'
const BOT = '42100000-0000-4000-8000-000000000003'
const EXPIRY = new Date('2099-01-31T00:00:00.000Z')
const SIGNATURE = '1'.repeat(32), ROW_SIGNATURE = '2'.repeat(32)
const look = { id: BOT, name: 'Fixture bot', color: 'blue', shape: 'circle' }
const queries: { text: string; params: unknown[] }[] = []
const order: string[] = [], liveReads: { owner: string; expiries: unknown[] }[] = []
const workspaceReads: string[] = []
let viewer: string | null = OWNER, taskRows = true, threadRows = false
let expiry: Date | null = EXPIRY

const client = { query: async (config: { text: string; rowMode?: string }, params: unknown[] = []) => {
  queries.push({ text: config.text, params }); order.push('query')
  const text = config.text.replace(/\s+/g, ' ').trim()
  if (text.includes('select distinct on ("agent_runs"."issueId")')) {
    if (!taskRows) return { rows: [] }
    // …, issueTitle, the conversation's stored title (none) and the opening of what it was asked, agentName, …
    const base = [ISSUE, RUN, 'Fixture issue', null, '', 'Codex', 'running', null, null]
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
  if (text.includes('"thread_list_expiry"')) return { rows: [[true, RUN, null, 'Fixture agent', ISSUE, 'Fixture task', null, 'running',
    '2099-01-01T00:00:00.000Z', '2099-01-02T00:00:00.000Z', 'Fixture reply', null, null, null, null, null, false, 'codex', null, null]] }
  throw Error('Unexpected fixture query')
} }
const database = drizzle(client as unknown as Pool)
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
let actions: typeof import('../app/actions/task-runs')
let stateQueries: typeof import('../lib/task-state-query')
let taskQueries: typeof import('../lib/task-block-runs')
let schema: typeof import('../lib/db/schema')
before(async () => {
  mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
  stub('../lib/auth.ts', { auth: { api: { getSession: async () => { order.push('auth'); return viewer ? { user: { id: viewer } } : null } } } })
  stub('../lib/workspace-access.ts', { loadWorkspaceContext: async (requested: string | undefined, user: { id: string }) => {
    assert.equal(requested, undefined); assert.equal(user.id, viewer)
    workspaceReads.push(user.id)
    return { workspace: { id: WORKSPACE }, user }
  } })
  stub('../lib/issue-visibility.ts', { issueVisibility: async (user: { id: string }, includeDeleted: boolean, workspaceId: string) => {
    assert.equal(user.id, viewer); assert.equal(workspaceId, WORKSPACE); assert.equal(includeDeleted, false)
    return { predicate: issueVisibilityPredicate(user.id, { allowedIds: [], workspaceIds: [WORKSPACE] }, includeDeleted) }
  } })
  stub('../lib/db/index.ts', { db: database })
  stub('../lib/db/request-scope.ts', { inDatabaseTransaction: () => false })
  stub('../lib/device-presence.ts', { deviceOnlineStates: async () => new Map() })
  stub('../lib/db/egress-sample.ts', { withDatabaseOperation: async (_route: string, work: () => unknown) => work() })
  stub('../lib/live/revision-read.ts', { beginWorkspaceListRead: async (owner: string, workspaceId: string) => {
    assert.equal(owner, viewer); assert.equal(workspaceId, WORKSPACE)
    order.push('revision'); return { revisions: {} }
  } })
  stub('../lib/live/list-read-server.ts', { ownerListRead: async (owner: string, expiries: unknown[]) => {
    liveReads.push({ owner, expiries }); return { ownerId: owner, workspaceId: WORKSPACE }
  } })
  stub('../lib/live/presence-read.ts', { withDevicePresence: (live: unknown) => live })
  actions = await import('../app/actions/task-runs')
  stateQueries = await import('../lib/task-state-query')
  taskQueries = await import('../lib/task-block-runs')
  schema = await import('../lib/db/schema')
})
beforeEach(() => {
  viewer = OWNER; taskRows = true; threadRows = false; expiry = EXPIRY
  queries.length = 0; order.length = 0; liveReads.length = 0; workspaceReads.length = 0
})

test('task runs fetch owner bot looks with the bounded latest issue rows in one SQL statement', async () => {
  const result = await actions.pollTaskRuns()
  assert.deepEqual(result.items.map(item => item.bot), [look, null], 'an unmatched bot is null, not a null-valued object')
  assert.deepEqual(result.items.map(item => item.failureDetails), [null, null])
  assert.deepEqual(result.items.map(item => item.issueId), [ISSUE, ISSUE.replace(/1$/, '4')])
  assert.equal(queries.length, 1, 'bot looks must not need another main-database read')
  assert.deepEqual(order, ['auth', 'revision', 'query'], 'Live revision is observed before rows')
  const { text, params } = queries[0]
  assert.match(text, /from \(select distinct on \("agent_runs"\."issueId"\)/)
  assert.match(text, /order by "agent_runs"\."issueId", "agent_runs"\."createdAt" desc, "agent_runs"\."id" desc limit \$\d+\) "latest_task_runs" left join "bots"/)
  assert.match(text, /left join "bots" on \("bots"\."id" = "botId" and "bots"\."ownerId" = \$\d+ and "bots"\."workspaceId" = \$\d+\)/)
  const bindingValue = (pattern: RegExp) => {
    const match = text.match(pattern)
    assert.ok(match, `expected authorization binding: ${pattern}`)
    return params[Number(match[1]) - 1]
  }
  assert.equal(bindingValue(/"agent_runs"\."userId" = \$(\d+)/), OWNER, 'the latest run rows remain owned by the reader')
  assert.equal(bindingValue(/"bots"\."ownerId" = \$(\d+)/), OWNER, 'bot decoration independently keeps its owner boundary')
  const acl = text.match(/mikka_resource_acl_allowed\('account', \$(\d+), "issues"\."workspaceId", \$(\d+), "issues"\."id", \$(\d+)\)/)
  assert.ok(acl, 'the resource check binds the exact task and its tenant')
  assert.deepEqual(acl.slice(1).map(slot => params[Number(slot) - 1]), [OWNER, 'task', 'canReadContent'], 'resource ACL evaluates the actual reader and content action')
  assert.equal(params.filter(value => value === OWNER).length, 3, 'only the run owner, bot owner and ACL actor bindings name the reader')
  assert.ok(params.includes(200), 'the original issue-row cap is applied before bot decoration')
  assert.match(text, /where \("agent_runs"\."userId" = \$\d+ and "agent_runs"\."workspaceId" = \$\d+ and /)
  assert.match(text, /"issues"\."ownershipState" = \$\d+/)
  assert.match(text, /"issues"\."workspaceId" in \(\$\d+\)/)
  assert.ok(params.includes('bound'))
  assert.equal(params.filter(value => value === WORKSPACE).length, 3, 'run, task and bot all use the selected tenant')
  assert.match(text, /and "agent_runs"\."issueId" is not null and "agent_runs"\."createdAt" > now\(\) - interval '30 days'\)/)
  assert.deepEqual(workspaceReads, [OWNER])
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
  const version = createHash('sha256').update(JSON.stringify([OWNER, WORKSPACE, SIGNATURE])).digest('hex').slice(0, 32)
  const result = await actions.syncThreadList(version)
  assert.ok('snapshot' in result)
  assert.deepEqual(result.snapshot, { unchanged: true, version, live: { ownerId: OWNER, workspaceId: WORKSPACE }, presenceFallback: false })
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
  assert.equal(result.snapshot.items?.[0].unread, true)
  assert.equal(result.snapshot.items?.[0].createdAt, '2099-01-01T00:00:00.000Z')
  assert.equal(result.snapshot.items?.[0].failureDetails, null)
  assert.equal(result.snapshot.items?.[0].harness, 'codex')
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
  assert.deepEqual(workspaceReads, [])
  assert.deepEqual(queries, [])
  assert.deepEqual(liveReads, [])
})

test('shared run facts correlate to the outer Run in both single-table and joined reads', () => {
  const { agentRuns, agents } = schema
  for (const joined of [false, true]) {
    const query = database.select(stateQueries.taskStateRunColumns).from(agentRuns).$dynamic()
    if (joined) query.innerJoin(agents, eq(agents.id, agentRuns.agentId))
    const { sql: text, params } = query.where(and(eq(agentRuns.userId, OWNER), eq(agentRuns.workspaceId, WORKSPACE))).toSQL()
    for (const alias of ['p', 'a', 'v']) {
      assert.ok(text.includes(`${alias}."runId"="agent_runs"."id"`), `${alias} must not capture its own id (${joined ? 'joined' : 'single-table'})`)
      assert.ok(text.includes(`${alias}."userId"="agent_runs"."userId"`), `${alias} must retain the outer owner`)
    }
    assert.ok(text.includes('"agent_runs"."status" in (\'preparing\',\'running\',\'waiting_input\',\'finishing\')'))
    assert.ok(text.includes('"agent_runs"."stopRequestedAt" is null'))
    assert.equal(text.match(/d\.id="agent_runs"\."deviceId"/g)?.length, 2, 'both presence facts use the actual Run device')
    assert.equal(text.match(/d\."ownerId"="agent_runs"\."userId"/g)?.length, 2, 'both presence facts retain the outer owner')
    assert.equal(text.match(/"agent_runs"\."status"='queued'/g)?.length, 2)
    assert.match(text, /where \("agent_runs"\."userId" = \$\d+ and "agent_runs"\."workspaceId" = \$\d+\)/)
    assert.ok(params.includes(OWNER) && params.includes(WORKSPACE), 'actor and Workspace remain parameterized')
    assert.ok(!text.includes(OWNER) && !text.includes(WORKSPACE))
  }
  assert.equal(queries.length, 0, 'query construction does not execute or add a read')
})

test('task schedules correlate to the outer Task and Workspace without capturing the schedule id', () => {
  const { issues, agents } = schema
  for (const joined of [false, true]) {
    const query = database.select({ id: issues.id, schedule: taskQueries.taskSchedule(issues.id, OWNER, WORKSPACE) }).from(issues).$dynamic()
    if (joined) query.leftJoin(agents, eq(agents.userId, issues.userId))
    const { sql: text, params } = query.where(eq(issues.id, ISSUE)).toSQL()
    assert.ok(text.includes('s.definition->\'task\'->>\'issueId\'="issues"."id"::text'), `schedule must use the outer Task (${joined ? 'joined' : 'single-table'})`)
    assert.ok(text.includes('s.workspace_id="issues"."workspaceId"'), 'schedule tenant must match the actual Task')
    assert.match(text, /s\.owner_id=\$\d+/)
    assert.match(text, /s\.workspace_id=\$\d+::uuid/)
    assert.deepEqual(params, [OWNER, WORKSPACE, ISSUE])
    assert.ok(!text.includes(OWNER) && !text.includes(WORKSPACE) && !text.includes(ISSUE))
  }
  assert.equal(queries.length, 0, 'schedule decoration stays in its existing query')
})
