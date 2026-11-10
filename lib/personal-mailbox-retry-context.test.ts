import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { agentRuns, agents, deviceRepos, devices } from './db/schema'
import { workspaceMembers, workspaces } from './db/workspace-schema'
import { organizationWorkspaces } from './db/governance-schema'
import { remoteKey } from '@mikka/protocol/repository'

// Exercise the actual infrastructure-retry writer with controlled persistence.
// No PostgreSQL, credentials, models or network calls are used.
const botId = '28700000-0000-4000-8000-000000000011'
const workspaceId = '28700000-0000-4000-8000-000000000012'
const repository = { remoteUrl: 'https://github.com/synthetic/fixture.git', repoPath: remoteKey('https://github.com/synthetic/fixture.git') }
const now = new Date('2026-11-06T00:00:00.000Z')
let observedAt = now.getTime()
let scenario: 'retry' | 'queued' = 'retry'
const lost = { id: '28700000-0000-4000-8000-000000000041', userId: 'synthetic-owner', botId, workspaceId,
  agentId: 'agent', deviceId: 'device', deviceRepoId: 'repository', issueId: 'issue',
  status: 'running', kind: 'implement', prompt: 'Already authorized task', baseBranch: 'main',
  attempt: 1, stopRequestedAt: null, leaseExpiresAt: new Date(0) }
