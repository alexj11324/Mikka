import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dispatchProduction, validateInputs } from './issue1512-production-dispatch.mjs'

const controller = await readFile(new URL('./issue1512-production-dispatch.mjs', import.meta.url))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const blob = value => createHash('sha1').update('blob ' + Buffer.byteLength(value) + '\0').update(value).digest('hex')
const D = 'd'.repeat(40), C = 'c'.repeat(40), T = 'e'.repeat(40), other = 'a'.repeat(40)
const repository = 'alexj11324/Mikka', branch = 'ops/1512-git-transport', workflowId = 410611055
const workflowPath = '.github/workflows/run-trace-acceptance.yml'
const workflowBlob = 'ebbf83b8d39c5471f9daaf0ed9bf0dfa758214e4'
const versionUrl = 'https://app.aspectlylabs.com/mikka/api/version'
const controlWorkflow = Buffer.from('name: offline-only fixture\njobs: {}\n')
const secret = 'DUMMY_OFFLINE_DISPATCH_SECRET_DO_NOT_PRINT'
const uuid = '3d60e2bc-7a6f-483a-932b-f8a37492f61e'
const input = { mode: 'preflight', 'expected-deployment-sha': D, 'model-case': 'all',
  prepare: 'false', 'browser-submit': 'false', 'export-target': 'dashboard',
  'export-id': '', 'session-id': '', 'trace-id': '' }
const baseRun = { id: 2001, workflow_id: workflowId, head_sha: D, head_branch: 'main',
  event: 'workflow_dispatch', run_attempt: 1, status: 'queued', created_at: '2026-11-10T04:00:00Z' }
const oldRun = { ...baseRun, id: 1901, status: 'completed' }

