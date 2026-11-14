import assert from 'node:assert/strict'
import { afterEach, before, mock, test } from 'node:test'
import { PgDialect, QueryBuilder, type PgTable, type SelectedFields } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { ActionFailureError } from './action-error'
import { agentRuns, issueMembers, runChunks, runMessages } from './db/schema'
import { workspaceMembers, workspaces } from './db/workspace-schema'
import { factoryEventId } from './factory/event-id'
import { FactoryError } from './factory/contract'

const runId = '31300000-0000-4000-8000-000000000001'
const issueId = '31300000-0000-4000-8000-000000000002'
const botId = '31300000-0000-4000-8000-000000000003'
const workspaceId = '31300000-0000-4000-8000-000000000004'
const dialect = new PgDialect()
const expectedMembershipSql = "select \"mikka_workspaces\".\"id\", \"mikka_workspaces\".\"kind\", \"mikka_organization_workspaces\".\"organizationId\" from \"mikka_workspaces\" inner join \"mikka_workspace_members\" on \"mikka_workspace_members\".\"workspaceId\" = \"mikka_workspaces\".\"id\" left join \"mikka_organization_workspaces\" on \"mikka_organization_workspaces\".\"workspaceId\" = \"mikka_workspaces\".\"id\" where (\"mikka_workspace_members\".\"userId\" = $1 and \"mikka_workspace_members\".\"status\" = $2 and \"mikka_workspaces\".\"id\" = $3 and (\"mikka_workspaces\".\"kind\" = $4 or (\"mikka_workspaces\".\"kind\" = $5 and \"mikka_workspaces\".\"userId\" = $6))) order by \"mikka_workspaces\".\"createdAt\" asc"
let viewer: string | null = 'owner'
let requestHeaders = new Headers({cookie: 'synthetic-session'})
let sessionUser: string | null = null
let freshSession = true
function fixture() {
  const run = { id: runId, issueId, workspaceId, deviceRepoId:undefined as string|undefined, userId: 'owner', botId, status: 'running', stopRequestedAt: null as Date | null, prompt: 'Private thread', promptTaskStart: 0, promptTaskLength: Array.from('Private thread').length, report: null, error: null as string | null, questionContinuation: null as (typeof agentRuns.$inferSelect)['questionContinuation'], createdAt: new Date(), finishedAt: null, agentName: 'Owned Bot', harness: 'codex', ownerName: 'Owner' }
  return { factoryStages: new Map<string, string>(), controlReads: [] as unknown[][], questions: new Map<string, string>(), questionOwners: new Map<string, string>(), questionReads: [] as unknown[][], epochReads: [] as unknown[][], run, continuation: null as typeof run | null, members: new Set(['owner', 'member', botId]), messages: [] as Array<{ id: string; runId: string; userId: string; text: string }>, updates: 0, transactions: 0, ordinaryDispatches: 0, beforeLock: undefined as (() => void) | undefined, fault: undefined as Error | undefined, recovery: null as Record<string,unknown> | null, recoveryReads: 0, recoveryCalls: [] as Array<{actor:unknown;input:unknown}> }
}
let current = fixture()
const revisionFailures: unknown[] = []
afterEach(() => assert.deepEqual(revisionFailures.splice(0), [], 'Live revision SQL cannot fail silently in a source-only action test'))
class Selection {
  table: unknown
  condition?: SQL
  from(table: unknown) { this.table = table; return this }
  innerJoin() { return this }
  leftJoin() { return this }
  where(condition: SQL) { this.condition = condition; return this.table === issueMembers ? Promise.resolve(this.materialize()) : this }
  orderBy() { return this.table === runChunks || this.table === runMessages ? Promise.resolve(this.materialize()) : this }
  materialize(): unknown[] {
    if (this.table === issueMembers) return [...current.members].map(id => ({ id }))
    const query = this.condition && dialect.sqlToQuery(this.condition)
    if (this.table === agentRuns) {
      assert.ok(query)
      if (query.sql.includes('"agent_runs"."issueId"')) {
        assert.ok(query.params.includes(issueId), 'readable thread must bind the requested issue')
      } else {
        assert.match(query.sql, /"agent_runs"\."userId"/, 'owned-run reads bind the authenticated owner')
        if (!query.params.includes('owner')) return []
        assert.ok(query.sql.includes('"agent_runs"."userId"') && query.params.includes('owner') && [current.run, current.continuation].some(run => run && query.params.includes(run.id)), 'message snapshot must bind owner and run')
      }
      if (query.sql.includes('"agent_runs"."workspaceId"')) assert.ok(query.params.includes(workspaceId), 'thread reads bind the current tenant')
      if (current.continuation && query.params.includes(current.continuation.id)) {
        assert.ok(query.sql.includes('"agent_runs"."userId"') && query.params.includes('owner'), 'latest failure stays scoped to its owner')
        return [{ ...current.continuation }]
      }
      if (/"agent_runs"\."id"/.test(query.sql) && !query.params.includes(runId)) return []
      return [{ ...current.run }]
    }
    if (this.table === runChunks) return []
    if (this.table === runMessages) return current.messages.map(message => ({ ...message, at: new Date(), name: 'Owner', email: 'synthetic@example.invalid', image: null }))
    throw new Error('unexpected action read')
  }
  async limit(count: number) { return this.materialize().slice(0, count) }
}
const database = {
  insert(table:unknown) {assert.equal(table,runMessages);return {values:async(value:typeof current.messages[number])=>{current.messages.push(value)}}},
  select() { return new Selection() },
  async transaction(callback: (tx: unknown) => Promise<void>) {
    current.transactions++
    const selection = {
      from(table: unknown) { assert.equal(table, agentRuns); return selection },
      condition: undefined as SQL | undefined,
      where(condition: SQL) { selection.condition = condition; return selection },
      limit(count: number) { assert.equal(count, 1); return selection },
      async for(mode: string) {
        assert.equal(mode, 'update')
        current.beforeLock?.()
        if (current.fault) throw current.fault
        assert.ok(selection.condition)
        const query = dialect.sqlToQuery(selection.condition)
        assert.match(query.sql, /"agent_runs"\."id"/)
        assert.match(query.sql, /"agent_runs"\."userId"/)
        return query.params.includes(runId) && query.params.includes(current.run.userId) ? [{ ...current.run }] : []
      },
    }
    await callback({
      select: () => selection,
      insert(table: unknown) { assert.equal(table, runMessages); return { async values(value: typeof current.messages[number]) { current.messages.push(value) } } },
      update(table: unknown) { assert.equal(table, agentRuns); return { set(value: { stopRequestedAt: Date }) { return { async where(condition: SQL) {
        const query = dialect.sqlToQuery(condition)
        assert.ok(query.params.includes(runId) && query.params.includes('owner'))
        current.run.stopRequestedAt = value.stopRequestedAt; current.updates++
      } } } } },
    })
  },
}
// The fixture resolves only the owner's same-issue chain. A continuation stays
// below its root, as in the real recursive query; unrelated pool reads fail.
const chainRow = (run = current.run) => ({ rootRunId: current.run.id, runId: run.id, status: run.status, stopRequestedAt: run.stopRequestedAt, createdAt: run.createdAt, finishedAt: run.finishedAt, rootCreatedAt: current.run.createdAt })
const chainReads: string[] = []
async function runChainQuery(sql: string, params: unknown[]) {
  if (!/^\s*WITH RECURSIVE/.test(sql)) throw new Error('Unexpected SQL pool access outside thread control')
  if (/WHERE id = \$1::uuid AND "userId" = \$2/.test(sql)) { // readRunChain(runId, userId)
    chainReads.push('chain')
    return { rows: [current.run, current.continuation].some(run => run?.id === params[0]) && params[1] === current.run.userId ? [chainRow(), ...(current.continuation ? [chainRow(current.continuation)] : [])] : [] }
  }
  if (/r\."issueId" = \$1 AND r\."userId" = ANY\(\$2::text\[\]\)/.test(sql)) { // listIssueRunChains(issueId, userIds)
    chainReads.push('issue')
    return { rows: params[0] === current.run.issueId && (params[1] as string[]).includes(current.run.userId) ? [chainRow(), ...(current.continuation ? [chainRow(current.continuation)] : [])] : [] }
  }
  throw new Error('Unexpected run-chain SQL shape')
}
let actions: typeof import('../app/actions/agents')
before(async () => {
  // The receipt store has its own PostgreSQL coverage. This fixture models run controls.
  mock.module('@/lib/thread-reads', { namedExports: { threadReadReceipts: async () => [] } })
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async (input?: { query?: { disableCookieCache?: boolean } }) => {
    if (input?.query?.disableCookieCache && !freshSession) return null
    return viewer ? { user: { id: sessionUser ?? viewer }, session: { id: 'synthetic-session' } } : null
  } } } } })
  mock.module('next/headers', { namedExports: { headers: async () => requestHeaders } })
  mock.module('@/lib/db', { namedExports: { db: database, withDatabaseClient: () => { throw Error('Factory dispatch is outside thread-control fixture') }, pool: { async query(sql: string, params: unknown[]) {
    // These ordinary threads have no machine binding; still verify the scoped stop probe.
    if (sql === 'SELECT "workspaceId" FROM computer_run_bindings WHERE "runId"=$1 AND "ownerId"=$2') {
      assert.deepEqual(params, [current.run.id, current.run.userId])
      return { rows: [] }
    }
    // Running owner messages first check for a Factory target to advance.
    // These ordinary-thread fixtures have no Factory binding; keep the actual
    // epoch function in the call path and verify its owner/run constraints.
    if (sql.startsWith('SELECT t.id,t."botId",t."issueId" FROM factory_attempts a')) {
      assert.match(sql,/JOIN factory_tasks t ON t\.id=a\."taskId" WHERE a\."runId"=\$1 AND t\."userId"=\$2/)
      assert.deepEqual(params,[current.continuation?.id ?? current.run.id,current.run.userId])
      current.epochReads.push(params)
      return {rows:[]}
    }
    if (sql.includes('AS "independentCheck"')) {
      const liveId = current.continuation?.id ?? current.run.id
      assert.deepEqual(params, [liveId, 'owner', issueId], 'controls must bind the current run, owner and issue')
      assert.match(sql, /a\."runId"=r\.id AND a\.stage IN \('review','verify','monitor'\)/)
      assert.match(sql, /r\.id=\$1 AND r\."userId"=\$2 AND r\."issueId" IS NOT DISTINCT FROM \$3::uuid/)
      current.controlReads.push(params)
      return { rows: [{ independentCheck: ['review', 'verify', 'monitor'].includes(current.factoryStages.get(liveId) ?? '') }] }
    }
    // Run chains (BE-18) fold a resumed-question continuation into its thread; covered against real PG in
    // tests/run-chain.db.test.ts and lib/factory/questions/postgres.test.ts.
    if (/SELECT q.id AS "questionId"/.test(sql)) {
      current.recoveryReads++;
      assert.equal(params[0], 'owner'); assert.equal(params[2], issueId);
      assert.ok([current.run.id, current.continuation?.id].includes(params[1] as string));
      assert.equal(params[3],factoryEventId('question-recover',factoryEventId('question-owner-retry',params[1] as string)));
      assert.match(sql,/r\."userId"=\$1/);assert.match(sql,/q\."userId"=\$1/);assert.match(sql,/t\."userId"=\$1/);
      return {rows:current.recovery?[current.recovery]:[]};
    }
    // The thread's context usage (lib/context-usage.ts) counts characters in
    // SQL and returns no text, so it never re-sends the brief.
    if (sql.includes('AS "conversationAscii"')) {
      // The real query, so this fixture cannot silently drift from it.
      const { CONTEXT_CHARS_SQL } = await import('./context-usage')
      assert.equal(sql, CONTEXT_CHARS_SQL, 'the context read is the shipped query')
      assert.ok(sql.includes('ANY($1::uuid[])'), 'context reads bind the run chain')
      assert.equal(params[1], current.run.id, 'context reads the root brief')
      assert.ok((params[0] as string[]).includes(current.run.id))
      return { rows: [{ conversationAscii: 0, conversationOther: 0, messageAscii: 0, messageOther: 0,
        promptAscii: 14, promptOther: 0, taskAscii: 14, taskOther: 0, model: null }] }
    }
    if (!/FROM factory_questions/.test(sql)) return runChainQuery(sql, params)
    // Factory questions are the other pool read on the thread path (lib/issue-thread-questions.ts).
    current.questionReads.push(params)
    const [runIds, viewerId] = params as [string[], string]
    // Apply the owner predicates the query states: the question row's owner and its task's (the run owner's).
    const questionOwner = /q\."userId"=\$2/.test(sql), taskOwner = /t\."userId"=\$2/.test(sql)
    if(!Array.isArray(runIds))return {rows:[]}; // The ended ordinary thread has no Factory question.
    return { rows: runIds.filter(id => current.questions.has(id)
      && (!questionOwner || (current.questionOwners.get(id) ?? current.run.userId) === viewerId)
      && (!taskOwner || current.run.userId === viewerId)).map(id => ({ runId: id, status: current.questions.get(id) })) }
  } } } })
  // revision-read intentionally uses the request executor directly. Keep its
  // real key normalization/batching while replacing this otherwise live pool.
  mock.module('@/lib/db/request-scope', { namedExports: {
    inDatabaseTransaction: () => false,
    withoutDatabaseClient: (work: () => unknown) => work(),
    pool: { async query(sql: string, params: [string[], string[]]) {
      try {
        assert.equal(sql.replace(/\s+/g, ' ').trim(), 'SELECT r.kind, r.id::text AS id, r.revision FROM live_revisions r JOIN unnest($1::text[], $2::uuid[]) AS t(k, i) ON r.kind = t.k AND r.id = t.i')
        assert.deepEqual(params[0], ['run', 'thread'])
        assert.equal(params[1].length, 2); assert.equal(params[1][0], params[1][1])
        return { rows: params[0].flatMap((kind, index) => [current.run.id, current.continuation?.id].includes(params[1][index])
          ? [{ kind, id: params[1][index], revision: '7' }] : []) }
      } catch (error) { revisionFailures.push(error); throw error }
    } },
  } })
  mock.module('@/lib/workspace-db', { namedExports: {
    workspacePool: { query: () => { throw new Error('Unexpected raw workspace read') } },
    workspaceDb: { select: (projection?: Record<string, unknown>) => ({ from: (table: PgTable) => {
      let member: PgTable | undefined, organization: PgTable | undefined
      let memberJoin: SQL | undefined, organizationJoin: SQL | undefined
      const query = {
        innerJoin: (joined: PgTable, predicate: SQL) => {
          assert.equal(member, undefined); member = joined; memberJoin = predicate
          return query
        },
        leftJoin: (joined: PgTable, predicate: SQL) => {
          assert.ok(member); assert.equal(organization, undefined)
          organization = joined; organizationJoin = predicate
          return query
        },
        where: (condition: SQL) => {
          if (projection?.organizationId) {
            assert.deepEqual(Object.keys(projection), ['id', 'kind', 'organizationId'])
            assert.ok(member && organization && memberJoin && organizationJoin)
            const selected = new QueryBuilder().select(projection as SelectedFields).from(table)
              .innerJoin(member, memberJoin).leftJoin(organization, organizationJoin).where(condition)
            return { orderBy: async (order: SQL) => {
              const compiled = selected.orderBy(order).toSQL()
              let actualSql = compiled.sql
              // Expand only fixed aliases; compare every base table, column,
              // join, predicate and parameter against the original query.
              for (const [table, name] of [['mikka_workspaces', 'w'], ['mikka_workspace_members', 'm'], ['mikka_organization_workspaces', 'o']]) {
                actualSql = actualSql.replaceAll('"' + table + '" "' + name + '"', '"' + table + '"')
                  .replaceAll('"' + name + '".', '"' + table + '".')
              }
              assert.equal(actualSql, expectedMembershipSql)
              assert.deepEqual(compiled.params, [viewer, 'active', workspaceId, 'team', 'personal', viewer])
              // SQL NULL keeps the real Enterprise filter on the ordinary
              // Shared path; membership still follows this fixture's state.
              return current.members.has(String(viewer)) ? [{ id: workspaceId, kind: 'team', organizationId: null }] : []
            } }
          }
          const sql = dialect.sqlToQuery(condition)
          assert.ok(sql.params.includes(workspaceId)); assert.ok(sql.params.includes('active'))
          assert.ok(table === workspaceMembers || table === workspaces)
          assert.equal(member, undefined); assert.equal(organization, undefined)
          const rows = table === workspaceMembers ? [...current.members].map(id => ({ id }))
            : current.members.has(String(sql.params[0])) ? [{ id: workspaceId, kind: 'team' }] : []
          const result = Promise.resolve(rows)
          return Object.assign(result, { orderBy: () => result })
        },
      }
      return query
    } }) },
  } })
  mock.module('@/lib/workspace-access', { namedExports: { loadWorkspaceContext: async (requestedId: string | undefined, user: { id: string }) => {
    assert.equal(requestedId, undefined); assert.ok(current.members.has(user.id))
    return { workspace: { id: workspaceId, kind: 'team' } }
  } } })
  // Scope SQL and post-COMMIT delivery have real-PG coverage in live/panels.db.test.ts.
  // This action fixture retains the original ownership/chain checks before resolving keys.
  mock.module('@/lib/live/panels', { namedExports: {
    runChanged: async () => {},
    threadLiveReferences: async (_database: unknown, _workspace: unknown, ids: string[], ownerId: string) => {
      assert.equal(ownerId, 'owner')
      assert.ok(ids.every(id => [current.run.id, current.continuation?.id].includes(id)))
      return ids.map(id => ({ id, workspaceId: null }))
    },
    documentLiveWorkspace: async (_database: unknown, _workspace: unknown, id: string, ownerId: string) => {
      assert.equal(id, issueId); assert.equal(ownerId, 'owner'); return null
    },
  } })
  mock.module('@/lib/issue-access', { namedExports: {
    requireIssueAccess: async (id: string) => {
      if (!viewer) throw new ActionFailureError('authRequired')
      if (id !== issueId || !current.members.has(viewer)) throw new ActionFailureError('issueNotFound')
      return { issue: { id: issueId, userId: 'owner', workspaceId }, user: { id: viewer } }
    },
    issueForUser: () => { throw new Error('queue path outside test') },
  } })
  mock.module('@/lib/issue-visibility', { namedExports: { issueVisibility: () => { throw new Error('listing runs outside test') } } })
  mock.module('@/lib/ssh', { namedExports: { listSshHosts: () => { throw new Error('SSH outside test') } } })
  mock.module('@/lib/device-link', { namedExports: { DEVICE_ONLINE_WINDOW_MS: 0, hashDeviceToken: () => { throw new Error('device credentials outside test') }, newDeviceToken: () => { throw new Error('device credentials outside test') }, issueDeviceToken: () => { throw new Error('device credentials outside test') } } })
  mock.module('@/lib/coordinator/store', { namedExports: { citationSources: () => { throw new Error('citations outside test') } } })
  // The thread's quota view (lib/run-quota-view.ts) is covered against real Postgres in tests/run-quota.db.test.ts.
  mock.module('@/lib/run-quota-view', { namedExports: { threadQuotaView: async () => ({ switched: [], paused: null }), threadModelFallbackState: async () => ({ notices: [], pending: false }) } })
  mock.module('@/lib/thread-dispatch',{namedExports:{explicitNewThread:async()=>false,latestTaskRun:async()=>({id:current.continuation?.id ?? current.run.id}),dispatchToTask:async()=>{current.ordinaryDispatches++;return {thread:'continued',runId:'ordinary-next-run'}}}});
  mock.module('@/lib/factory/runtime',{namedExports:{factoryLifecycleEnabled:()=>true,guardFactoryClaim:async()=>({}),factoryAuthorize:async()=>true,factoryRuntimeForBot:(selectedBot:string|null)=>({questions:{recover:async(actor:unknown,input:unknown)=>{
    assert.equal(selectedBot,botId);current.recoveryCalls.push({actor,input});
    if (current.fault) throw current.fault;
    return {continuationRunId:'owner-recovery-run'};
  }}})}});
  actions = await import('../app/actions/agents')
})
const rejected = (code: string) => (error: unknown) => error instanceof ActionFailureError && error.code === code

