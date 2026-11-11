import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import yaml from 'js-yaml'
import { MEMORY_CASE_STEPS, memoryCaseProofs, readPriorMemoryCases, memoryCasePassed, confirmMemoryCase,
  memoryCaseFailure } from './memory-production-cases.mjs'

const SOURCE = 'a'.repeat(40), RUN = 17, ATTEMPT = 1, JOB = 'Core production API and gateway acceptance'
const binding = { sourceSha: SOURCE, runId: RUN, runAttempt: ATTEMPT }
const step = (kind, patch = {}) => ({ name: MEMORY_CASE_STEPS[kind], number: Object.keys(MEMORY_CASE_STEPS).indexOf(kind) + 10,
  status: 'completed', conclusion: 'success', ...patch })
const jobs = (patch = {}) => ({ total_count: 1, jobs: [{ id: 1821001, name: JOB, run_id: RUN, run_attempt: ATTEMPT,
  head_sha: SOURCE, status: 'completed', conclusion: 'failure', steps: Object.keys(MEMORY_CASE_STEPS).map(kind => step(kind)), ...patch }] })

test('a successful exact case confirmation survives aggregate job failure with an immutable same-run proof', () => {
  const proof = memoryCaseProofs(jobs(), binding)
  for (const kind of Object.keys(MEMORY_CASE_STEPS)) {
    assert.deepEqual(proof[kind], { ...binding, jobId: 1821001, stepNumber: step(kind).number, stepName: MEMORY_CASE_STEPS[kind] })
  }
  const partial = memoryCaseProofs(jobs({ steps: [step('owner'), step('claude_code'), step('codex', { conclusion: 'failure' }),
    step('pending', { conclusion: 'skipped' })] }), binding)
  assert.ok(partial.owner); assert.ok(partial.claude_code); assert.equal(partial.codex, null); assert.equal(partial.pending, null)
})

test('wrong source, run, attempt, active jobs and duplicate case evidence cannot be reused', () => {
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { run_id: RUN + 1 }, { run_attempt: ATTEMPT + 1 },
    { status: 'in_progress' }, { id: 0 }, { steps: [step('codex'), step('codex')] }, { steps: [step('codex', { number: 0 })] }]) {
    assert.throws(() => memoryCaseProofs(jobs(patch), binding), error => {
      assert.deepEqual(memoryCaseFailure(error), { code: 'memory_case_proof_invalid' }); return true
    })
  }
  const duplicate = jobs(); duplicate.jobs.push(duplicate.jobs[0]); duplicate.total_count = 2
  assert.throws(() => memoryCaseProofs(duplicate, binding), /memory_case_proof_invalid/)
  assert.throws(() => memoryCaseProofs({ ...jobs(), total_count: 101 }, binding), /memory_case_proof_invalid/)
  for (const patch of [{ sourceSha: 'main' }, { runId: 0 }, { runAttempt: 0 }])
    assert.throws(() => memoryCaseProofs(jobs(), { ...binding, ...patch }), /memory_case_proof_invalid/)
})

test('a successful unrelated step or failed, skipped, cancelled or running confirmation supplies no proof', () => {
  for (const patch of [{ conclusion: 'failure' }, { conclusion: 'skipped' }, { conclusion: 'cancelled' },
    { conclusion: null, status: 'in_progress' }, { name: 'Ordinary successful build' }]) {
    assert.equal(memoryCaseProofs(jobs({ steps: [step('codex', patch)] }), binding).codex, null)
  }
  assert.deepEqual(memoryCaseProofs(jobs({ name: 'Another job' }), binding), { owner: null, claude_code: null, codex: null, pending: null })
})

