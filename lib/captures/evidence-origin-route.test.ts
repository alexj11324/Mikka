import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { RunOrigin, RunOriginRef } from '../run-origin'

// Owner-only acceptance evidence is the one read allowed to expose the opaque
// entry ids. Everything else (lists, chat, events, logs) stays out of it.
const owner = 'run-origin-evidence-owner', runId = randomUUID()
const slackRef: RunOriginRef = { kind: 'slack', teamId: 'T123', channelId: 'C123', threadTs: '1700000000.000001' }
let signedIn = true, outside = false, reads = 0
let evidence: { run: { id: string; origin: RunOrigin | null; originRef: RunOriginRef | null }; recording: boolean; captures: unknown[]; artifacts: unknown[] } | null
mock.module(new URL('../api-auth.ts', import.meta.url).href, { namedExports: {
  auth: { api: { getSession: async () => signedIn ? { user: { id: owner } } : null } },
} })
mock.module(new URL('./store.ts', import.meta.url).href, { namedExports: {
  runEvidence: async (userId: string, id: string) => {
    reads++
    assert.equal(userId, owner)
    assert.equal(id, runId)
    return evidence
  },
} })
mock.module(new URL('../tokens/scope.ts', import.meta.url).href, { namedExports: {
  runOutsideToken: async () => outside,
} })
const { GET } = await import('../../app/api/runs/[runId]/evidence/route')
const call = () => GET(new Request(`https://app.example/mikka/api/runs/${runId}/evidence`), { params: Promise.resolve({ runId }) })
beforeEach(() => {
  signedIn = true; outside = false; reads = 0
  evidence = { run: { id: runId, origin: 'slack', originRef: slackRef }, recording: false, captures: [], artifacts: [] }
})

test('the owner receives the opaque entry provenance and ref', async () => {
  const response = await call()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), evidence)
  assert.equal(reads, 1)
})

test('a legacy run reports unknown instead of inventing web', async () => {
  evidence = { run: { id: runId, origin: null, originRef: null }, recording: false, captures: [], artifacts: [] }
  const response = await call()
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).run, { id: runId, origin: null, originRef: null })
})

test('without a session, an owner match or an owner token there is no evidence', async () => {
  signedIn = false
  assert.equal((await call()).status, 401)
  assert.equal(reads, 0)
  signedIn = true
  evidence = null
  assert.equal((await call()).status, 404)
  assert.equal(reads, 1)
  evidence = { run: { id: runId, origin: 'slack', originRef: slackRef }, recording: false, captures: [], artifacts: [] }
  outside = true
  assert.equal((await call()).status, 404)
  assert.equal(reads, 1)
})