function response(status, value) {
  return new Response(status === 204 ? null : JSON.stringify(value), { status })
}
function fixture(options = {}) {
  const manifest = { schema: 'issue1512.production-dispatch-request.v1', enabled: true,
    repository, opsBranch: branch, requestId: uuid,
    activationCommitMessage: 'issue1512:dispatch preflight ' + uuid,
    controlWorkflowBlob: blob(controlWorkflow),
    controller: { path: 'scripts/ops/issue1512-production-dispatch.mjs', sha256: sha256(controller) },
    target: { branch: 'main', commit: D, tree: T, workflowId, workflowPath, workflowBlob },
    inputs: { ...input, ...options.inputs } }
  manifest.activationCommitMessage = 'issue1512:dispatch ' + manifest.inputs.mode + ' ' + uuid
  Object.assign(manifest, options.manifest ?? {})
  const env = { GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/' + branch, GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: C, GITHUB_RUN_ID: '1001', GITHUB_EVENT_PATH: '/offline/event.json',
    MIKKA_DISPATCH_TOKEN: secret, ...options.env }
  const event = { repository: { full_name: repository }, ref: 'refs/heads/' + branch,
    deleted: false, forced: false, after: C,
    head_commit: { id: C, message: manifest.activationCommitMessage }, ...options.event }
  const calls = []
  let mainReads = 0, versionReads = 0, listReads = 0
  const dependencies = { env,
    now: () => '2026-11-10T04:00:00.123Z',
    git: args => args[0] === 'rev-parse' ? options.checkout ?? C : options.localMessage ?? manifest.activationCommitMessage,
    read: async path => {
      if (path === env.GITHUB_EVENT_PATH) return JSON.stringify(event)
      if (path.endsWith('/.github/issue1512-dispatch.json')) return JSON.stringify(manifest)
      if (path.endsWith('/.github/workflows/issue1512-git-transport.yml')) return controlWorkflow
      if (path.endsWith('/scripts/ops/issue1512-production-dispatch.mjs')) return controller
      throw new Error('Unexpected offline file')
    },
    fetchImpl: async (url, request) => {
      calls.push({ url, request })
      if (url === versionUrl) {
        assert.equal(request.headers.Authorization, undefined, 'No GitHub token may reach the public version endpoint')
        versionReads++
        return response(200, { build: versionReads === 1 ? options.versionBefore ?? D : options.versionAfter ?? D,
          overlaySha: 'b'.repeat(40) })
      }
      assert.ok(url.startsWith('https://api.github.com/repos/' + repository + '/'))
      assert.equal(request.headers.Authorization, 'Bearer ' + secret)
      if (request.method === 'POST') {
        assert.ok(url.endsWith('/actions/workflows/' + workflowId + '/dispatches'))
        assert.equal(calls.filter(call => call.request.method === 'POST').length, 1)
        const body = JSON.parse(request.body)
        assert.equal(body.ref, 'main')
        assert.equal(body.return_run_details, true)
        assert.equal(body.inputs['expected-deployment-sha'], D)
        if (options.postThrow) { const error = new Error(secret); error.name = 'TimeoutError'; throw error }
        if (options.postRaw) return new Response(options.postRaw, { status: 200 })
        const status = options.postStatus ?? 200
        return response(status, options.postBody ?? { workflow_run_id: 2001,
          run_url: 'https://api.github.com/repos/' + repository + '/actions/runs/2001',
          html_url: 'https://github.com/' + repository + '/actions/runs/2001' })
      }
      assert.equal(request.method, 'GET')
      if (url.endsWith('/git/ref/heads/' + branch)) return response(200,
        { ref: 'refs/heads/' + branch, object: { type: 'commit', sha: options.controlRef ?? C } })
      if (url.endsWith('/git/ref/heads/main')) {
        mainReads++
        return response(200, { ref: 'refs/heads/main', object: { type: 'commit',
          sha: mainReads === 1 ? options.mainBefore ?? D : options.mainAfter ?? D } })
      }
      if (url.endsWith('/git/commits/' + D)) return response(200, { sha: D, tree: { sha: options.tree ?? T } })
      if (url.endsWith('/actions/workflows/' + workflowId)) return response(200,
        { id: workflowId, path: options.workflowPath ?? workflowPath, state: 'active' })
      if (url.includes('/contents/' + workflowPath)) return response(200,
        { type: 'file', path: workflowPath, sha: options.workflowBlob ?? workflowBlob })
      if (url.includes('/actions/workflows/' + workflowId + '/runs?')) {
        listReads++
        const runs = listReads === 1 ? options.existing ?? [] : options.discovered ?? []
        return response(200, { total_count: options.totalCount ?? runs.length, workflow_runs: runs })
      }
      if (url.endsWith('/actions/runs/2001')) return response(200, { ...baseRun, ...options.returnedRun })
      throw new Error('Unexpected offline request')
    } }
  return { manifest, env, event, dependencies, calls, reads: () => ({ mainReads, versionReads, listReads }) }
}
async function runCase(options = {}) {
  const state = fixture(options), receipt = await dispatchProduction(state.dependencies)
  assert.ok(state.calls.filter(call => call.request.method === 'POST').length <= 1)
  assert.equal(receipt.postCalls, state.calls.filter(call => call.request.method === 'POST').length)
  assert.equal(JSON.stringify(receipt).includes(secret), false, 'Safe receipt never includes token or raw exception message')
  return { ...state, receipt }
}

