// Reuse only a successfully confirmed case in an earlier attempt of this same
// source-bound workflow run. A failed aggregate job does not erase a completed
// paid case, and a successful unrelated step does not establish one.
export const MEMORY_CASE_STEPS = Object.freeze({
  owner: 'Confirm Memory owner API acceptance',
  claude_code: 'Confirm Claude Memory reply and real usage',
  codex: 'Confirm Codex Memory reply and real usage',
  pending: 'Confirm Memory notification pending review',
})
const JOB = 'Core production API and gateway acceptance'
const SHA = /^[a-f0-9]{40}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const kinds = Object.keys(MEMORY_CASE_STEPS)
export class MemoryCaseError extends Error {
  constructor() { super('memory_case_proof_invalid'); this.code = this.message }
}
const check = value => { if (!value) throw new MemoryCaseError() }
export const memoryCaseFailure = error => error instanceof MemoryCaseError ? { code: error.code } : null

export function memoryCaseProofs(jobs, { sourceSha, runId, runAttempt }) {
  check(SHA.test(sourceSha) && positive(runId) && positive(runAttempt)
    && Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length <= 100)
  const matching = jobs.jobs.filter(job => job.name === JOB)
  check(matching.length <= 1)
  const result = Object.fromEntries(kinds.map(kind => [kind, null]))
  if (!matching.length) return result
  const job = matching[0]
  check(positive(job.id) && job.status === 'completed' && Array.isArray(job.steps)
    && job.run_id === runId && job.run_attempt === runAttempt && job.head_sha === sourceSha)
  for (const kind of kinds) {
    const steps = job.steps.filter(step => step.name === MEMORY_CASE_STEPS[kind])
    check(steps.length <= 1)
    const step = steps[0]
    if (step?.status === 'completed' && step.conclusion === 'success') {
      check(positive(step.number))
      result[kind] = { sourceSha, runId, runAttempt, jobId: job.id, stepNumber: step.number, stepName: step.name }
    }
  }
  return result
}

export async function readPriorMemoryCases(read, { sourceSha, runId, runAttempt }) {
  check(SHA.test(sourceSha) && positive(runId) && positive(runAttempt) && runAttempt <= 10)
  const result = Object.fromEntries(kinds.map(kind => [kind, { reused: null }]))
  for (let attempt = 1; attempt < runAttempt; attempt++) {
    const prior = memoryCaseProofs(await read(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`),
      { sourceSha, runId, runAttempt: attempt })
    for (const kind of kinds) if (prior[kind] && !result[kind].reused) result[kind].reused = prior[kind]
  }
  return result
}

export function memoryCasePassed(report, kind) {
  if (!kinds.includes(kind) || report?.schema !== 1 || report.kind !== 'mikka1821-production-memory') return false
  const cleanup = report.cleanup
  if (!cleanup || !['factRemoved', 'originalFactsPreserved', 'preferencePreserved', 'workspaceRestored', 'sessionRevoked']
    .every(key => cleanup[key] === true) || !Array.isArray(cleanup.failures) || cleanup.failures.length) return false
  if (kind === 'owner') return report.checks?.ownerCrud === true
    && report.coverage?.manualSource === 'normal_owner_insert_told_assertion_id'
  if (kind === 'pending') return report.pending?.status === 'passed'
    && ['approved', 'rejected', 'pendingRestoredByNormalUndo', 'approvalIdempotent', 'scopeRejectedOutsideSourceWorkspace',
      'cleaned', 'inboxCleaned', 'otherFactsPreserved'].every(key => report.pending[key] === true)
  const model = report.models?.find(row => row.harness === kind)
  return model?.status === 'passed' && model.reply === true && model.usage === true && model.botStopped === true
    && Number.isSafeInteger(model.usedCountIncrease) && model.usedCountIncrease > 0
    && (kind === 'claude_code' ? model.provider === 'claude' && model.model === 'claude-haiku-5-5'
      : model.provider === 'codex' && model.model === 'gpt-6-luna')
}

/** The confirm step runs in the same trusted checkout/job after the real case.
 * Its successful GitHub step metadata is the durable future-attempt proof.
 * It never creates an external event or repeats a provider request. */
export function confirmMemoryCase(report, kind, env) {
  check(SHA.test(env.GITHUB_SHA ?? '') && report.applicationSha === env.GITHUB_SHA
    && positive(Number(env.GITHUB_RUN_ID)) && report.driverRunId === Number(env.GITHUB_RUN_ID)
    && positive(Number(env.GITHUB_RUN_ATTEMPT)) && report.driverRunAttempt === Number(env.GITHUB_RUN_ATTEMPT)
    && memoryCasePassed(report, kind))
  return { schema: 1, kind: 'mikka1821-case-confirmation', status: 'passed', case: kind,
    applicationSha: report.applicationSha, driverRunId: report.driverRunId, driverRunAttempt: report.driverRunAttempt }
}
