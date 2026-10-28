import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { ActionFailureError } from './action-error'
import { agentRuns, issueMembers, runChunks, runMessages } from './db/schema'

const runId = '31300000-0000-4000-8000-000000000001'
const issueId = '31300000-0000-4000-8000-000000000002'
const botId = '31300000-0000-4000-8000-000000000003'
const dialect = new PgDialect()
let viewer: string | null = 'owner'
function fixture() {
  const run = { id: runId, issueId, userId: 'owner', botId, status: 'running', stopRequestedAt: null as Date | null, prompt: 'Private thread', report: null, error: null, createdAt: new Date(), finishedAt: null, agentName: 'Owned Bot', harness: 'codex', ownerName: 'Owner' }
  return { run, members: new Set(['owner', 'member', botId]), messages: [] as Array<{ id: string; runId: string; userId: string; text: string }>, updates: 0, transactions: 0, beforeLock: undefined as (() => void) | undefined, fault: undefined as Error | undefined }
}
let current = fixture()
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
      assert.ok(query.params.includes(issueId), 'actual action must bind the requested issue')
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
let actions: typeof import('../app/actions/agents')
before(async () => {
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => viewer ? { user: { id: viewer } } : null } } } })
  mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
  mock.module('@/lib/db', { namedExports: { db: database, pool: { query() { throw new Error('Unexpected SQL pool access outside thread control') } } } })
  mock.module('@/lib/workspace-db', { namedExports: { workspaceDb: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } } })
  mock.module('@/lib/issue-access', { namedExports: {
    requireIssueAccess: async (id: string) => {
      if (!viewer) throw new ActionFailureError('authRequired')
      if (id !== issueId || !current.members.has(viewer)) throw new ActionFailureError('issueNotFound')
      return { issue: { id: issueId, userId: 'owner' }, user: { id: viewer } }
    },
    issueForUser: () => { throw new Error('queue path outside test') },
  } })
  mock.module('@/lib/issue-visibility', { namedExports: { issueVisibility: () => { throw new Error('listing runs outside test') } } })
  mock.module('@/lib/ssh', { namedExports: { listSshHosts: () => { throw new Error('SSH outside test') } } })
  mock.module('@/lib/device-link', { namedExports: { DEVICE_ONLINE_WINDOW_MS: 0, hashDeviceToken: () => { throw new Error('device credentials outside test') }, newDeviceToken: () => { throw new Error('device credentials outside test') } } })
  mock.module('@/lib/coordinator/store', { namedExports: { citationSources: () => { throw new Error('citations outside test') } } })
  actions = await import('../app/actions/agents')
})
const rejected = (code: string) => (error: unknown) => error instanceof ActionFailureError && error.code === code

test('actual thread actions preserve owner detail/Bot display and attribute an accepted message', async () => {
  current = fixture(); viewer = 'owner'
  const detail = await actions.getIssueThread(issueId, runId)
  assert.equal(detail.thread.detail?.agentName, 'Owned Bot')
  await actions.sendIssueThreadMessage({ issueId, runId, text: '  continue  ' })
  assert.deepEqual(current.messages.map(({ runId: run, userId, text }) => ({ run, userId, text })), [{ run: runId, userId: 'owner', text: 'continue' }])
  assert.equal(current.transactions, 1)
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
  current = fixture(); viewer = 'owner'
  await actions.stopRun(runId)
  const stoppedAt = current.run.stopRequestedAt
  assert.ok(stoppedAt instanceof Date)
  await actions.stopRun(runId)
  assert.equal(current.run.stopRequestedAt, stoppedAt); assert.equal(current.updates, 1)
  await assert.rejects(actions.sendIssueThreadMessage({ issueId, runId, text: 'after stop' }), rejected('runNotFound'))
  current.run.status = 'succeeded'
  await assert.rejects(actions.stopRun(runId), rejected('runNotFound'))
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
