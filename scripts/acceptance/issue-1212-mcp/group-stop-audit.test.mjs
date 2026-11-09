import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { databaseAuditPassed, terminalFor, STATEMENT_SHA256 } from './group-stop-audit.mjs'

const proof = JSON.parse(readFileSync(new URL('./group-stop-audit-fixtures.json', import.meta.url), 'utf8'))

test('the actual PG17 query projections accept the three stopped snapshots and refuse nine unsafe or foreign scopes', () => {
  assert.equal(proof.statementSha256, STATEMENT_SHA256)
  assert.equal(proof.productionAcceptance, false)
  assert.equal(proof.cases.length, 12)
  for (const row of proof.cases) {
    const audit = row.audit, original = { groupId: audit.scope?.groupId, messageId: audit.scope?.messageId,
      scenario: row.case === 'normal_private' ? 'private' : 'public' }
    assert.equal(databaseAuditPassed(audit, original), ['normal_public','normal_private','physical_session_closed'].includes(row.case), row.case)
  }
  const late = structuredClone(proof.cases.find(row => row.case === 'normal_public').audit)
  late.public.rows[0].createdAt = new Date(Date.parse(late.turn.traceFinishedAt) + 1).toISOString()
  assert.equal(databaseAuditPassed(late, { groupId: late.scope.groupId, messageId: late.scope.messageId, scenario: 'public' }), false)
})

test('a client Stop receipt, duplicate record or an unsettled generator never authorizes a database audit', () => {
  const artifact = { binding: { runId: '12345', applicationSha: 'a'.repeat(40) } }
  const row = { groupId: '00000000-0000-4000-8000-000000001212', messageId: '00000000-0000-4000-8000-000000001213', stop: { requestedAt: '2026-11-08T01:00:00.000Z' } }
  const terminal = { event: 'group_turn_terminal', conversationId: row.groupId, messageId: row.messageId,
    started: 2, settled: 2, aborted: 1, sessionLost: false, endedAt: Date.parse(row.stop.requestedAt) + 1000 }
  const runtime = { sourceRunId: artifact.binding.runId, sourceSha: artifact.binding.applicationSha, deploymentId: 'dpl_fixture', groups: [terminal] }
  assert.equal(terminalFor(artifact, runtime, row), terminal)
  for (const change of [{ event: 'stop_acknowledged' }, { settled: 1 }, { aborted: 0 }, { sessionLost: true }]) {
    assert.throws(() => terminalFor(artifact, { ...runtime, groups: [{ ...terminal, ...change }] }, row), /terminal_incomplete/)
  }
  assert.throws(() => terminalFor(artifact, { ...runtime, groups: [terminal, terminal] }, row), /terminal_missing/)
  assert.throws(() => terminalFor(artifact, { ...runtime, sourceSha: 'b'.repeat(40) }, row), /runtime_source/)
})
