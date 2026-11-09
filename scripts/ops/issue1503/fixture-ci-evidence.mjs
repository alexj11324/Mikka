import { createHash } from 'node:crypto'

const repository = 'alexj11324/Mikka-handoff'
const api = 'https://api.github.com/repos/' + repository
const workflowPath = '.github/workflows/factory-fixtures.yml'
const files = Object.freeze([
  {
    "path": ".github/workflows/factory-fixtures.yml",
    "bytes": 902,
    "gitBlob": "0b5a806ca204738f044fbb34f0b08c31acd962ef",
    "sha256": "f44df4484453290c75dc5754921947d2adc6b91b6d41feb0726545c958e97a7d"
  },
  {
    "path": "scripts/validate-factory-files.mjs",
    "bytes": 1299,
    "gitBlob": "47f2946ec06d0bfc916047f5d21bec5e6ae43480",
    "sha256": "19cb7ab567585c868605352e35830f94bc158a04575aa73953847f605d12e73d"
  },
  {
    "path": "scripts/validate-factory-files.test.mjs",
    "bytes": 2457,
    "gitBlob": "f9035d3979ca019bc2de1825f29915fbabf881d1",
    "sha256": "476c0759ad37217e50d145124417b89a283fad1e297c4851aa9d8da2a10c410c"
  }
])
const checkoutAction = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
const nodeAction = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
const requiredSteps = Object.freeze([
  { name: 'Run ' + checkoutAction, purpose: 'checkout' },
  { name: 'Confirm candidate checkout', purpose: 'exact_head', command: 'test "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT"' },
  { name: 'Run ' + nodeAction, purpose: 'node_24' },
  { name: 'Check the fixture validator', purpose: 'validator_tests', command: 'node --test scripts/validate-factory-files.test.mjs' },
  { name: 'Verify committed Factory files', purpose: 'repository_validator', command: 'node scripts/validate-factory-files.mjs' },
])
export const EXTERNAL_CRITERIA = Object.freeze({
  'Repository validator accepts the committed fixture.': 'repository_validator',
  'Validator unit tests pass.': 'validator_tests',
  "The 'verify' job of the Factory fixture checks and every other check on the pushed commit complete successfully.": 'exact_head_checks',
})
export const IMPLEMENTATION_CRITERION = 'Run a small command that reads the file and verifies these requirements.'
export const FIXTURE_CI_CONTRACT = immutable({ repository, workflowPath, files, requiredSteps })
const verifiedReceipts = new WeakSet()
const verifiedImplementationReceipts = new WeakSet()
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const integer = value => Number.isSafeInteger(value) && value > 0
const digest = value => createHash('sha256').update(value).digest('hex')
const fail = (code, options) => { throw new Error('issue1503_ci_' + code, options) }
const requireEvidence = (condition, code) => { if (!condition) fail(code) }
const sameRepository = value => typeof value === 'string' && value.toLowerCase() === repository.toLowerCase()
const successful = value => value?.status === 'completed' && value.conclusion === 'success'
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}
function completedInterval(value) {
  return successful(value) && time(value.started_at) && time(value.completed_at)
    && Date.parse(value.completed_at) >= Date.parse(value.started_at)
}
function exactRepositoryUrl(value, suffix) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.origin === 'https://api.github.com' && !url.search && !url.hash
      && url.pathname.toLowerCase() === ('/repos/' + repository + suffix).toLowerCase()
  } catch { return false }
}
function allowedPath(path) {
  if (/^\/pulls\/[1-9]\d*$/.test(path)) return true
  if (/^\/commits\/[a-f0-9]{40}\/(?:check-runs\?filter=latest&per_page=100|status\?per_page=100)$/.test(path)) return true
  if (/^\/actions\/(?:runs|jobs)\/[1-9]\d*$/.test(path)) return true
  return files.some(file => path.startsWith('/contents/' + file.path + '?ref=')
    && sha(path.slice(('/contents/' + file.path + '?ref=').length)))
}

/** The token is an already-authorized, hash/expiry-checked repo child supplied
 * by the operator. No credential lookup, refresh, write, retry or polling. */
