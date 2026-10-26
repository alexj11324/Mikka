import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { handleImprovement } from './http'
import { ImprovementError } from './contract'
import { BASELINE_ARTIFACT } from './builtin-skill'
import { SKILL_PATH } from './regression'

const origin = 'https://preview.example.test'
const binding = { taskId: randomUUID(), issueId: randomUUID(), attemptId: randomUUID(), revision: 1, candidateId: randomUUID() }
const registration = { action: 'register_candidate', proposalId: randomUUID(), binding }
function request(body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/self-improvement`, { method: 'POST', headers: { origin: requestOrigin }, body: JSON.stringify(body) })
}

test('registration HTTP boundary accepts only proposal and Factory binding after auth and same-origin checks', async () => {
  const calls: unknown[] = []
  const registered: Awaited<ReturnType<NonNullable<Parameters<typeof handleImprovement>[5]>['registerCandidate']>> = {
    artifact:{...BASELINE_ARTIFACT,versionId:binding.candidateId},versionId:binding.candidateId,userId:'owner',issueId:binding.issueId,
    agentId:randomUUID(),repoId:randomUUID(),proposalId:registration.proposalId,factoryTaskId:binding.taskId,candidateId:binding.candidateId,
    repository:'example/fixture',commitSha:'a'.repeat(40),path:SKILL_PATH,baselineVersionId:BASELINE_ARTIFACT.versionId,createdAt:new Date(),
  }
  const registry = { registerCandidate: async (...args: unknown[]) => { calls.push(args); return registered } }
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

test('evaluation HTTP commands use authenticated identity and server-owned settings only', async () => {
  const calls: { method: string; args: unknown[] }[] = []
  const result = { source: 'persisted_evaluation', productionEligible: false }
  const callback = (method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return result }
  const evaluations = { freezeBenchmark: callback('freezeBenchmark'), dispatchNext: callback('dispatchNext'),
    beginEvaluation: callback('beginEvaluation'), compare: callback('compare') } as unknown as Parameters<typeof handleImprovement>[6]
  const store = {} as Parameters<typeof handleImprovement>[0]
  const sourceRunId = randomUUID(), instanceId = randomUUID(), proposalId = randomUUID(), candidateVersionId = randomUUID(), evaluationId = randomUUID()
  const commands = [
    { body: { action: 'freeze_benchmark', sourceRunId }, method: 'freezeBenchmark', args: ['owner', sourceRunId] },
    { body: { action: 'dispatch_training', instanceId }, method: 'dispatchNext', args: ['owner', instanceId, true] },
    { body: { action: 'begin_evaluation', instanceId, proposalId, candidateVersionId }, method: 'beginEvaluation', args: ['owner', instanceId, proposalId, candidateVersionId] },
    { body: { action: 'dispatch_evaluation', evaluationId }, method: 'dispatchNext', args: ['owner', evaluationId, false] },
    { body: { action: 'compare_evaluation', evaluationId }, method: 'compare', args: ['owner', evaluationId] },
  ]
  for (const command of commands) {
    assert.equal((await handleImprovement(store, request(command.body), null, undefined, undefined, undefined, evaluations)).status, 401)
    assert.equal((await handleImprovement(store, request(command.body, 'https://other.test'), 'owner', undefined, undefined, undefined, evaluations)).status, 403)
    assert.equal((await handleImprovement(store, request(command.body), 'owner')).status, 409)
    const before = calls.length
    for (const extra of [{ userId: 'other' }, { model: 'replacement' }, { policy: {} }, { threshold: 0 }, { caseId: 'injected' },
      { actualOutput: 'passed' }, { passed: true }, { markdown: 'injected' }, { arm: 'candidate' }])
      assert.equal((await handleImprovement(store, request({ ...command.body, ...extra }), 'owner', undefined, undefined, undefined, evaluations)).status, 422)
    assert.equal(calls.length, before)
    const response = await handleImprovement(store, request(command.body), 'owner', undefined, undefined, undefined, evaluations)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), result)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(calls.at(-1), { method: command.method, args: command.args })
  }
  assert.equal(calls.length, commands.length)
  const rejected = { ...evaluations, compare: async () => { throw new ImprovementError('notFound') } } as Parameters<typeof handleImprovement>[6]
  assert.equal((await handleImprovement(store, request({ action: 'compare_evaluation', evaluationId }), 'owner', undefined, undefined, undefined, rejected)).status, 404)
})
