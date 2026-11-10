// Temporary issue1512 production transport. No product/account code is loaded here.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'alexj11324/Mikka'
const opsBranch = 'ops/1512-git-transport'
const opsRef = 'refs/heads/' + opsBranch
const targetBranch = 'main'
const workflowId = 410611055
const workflowPath = '.github/workflows/run-trace-acceptance.yml'
const workflowBlob = 'ebbf83b8d39c5471f9daaf0ed9bf0dfa758214e4'
const manifestPath = '.github/issue1512-dispatch.json'
const controlWorkflowPath = '.github/workflows/issue1512-git-transport.yml'
const controllerPath = 'scripts/ops/issue1512-production-dispatch.mjs'
const versionUrl = 'https://app.aspectlylabs.com/mikka/api/version'
const self = fileURLToPath(import.meta.url)
const root = resolve(dirname(self), '../..')
const apiBase = '/repos/' + repository
const postPath = apiBase + '/actions/workflows/' + workflowId + '/dispatches'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const gitBlob = value => createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex')
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const inputKeys = ['mode', 'expected-deployment-sha', 'model-case', 'prepare', 'browser-submit', 'export-target', 'export-id', 'session-id', 'trace-id']
function fail(code) { const error = new Error(code); error.safeCode = code; throw error }
function requireCondition(value, code) { if (!value) fail(code) }

export function validateInputs(input, targetCommit) {
  requireCondition(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => inputKeys.includes(key)), 'INPUT_KEYS_INVALID')
  const value = { ...input, 'export-target': input['export-target'] ?? 'dashboard',
    'export-id': input['export-id'] ?? '', 'session-id': input['session-id'] ?? '', 'trace-id': input['trace-id'] ?? '' }
  requireCondition(inputKeys.every(key => typeof value[key] === 'string' && value[key].length <= 100), 'INPUT_TYPE_INVALID')
  requireCondition(['preflight', 'execute', 'export', 'controlled-failure'].includes(value.mode) &&
    ['all', 'claude', 'codex'].includes(value['model-case']), 'INPUT_MODE_INVALID')
  requireCondition(isSha(targetCommit) && value['expected-deployment-sha'] === targetCommit, 'INPUT_TARGET_MISMATCH')
  for (const key of ['prepare', 'browser-submit']) requireCondition(['true', 'false'].includes(value[key]), 'INPUT_BOOLEAN_INVALID')
  requireCondition(value.mode === 'execute' || value.prepare === 'false' && value['browser-submit'] === 'false', 'INPUT_EXECUTE_ONLY')
  requireCondition(value['browser-submit'] === 'false' || value['model-case'] !== 'all', 'INPUT_BROWSER_CASE_INVALID')
  requireCondition(['dashboard', 'insight'].includes(value['export-target']) &&
    (value['export-id'] === '' || /^[1-9][0-9]{0,14}$/.test(value['export-id'])), 'INPUT_EXPORT_INVALID')
  if (value.mode === 'export') requireCondition(value['export-id'] !== '', 'INPUT_EXPORT_ID_REQUIRED')
  const sessionId = value['session-id'], traceId = value['trace-id']
  if (sessionId || traceId) {
    requireCondition(value.mode === 'export' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId) &&
      sessionId !== '00000000-0000-0000-0000-000000000000' &&
      /^[0-9a-f]{32}$/.test(traceId) && traceId !== '0'.repeat(32), 'INPUT_REPLAY_INVALID')
  }
  if (value.mode === 'controlled-failure') requireCondition(value['model-case'] === 'all' &&
    value['export-target'] === 'dashboard' && !value['export-id'] && !sessionId && !traceId, 'INPUT_ISOLATED_MODE_INVALID')
  return value
}