export function createFixtureGithubReader(token, fetchImpl = globalThis.fetch) {
  requireEvidence(nonempty(token), 'read_token_required')
  return async path => {
    requireEvidence(typeof path === 'string' && allowedPath(path), 'read_path_invalid')
    let response
    try {
      response = await fetchImpl(api + path, { method: 'GET', redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15_000) })
    } catch (error) { fail('read_unavailable', { cause: error }) }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'read_unauthorized' : 'read_failed'
      try { await response.body?.cancel() } catch (error) { fail(code, { cause: error }) }
      fail(code)
    }
    let bytes = 0, text = ''
    try {
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 1_048_576) { await reader.cancel(); fail('response_too_large') }
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) {
      if (error?.message === 'issue1503_ci_response_too_large') throw error
      fail('read_unavailable', { cause: error })
    }
    try { return JSON.parse(text) } catch (error) { fail('response_invalid', { cause: error }) }
  }
}
function validateSource(file, response) {
  requireEvidence(response?.type === 'file' && response.path === file.path
    && response.sha === file.gitBlob && response.encoding === 'base64'
    && typeof response.content === 'string' && response.content.length <= 32_768, 'source_mismatch')
  const encoded = response.content.replace(/\s/g, '')
  const bytes = Buffer.from(encoded, 'base64')
  requireEvidence(bytes.toString('base64') === encoded && bytes.length === file.bytes && response.size === file.bytes
    && digest(bytes) === file.sha256
    && createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + bytes.length + '\0'), bytes])).digest('hex') === file.gitBlob,
  'source_mismatch')
  return { path: file.path, gitBlob: file.gitBlob, sha256: file.sha256, bytes: file.bytes }
}
function checkJobLocation(value) {
  try {
    const url = new URL(value)
    requireEvidence(url.origin === 'https://github.com' && !url.search && !url.hash, 'check_job_binding')
    const pattern = new RegExp('^/' + repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/actions/runs/([1-9]\\d*)/job/([1-9]\\d*)$', 'i')
    const match = pattern.exec(url.pathname)
    requireEvidence(match, 'check_job_binding')
    const runId = Number(match[1]), jobId = Number(match[2])
    requireEvidence(integer(runId) && integer(jobId), 'check_job_binding')
    return { runId, jobId }
  } catch (error) {
    if (error?.message?.startsWith('issue1503_ci_')) throw error
    fail('check_job_binding', { cause: error })
  }
}

/** One bounded read of the actual PR, latest exact-head checks/statuses, source,
 * run and job. A missing or unfinished observation fails; it is never polled. */
export async function collectFixtureCiEvidence(read, { candidateSha, pullRequestUrl, expectedBranch }) {
  requireEvidence(typeof read === 'function' && sha(candidateSha) && nonempty(expectedBranch), 'binding_invalid')
  let prNumber
  try {
    const url = new URL(pullRequestUrl)
    const pattern = new RegExp('^/' + repository + '/pull/([1-9]\\d*)$', 'i')
    const match = pattern.exec(url.pathname)
    requireEvidence(url.origin === 'https://github.com' && !url.search && !url.hash && match, 'pr_binding')
    prNumber = Number(match[1])
  } catch (error) {
    if (error?.message?.startsWith('issue1503_ci_')) throw error
    fail('pr_binding', { cause: error })
  }
  requireEvidence(integer(prNumber), 'pr_binding')
  const [pr, checks, statuses] = await Promise.all([
    read('/pulls/' + prNumber),
    read('/commits/' + candidateSha + '/check-runs?filter=latest&per_page=100'),
    read('/commits/' + candidateSha + '/status?per_page=100'),
  ])
  requireEvidence(pr?.number === prNumber && pr.state === 'open' && pr.draft === false
    && pr.user?.login?.toLowerCase() === 'alexj11324'
    && sameRepository(pr.head?.repo?.full_name) && sameRepository(pr.base?.repo?.full_name)
    && pr.head.sha === candidateSha && pr.head.ref === expectedBranch
    && pr.base.ref === 'main' && sha(pr.base.sha), 'pr_binding')
  requireEvidence(Number.isSafeInteger(checks?.total_count) && checks.total_count > 0 && checks.total_count <= 100
    && Array.isArray(checks.check_runs) && checks.check_runs.length === checks.total_count
    && checks.check_runs.every(item => integer(item.id) && item.head_sha === candidateSha && successful(item)), 'checks_not_successful')
  requireEvidence(statuses?.sha === candidateSha && Number.isSafeInteger(statuses.total_count) && statuses.total_count >= 0 && statuses.total_count <= 100
    && Array.isArray(statuses.statuses) && statuses.statuses.length === statuses.total_count
    && (statuses.total_count === 0 || statuses.state === 'success')
    && statuses.statuses.every(item => item.state === 'success'), 'statuses_not_successful')
  const verifyChecks = checks.check_runs.filter(item => item.name === 'verify' && item.app?.slug === 'github-actions')
  requireEvidence(verifyChecks.length === 1, 'verify_check_missing')
  const verify = verifyChecks[0]
  requireEvidence(integer(verify.check_suite?.id), 'check_job_binding')
  const { runId, jobId } = checkJobLocation(verify.details_url)
  const [run, job, ...sourceResponses] = await Promise.all([
    read('/actions/runs/' + runId), read('/actions/jobs/' + jobId),
    ...[candidateSha, pr.base.sha].flatMap(ref => files.map(file => read('/contents/' + file.path + '?ref=' + ref))),
  ])
  const sources = sourceResponses.map((response, index) => ({
    ref: index < files.length ? candidateSha : pr.base.sha,
    ...validateSource(files[index % files.length], response),
  }))
  requireEvidence(run?.id === runId && integer(run.run_attempt) && successful(run)
    && run.name === 'Factory fixture checks' && run.path === workflowPath && run.event === 'pull_request'
    && run.head_sha === candidateSha && run.head_branch === expectedBranch
    && run.check_suite_id === verify.check_suite.id && sameRepository(run.repository?.full_name)
    && sameRepository(run.head_repository?.full_name)
    && Array.isArray(run.pull_requests) && run.pull_requests.length <= 10
    && run.pull_requests.filter(item => item.number === prNumber && item.head?.sha === candidateSha && item.base?.sha === pr.base.sha).length === 1,
  'run_binding')
  requireEvidence(job?.id === jobId && job.run_id === runId && job.run_attempt === run.run_attempt
    && job.name === 'verify' && job.head_sha === candidateSha && job.head_branch === expectedBranch
    && completedInterval(job) && exactRepositoryUrl(job.check_run_url, '/check-runs/' + verify.id)
    && Array.isArray(job.steps) && job.steps.length <= 100, 'job_binding')
  const observedSteps = requiredSteps.map(required => {
    const found = job.steps.filter(step => step.name === required.name)
    requireEvidence(found.length === 1 && integer(found[0].number) && completedInterval(found[0]), 'required_step_not_successful')
    const step = found[0]
    requireEvidence(Date.parse(step.started_at) >= Date.parse(job.started_at)
      && Date.parse(step.completed_at) <= Date.parse(job.completed_at), 'required_step_not_successful')
    return { name: required.name, purpose: required.purpose, number: step.number,
      status: step.status, conclusion: step.conclusion, startedAt: step.started_at, completedAt: step.completed_at,
      ...(required.command ? { commandSha256: digest(required.command) } : {}) }
  })
  requireEvidence(observedSteps.every((step, index) => index === 0 || step.number > observedSteps[index - 1].number), 'step_order_invalid')
  const receipt = immutable({
    schemaVersion: 1, source: 'github_actions_exact_head', repository, candidateSha,
    pullRequestNumber: prNumber, branch: expectedBranch, baseSha: pr.base.sha, sources,
    run: { id: run.id, attempt: run.run_attempt, headSha: run.head_sha, event: run.event,
      workflowPath, status: run.status, conclusion: run.conclusion },
    job: { id: job.id, runId, attempt: job.run_attempt, headSha: job.head_sha,
      status: job.status, conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at,
      steps: observedSteps },
    checks: { checkRunCount: checks.total_count, statusCount: statuses.total_count, verifyCheckRunId: verify.id,
      checkRuns: checks.check_runs.map(item => ({ id: item.id, headSha: item.head_sha,
        status: item.status, conclusion: item.conclusion, nameSha256: digest(item.name ?? '') })),
      statuses: statuses.statuses.map(item => ({ id: Number.isSafeInteger(item.id) ? item.id : null,
        state: item.state, contextSha256: digest(item.context ?? '') })),
      checksSha256: digest(JSON.stringify(checks)), statusesSha256: digest(JSON.stringify(statuses)) },
  })
  verifiedReceipts.add(receipt)
  return receipt
}


const requireImplementation = (condition, code) => { if (!condition) throw new Error('issue1503_' + code) }

/** One existing producer-artifact read, bound to the exact task/run/head. The
 * daemon's successful command and exact file bytes are not a reviewer claim. */
export async function collectFixtureImplementationEvidence(readArtifact, {
  taskId, producerRunId, candidateSha, expectedBranch, command, filePath, expectedText, expectedState,
}) {
  requireEvidence(typeof readArtifact === 'function' && uuid(taskId) && uuid(producerRunId) && sha(candidateSha)
    && typeof expectedBranch === 'string' && /^mikka\/f1503-[a-z0-9-]+$/.test(expectedBranch)
    && nonempty(command) && typeof filePath === 'string' && /^docs\/issue-1503\/[a-zA-Z0-9_-]+\.txt$/.test(filePath)
    && typeof expectedText === 'string' && ['initial', 'revised'].includes(expectedState), 'implementation_binding_invalid')
  const artifact = await readArtifact('/api/factory/tasks/' + taskId + '/approval?artifact='
    + encodeURIComponent('run-report:' + producerRunId))
  const publish = artifact?.raw?.publish
  requireImplementation(publish?.pushed === true && publish.branch === expectedBranch
    && publish.commit === candidateSha && publish.remote === 'origin', 'publication_report_mismatch')
  const verifiedContent = verifiedFileBytes(artifact?.raw, command, filePath, expectedText, expectedState)
  const receipt = immutable({ source: 'mikka_daemon_fixture_verification', taskId, producerRunId, candidateSha,
    branch: expectedBranch, filePath, expectedState, bytes: verifiedContent.bytes, sha256: verifiedContent.sha256,
    commandSha256: verifiedContent.commandSha256, reportSha256: digest(JSON.stringify(artifact.raw)) })
  verifiedImplementationReceipts.add(receipt)
  return { artifact, verifiedContent, receipt }
}

export function verifiedFileBytes(report, command, filePath, expectedText, expectedState) {
  const verify = report?.verify
  requireImplementation(verify?.status === 'passed' && verify.command === command && verify.exitCode === 0
    && verify.timedOut === false && verify.signal === null, 'implementation_command_verification_missing')
  let receipt
  try { receipt = JSON.parse(verify.output?.trim().split('\n').at(-1)) } catch {}
  const matches = receipt?.issue === 1503 && Array.isArray(receipt.files) ? receipt.files.filter(item => item.path === filePath) : []
  requireImplementation(matches.length === 1 && matches[0].state === expectedState && matches[0].bytes === Buffer.byteLength(expectedText)
    && matches[0].sha256 === digest(expectedText), 'implementation_file_bytes_mismatch')
  return { ...matches[0], source: 'daemon_verify', commandSha256: digest(command) }
}

/** Preserve original review fields. Only the three exact, separately proven
 * fixture execution/CI requirements may remain honestly unverified. No scope,
 * unknown, failed, malformed, duplicate or missing-evidence item is waived. */
export function reviewCriteriaEvidence(criteria, candidateSha, receipt, { requireExplicitStatus = false, implementationReceipt = null } = {}) {
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 200) return null
  const covered = [], seenExternal = new Set()
  for (const [index, criterion] of criteria.entries()) {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return null
    const externalId = typeof criterion.text === 'string' && Object.hasOwn(EXTERNAL_CRITERIA, criterion.text) ? EXTERNAL_CRITERIA[criterion.text] : null
    // Both exact terminal-period forms name the same observed fixture command.
    const implementationId = (criterion.text === IMPLEMENTATION_CRITERION
      || criterion.text === IMPLEMENTATION_CRITERION.slice(0, -1)) ? 'implementation_file_command' : null
    const observationId = externalId ?? implementationId
    if (observationId) {
      if (seenExternal.has(observationId)) return null
      seenExternal.add(observationId)
    }
    if (criterion.passed === true && (criterion.status ?? (requireExplicitStatus ? null : 'passed')) === 'passed'
      && nonempty(criterion.evidence)) continue
    if (!observationId || criterion.passed !== false || criterion.status !== 'unverified'
      || !nonempty(criterion.reason) || criterion.reason.length > 2000) return null
    if (implementationId) {
      if (!implementationReceipt || !verifiedImplementationReceipts.has(implementationReceipt)
        || implementationReceipt.candidateSha !== candidateSha) return null
      covered.push({ index: index + 1, criterion: implementationId, source: implementationReceipt.source,
        taskId: implementationReceipt.taskId, producerRunId: implementationReceipt.producerRunId, candidateSha,
        fileSha256: implementationReceipt.sha256, commandSha256: implementationReceipt.commandSha256,
        reportSha256: implementationReceipt.reportSha256 })
    } else {
      if (!receipt || !verifiedReceipts.has(receipt) || receipt.candidateSha !== candidateSha) return null
      covered.push({ index: index + 1, criterion: externalId, source: receipt.source,
        candidateSha, workflowRunId: receipt.run.id, jobId: receipt.job.id })
    }
  }
  return { covered }
}