test('actual thread actions preserve owner detail/Bot display and attribute an accepted message', async () => {
  current = fixture(); viewer = 'owner'
  const detail = await actions.getIssueThread(issueId, runId)
  assert.equal(detail.thread.detail?.agentName, 'Owned Bot')
  assert.deepEqual(detail.live?.revisions, { [`run:${runId}`]: 7, [`thread:${runId}`]: 7 })
  await actions.sendIssueThreadMessage({ issueId, runId, text: '  continue  ' })
  assert.deepEqual(current.messages.map(({ runId: run, userId, text }) => ({ run, userId, text })), [{ run: runId, userId: 'owner', text: 'continue' }])
  assert.equal(current.transactions, 1)
  assert.deepEqual(current.epochReads,[[runId,'owner']])
})

test('actual actions deny member/Bot-ID authority for content, messages and stop while retaining metadata', async () => {
  for (const identity of ['member', botId]) {
    current = fixture(); viewer = identity
    const [metadata] = await actions.listIssueThreads(issueId)
    assert.equal(metadata.detail, null); assert.equal(metadata.ownerName, 'Owner')
    await assert.rejects(actions.getIssueThread(issueId, runId), rejected('runNotFound'))
    await assert.rejects(actions.sendIssueThreadMessage({ issueId, runId, text: 'forged' }), rejected('runNotFound'))
    await assert.rejects(actions.stopRun(runId), rejected('runNotFound'))
    assert.equal(current.messages.length + current.updates, 0)
    assert.equal(current.epochReads.length,0,'a collaborator cannot reach the owner target probe')
  }
})

