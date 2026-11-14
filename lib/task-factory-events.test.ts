import assert from 'node:assert/strict'
import test from 'node:test'
import { taskFactoryEvents, taskFactoryProgress } from './task-factory-events'

test('a gate transition keeps its actual revision and a hidden historical attempt cannot become an event', () => {
  const common = { createdAt: '2026-11-09T01:00:00Z', stage: 'review', status: 'passed', attemptId: 'visible', receiptCandidateId: 'candidate' }
  const rows = taskFactoryEvents('task', [
    { ...common, id: 'human-gate', revision: 3 },
    { ...common, id: 'recorded-again', revision: 4 },
    { ...common, id: 'hidden-producer', revision: 5, attemptId: 'hidden' },
    { ...common, id: 'back-from-hidden', revision: 6, previousAttemptId: 'hidden' },
    { ...common, id: 'new-stage', revision: 7, stage: 'approval', status: 'waiting' },
  ], [{ id: 'visible', runId: 'review-run', candidateId: 'candidate' }], [])
  assert.deepEqual(rows.map(row => row.sourceId), ['human-gate', 'new-stage'])
  assert.deepEqual(rows.map(row => row.kind === 'factory_gate' && [row.revision, row.runId, row.candidateId]), [[3, 'review-run', 'candidate'], [7, 'review-run', 'candidate']])
})

test('same-title evidence retains each immutable version, producing run and candidate', () => {
  const common = { title: 'Report', createdAt: '2026-11-09T01:03:00Z', kind: 'document' as const, runId: 'run', attemptId: 'attempt', artifactId: 'same' }
  const rows = taskFactoryEvents('task', [], [{ id: 'attempt', runId: 'run', candidateId: 'candidate' }], [
    { ...common, id: 'artifact:same:v1:attempt', version: 1 }, { ...common, id: 'artifact:same:v2:attempt', version: 2 },
    { ...common, id: 'unreadable', attemptId: 'denied', version: 3 },
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.kind === 'evidence' && [row.sourceId, row.artifactId, row.version, row.runId, row.candidateId]), [
    ['artifact:same:v1:attempt', 'same', 1, 'run', 'candidate'], ['artifact:same:v2:attempt', 'same', 2, 'run', 'candidate'],
  ])
})

test('the mobile handoff addresses the selected Task and immutable version after reopening', async () => {
  const { taskEvidenceHref, readTaskEvidenceTarget } = await import('./task-factory-events')
  const { mobileWebTarget } = await import('./mobile-web-target')
  const issue = '11000000-0000-4000-8000-000000000001', factory = '21000000-0000-4000-8000-000000000001'
  const artifact = '31000000-0000-4000-8000-000000000001', attempt = '41000000-0000-4000-8000-000000000001'
  const receipt = `artifact:${artifact}:v2:${attempt}`
  const href = taskEvidenceHref(issue, factory, receipt)!
  assert.equal(mobileWebTarget(href), href)
  assert.deepEqual(readTaskEvidenceTarget(new URL(href, 'https://mikka.example').searchParams), { issueId: issue, factoryTaskId: factory, receiptId: receipt })
  assert.equal(taskEvidenceHref(issue, factory, 'https://example.test'), null)
  assert.equal(readTaskEvidenceTarget(new URLSearchParams({ issue, factoryTask: factory, evidence: `artifact:${artifact}:latest:${attempt}` })), null)
})

test('revoked, foreign and malformed Factory receipts do not become Task activity', async () => {
  const { presentedFactoryEvents } = await import('./task-factory-events')
  const event = { kind: 'evidence', id: 'evidence:active:report', at: '2026-01-01T00:00:00Z', sourceId: 'report',
    factoryTaskId: 'active', runId: 'producer', candidateId: 'candidate', attemptId: 'attempt', artifactId: 'artifact', version: 2, title: 'Report', evidenceKind: 'document' }
  assert.deepEqual(presentedFactoryEvents([event, { ...event, version: -1 }, { ...event, runId: null }, { ...event, factoryTaskId: 'other' }], 'active'), [event])
  assert.deepEqual(presentedFactoryEvents([event], undefined), [])
})

test('progress folds visible gates per run, retains retries and keeps pre-dispatch work separate', () => {
  const at = '2026-11-09T01:00:00Z'
  const attempts = [{ id: 'a', runId: 'run', candidateId: null }, { id: 'b', runId: null, candidateId: null }]
  const gates = [
    { id: 'started', revision: 1, attemptId: 'a', stage: 'execute', status: 'running' },
    { id: 'failed', revision: 2, attemptId: 'a', stage: 'verify', status: 'failed' },
    { id: 'retried', revision: 3, attemptId: 'a', stage: 'execute', status: 'running' },
    { id: 'unbound', revision: 4, attemptId: 'b', stage: 'review', status: 'pending' },
    { id: 'unassigned', revision: 5, attemptId: null, stage: 'clarify', status: 'pending' },
    { id: 'hidden', revision: 6, attemptId: 'foreign', stage: 'publish', status: 'passed' },
  ].map(gate => ({ ...gate, createdAt: at }))
  const receipts = taskFactoryEvents('factory', gates, attempts, [
    { id: 'doc', kind: 'document', title: 'Report', createdAt: at, runId: 'run', attemptId: 'a' },
  ])
  const items = taskFactoryProgress(receipts.toReversed())
  assert.equal(items.length, 3)
  const run = items.find(item => item.runId === 'run')!
  assert.deepEqual(run.steps.map(gate => gate.sourceId), ['started', 'failed', 'retried'])
  assert.equal(run.current.sourceId, 'retried')
  assert.deepEqual(items.filter(item => !item.runId).map(item => item.current.sourceId).sort(), ['unassigned', 'unbound'])
  const otherTask = taskFactoryEvents('other', gates, attempts, [])
  assert.equal(taskFactoryProgress([...receipts, ...otherTask]).length, 6)
  assert.equal(JSON.stringify(items).includes('foreign'), false)
})
