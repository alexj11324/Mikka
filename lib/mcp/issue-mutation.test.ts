import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { collectIssueEffects, scheduleIssueEffect } from '@/lib/issue-effects'

type Receipt = { userId: string; toolCallId: string; operation: string; inputHash: string; issueId: string; result: Record<string, unknown>; effects: unknown[] }
const receipts = new Map<string, Receipt>()
const issues: string[] = []
const dialect = new PgDialect()
const key = (condition: SQL) => JSON.stringify(dialect.sqlToQuery(condition).params)
let allowed = true, failEffect = false
const sync = mock.fn(async () => { if (failEffect) throw new Error('temporary followup failure') })
const access = mock.fn(async () => { if (!allowed) throw new Error('issueNotFound') })
let effectsOutsideTransaction = 0
mock.module('next/server', { namedExports: { after: () => { effectsOutsideTransaction++ } } })
mock.module('@/lib/linear-sync/worker', { namedExports: { processLinearIssueOutbox: sync } })
mock.module('@/lib/issue-access', { namedExports: { requireIssueAccess: access } })
const queryExecutor = {
  async execute(query: SQL) { assert.match(dialect.sqlToQuery(query).sql, /pg_advisory_xact_lock/); assert.match(String(dialect.sqlToQuery(query).params[0]), /^issue-tool:/) },
  select() { return { from() { return { where(condition: SQL) { return { async limit() { const row = receipts.get(key(condition)); return row ? [structuredClone(row)] : [] } } } } } } },
  insert() { return { async values(receipt: Receipt) { receipts.set(JSON.stringify([receipt.userId, receipt.toolCallId]), structuredClone(receipt)) } } },
  update() { return { set(values: Partial<Receipt>) { return { async where(condition: SQL) { const row = receipts.get(key(condition)); assert.ok(row); Object.assign(row, structuredClone(values)) } } } } },
}
const executor = {
  ...queryExecutor,
  async transaction<T>(callback: (tx: typeof queryExecutor) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(receipts), savedIssues = [...issues]
    try { return await callback(queryExecutor) }
    catch (error) {
      receipts.clear(); for (const [key, value] of snapshot) receipts.set(key, value)
      issues.splice(0, issues.length, ...savedIssues)
      throw error
    }
  },
}
mock.module('@/lib/db', { namedExports: { db: executor, withDatabaseTransaction: (_tx: unknown, fn: () => unknown) => fn() } })
let mutate: typeof import('./issue-mutation').idempotentIssueMutation
before(async () => { mutate = (await import('./issue-mutation')).idempotentIssueMutation })
beforeEach(() => { receipts.clear(); issues.length = 0; allowed = true; failEffect = false; effectsOutsideTransaction = 0; sync.mock.resetCalls(); access.mock.resetCalls() })

test('a failure after commit resumes persisted followups and returns the original result without mutating again', async () => {
  const change = mock.fn(async () => {
    issues.push('issue')
    scheduleIssueEffect({ kind: 'sync', issueId: 'issue' })
    scheduleIssueEffect({ kind: 'sync', issueId: 'issue' })
    return { id: 'issue', title: 'Original title' }
  })
  failEffect = true
  await assert.rejects(mutate('owner', 'create_issue', 'call', { title: 'Original title' }, change), /temporary followup/)
  assert.equal(receipts.size, 1)
  assert.equal(issues.length, 1)
  failEffect = false
  assert.deepEqual(await mutate('owner', 'create_issue', 'call', { title: 'Original title' }, change), { id: 'issue', title: 'Original title' })
  assert.equal(change.mock.callCount(), 1)
  assert.equal(sync.mock.callCount(), 2, 'the single persisted followup is retried')
  assert.equal(access.mock.callCount(), 1, 'access is rechecked even for a receipt')
  assert.equal(effectsOutsideTransaction, 0, 'Workflow steps never call Next after()')
  await mutate('owner', 'create_issue', 'call', { title: 'Original title' }, change)
  assert.equal(sync.mock.callCount(), 2, 'completed followups are not repeated')
})

test('partial writes and collected followups roll back together when validation fails', async () => {
  await assert.rejects(mutate('owner', 'create_issue', 'call', {}, async () => {
    issues.push('partial')
    scheduleIssueEffect({ kind: 'sync', issueId: 'partial' })
    throw new Error('memberNotJoined')
  }), /memberNotJoined/)
  assert.deepEqual(issues, [])
  assert.equal(receipts.size, 0)
  assert.equal(sync.mock.callCount(), 0)
})

test('receipts are owner scoped, compare normalized payloads and reject revoked access', async () => {
  const change = mock.fn(async () => ({ id: 'issue' }))
  await mutate('owner', 'update_issue', 'call', { title: 'Task', status: 'doing' }, change)
  await mutate('owner', 'update_issue', 'call', { status: 'doing', title: 'Task', labels: undefined }, change)
  assert.equal(change.mock.callCount(), 1)
  await assert.rejects(mutate('owner', 'update_issue', 'call', { title: 'Other' }, change), /issueToolCallConflict/)
  await assert.rejects(mutate('owner', 'create_issue', 'call', { title: 'Task', status: 'doing' }, change), /issueToolCallConflict/)
  await mutate('other-owner', 'update_issue', 'call', { title: 'Task', status: 'doing' }, change)
  assert.equal(change.mock.callCount(), 2)
  allowed = false
  await assert.rejects(mutate('owner', 'update_issue', 'call', { title: 'Task', status: 'doing' }, change), /issueNotFound/)
  for (const invalid of ['', 'x'.repeat(201)]) await assert.rejects(mutate('owner', 'create_issue', invalid, {}, change), /issueToolCallConflict/)
  assert.equal(change.mock.callCount(), 2)
})

test('the collector scopes concurrent action effects independently', async () => {
  const first: Parameters<typeof collectIssueEffects>[0] = [], second: Parameters<typeof collectIssueEffects>[0] = []
  await Promise.all([
    collectIssueEffects(first, async () => { await Promise.resolve(); scheduleIssueEffect({ kind: 'sync', issueId: 'first' }) }),
    collectIssueEffects(second, async () => { scheduleIssueEffect({ kind: 'sync', issueId: 'second' }); await Promise.resolve() }),
  ])
  assert.deepEqual(first, [{ kind: 'sync', issueId: 'first' }])
  assert.deepEqual(second, [{ kind: 'sync', issueId: 'second' }])
})