test('actual thread actions refuse revoked collaborators before sending or returning detail', async () => {
  current = fixture(); viewer = 'owner'; current.members.delete('owner')
  await assert.rejects(actions.getIssueThread(issueId, runId), rejected('issueNotFound'))
  await assert.rejects(actions.sendIssueThreadMessage({ issueId, runId, text: 'revoked' }), rejected('issueNotFound'))
  assert.equal(current.transactions, 0); assert.equal(current.messages.length, 0)
})

test('actual send rechecks completion after the first readable-thread snapshot', async () => {
  current = fixture(); viewer = 'owner'
  current.beforeLock = () => { current.run.status = 'succeeded' }
  await assert.rejects(actions.sendIssueThreadMessage({ issueId, runId, text: 'late' }), rejected('runNotFound'))
  assert.equal(current.transactions, 1); assert.equal(current.messages.length, 0)
})

test('actual stop action is idempotent for the owner and rejects ended/stopping sends', async () => {
  current = fixture(); viewer = 'owner'; chainReads.length = 0
  assert.deepEqual(await actions.stopRun(runId), { stoppedRunIds: [runId] })
  assert.ok(chainReads.includes('chain'), 'stop resolves the run chain first')
  const stoppedAt = current.run.stopRequestedAt
  assert.ok(stoppedAt instanceof Date)
  const detail = await actions.getIssueThread(issueId, runId)
  assert.equal(detail.thread.stopping, true)
  assert.equal(detail.thread.stopRequestedAt, stoppedAt)
  const [listed] = await actions.listIssueThreads(issueId)
  assert.equal(listed.stopping, true)
  assert.deepEqual(await actions.stopRun(runId), { stoppedRunIds: [runId] })
  assert.equal(current.run.stopRequestedAt, stoppedAt); assert.equal(current.updates, 1)
  await assert.rejects(actions.sendIssueThreadMessage({ issueId, runId, text: 'after stop' }), rejected('runNotFound'))
  current.run.status = 'succeeded'
  assert.equal((await actions.getIssueThread(issueId, runId)).thread.stopping, false)
  // BE-18: an owned chain with nothing unfinished is a 409 runChainEnded with latestRunId, not a silent no-op.
  await assert.rejects(actions.stopRun(runId), (error: unknown) => error instanceof ActionFailureError && error.code === 'runChainEnded' && (error.params as { latestRunId?: string } | undefined)?.latestRunId === runId)
  assert.equal(current.messages.length, 0); assert.equal(current.updates, 1)
})