test('200: prior completed mode is allowed; direct returned ID binds the new run', async () => {
  const { receipt, calls } = await runCase({ existing: [oldRun] })
  assert.equal(receipt.status, 'dispatched_source_verified')
  assert.equal(receipt.run.id, 2001)
  assert.equal(receipt.run.attribution, 'server_returned_run_id')
  assert.equal(receipt.postCalls, 1)
  assert.deepEqual(receipt.afterChecks, { main: true, publicVersion: true, errors: [] })
  assert.equal(calls.filter(call => call.url === versionUrl).length, 2)
})
test('204: acceptance with no indexed new run is pending, not retried or reported as failed', async () => {
  const { receipt, reads } = await runCase({ postStatus: 204, existing: [oldRun], discovered: [oldRun] })
  assert.equal(receipt.status, 'dispatch_accepted_run_pending')
  assert.equal(receipt.post.outcome, 'accepted')
  assert.equal(receipt.errorCode, null)
  assert.equal(receipt.postCalls, 1)
  assert.equal(reads().listReads, 2)
})
test('204: one new source-correct run remains explicitly a metadata candidate', async () => {
  const { receipt } = await runCase({ postStatus: 204, existing: [oldRun], discovered: [oldRun, baseRun] })
  assert.equal(receipt.status, 'dispatch_accepted_candidate_source_verified')
  assert.equal(receipt.run.attribution, 'unique_new_metadata_candidate_not_input_proof')
  assert.equal(receipt.postCalls, 1)
})
test('204: two new run IDs are ambiguous and never cause another POST', async () => {
  const { receipt } = await runCase({ postStatus: 204, discovered: [baseRun, { ...baseRun, id: 2002 }] })
  assert.equal(receipt.errorCode, 'DISPATCH_RUN_DISCOVERY_AMBIGUOUS')
  assert.equal(receipt.postCalls, 1)
})
test('unknown POST timeout retains unknown outcome and still reads main/public version after', async () => {
  const { receipt, reads } = await runCase({ postThrow: true })
  assert.equal(receipt.status, 'dispatch_requires_inspection')
  assert.equal(receipt.post.outcome, 'unknown')
  assert.equal(receipt.errorCode, 'POST_OUTCOME_UNKNOWN')
  assert.equal(receipt.post.errorCode, 'POST_OUTCOME_UNKNOWN')
  assert.equal(receipt.postCalls, 1)
  assert.deepEqual(reads(), { mainReads: 2, versionReads: 2, listReads: 1 })
})
test('200 malformed response is still accepted but requires inspection without retry', async () => {
  const { receipt } = await runCase({ postRaw: 'not-json ' + secret })
  assert.equal(receipt.post.outcome, 'accepted')
  assert.equal(receipt.errorCode, 'RESPONSE_NOT_JSON')
  assert.equal(receipt.postCalls, 1)
})
test('HTTP non-success remains inspection; raw error body is not emitted', async () => {
  const { receipt } = await runCase({ postStatus: 422, postBody: { message: secret } })
  assert.equal(receipt.errorCode, 'DISPATCH_HTTP_NON_SUCCESS')
  assert.equal(receipt.postCalls, 1)
})
for (const [name, options, code, posts] of [
  ['disabled manifest', { manifest: { enabled: false } }, 'ENTRY_DISABLED', 0],
  ['attempt two', { env: { GITHUB_RUN_ATTEMPT: '2' } }, 'CONTROL_RUN_INVALID', 0],
  ['wrong event message', { event: { head_commit: { id: C, message: 'wrong' } } }, 'CONTROL_EVENT_INVALID', 0],
  ['forced push', { event: { forced: true } }, 'CONTROL_EVENT_INVALID', 0],
  ['local checkout mismatch', { checkout: other }, 'CONTROL_CHECKOUT_MISMATCH', 0],
  ['local commit message mismatch', { localMessage: 'wrong' }, 'CONTROL_CHECKOUT_MISMATCH', 0],
  ['control ref moved', { controlRef: other }, 'CONTROL_REF_MOVED', 0],
  ['controller hash mismatch', { manifest: { controller: { path: 'scripts/ops/issue1512-production-dispatch.mjs', sha256: '0'.repeat(64) } } }, 'CONTROLLER_HASH_MISMATCH', 0],
  ['workflow hash mismatch', { manifest: { controlWorkflowBlob: other } }, 'CONTROL_WORKFLOW_MISMATCH', 0],
  ['tree mismatch', { tree: other }, 'TARGET_TREE_MISMATCH', 0],
  ['workflow ID-to-path mismatch', { workflowPath: '.github/workflows/other.yml' }, 'TARGET_WORKFLOW_ID_MISMATCH', 0],
  ['target workflow blob mismatch', { workflowBlob: other }, 'TARGET_WORKFLOW_MISMATCH', 0],
  ['public version mismatch before', { versionBefore: other }, 'VERSION_BEFORE_MISMATCH', 0],
  ['main mismatch before', { mainBefore: other }, 'REF_BEFORE_MISMATCH', 0],
  ['main moved after', { mainAfter: other }, 'REF_AFTER_MISMATCH', 1],
  ['public version changed after', { versionAfter: other }, 'VERSION_AFTER_MISMATCH', 1],
  ['active target run', { existing: [baseRun] }, 'TARGET_RUN_ACTIVE', 0],
  ['truncated baseline', { totalCount: 2 }, 'RUN_LIST_INCOMPLETE', 0],
  ['wrong returned source', { returnedRun: { head_sha: other } }, 'DISPATCHED_RUN_BINDING_MISMATCH', 1],
  ['returned attempt two', { returnedRun: { run_attempt: 2 } }, 'DISPATCHED_RUN_BINDING_MISMATCH', 1],
  ['unverified returned URL', { postBody: { workflow_run_id: 2001, run_url: 'https://example.test/' } }, 'DISPATCH_RESPONSE_UNVERIFIED', 1],
  ['unexpected input key', { inputs: { unapproved: 'true' } }, 'INPUT_KEYS_INVALID', 0],
  ['preflight cannot prepare', { inputs: { prepare: 'true' } }, 'INPUT_EXECUTE_ONLY', 0],
  ['browser submit cannot use all', { inputs: { mode: 'execute', 'browser-submit': 'true' } }, 'INPUT_BROWSER_CASE_INVALID', 0],
  ['export needs numeric ID', { inputs: { mode: 'export' } }, 'INPUT_EXPORT_ID_REQUIRED', 0],
  ['nil Replay session UUID', { inputs: { mode: 'export', 'export-id': '123', 'session-id': '00000000-0000-0000-0000-000000000000', 'trace-id': '1'.repeat(32) } }, 'INPUT_REPLAY_INVALID', 0],
  ['half replay pair', { inputs: { mode: 'export', 'export-id': '123', 'session-id': uuid } }, 'INPUT_REPLAY_INVALID', 0],
  ['isolated mode case guard', { inputs: { mode: 'controlled-failure', 'model-case': 'claude' } }, 'INPUT_ISOLATED_MODE_INVALID', 0],
]) test(name, async () => {
  const { receipt } = await runCase(options)
  assert.equal(receipt.errorCode, code)
  assert.equal(receipt.postCalls, posts)
  assert.equal(receipt.status, posts ? 'dispatch_requires_inspection' : 'not_dispatched')
})

