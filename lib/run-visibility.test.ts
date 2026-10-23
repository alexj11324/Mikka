import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceRunView } from './run-visibility'
import { PgDialect } from 'drizzle-orm/pg-core'
import { issueVisibilityPredicate } from './issue-visibility-policy'

test('teammate projection is an allowlist; never spread untyped private fields', () => {
  const date = new Date()
  const run = { id: 'run', issueId: 'issue', agentId: 'private-id', agentName: 'private-name', harness: 'codex' as const, status: 'running', kind: 'secret-kind', stopReason: 'secret-reason', error: 'secret-error', report: { summary: 'secret-report' }, createdAt: date, startedAt: date, finishedAt: null, prompt: 'secret-prompt', memory: 'secret-memory' }
  const shared = workspaceRunView(run)
  assert.equal(JSON.stringify(shared).includes('secret'), false)
  assert.equal(JSON.stringify(shared).includes('private'), false)
  assert.equal(shared.agentId, '')
  assert.equal(shared.status, 'running')
  assert.equal(shared.report, null)
  assert.equal(run.report.summary, 'secret-report')
})
test('owners retain access; nonowners require active linked workspace IDs', () => {
  const { sql, params } = new PgDialect().sqlToQuery(issueVisibilityPredicate('viewer', { linkedIds: ['linked'], allowedIds: ['allowed'] }))
  assert.doesNotMatch(sql, /issue_members|not in/)
  assert.deepEqual(params, ['viewer', 'workspace', 'allowed'])
  const denied = new PgDialect().sqlToQuery(issueVisibilityPredicate('viewer', { linkedIds: [], allowedIds: [] }))
  assert.match(denied.sql, /false/)
})