let inserted: Record<string, unknown> | undefined
let transactions = 0
let workspaceTransactions = 0, resourceLocked = false, resourceReads = 0
const dialect = new PgDialect()
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()
function queryOf(statement: SQL) {
  const query = dialect.sqlToQuery(statement)
  return { ...query, sql: normalize(query.sql) }
}
const events: { botId?: string | null }[] = [], revoked: string[] = []
const tx = {
  execute: async () => { throw Error('Unexpected transactional SQL in legacy retry fixture') },
  update(table: unknown) { assert.equal(table, agentRuns); return { set() { return { where() { return { returning: async () => [{ id: lost.id }] } } } } } },
  insert(table: unknown) { assert.equal(table, agentRuns); return { values: async (value: Record<string, unknown>) => { inserted = value } } },
}
const database = {
  execute: async (statement: SQL) => {
    const query = queryOf(statement)
    assert.deepEqual(query.params, [lost.id, lost.userId])
    assert.ok(resourceLocked, 'recovery reads hold the live resource lease')
    assert.ok([
      'select b."workspaceId",m."sandboxId",m."operationId",m."deviceId",m."repoId" from computer_run_bindings b left join thread_machines m on m."runId"=b."runId" and m."ownerId"=b."ownerId" and m."workspaceId"=b."workspaceId" where b."runId"=$1 and b."ownerId"=$2',
      'select 1 from computer_run_bindings where "runId"=$1 and "ownerId"=$2',
    ].includes(query.sql), `Unexpected recovery SQL: ${query.sql}`)
    return { rows: [] }
  },
  select(fields?: Record<string, unknown>) {
    let table: unknown, condition: SQL
    const selection = {
      from(value: unknown) { table = value; return selection }, where(value: SQL) { condition = value; return selection }, innerJoin(value: unknown) { assert.equal(value, devices); return selection },
      limit: async () => {
        const params = queryOf(condition).params
        if (table === agentRuns) {
          assert.ok(params.includes(lost.userId))
          if (!fields) return scenario === 'retry' ? [lost] : []
          assert.ok('run' in fields && 'lastSeenAt' in fields, 'only the stranded retry projection is expected')
          if (scenario === 'queued') {
            await Promise.resolve()
            observedAt = now.getTime() + 20
            return [{ run: { ...lost, status: 'queued', retryOf: 'previous-attempt' }, lastSeenAt: new Date(observedAt) }]
          }
          return []
        }
        assert.ok(resourceLocked)
        if (table === deviceRepos) { assert.deepEqual(params, [lost.deviceRepoId]); return [repository] }
        assert.equal(table, agents, 'unexpected recovery table')
        assert.deepEqual(params, [lost.agentId]); return [{ harness: 'codex' }]
      },
      // A run only retries where a machine can take it: one online server with Codex (允许自动调度 on by default).
      orderBy: async () => {
        assert.equal(table, devices)
        const params = queryOf(condition).params
        assert.ok(params.includes(lost.userId) && params.includes(true) && params.includes('local'))
        assert.equal(scenario, 'retry', 'a device that heartbeats during the read must keep its queued run')
        await Promise.resolve()
        observedAt = now.getTime() + 20
        return [{ deviceId: 'other-device', lastSeenAt: new Date(observedAt), harnesses: [{ harness: 'codex', installed: true }], deviceType: 'server', autoSchedule: null }]
      },
    }
    return selection
  },
  transaction: async (fn: (transaction: typeof tx) => Promise<unknown>) => {
    assert.ok(resourceLocked && workspaceTransactions > 0, 'the retry APP write must remain inside the resource and membership lease')
    transactions++; return fn(tx)
  },
}
mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { withDatabaseClient: () => { throw Error('Unexpected device completion transaction in legacy retry fixture') }, db: database, pool: { query: async (statement: string, params: unknown[]) => {
  assert.ok(resourceLocked, 'both source and replacement repository checks hold the lease')
  if (normalize(statement) === 'SELECT r."botId",r."workspaceId",r.harness,r."agentId",r."repoId",a."deviceId" FROM bot_cloud_runtimes r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."ownerId" WHERE r."ownerId"=$1 AND r."botId"=$2 AND a."deviceId" IS NOT NULL AND (EXISTS (SELECT 1 FROM user_e2b_keys uk WHERE uk."userId"=r."ownerId") OR EXISTS (SELECT 1 FROM workspace_e2b_keys wk WHERE wk."createdBy"=r."ownerId")) ORDER BY (r.harness=$3) DESC NULLS LAST LIMIT 1') {
    assert.deepEqual(params, [lost.userId, botId, null])
    return { rows: [] }
  }
  assert.equal(normalize(statement), 'SELECT repo."repoPath",repo."remoteUrl",device.kind,agent.harness FROM device_repos repo JOIN devices device ON device.id=repo."deviceId" AND device."ownerId"=repo."userId" JOIN agents agent ON agent.id=$4 AND agent."userId"=repo."userId" WHERE repo.id=$1 AND repo."userId"=$2 AND repo."deviceId"=$3 FOR SHARE OF repo,device,agent')
  assert.deepEqual(params, resourceReads++ === 0
    ? [lost.deviceRepoId, lost.userId, lost.deviceId, lost.agentId]
    : ['other-repository', lost.userId, 'other-device', lost.agentId])
  return { rows: [{ ...repository, kind: 'local', harness: 'codex' }] }
} } } })
// Keep the actual Workspace and Project admission code. Only its persistence is
// synthetic; every SQL statement is checked and no unknown query is allowed.
const workspaceTx = {
  select() {
    let table: unknown, condition: SQL
    const selection = {
      from(value: unknown) { table = value; return selection },
      leftJoin(value: unknown, on: SQL) {
        assert.equal(table, workspaceMembers)
        assert.equal(value, organizationWorkspaces)
        assert.deepEqual(queryOf(on), {
          sql: '"mikka_organization_workspaces"."workspaceId" = "mikka_workspace_members"."workspaceId"',
          params: [],
        })
        return selection
      },
      where(value: SQL) { condition = value; return selection },
      for: async (lock: string) => {
        assert.equal(lock, 'share')
        assert.ok(workspaceTransactions > 0)
        const params = queryOf(condition).params
        if (table === workspaces) {
          assert.deepEqual(params, [workspaceId])
          return [{ id: workspaceId, kind: 'personal', ownerId: lost.userId }]
        }
        assert.equal(table, workspaceMembers)
        assert.deepEqual(params, [workspaceId, lost.userId, 'active'])
        return [{ id: lost.userId, organizationId: null }]
      },
    }
    return selection
  },
  execute: async (statement: SQL) => {
    const query = queryOf(statement)
    assert.ok(workspaceTransactions > 0)
    if (query.sql === "select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))") {
      assert.deepEqual(query.params, []); return { rows: [] }
    }
    if (query.sql === 'select pg_advisory_xact_lock_shared(hashtextextended($1,0))') {
      assert.deepEqual(query.params, ['project-resources:' + workspaceId])
      resourceLocked = true; return { rows: [] }
    }
    assert.ok(resourceLocked)
    if (query.sql === 'select mode,"repositoryKeys",revision from workspace_repository_policies where "workspaceId"=$1') {
      assert.deepEqual(query.params, [workspaceId]); return { rows: [] }
    }
    assert.equal(query.sql, 'select p.id,p.revision,p."archivedAt" from workspace_project_tasks t join workspace_projects p on p.id=t."projectId" and p."workspaceId"=t."workspaceId" where t."issueId"=$1 and t."workspaceId"=$2')
    assert.deepEqual(query.params, [lost.issueId, workspaceId]); return { rows: [] }
  },
}
mock.module(new URL('./workspace-db.ts', import.meta.url).href, { namedExports: {
  workspaceDb: { transaction: async (work: (transaction: typeof workspaceTx) => Promise<unknown>) => {
    const priorLock = resourceLocked
    workspaceTransactions++
    try { return await work(workspaceTx) } finally { workspaceTransactions--; resourceLocked = priorLock }
  } },
  workspacePool: { query: () => { throw Error('Unexpected raw workspace query in legacy retry fixture') } },
} })
mock.module(new URL('./coordinator-event-store.ts', import.meta.url).href, { namedExports: {
  recordCoordinatorEvent: async (_tx: unknown, event: { botId?: string | null }) => { events.push(event) },
} })
mock.module(new URL('./coordinator/wake.ts', import.meta.url).href, { namedExports: { wakeCoordinator: () => { throw Error('Unexpected wake') } } })
mock.module(new URL('./mcp/worker.ts', import.meta.url).href, { namedExports: { revokeRunTokens: async (id: string) => { revoked.push(id) } } })
mock.module(new URL('./device-repositories.ts', import.meta.url).href, { namedExports: { ensureDeviceRepository: async (owner: string, device: string, remote: string) => {
  assert.deepEqual([owner, device, remote], [lost.userId, 'other-device', repository.remoteUrl])
  return { id: 'other-repository' }
} } })
// The writer must schedule its exact committed source for downstream cleanup;
// recording storage and Factory reconciliation have separate persistence tests.
const stopRecordings = mock.fn((ids: string[]) => {
  assert.deepEqual(ids, [lost.id]); assert.ok(inserted); assert.deepEqual(revoked, [lost.id])
})
const afterEnded = mock.fn(async (userId: string, runId: string) => {
  assert.deepEqual([userId, runId], [lost.userId, lost.id]); assert.ok(inserted)
  assert.deepEqual(revoked, [lost.id]); assert.equal(stopRecordings.mock.callCount(), 1)
  return 0
})
mock.module(new URL('./captures/run-end.ts', import.meta.url).href, { namedExports: { stopRecordingsAfter: stopRecordings } })
mock.module(new URL('./run-completion-effects.ts', import.meta.url).href, { namedExports: { afterRunEnded: afterEnded } })
// This fixture covers the legacy private-mailbox writer. Admitted repository
// recovery has real database coverage and must never run for this legacy row.
const readmit = mock.fn(async () => { throw Error('Unexpected repository admission for legacy mailbox retry') })
mock.module(new URL('./run-repository-retry.ts', import.meta.url).href, { namedExports: { readmitLostLocalRun: readmit } })
const recoveryHandoff = mock.fn(async (_pool: unknown, identity: unknown, prompt: string) => {
  assert.equal(identity, lost)
  return { prompt, briefing: '' }
})
mock.module(new URL('./factory/handoff.ts', import.meta.url).href, { namedExports: { factoryRecoveryHandoff: recoveryHandoff } })

