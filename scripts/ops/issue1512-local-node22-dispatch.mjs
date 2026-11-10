// Temporary issue1512 dispatcher. It never loads or changes product code.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'alexj11324/Mikka'
const branch = 'fix/1512-daemon-fixture-executable-20261109'
const opsRef = 'refs/heads/ops/1512-local-node22-dispatch-20261110'
const workflowId = 409752684
const workflowPath = '.github/workflows/local-device-node22.yml'
const servicePath = 'packages/daemon/src/service.ts'
const serviceBlob = '277fae47e47d1ce4a2061838b1f08f457b7b3355'
const fixturePath = 'scripts/acceptance/local-installer-macos.ts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const receiptPath = join(root, 'artifacts/issue1512-local-node22-dispatch/receipt.safe.json')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const receipt = { schema: 'issue1512.local-node22-dispatch-result.v1',
  requestId: '20261110-local-node22-formal-a1', startedAt: new Date().toISOString(),
  control: null, target: null, requests: [], preexistingRuns: null,
  refBefore: null, post: { attempted: false, accepted: false, response: null },
  refAfter: null, run: null, status: 'not_dispatched', errorCode: null,
  boundary: 'One POST only. Unknown submission outcomes must be investigated by metadata, never retried automatically. Accepted dispatch is not test success.' }
