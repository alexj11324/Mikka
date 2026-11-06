import assert from 'node:assert/strict'
import { test } from 'node:test'
import { artifactReviewDot, artifactReviewKind, pullNumberOf } from './artifact-review'

const flow = (patch: Record<string, unknown> = {}) => ({ stage: 'handoff' as const, needsYou: { kind: 'pr_review' as const, since: '2026-11-06T10:00:00Z' }, acceptance: { artifactId: 'a', version: 1, runId: 'r', candidateId: 'c', counts: {}, media: [] }, ...patch })
const kind = (input: Partial<Parameters<typeof artifactReviewKind>[0]>) => artifactReviewKind({ hasArtifact: true, runSucceeded: true, ...input })

test('no Artifact: off until the thread finishes, then preparing', () => {
  assert.equal(kind({ hasArtifact: false, runSucceeded: false }), 'none')
  assert.equal(kind({ hasArtifact: false }), 'preparing')
  assert.equal(kind({}), 'ready')
})

test('a v2 PR report follows its flow and merge', () => {
  assert.equal(kind({ flow: flow(), merge: { state: 'pending' } }), 'review')
  assert.equal(kind({ flow: flow(), merge: { state: 'merging' } }), 'merging')
  assert.equal(kind({ flow: flow(), merge: { state: 'pending', refusal: 'githubMergeConflict' } }), 'refused')
  assert.equal(kind({ flow: flow({ stage: 'completed', needsYou: undefined, completion: 'merged' }) }), 'merged')
  assert.equal(kind({ flow: flow({ stage: 'implement', needsYou: undefined }) }), 'fixing')
  assert.equal(kind({ flow: flow({ needsYou: { kind: 'failed', since: '' } }) }), 'blocked')
  assert.equal(kind({ hasArtifact: false, flow: flow({ needsYou: undefined, acceptance: null }) }), 'preparing')
})

test('an older task follows its merge state', () => {
  assert.equal(kind({ merge: { state: 'pending' } }), 'review')
  assert.equal(kind({ merge: { state: 'merged' } }), 'merged')
  assert.equal(kind({ merge: { state: 'unavailable' } }), 'ready')
})

test('dots: amber review, grey work, purple merged, red trouble', () => {
  assert.deepEqual((['none', 'preparing', 'ready', 'review', 'fixing', 'merging', 'merged', 'refused', 'blocked'] as const).map(artifactReviewDot),
    [null, null, null, 'warning', 'neutral', 'neutral', 'merged', 'destructive', 'destructive'])
})

test('PR numbers come only from GitHub pull links', () => {
  assert.equal(pullNumberOf('https://github.com/o/r/pull/1288'), '1288')
  assert.equal(pullNumberOf('https://example.com/o/r/pull/1'), null)
  assert.equal(pullNumberOf(null), null)
})