test('actual actions preserve auth/validation and unknown database failures without writes', async () => {
  current = fixture(); viewer = null
  await assert.rejects(actions.stopRun(runId), rejected('authRequired'))
  viewer = 'owner'
  await assert.rejects(actions.stopRun('invalid'), rejected('runNotFound'))
  await assert.rejects(actions.sendIssueThreadMessage({ issueId, runId, text: ' ' }), rejected('messageRequired'))
  const fault = new Error('synthetic lock failure'); current.fault = fault
  await assert.rejects(actions.stopRun(runId), error => error === fault)
  await assert.rejects(actions.sendIssueThreadMessage({ issueId, runId, text: 'retry' }), error => error === fault)
  assert.equal(current.messages.length + current.updates, 0)
})


test('running UI messages require a fresh matching browser session without an API identity', async () => {
  try {
    for (const mode of ['no-cookie', 'authorization', 'expired', 'other-user']) {
      current = fixture(); viewer = 'owner'
      requestHeaders = new Headers(mode === 'no-cookie' ? {} : {cookie: 'synthetic-session'})
      if (mode === 'authorization') requestHeaders.set('authorization', 'Bearer synthetic')
      freshSession = mode !== 'expired'
      sessionUser = mode === 'other-user' ? 'other' : null
      await assert.rejects(actions.sendIssueThreadMessage({issueId, runId, text: 'Must remain unsent'}), rejected('authRequired'))
      assert.equal(current.transactions, 0); assert.equal(current.messages.length, 0)
    }
  } finally {
    requestHeaders = new Headers({cookie: 'synthetic-session'}); sessionUser = null; freshSession = true
  }
})

