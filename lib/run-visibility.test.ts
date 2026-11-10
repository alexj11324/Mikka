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
  // The harness is behavior, not private provenance: keep it, never default it.
  assert.equal(shared.harness, 'codex')
  assert.equal(shared.report, null)
  assert.equal(run.report.summary, 'secret-report')
})
test('creators and teammates both need an authorized immutable workspace', () => {
  const { sql, params } = new PgDialect().sqlToQuery(issueVisibilityPredicate('viewer', { allowedIds: ['old-team-link'], workspaceIds: ['tenant'] }))
  assert.doesNotMatch(sql, /issue_members|userId|not in/)
  assert.match(sql, /workspaceId/)
  assert.match(sql, /mikka_resource_acl_allowed/)
  assert.deepEqual(params, ['bound', 'tenant', 'viewer', 'task', 'canReadContent'])
  const denied = new PgDialect().sqlToQuery(issueVisibilityPredicate('viewer', { allowedIds: [] }))
  assert.match(denied.sql, /false/)
})
