import assert from 'node:assert/strict'
import test from 'node:test'
import { threadArtifactCount, threadArtifacts } from './thread-artifacts'

const factory = [
  { id: 'artifact:plan:v1:a', kind: 'plan', runId: 'build', artifactId: 'plan', version: 1, title: 'Search scope' },
  { id: 'capture-1', captureId: 'capture-1', kind: 'image', runId: 'review', title: 'Home', url: '/api/factory/tasks/t/media/capture-1', contentType: 'image/png' },
  { id: 'artifact:report:v2:b', kind: 'acceptance', runId: 'review', artifactId: 'report', version: 2, title: 'Acceptance' },
  { id: 'pr:build', kind: 'pull_request', runId: 'build', url: 'https://github.com/acme/app/pull/50', state: 'open', title: 'Bundle search' },
  { id: 'pr:other', kind: 'pull_request', runId: 'build', url: 'javascript:alert(1)', state: 'open', title: 'Bad' },
]

test('the task\'s conversation groups every admitted receipt, with the task\'s newest PR state and no duplicates', () => {
  const groups = threadArtifacts({ factory, runIds: null,
    pullRequests: [{ url: 'https://github.com/acme/app/pull/50', state: 'merged' }, { url: 'https://github.com/acme/app/pull/51', state: 'draft', title: 'Follow-up' }],
    runArtifacts: [{ id: 'report', title: 'Acceptance', latestVersion: 2 }, { id: 'notes', title: 'Notes', latestVersion: 1 }],
    captures: [{ id: 'capture-1', kind: 'image', title: 'Home', url: '/api/captures/capture-1' }, { id: 'clip', kind: 'video', title: null, url: '/api/captures/clip', durationMs: 4000 }] })
  assert.deepEqual(groups.plans.map(item => item.id), ['artifact:plan:v1:a'])
  assert.deepEqual(groups.pullRequests.map(item => item.group === 'pullRequests' && [item.id, item.state]), [['pr:build', 'merged'], ['https://github.com/acme/app/pull/51', 'draft']])
  assert.deepEqual(groups.reports.map(item => item.id), ['artifact:report:v2:b', 'notes'])
  assert.deepEqual(groups.captures.map(item => item.id), ['capture-1', 'clip'])
  assert.equal(threadArtifactCount(groups), 7)
})

test('a review or verify thread shows only its own runs\' receipts', () => {
  const groups = threadArtifacts({ factory, runIds: ['review'] })
  assert.deepEqual([groups.plans.length, groups.pullRequests.length, groups.reports.length, groups.captures.length], [0, 0, 1, 1])
})

test('a thread with no Factory task reads its run\'s own Artifacts and captures', () => {
  const groups = threadArtifacts({ factory: null, runIds: null, runArtifacts: [{ id: 'doc', title: 'Doc' }], captures: [{ id: 'log', kind: 'log', title: null, url: '/x' }] })
  assert.deepEqual(groups.reports.map(item => item.id), ['doc'])
  assert.equal(groups.captures.length, 0)
  assert.equal(threadArtifactCount(threadArtifacts({ factory: null, runIds: null })), 0)
})