test('history reads only bounded previous attempts of this exact run and preserves the first actual success', async () => {
  const paths = []
  const proofs = await readPriorMemoryCases(async path => {
    paths.push(path)
    const attempt = Number(path.match(/\/attempts\/(\d+)\//)[1])
    return jobs({ run_attempt: attempt, steps: attempt === 1 ? [step('claude_code')] : [step('claude_code'), step('codex')] })
  }, { ...binding, runAttempt: 3 })
  assert.deepEqual(paths, ['/actions/runs/17/attempts/1/jobs?per_page=100', '/actions/runs/17/attempts/2/jobs?per_page=100'])
  assert.equal(proofs.claude_code.reused.runAttempt, 1); assert.equal(proofs.codex.reused.runAttempt, 2)
  assert.equal(proofs.pending.reused, null); assert.equal(proofs.owner.reused, null)
  assert.deepEqual(await readPriorMemoryCases(() => assert.fail('first attempt has no history'), binding), {
    owner: { reused: null }, claude_code: { reused: null }, codex: { reused: null }, pending: { reused: null },
  })
  await assert.rejects(readPriorMemoryCases(() => assert.fail('unbounded history refused'), { ...binding, runAttempt: 11 }), /memory_case_proof_invalid/)
})

const report = () => ({ schema: 1, kind: 'mikka1821-production-memory', status: 'partial', applicationSha: SOURCE,
  driverRunId: RUN, driverRunAttempt: ATTEMPT, checks: { ownerCrud: true }, coverage: { manualSource: 'normal_owner_insert_told_assertion_id' },
  cleanup: { factRemoved: true, originalFactsPreserved: true, preferencePreserved: true, workspaceRestored: true, sessionRevoked: true, failures: [] },
  models: [{ harness: 'claude_code', provider: 'claude', model: 'claude-haiku-5-5', status: 'passed', reply: true, usage: true, botStopped: true, usedCountIncrease: 1 },
    { harness: 'codex', provider: 'codex', model: 'gpt-6-luna', status: 'passed', reply: true, usage: true, botStopped: true, usedCountIncrease: 1 }],
  pending: { status: 'passed', rejected: true, approved: true, pendingRestoredByNormalUndo: true, approvalIdempotent: true,
    scopeRejectedOutsideSourceWorkspace: true, cleaned: true, inboxCleaned: true, otherFactsPreserved: true },
})
const env = { GITHUB_SHA: SOURCE, GITHUB_RUN_ID: String(RUN), GITHUB_RUN_ATTEMPT: String(ATTEMPT) }

test('new confirmations require a concrete successful case, original source/run/attempt and complete own cleanup', () => {
  for (const kind of Object.keys(MEMORY_CASE_STEPS)) {
    assert.equal(memoryCasePassed(report(), kind), true)
    assert.deepEqual(confirmMemoryCase(report(), kind, env), { schema: 1, kind: 'mikka1821-case-confirmation', status: 'passed', case: kind,
      applicationSha: SOURCE, driverRunId: RUN, driverRunAttempt: ATTEMPT })
    for (const patch of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ID: '18' }, { GITHUB_RUN_ATTEMPT: '2' }])
      assert.throws(() => confirmMemoryCase(report(), kind, { ...env, ...patch }), /memory_case_proof_invalid/)
    for (const key of Object.keys(report().cleanup).filter(key => key !== 'failures')) {
      const value = report(); value.cleanup[key] = false
      assert.equal(memoryCasePassed(value, kind), false)
    }
    const failedCleanup = report(); failedCleanup.cleanup.failures.push({ code: 'synthetic_failure' })
    assert.equal(memoryCasePassed(failedCleanup, kind), false)
  }
  assert.equal(memoryCasePassed(report(), 'unrelated'), false)
})

test('reused, blocked, unpaid-alternative or usage-only model rows never become a new paid-case success', () => {
  for (const patch of [{ status: 'reused' }, { status: 'blocked' }, { reply: false }, { usage: false }, { botStopped: false },
    { usedCountIncrease: 0 }, { usedCountIncrease: 1.5 }, { model: 'another-model' }, { provider: 'api-key' }]) {
    const value = report(); Object.assign(value.models[1], patch)
    assert.equal(memoryCasePassed(value, 'codex'), false)
    assert.throws(() => confirmMemoryCase(value, 'codex', env), /memory_case_proof_invalid/)
  }
  for (const key of ['approved', 'rejected', 'pendingRestoredByNormalUndo', 'approvalIdempotent', 'scopeRejectedOutsideSourceWorkspace',
    'cleaned', 'inboxCleaned', 'otherFactsPreserved']) {
    const value = report(); value.pending[key] = false; assert.equal(memoryCasePassed(value, 'pending'), false)
  }
  const reused = report(); reused.pending.status = 'reused'; assert.equal(memoryCasePassed(reused, 'pending'), false)
})

test('workflow confirmations use exact successful-case outputs, trusted report binding and readonly GitHub metadata permissions', async () => {
  const workflow = yaml.load(await readFile(new URL('../../.github/workflows/self-hosted-production.yml', import.meta.url), 'utf8'))
  const job = workflow.jobs.acceptance, steps = job.steps
  assert.equal(job.name, JOB); assert.equal(job.permissions['pull-requests'], 'read')
  assert.equal(job.permissions.actions, 'read'); assert.equal(job.permissions.issues, 'read'); assert.equal(job.permissions.contents, 'read')
  const driver = steps.find(step => step.id === 'memory')
  assert.equal(driver.run, 'node --import tsx scripts/acceptance/memory-production.mjs')
  for (const kind of Object.keys(MEMORY_CASE_STEPS)) {
    const confirmations = steps.filter(step => step.name === MEMORY_CASE_STEPS[kind])
    assert.equal(confirmations.length, 1)
    assert.ok(steps.indexOf(confirmations[0]) > steps.indexOf(driver))
    assert.equal(confirmations[0].if, `always() && steps.memory.outputs.${kind}_passed == 'true'`)
    assert.equal(confirmations[0].run, 'node --import tsx scripts/acceptance/memory-production.mjs --confirm-case ' + kind)
  }
})