test('a question reaches only its owner, only on an ended run, and only behind the Factory flags', async () => {
  const flags = { routing: process.env.MIKKA_FACTORY_ROUTING_ENABLED, lifecycle: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED }
  const restore = () => {
    for (const [key, value] of [['MIKKA_FACTORY_ROUTING_ENABLED', flags.routing], ['MIKKA_FACTORY_LIFECYCLE_ENABLED', flags.lifecycle]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
  try {
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = '1'; process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
    current = fixture(); viewer = 'owner'; current.run.status = 'succeeded'; current.questions.set(runId, 'waiting_user')
    assert.equal((await actions.getIssueThread(issueId, runId)).thread.question, 'waiting')
    assert.equal((await actions.listIssueThreads(issueId))[0].question, 'waiting')
    current.questions.set(runId, 'resuming')
    assert.equal((await actions.getIssueThread(issueId, runId)).thread.question, 'resuming')

    // A question row owned by someone else never surfaces on the viewer's own run.
    current = fixture(); viewer = 'owner'; current.run.status = 'succeeded'; current.questions.set(runId, 'waiting_user'); current.questionOwners.set(runId, 'member')
    assert.equal((await actions.getIssueThread(issueId, runId)).thread.question, null)
    assert.equal((await actions.listIssueThreads(issueId))[0].question, null)
    assert.equal(current.questionReads.length, 2)

    // A live run is already answering: no question, and no read for one.
    current = fixture(); viewer = 'owner'; current.questions.set(runId, 'waiting_user')
    assert.equal((await actions.getIssueThread(issueId, runId)).thread.question, null)
    assert.equal(current.questionReads.length, 0)

    // A teammate sees the row, never the question.
    current = fixture(); viewer = 'member'; current.run.status = 'succeeded'; current.questions.set(runId, 'waiting_user')
    const [listed] = await actions.listIssueThreads(issueId)
    assert.equal(listed.question, null); assert.equal(listed.detail, null)
    assert.equal(current.questionReads.length, 0)

    // Routing on but lifecycle off: no question, and the store is never asked.
    process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '0'
    current = fixture(); viewer = 'owner'; current.run.status = 'succeeded'; current.questions.set(runId, 'waiting_user')
    assert.equal((await actions.getIssueThread(issueId, runId)).thread.question, null)
    assert.equal((await actions.listIssueThreads(issueId))[0].question, null)
    assert.equal(current.questionReads.length, 0)

    // Flags off: no question, and the store is never asked.
    process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = '0'
    current = fixture(); viewer = 'owner'; current.run.status = 'succeeded'; current.questions.set(runId, 'waiting_user')
    assert.equal((await actions.getIssueThread(issueId, runId)).thread.question, null)
    assert.equal((await actions.listIssueThreads(issueId))[0].question, null)
    assert.equal(current.questionReads.length, 0)
  } finally { restore() }
})

test('the composer send returns a refusal as its code and still throws unknown failures', async () => {
  current = fixture(); viewer = 'owner'
  assert.deepEqual(await actions.sendIssueThreadReply({ issueId, runId, text: 'go on' }), { sent: true,runId,continued:false })
  current = fixture(); viewer = 'member'
  assert.equal((await actions.sendIssueThreadReply({ issueId, runId, text: 'forged' })).error, 'runNotFound')
  current = fixture(); viewer = 'owner'
  assert.equal((await actions.sendIssueThreadReply({ issueId, runId, text: ' ' })).error, 'messageRequired')
  const fault = new Error('synthetic lock failure'); current.fault = fault
  await assert.rejects(actions.sendIssueThreadReply({ issueId, runId, text: 'retry' }), error => error === fault)
})

const recoveryRow=()=>({questionId:'31300000-0000-4000-8000-000000000010',botId,continuationRunId:runId,questionStatus:'blocked',taskStatus:'blocked',runStatus:'failed',questionRevision:13,originRunId:'31300000-0000-4000-8000-000000000011',originSessionId:'original-sdk-session',binding:{taskId:'31300000-0000-4000-8000-000000000012',issueId,attemptId:'31300000-0000-4000-8000-000000000013',revision:13,candidateId:null},recoveryRequest:null});
test('only the explicit owner Retry intent recovers a blocked original-session question with a stable request',async()=>{
  current=fixture();viewer='owner';current.run.status='failed';current.recovery=recoveryRow();
  const result=await actions.sendIssueThreadReply({issueId,runId,text:'Arbitrary translated button label',retryOriginalSession:true});
  assert.deepEqual(result,{sent:true,runId:'owner-recovery-run',continued:true});
  assert.equal(current.recoveryCalls.length,1);assert.equal(current.messages.length,0);
  assert.equal(current.epochReads.length,0,'explicit native-question recovery must not create a new owner target')
  const first=current.recoveryCalls[0];
  assert.deepEqual(first.actor,{source:'human',userId:'owner',sessionId:'synthetic-session'});
  const expected={requestId:factoryEventId('question-owner-retry',runId),expectedFailedRunId:runId,reference:{questionId:current.recovery.questionId,questionRevision:13,binding:current.recovery.binding,originRunId:current.recovery.originRunId,originSessionId:current.recovery.originSessionId}};
  assert.deepEqual(first.input,expected);
  current.recovery={...recoveryRow(),questionStatus:'resuming',taskStatus:'running',questionRevision:14,recoveryRequest:{kind:'question_recover',userId:'owner',input:expected}};
  assert.deepEqual(await actions.sendIssueThreadReply({issueId,runId,text:'Another label',retryOriginalSession:true}),result);
  assert.deepEqual(current.recoveryCalls[1].input,expected,'transport/click replay must retain the old reference');
});
test('owner Retry reports original-session recovery failure without claiming its task is missing', async () => {
  current=fixture();viewer='owner';current.run.status='failed';current.recovery=recoveryRow();
  current.fault=new FactoryError('factoryQuestionContinuationUnavailable');
  assert.deepEqual(await actions.sendIssueThreadReply({issueId,runId,text:'Retry',retryOriginalSession:true}),{error:'threadRecoveryUnavailable',params:undefined});
  assert.equal(current.recoveryCalls.length,1);
  assert.equal(current.ordinaryDispatches,0);assert.equal(current.messages.length,0);
  current.fault=new FactoryError('factoryNotFound');
  assert.equal((await actions.sendIssueThreadReply({issueId,runId,text:'Retry',retryOriginalSession:true})).error,'runNotFound');
  const unexpected=new Error('unexpected synthetic failure');current.fault=unexpected;
  await assert.rejects(actions.sendIssueThreadReply({issueId,runId,text:'Retry',retryOriginalSession:true}),error=>error===unexpected);
});
test('typed Retry text is ordinary messaging, and explicit retry never grants a collaborator or API actor authority',async()=>{
  current=fixture();viewer='owner';current.recovery=recoveryRow();
  await actions.sendIssueThreadReply({issueId,runId,text:'Retry'});
  assert.equal(current.recoveryReads,0);assert.equal(current.recoveryCalls.length,0);assert.equal(current.messages.length,1);
  assert.deepEqual(current.epochReads,[[runId,'owner']])
  for(const mode of ['member','api','expired']) {
    current=fixture();current.run.status='failed';current.recovery=recoveryRow();viewer=mode==='member'?'member':'owner';
    if(mode==='api')requestHeaders=new Headers({cookie:'synthetic-session',authorization:'Bearer synthetic'});
    if(mode==='expired')freshSession=false;
    try { const result=await actions.sendIssueThreadReply({issueId,runId,text:'Retry',retryOriginalSession:true});assert.ok(result.error);assert.equal(current.recoveryReads,0);assert.equal(current.recoveryCalls.length,0); }
    finally {requestHeaders=new Headers({cookie:'synthetic-session'});freshSession=true;viewer='owner';}
  }
});
test('an explicit retry with a stale strict question never falls back to ordinary messaging',async()=>{
  current=fixture();viewer='owner';current.run.status='failed';current.recovery={...recoveryRow(),questionStatus:'resuming',taskStatus:'running'};
  assert.equal((await actions.sendIssueThreadReply({issueId,runId,text:'Retry',retryOriginalSession:true})).error,'threadCannotContinue');
  assert.equal(current.recoveryCalls.length,0);assert.equal(current.messages.length,0);
  current.recovery={...recoveryRow(),continuationRunId:'another-failed-run'};
  assert.equal((await actions.sendIssueThreadReply({issueId,runId,text:'Retry',retryOriginalSession:true})).error,'threadCannotContinue');
  assert.equal(current.recoveryCalls.length,0);assert.equal(current.messages.length,0);
});

test('the existing Retry on an ordinary failed run retains the ordinary continuation path',async()=>{
  current=fixture();viewer='owner';current.run.status='failed';current.run.deviceRepoId='31300000-0000-4000-8000-000000000020';
  assert.deepEqual(await actions.sendIssueThreadReply({issueId,runId,text:'Retry',retryOriginalSession:true}),{sent:true,runId:'ordinary-next-run',continued:true});
  assert.equal(current.recoveryReads,1);assert.equal(current.recoveryCalls.length,0);
  assert.deepEqual(current.messages.map(message=>({runId:message.runId,text:message.text})),[{runId:'ordinary-next-run',text:'Retry'}]);
});

const failedRunId = '31300000-0000-4000-8000-000000000030'
function strictContinuation(status = 'failed') {
  current.run.status = 'stopped'
  current.continuation = { ...current.run, id: failedRunId, status, deviceRepoId: '31300000-0000-4000-8000-000000000020',
    error: 'Codex subscription execution failed', createdAt: new Date(current.run.createdAt.getTime() + 1),
    questionContinuation: { questionId: recoveryRow().questionId as string, originRunId: runId, originSessionId: 'original-sdk-session', followUp: 'Existing answer', requireSessionResume: true } }
}

test('ordinary text on a failed strict continuation cannot start another task or discard its original session', async () => {
  current = fixture(); viewer = 'owner'; strictContinuation()
  // The owner opened the original thread, while the failure belongs to its latest attempt.
  for (const text of ['Retry', '重试', 'Continue the task.']) {
    assert.equal((await actions.sendIssueThreadReply({ issueId, runId, text })).error, 'threadCannotContinue')
  }
  assert.equal(current.ordinaryDispatches, 0)
  assert.equal(current.recoveryCalls.length, 0)
  assert.equal(current.messages.length, 0)
})

test('successful strict continuations still accept new owner work through ordinary continuation', async () => {
  current = fixture(); viewer = 'owner'; strictContinuation('succeeded')
  assert.deepEqual(await actions.sendIssueThreadReply({ issueId, runId, text: 'Add the next requirement.' }), { sent: true, runId: 'ordinary-next-run', continued: true })
  assert.equal(current.ordinaryDispatches, 1)
  assert.equal(current.recoveryCalls.length, 0)
})

test('opening the root thread exposes its latest failed attempt error without changing root identity', async () => {
  current = fixture(); viewer = 'owner'; strictContinuation()
  const detail = await actions.getIssueThread(issueId, runId)
  assert.equal(detail.thread.id, runId)
  assert.equal(detail.thread.rootRunId, runId)
  assert.equal(detail.thread.latestRunId, failedRunId)
  assert.equal(detail.thread.status, 'stopped', 'root status remains historical metadata')
  assert.equal(detail.thread.continuation?.status, 'failed')
  assert.equal(detail.thread.error, 'Codex subscription execution failed')
  assert.equal(detail.thread.prompt, 'Private thread')
})

test('an earlier attempt failure does not remain the current error after a continuation starts or succeeds', async () => {
  for (const status of ['running', 'succeeded']) {
    current = fixture(); viewer = 'owner'; strictContinuation(status)
    current.run.status = 'failed'; current.run.error = 'Historical failure'
    assert.equal((await actions.getIssueThread(issueId, runId)).thread.error, null)
  }
})


test('thread controls use host Factory check bindings even when the failed run has no report', async () => {
  for (const stage of ['review', 'verify', 'monitor']) {
    current = fixture(); viewer = 'owner'; current.run.status = 'failed'; current.factoryStages.set(runId, stage)
    const { thread } = await actions.getIssueThread(issueId, runId)
    assert.equal(thread.retryAvailable, false, `${stage} must not offer ordinary Retry`)
    assert.equal(thread.replyAvailable, false, `${stage} cannot continue as execution`)
    assert.deepEqual(current.controlReads, [[runId, 'owner', issueId]])
    assert.equal(current.recoveryCalls.length + current.ordinaryDispatches, 0, 'a projection must not dispatch')
  }
})

test('producer and ordinary failed threads keep their existing Retry and reply controls', async () => {
  for (const stage of [null, 'execute']) {
    current = fixture(); viewer = 'owner'; current.run.status = 'failed'
    if (stage) current.factoryStages.set(runId, stage)
    const { thread } = await actions.getIssueThread(issueId, runId)
    assert.equal(thread.retryAvailable, true)
    assert.equal(thread.replyAvailable, true)
    assert.equal(current.recoveryReads, 0, 'ordinary controls do not acquire question recovery')
  }
})

test('an independent check retains strict question Retry without enabling ordinary Send', async () => {
  current = fixture(); viewer = 'owner'; current.run.status = 'failed'; current.factoryStages.set(runId, 'review')
  current.recovery = recoveryRow()
  let detail = await actions.getIssueThread(issueId, runId)
  assert.equal(detail.thread.retryAvailable, true)
  assert.equal(detail.thread.replyAvailable, false)
  current.recovery = { ...recoveryRow(), questionStatus: 'resuming', taskStatus: 'running' }
  assert.equal((await actions.getIssueThread(issueId, runId)).thread.retryAvailable, false, 'stale blocked state is not recovery authority')
  current.recovery = { ...recoveryRow(), continuationRunId: 'another-run' }
  assert.equal((await actions.getIssueThread(issueId, runId)).thread.retryAvailable, false, 'another continuation cannot enable this control')
  current.recovery = { ...recoveryRow(), questionStatus: 'resuming', taskStatus: 'running', recoveryRequest: { kind: 'question_recover' } }
  detail = await actions.getIssueThread(issueId, runId)
  assert.equal(detail.thread.retryAvailable, true, 'the existing durable receipt remains replayable')
  assert.equal(detail.thread.replyAvailable, false)
  assert.equal(current.recoveryCalls.length + current.ordinaryDispatches, 0)
})

test('current check questions and running checks retain their existing message path', async () => {
  const routing = process.env.MIKKA_FACTORY_ROUTING_ENABLED, lifecycle = process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED
  try {
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = '1'; process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
    current = fixture(); viewer = 'owner'; current.run.status = 'stopped'; current.factoryStages.set(runId, 'verify'); current.questions.set(runId, 'waiting_user')
    const waiting = await actions.getIssueThread(issueId, runId)
    assert.equal(waiting.thread.question, 'waiting')
    assert.equal(waiting.thread.replyAvailable, true, 'the composer must still answer the current question')
    assert.equal(waiting.thread.retryAvailable, false)
    current = fixture(); viewer = 'owner'; current.factoryStages.set(runId, 'monitor')
    const working = await actions.getIssueThread(issueId, runId)
    assert.equal(working.thread.replyAvailable, true, 'active checks retain mailbox messages')
    assert.equal(working.thread.retryAvailable, false)
    assert.deepEqual(current.controlReads, [], 'an active run needs no continuation probe')
  } finally {
    if (routing === undefined) delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; else process.env.MIKKA_FACTORY_ROUTING_ENABLED = routing
    if (lifecycle === undefined) delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED; else process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = lifecycle
  }
})

test('thread controls follow the latest attempt binding rather than the opened root stage', async () => {
  current = fixture(); viewer = 'owner'; strictContinuation()
  current.factoryStages.set(runId, 'execute'); current.factoryStages.set(failedRunId, 'review')
  let detail = await actions.getIssueThread(issueId, runId)
  assert.equal(detail.thread.retryAvailable, false)
  assert.equal(detail.thread.replyAvailable, false)
  assert.deepEqual(current.controlReads, [[failedRunId, 'owner', issueId]])
  current.factoryStages.set(runId, 'review'); current.factoryStages.set(failedRunId, 'execute')
  current.continuation!.questionContinuation = null
  detail = await actions.getIssueThread(issueId, runId)
  assert.equal(detail.thread.retryAvailable, true)
  assert.equal(detail.thread.replyAvailable, true)
})