test('actual reclaim writer keeps the trusted private Bot when the target heartbeats after the lease snapshot', async t => {
  t.mock.method(Date, 'now', () => observedAt)
  const { reclaimLostRuns } = await import('./run-leases')
  // The async device query advances the observation clock after the immutable
  // lease cutoff. The new heartbeat is current when read, not in the future.
  await reclaimLostRuns(lost.userId, now)
  assert.ok(inserted)
  assert.equal(recoveryHandoff.mock.callCount(), 1)
  assert.equal(readmit.mock.callCount(), 0)
  assert.equal(inserted.botId, botId)
  assert.equal(inserted.userId, lost.userId)
  assert.equal(inserted.retryOf, lost.id)
  assert.equal(inserted.attempt, 2)
  assert.equal(inserted.status, 'queued')
  assert.equal(inserted.deviceId, 'other-device')
  assert.deepEqual(revoked, [lost.id])
  assert.equal(events[0].botId, botId)
  assert.equal(afterEnded.mock.callCount(), 1)
  assert.equal(resourceReads, 2, 'the original and replacement repository both pass real admission')
  assert.equal(resourceLocked, false)
  assert.equal(workspaceTransactions, 0)
})

test('a heartbeat arriving during the queued-run query prevents migration or finalization', async t => {
  scenario = 'queued'
  observedAt = now.getTime()
  transactions = 0
  inserted = undefined
  events.length = 0
  revoked.length = 0
  stopRecordings.mock.resetCalls()
  afterEnded.mock.resetCalls()
  t.mock.method(Date, 'now', () => observedAt)
  const { reclaimLostRuns } = await import('./run-leases')
  await reclaimLostRuns(lost.userId, now)
  assert.ok(observedAt > now.getTime(), 'the heartbeat arrived after the lease snapshot')
  assert.equal(transactions, 0)
  assert.equal(inserted, undefined)
  assert.deepEqual(events, [])
  assert.deepEqual(revoked, [])
  assert.equal(stopRecordings.mock.callCount(), 0)
  assert.equal(afterEnded.mock.callCount(), 0)
})
