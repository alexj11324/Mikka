import assert from 'node:assert/strict'
import test from 'node:test'
import { taskFactoryEvents } from './task-factory-events'

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