// Dependencies permit offline protocol tests; defaults only operate inside the explicitly guarded Actions run.
export async function dispatchProduction({ env = process.env, fetchImpl = fetch, read = readFile,
  git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 }).trimEnd(),
  now = () => new Date().toISOString() } = {}) {
  const receipt = { schema: 'issue1512.production-dispatch-result.v1', startedAt: now(),
    requestId: null, control: null, target: null, inputs: null, requests: [], preexistingRuns: null,
    refBefore: null, versionBefore: null, post: { attempted: false, outcome: 'not_attempted', status: null, response: null },
    refAfter: null, versionAfter: null, afterChecks: null, run: null, status: 'not_dispatched', errorCode: null,
    boundary: 'Exactly one POST maximum. An unknown or accepted submission must never be retried. Metadata discovery without a server-returned run ID is a candidate, not proof of input attribution. Dispatch is not acceptance success.' }
  let phase = 'validate', token = '', postCount = 0
  function safeCode(error) { return typeof error?.safeCode === 'string' ? error.safeCode : 'LOCAL_CHECK_FAILED' }
  async function request(label, destination, path, method = 'GET', body) {
    requireCondition(destination === 'github' && path.startsWith(apiBase + '/') ||
      destination === 'public' && path === versionUrl && method === 'GET', 'REQUEST_DESTINATION_INVALID')
    requireCondition(method === 'GET' || destination === 'github' && method === 'POST' && path === postPath && postCount === 0,
      'POST_LIMIT_EXCEEDED')
    if (method === 'POST') postCount++
    const record = { label, destination, method, startedAt: now(), status: null, bodyBytes: null,
      bodySha256: null, transport: 'unknown' }
    receipt.requests.push(record)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    if (method === 'POST') {
      receipt.post.attempted = true
      receipt.post.outcome = 'unknown'
      receipt.post.startedAt = record.startedAt
      receipt.post.requestBodySha256 = sha256(payload)
    }
    try {
      const response = await fetchImpl(destination === 'github' ? 'https://api.github.com' + path : path, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: destination === 'github' ? {
          Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json',
        } : { Accept: 'application/json', 'Cache-Control': 'no-store' },
        ...(payload === undefined ? {} : { body: payload }),
      })
      record.status = response.status
      if (method === 'POST') {
        receipt.post.status = response.status
        receipt.post.outcome = response.status === 200 || response.status === 204 ? 'accepted' : 'non_success_response_requires_inspection'
      }
      const chunks = [], reader = response.body?.getReader()
      let length = 0
      if (reader) while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > 131072) { await reader.cancel().catch(() => {}); fail('RESPONSE_TOO_LARGE') }
        chunks.push(value)
      }
      const bytes = Buffer.concat(chunks)
      record.bodyBytes = bytes.length
      record.bodySha256 = sha256(bytes)
      record.transport = 'received'
      let value = null
      if (bytes.length) {
        try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('RESPONSE_NOT_JSON') }
      }
      return { status: response.status, value }
    } catch (error) {
      if (error?.safeCode) throw error
      record.transport = error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'AbortError' ? 'aborted' : 'error'
      fail(method === 'POST' ? 'POST_OUTCOME_UNKNOWN' : 'READ_FAILED')
    } finally { record.finishedAt = now() }
  }
  async function get(label, path) {
    const response = await request(label, 'github', apiBase + path)
    requireCondition(response.status === 200, 'READ_HTTP_NON_200')
    return response.value
  }
  async function readRef(label, branch) {
    const value = await get(label, '/git/ref/heads/' + branch)
    requireCondition(value?.ref === 'refs/heads/' + branch && value.object?.type === 'commit' &&
      isSha(value.object.sha), 'REF_RESPONSE_INVALID')
    return value.object.sha
  }
  async function readVersion(label) {
    const response = await request(label, 'public', versionUrl)
    requireCondition(response.status === 200, 'VERSION_HTTP_NON_200')
    requireCondition(isSha(response.value?.build), 'VERSION_RESPONSE_INVALID')
    return { build: response.value.build,
      overlaySha: isSha(response.value.overlaySha) ? response.value.overlaySha : null }
  }
  function runList(value, targetCommit) {
    requireCondition(Number.isInteger(value?.total_count) && value.total_count >= 0 && value.total_count <= 100 &&
      Array.isArray(value.workflow_runs) && value.workflow_runs.length === value.total_count, 'RUN_LIST_INCOMPLETE')
    const ids = new Set()
    for (const run of value.workflow_runs) {
      requireCondition(Number.isSafeInteger(run?.id) && run.id > 0 && !ids.has(run.id) &&
        run.workflow_id === workflowId && run.head_sha === targetCommit && run.head_branch === targetBranch &&
        run.event === 'workflow_dispatch', 'RUN_LIST_BINDING_INVALID')
      ids.add(run.id)
    }
    return value.workflow_runs
  }
  function runProjection(run, attribution) {
    return { id: run.id, workflowId: run.workflow_id, head: run.head_sha, branch: run.head_branch,
      event: run.event, attempt: run.run_attempt, status: run.status,
      createdAt: run.created_at ?? null, attribution }
  }
  try {
    const manifest = JSON.parse(await read(join(root, manifestPath), 'utf8'))
    requireCondition(manifest.schema === 'issue1512.production-dispatch-request.v1' && manifest.enabled === true, 'ENTRY_DISABLED')
    requireCondition(manifest.repository === repository && manifest.opsBranch === opsBranch &&
      manifest.target?.branch === targetBranch && manifest.target?.workflowId === workflowId &&
      manifest.target?.workflowPath === workflowPath && manifest.target?.workflowBlob === workflowBlob, 'MANIFEST_SCOPE_INVALID')
    requireCondition(isUuid(manifest.requestId) && isSha(manifest.target?.commit) && isSha(manifest.target?.tree) &&
      isSha(manifest.controlWorkflowBlob), 'REQUEST_NOT_FIXED')
    const inputs = validateInputs(manifest.inputs, manifest.target.commit)
    const expectedMessage = 'issue1512:dispatch ' + inputs.mode + ' ' + manifest.requestId
    requireCondition(manifest.activationCommitMessage === expectedMessage, 'MANIFEST_MESSAGE_INVALID')
    requireCondition(env.GITHUB_REPOSITORY === repository && env.GITHUB_EVENT_NAME === 'push' &&
      env.GITHUB_REF === opsRef && env.GITHUB_RUN_ATTEMPT === '1' && isSha(env.GITHUB_SHA) &&
      /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && typeof env.GITHUB_EVENT_PATH === 'string' &&
      env.GITHUB_EVENT_PATH.length > 0, 'CONTROL_RUN_INVALID')
    const event = JSON.parse(await read(env.GITHUB_EVENT_PATH, 'utf8'))
    requireCondition(event.repository?.full_name === repository && event.ref === opsRef &&
      event.deleted !== true && event.forced !== true && event.after === env.GITHUB_SHA &&
      event.head_commit?.id === env.GITHUB_SHA && event.head_commit?.message === expectedMessage, 'CONTROL_EVENT_INVALID')
    const actualControl = git(['rev-parse', 'HEAD'])
    requireCondition(actualControl === env.GITHUB_SHA && git(['show', '-s', '--format=%B', 'HEAD']) === expectedMessage,
      'CONTROL_CHECKOUT_MISMATCH')
    requireCondition(manifest.controller?.path === controllerPath &&
      /^[a-f0-9]{64}$/.test(manifest.controller?.sha256 ?? '') &&
      sha256(await read(self)) === manifest.controller.sha256, 'CONTROLLER_HASH_MISMATCH')
    requireCondition(gitBlob(await read(join(root, controlWorkflowPath))) === manifest.controlWorkflowBlob, 'CONTROL_WORKFLOW_MISMATCH')
    token = env.MIKKA_DISPATCH_TOKEN ?? ''
    requireCondition(token.length > 0, 'TOKEN_UNAVAILABLE')
    receipt.requestId = manifest.requestId
    receipt.control = { commit: actualControl, runId: env.GITHUB_RUN_ID, attempt: 1,
      message: expectedMessage, workflowBlob: manifest.controlWorkflowBlob, controllerSha256: manifest.controller.sha256 }
    receipt.target = { commit: manifest.target.commit, tree: manifest.target.tree, branch: targetBranch,
      workflowId, workflowPath, workflowBlob, versionUrl }
    receipt.inputs = inputs
    phase = 'preflight'
    const currentControl = await readRef('control_ref_before', opsBranch)
    requireCondition(currentControl === actualControl, 'CONTROL_REF_MOVED')
    const commit = await get('target_commit', '/git/commits/' + manifest.target.commit)
    requireCondition(commit?.sha === manifest.target.commit && commit.tree?.sha === manifest.target.tree, 'TARGET_TREE_MISMATCH')
    const targetWorkflow = await get('target_workflow_metadata', '/actions/workflows/' + workflowId)
    requireCondition(targetWorkflow?.id === workflowId && targetWorkflow.path === workflowPath && targetWorkflow.state === 'active', 'TARGET_WORKFLOW_ID_MISMATCH')
    const file = await get('target_workflow', '/contents/' + workflowPath + '?ref=' + manifest.target.commit)
    requireCondition(file?.type === 'file' && file.path === workflowPath && file.sha === workflowBlob, 'TARGET_WORKFLOW_MISMATCH')
    const listPath = '/actions/workflows/' + workflowId + '/runs?head_sha=' + manifest.target.commit + '&event=workflow_dispatch&per_page=100'
    const existing = runList(await get('existing_target_runs', listPath), manifest.target.commit)
    receipt.preexistingRuns = existing.map(run => runProjection(run, 'preexisting'))
    requireCondition(existing.every(run => run.status === 'completed'), 'TARGET_RUN_ACTIVE')
    const previousIds = new Set(existing.map(run => run.id))
    receipt.versionBefore = await readVersion('version_before')
    requireCondition(receipt.versionBefore.build === manifest.target.commit, 'VERSION_BEFORE_MISMATCH')
    receipt.refBefore = await readRef('main_ref_before', targetBranch)
    requireCondition(receipt.refBefore === manifest.target.commit, 'REF_BEFORE_MISMATCH')
    phase = 'post'
    let postError = null
    try {
      const response = await request('dispatch', 'github', postPath, 'POST',
        { ref: targetBranch, inputs, return_run_details: true })
      if (response.status === 200) {
        const value = response.value, id = value?.workflow_run_id
        requireCondition(Number.isSafeInteger(id) && id > 0 && !previousIds.has(id) &&
          value.run_url === 'https://api.github.com/repos/' + repository + '/actions/runs/' + id &&
          value.html_url === 'https://github.com/' + repository + '/actions/runs/' + id, 'DISPATCH_RESPONSE_UNVERIFIED')
        receipt.post.response = { workflow_run_id: id, run_url: value.run_url, html_url: value.html_url }
      }
      requireCondition(response.status === 200 || response.status === 204, 'DISPATCH_HTTP_NON_SUCCESS')
    } catch (error) { receipt.post.errorCode = safeCode(error); postError = error }
    finally {
      phase = 'after_checks'
      receipt.afterChecks = { main: false, publicVersion: false, errors: [] }
      try {
        receipt.refAfter = await readRef('main_ref_after', targetBranch)
        requireCondition(receipt.refAfter === manifest.target.commit, 'REF_AFTER_MISMATCH')
        receipt.afterChecks.main = true
      } catch (error) { receipt.afterChecks.errors.push(safeCode(error)); if (!postError) postError = error }
      try {
        receipt.versionAfter = await readVersion('version_after')
        requireCondition(receipt.versionAfter.build === manifest.target.commit, 'VERSION_AFTER_MISMATCH')
        receipt.afterChecks.publicVersion = true
      } catch (error) { receipt.afterChecks.errors.push(safeCode(error)); if (!postError) postError = error }
    }
    if (postError) throw postError
    phase = 'verify_dispatched_run'
    let run, attribution
    if (receipt.post.response) {
      run = await get('returned_run', '/actions/runs/' + receipt.post.response.workflow_run_id)
      requireCondition(run?.id === receipt.post.response.workflow_run_id, 'RETURNED_RUN_ID_MISMATCH')
      attribution = 'server_returned_run_id'
    } else {
      // A 204 is accepted, not a failure. One read may discover a candidate; never a second POST.
      const discovered = runList(await get('discover_accepted_run', listPath), manifest.target.commit)
      const candidates = discovered.filter(item => !previousIds.has(item.id))
      receipt.discoveredNewRunIds = candidates.map(item => item.id)
      if (candidates.length === 0) { receipt.status = 'dispatch_accepted_run_pending'; return receipt }
      requireCondition(candidates.length === 1, 'DISPATCH_RUN_DISCOVERY_AMBIGUOUS')
      run = candidates[0]
      attribution = 'unique_new_metadata_candidate_not_input_proof'
    }
    requireCondition(Number.isSafeInteger(run?.id) && run.id > 0 && !previousIds.has(run.id) &&
      run.workflow_id === workflowId && run.head_sha === manifest.target.commit && run.head_branch === targetBranch &&
      run.event === 'workflow_dispatch' && run.run_attempt === 1, 'DISPATCHED_RUN_BINDING_MISMATCH')
    receipt.run = runProjection(run, attribution)
    receipt.status = attribution === 'server_returned_run_id' ? 'dispatched_source_verified' : 'dispatch_accepted_candidate_source_verified'
  } catch (error) {
    receipt.errorCode = safeCode(error)
    receipt.failedPhase = phase
    receipt.status = receipt.post.attempted ? 'dispatch_requires_inspection' : 'not_dispatched'
  } finally {
    token = ''
    receipt.postCalls = postCount
    receipt.finishedAt = now()
  }
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  const receipt = await dispatchProduction()
  const receiptPath = join(root, 'artifacts/issue1512-production-dispatch/receipt.safe.json')
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 })
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(receipt))
  if (receipt.errorCode) process.exitCode = 1
}