let phase = 'validate', token = '', postCount = 0
function fail(code) { const error = new Error(code); error.safeCode = code; throw error }
function requireCondition(value, code) { if (!value) fail(code) }
async function request(label, path, method = 'GET', body) {
  requireCondition(path.startsWith('/repos/' + repository + '/'), 'REQUEST_DESTINATION_INVALID')
  requireCondition(method === 'GET' || (method === 'POST' &&
    path === '/repos/' + repository + '/actions/workflows/' + workflowId + '/dispatches' && postCount++ === 0), 'POST_LIMIT_EXCEEDED')
  const record = { label, method, startedAt: new Date().toISOString(),
    status: null, bodyBytes: null, bodySha256: null, transport: 'unknown' }
  receipt.requests.push(record)
  try {
    const response = await fetch('https://api.github.com' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    record.status = response.status
    if (method === 'POST') {
      receipt.post.status = response.status
      receipt.post.accepted = response.status === 200 || response.status === 204
    }
    const chunks = [], reader = response.body?.getReader()
    let length = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > 131072) { await reader.cancel(); fail('RESPONSE_TOO_LARGE') }
        chunks.push(value)
      }
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
  } finally { record.finishedAt = new Date().toISOString() }
}
async function get(label, path) {
  const response = await request(label, '/repos/' + repository + path)
  requireCondition(response.status === 200, 'READ_HTTP_NON_200')
  return response.value
}
async function readRef(label) {
  const value = await get(label, '/git/ref/heads/' + branch)
  requireCondition(value?.ref === 'refs/heads/' + branch && value.object?.type === 'commit' && isSha(value.object.sha), 'REF_RESPONSE_INVALID')
  return value.object.sha
}
async function main() {
  const manifest = JSON.parse(await readFile(join(root, '.github/issue1512-local-node22-dispatch.json'), 'utf8'))
  requireCondition(manifest.schema === 'issue1512.local-node22-dispatch-request.v1' && manifest.enabled === true, 'ENTRY_DISABLED')
  requireCondition(manifest.requestId === receipt.requestId && manifest.repository === repository &&
    manifest.branch === branch && manifest.workflowId === workflowId && manifest.workflowPath === workflowPath, 'MANIFEST_SCOPE_INVALID')
  requireCondition(isSha(manifest.target?.commit) && isSha(manifest.target?.tree) &&
    isSha(manifest.target?.workflowBlob) && isSha(manifest.target?.fixtureBlob) &&
    manifest.target?.serviceBlob === serviceBlob, 'TARGET_NOT_FIXED')
  requireCondition(process.env.GITHUB_REPOSITORY === repository && process.env.GITHUB_EVENT_NAME === 'push' &&
    process.env.GITHUB_REF === opsRef && process.env.GITHUB_RUN_ATTEMPT === '1' &&
    isSha(process.env.GITHUB_SHA) && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? ''), 'CONTROL_RUN_INVALID')
  const actualControl = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim()
  requireCondition(actualControl === process.env.GITHUB_SHA, 'CONTROL_CHECKOUT_MISMATCH')
  requireCondition(manifest.controller?.path === 'scripts/ops/issue1512-local-node22-dispatch.mjs' &&
    sha256(await readFile(fileURLToPath(import.meta.url))) === manifest.controller.sha256, 'CONTROLLER_HASH_MISMATCH')
  token = process.env.MIKKA_DISPATCH_TOKEN ?? ''
  requireCondition(token.length > 0, 'TOKEN_UNAVAILABLE')
  receipt.control = { commit: actualControl, runId: process.env.GITHUB_RUN_ID, attempt: 1 }
  receipt.target = { ...manifest.target, repository, branch, workflowId, workflowPath }
  phase = 'preflight'
  const existing = await get('existing_target_runs', '/actions/workflows/' + workflowId + '/runs?head_sha=' + manifest.target.commit + '&per_page=100')
  requireCondition(Number.isInteger(existing?.total_count) && Array.isArray(existing.workflow_runs), 'RUN_LIST_INVALID')
  receipt.preexistingRuns = existing.total_count
  requireCondition(existing.total_count === 0 && existing.workflow_runs.length === 0, 'TARGET_ALREADY_HAS_RUN')
  const commit = await get('target_commit', '/git/commits/' + manifest.target.commit)
  requireCondition(commit?.sha === manifest.target.commit && commit.tree?.sha === manifest.target.tree, 'TARGET_TREE_MISMATCH')
  for (const [label, path, expected] of [
    ['target_workflow', workflowPath, manifest.target.workflowBlob],
    ['target_service', servicePath, serviceBlob],
    ['target_fixture', fixturePath, manifest.target.fixtureBlob],
  ]) {
    const file = await get(label, '/contents/' + path + '?ref=' + manifest.target.commit)
    requireCondition(file?.type === 'file' && file.path === path && file.sha === expected, 'TARGET_FILE_MISMATCH')
  }
  receipt.refBefore = await readRef('ref_before')
  requireCondition(receipt.refBefore === manifest.target.commit, 'REF_BEFORE_MISMATCH')
  phase = 'post'
  receipt.post.attempted = true
  let postError = null
  try {
    const response = await request('dispatch', '/repos/' + repository + '/actions/workflows/' + workflowId + '/dispatches', 'POST', { ref: branch })
    receipt.post.accepted = response.status === 200 || response.status === 204
    receipt.post.status = response.status
    if (response.status === 200) {
      const value = response.value, id = value?.workflow_run_id
      requireCondition(Number.isSafeInteger(id) && id > 0 &&
        value.run_url === 'https://api.github.com/repos/' + repository + '/actions/runs/' + id &&
        value.html_url === 'https://github.com/' + repository + '/actions/runs/' + id, 'DISPATCH_RESPONSE_UNVERIFIED')
      receipt.post.response = { workflow_run_id: id, run_url: value.run_url, html_url: value.html_url }
    }
    requireCondition(response.status === 200 || response.status === 204, 'DISPATCH_HTTP_NON_SUCCESS')
  } catch (error) { postError = error }
  finally {
    phase = 'ref_after'
    try {
      receipt.refAfter = await readRef('ref_after')
      requireCondition(receipt.refAfter === manifest.target.commit, 'REF_AFTER_MISMATCH')
    } catch (error) { if (!postError) postError = error; receipt.refAfterVerified = false }
  }
  if (postError) throw postError
  receipt.refAfterVerified = true
  phase = 'verify_dispatched_run'
  let run
  if (receipt.post.response) {
    run = await get('returned_run', '/actions/runs/' + receipt.post.response.workflow_run_id)
    requireCondition(run?.id === receipt.post.response.workflow_run_id, 'RETURNED_RUN_ID_MISMATCH')
  } else {
    // Standard 204 means accepted. One bounded metadata read, never another POST.
    const discovered = await get('discover_accepted_run', '/actions/workflows/' + workflowId +
      '/runs?head_sha=' + manifest.target.commit + '&event=workflow_dispatch&per_page=100')
    requireCondition(Number.isInteger(discovered?.total_count) && Array.isArray(discovered.workflow_runs), 'RUN_LIST_INVALID')
    receipt.discoveredRuns = discovered.total_count
    if (discovered.total_count === 0 && discovered.workflow_runs.length === 0) {
      receipt.status = 'dispatch_accepted_run_pending'
      return
    }
    requireCondition(discovered.total_count === 1 && discovered.workflow_runs.length === 1, 'DISPATCH_RUN_DISCOVERY_AMBIGUOUS')
    run = discovered.workflow_runs[0]
  }
  requireCondition(Number.isSafeInteger(run?.id) && run.id > 0 && run.workflow_id === workflowId &&
    run.head_sha === manifest.target.commit && run.head_branch === branch &&
    run.event === 'workflow_dispatch' && run.run_attempt === 1, 'DISPATCHED_RUN_BINDING_MISMATCH')
  receipt.run = { id: run.id, workflowId: run.workflow_id, head: run.head_sha, branch: run.head_branch,
    event: run.event, attempt: run.run_attempt }
  receipt.status = 'dispatched_source_verified'
}
try { await main() }
catch (error) {
  receipt.errorCode = typeof error?.safeCode === 'string' ? error.safeCode : 'LOCAL_CHECK_FAILED'
  receipt.failedPhase = phase
  receipt.status = receipt.post.attempted ? 'dispatch_requires_inspection' : 'not_dispatched'
  process.exitCode = 1
} finally {
  token = ''
  receipt.finishedAt = new Date().toISOString()
  receipt.postCalls = postCount
  await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 })
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(receipt))
}