test('original modes and optional Replay/export inputs retain intended allowed combinations', () => {
  for (const mode of ['preflight', 'controlled-failure']) assert.equal(validateInputs({ ...input, mode }, D).mode, mode)
  for (const model of ['claude', 'codex']) {
    const value = validateInputs({ ...input, mode: 'execute', 'model-case': model, prepare: 'true', 'browser-submit': 'true' }, D)
    assert.equal(value['model-case'], model)
  }
  const value = validateInputs({ ...input, mode: 'export', 'export-target': 'insight', 'export-id': '123',
    'session-id': uuid, 'trace-id': '1'.repeat(32) }, D)
  assert.equal(value['trace-id'], '1'.repeat(32))
  assert.throws(() => validateInputs({ ...input, mode: 'export', 'export-id': '123',
    'session-id': uuid, 'trace-id': '0'.repeat(32) }, D), /INPUT_REPLAY_INVALID/)
})
test('export mode itself dispatches only the existing workflow with exact validated inputs', async () => {
  const { receipt } = await runCase({ inputs: { mode: 'export', 'export-id': '123',
    'session-id': uuid, 'trace-id': '1'.repeat(32) } })
  assert.equal(receipt.status, 'dispatched_source_verified')
  assert.equal(receipt.inputs.mode, 'export')
  assert.equal(receipt.postCalls, 1)
})
