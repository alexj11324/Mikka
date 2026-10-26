import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { handleImprovement } from './http'
import { ImprovementError } from './contract'

const origin = 'https://preview.example.test'
const binding = { taskId: randomUUID(), issueId: randomUUID(), attemptId: randomUUID(), revision: 1, candidateId: randomUUID() }
const registration = { action: 'register_candidate', proposalId: randomUUID(), binding }
function request(body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/self-improvement`, { method: 'POST', headers: { origin: requestOrigin }, body: JSON.stringify(body) })
}

test('registration HTTP boundary accepts only proposal and Factory binding after auth and same-origin checks', async () => {
  const calls: unknown[] = []
  const registry = { registerCandidate: async (...args: unknown[]) => { calls.push(args); return { versionId: binding.candidateId } } }
  const store = {} as Parameters<typeof handleImprovement>[0]
  assert.equal((await handleImprovement(store, request(registration), null, undefined, undefined, registry)).status, 401)
  assert.equal((await handleImprovement(store, request(registration, 'https://other.test'), 'owner', undefined, undefined, registry)).status, 403)
  for (const extra of [{ markdown: 'injected' }, { sha: 'a'.repeat(40) }, { path: '../SKILL.md' }, { versionId: randomUUID() }])
    assert.equal((await handleImprovement(store, request({ ...registration, ...extra }), 'owner', undefined, undefined, registry)).status, 422)
  assert.equal(calls.length, 0)
  const response = await handleImprovement(store, request(registration), 'owner', undefined, undefined, registry)
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [['owner', { proposalId: registration.proposalId, binding }]])
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const rejected = { registerCandidate: async () => { throw new ImprovementError('sourceMismatch') } }
  assert.equal((await handleImprovement(store, request(registration), 'owner', undefined, undefined, rejected)).status, 409)
})

test('active selection resolves version on the server; arbitrary version and purpose fields are rejected', async () => {
  const calls: unknown[] = [], runId = randomUUID()
  const assignments = { selectActive: async (...args: unknown[]) => { calls.push(args); return { runId } } } as unknown as Parameters<typeof handleImprovement>[3]
  const store = {} as Parameters<typeof handleImprovement>[0]
  const command = { action: 'select_active', runId }
  for (const extra of [{ versionId: randomUUID() }, { purpose: 'evaluation' }, { evaluationId: randomUUID() }])
    assert.equal((await handleImprovement(store, request({ ...command, ...extra }), 'owner', assignments)).status, 422)
  assert.equal((await handleImprovement(store, request(command), 'owner', assignments)).status, 200)
  assert.deepEqual(calls, [['owner', runId]])
})
