import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_SHA, SANDBOX, control, loadCandidate } from './control.mjs'

globalThis.fetch = async () => { throw new Error('real_network_forbidden') }
const DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DOCKER_ID = 'fixture-docker-owner', PAT = 'fixture-docker-private-pat', TOKEN = 'fixture-private-management-token', ENDPOINT = 'fixture-private-scoped-token'
const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/acceptance/issues-1504-1506',
  GITHUB_RUN_ID: '1234567', GITHUB_RUN_ATTEMPT: '1', DOCKER_ID, DOCKER_PAT: PAT }
const MANAGEMENT = 'https://connect.docker.com/sandboxes/v1/' + SANDBOX
const endpoint = 'https://owned-sandbox.docker.test/own-prefix/v1/'
const checkNames = ['git-diff-check','stop-unit','stop-database','live-unit','live-hooks','typecheck','lint','polling-policy','idle-budget']
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fixture() {
  const calls = [], writes = new Map(), candidate = loadCandidate()
  const data = { status: 'running', failUpload: false, failExecNetwork: false, execCode: 0, wrongName: false, wrongHash: false }
  const sandbox = () => ({ name: data.wrongName ? 'sandboxes/unrelated' : SANDBOX,
    core: { status: data.status, etag: '"fixture-etag"', endpoint: { uri: endpoint.replace(/\/v1\/$/, ''), sandbox: SANDBOX,
      protocol: 'http', apiVersion: 'v1', authentication: { scheme: 'scopedBearer' } } } })
  const fetcher = async (url, options = {}) => {
    url = String(url); calls.push({ url, method: options.method ?? 'GET' })
    assert.equal(options.redirect, 'error')
    if (url === 'https://hub.docker.com/v2/auth/token') {
      assert.deepEqual(JSON.parse(options.body), { identifier: DOCKER_ID, secret: PAT })
      return json({ access_token: TOKEN })
    }
    if (url.startsWith(MANAGEMENT)) {
      assert.equal(options.headers.authorization, 'Bearer ' + TOKEN)
      if (url === MANAGEMENT) return json(sandbox())
      if (url === MANAGEMENT + '/endpoint-credentials') {
        const body = JSON.parse(options.body)
        assert.equal(body.permissions.length, 1)
        assert.ok(['sandboxesFilesWrite','sandboxesFilesRead','sandboxesExec'].includes(body.permissions[0]))
        return json({ token: ENDPOINT })
      }
      if (url === MANAGEMENT + '/start') { assert.equal(data.status, 'stopped'); assert.equal(options.headers['if-match'], '"fixture-etag"'); data.status = 'running'; return json(sandbox()) }
      if (url === MANAGEMENT + '/stop') { assert.equal(options.headers['if-match'], '"fixture-etag"'); data.status = 'stopped'; return json(sandbox()) }
      throw new Error('unexpected management operation')
    }
    assert.ok(url.startsWith(endpoint))
    assert.equal(options.headers.authorization, 'Bearer ' + ENDPOINT)
    if (url.startsWith(endpoint + 'files/content?')) {
      const path = new URL(url).searchParams.get('path')
      assert.match(path, /^\/tmp\/mikka-1506-1234567-1-/)
      if (options.method === 'PUT') {
        assert.equal(new URL(url).searchParams.get('mode'), '384', 'the API uses decimal Unix bits, not an octal string')
        if (data.failUpload) return json({ message: 'never copy ' + PAT }, 403)
        writes.set(path, options.body); return new Response(null, { status: 204 })
      }
      const sources = { ...candidate.sources }
      if (data.wrongHash) sources[Object.keys(sources)[0]] = '0'.repeat(64)
      return json({ schemaVersion: 1, baseSha: BASE_SHA, worktree: '/workspace/Mikka-1506-verify-1234567-1',
        status: 'passed', bootstrapPassed: true, sourceHashes: sources,
        checks: checkNames.map(name => ({ name, exitCode: 0, stdout: 'safe check output ' + PAT, stderr: '', durationMs: 1 })) })
    }
    if (url === endpoint + 'processes/exec') {
      if (data.failExecNetwork) throw new TypeError('network refusal ' + PAT)
      const body = JSON.parse(options.body)
      assert.deepEqual(body.cmd.slice(0, 7), ['timeout','--signal=TERM','--kill-after=15s','840s','env','-i','PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node24/bin'])
      assert.equal(body.workingDir, '/workspace'); assert.equal(body.env, undefined)
      assert.equal(body.user, 'root')
      assert.equal(body.cmd.some(arg => arg.includes(PAT) || arg.includes(DOCKER_ID) || arg.includes(TOKEN)), false)
      assert.equal(writes.size, 5)
      return json({ exitCode: data.execCode, incomplete: false,
        stdout: Buffer.from('complete ' + PAT).toString('base64'), stderr: Buffer.from('Bearer ' + TOKEN).toString('base64') })
    }
    throw new Error('unexpected endpoint operation')
  }
  return { data, calls, fetcher }
}
async function run(mock, extra = {}) {
  const result = await control({ env, fetcher: mock.fetcher, wait: async () => {}, checkpoint: false, ...extra })
  for (const secret of [DOCKER_ID, PAT, TOKEN, ENDPOINT]) assert.equal(JSON.stringify(result).includes(secret), false)
  assert.equal(mock.calls.some(call => call.method === 'DELETE' || call.url.endsWith('/sandboxes')), false)
  return result
}
const requests = (mock, suffix) => mock.calls.filter(call => call.url.endsWith(suffix)).length

test('validate pins both patches, all 14 source files, and performs zero network calls', async () => {
  const mock = fixture(), result = await run(mock, { mode: 'validate' })
  assert.equal(result.status, 'candidate_validated'); assert.equal(mock.calls.length, 0)
  assert.equal(Object.keys(result.sourceHashes).length, 14)
})
test('one normal exec produces complete sanitized verification and finally stops only this sandbox', async () => {
  const mock = fixture(), result = await run(mock)
  assert.equal(result.status, 'verification_passed'); assert.equal(result.cleanup.stopped, true)
  assert.equal(requests(mock, '/processes/exec'), 1); assert.equal(requests(mock, '/stop'), 1); assert.equal(requests(mock, '/start'), 0)
  assert.equal(result.verification.checks.length, 9)
})
test('stopped sandbox is started once, reused, then stopped', async () => {
  const mock = fixture(); mock.data.status = 'stopped'
  assert.equal((await run(mock)).status, 'verification_passed')
  assert.equal(requests(mock, '/start'), 1); assert.equal(requests(mock, '/stop'), 1)
})
test('a denied endpoint is not retried or bypassed; only owned cleanup follows', async () => {
  const mock = fixture(); mock.data.failUpload = true
  const result = await run(mock)
  assert.equal(result.status, 'failed'); assert.equal(result.httpStatus, 403)
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 1)
  assert.equal(requests(mock, '/processes/exec'), 0); assert.equal(requests(mock, '/stop'), 1)
})
test('lost exec response never repeats execution and still stops the same machine', async () => {
  const mock = fixture(); mock.data.failExecNetwork = true
  const result = await run(mock)
  assert.equal(result.error, 'docker_network_failed'); assert.equal(requests(mock, '/processes/exec'), 1)
  assert.equal(result.cleanup.stopped, true)
})
test('wrong remote source hash or nonzero process exit cannot be called a pass', async () => {
  for (const kind of ['hash', 'exit']) {
    const mock = fixture()
    if (kind === 'hash') mock.data.wrongHash = true
    else mock.data.execCode = 1
    const result = await run(mock)
    assert.equal(result.status, 'failed'); assert.equal(result.cleanup.stopped, true)
    assert.equal(result.verification.checks.length, 9)
  }
})
test('runner scope and tampered patch are rejected before any credential use', async () => {
  const mock = fixture()
  assert.equal((await run(mock, { env: { ...env, GITHUB_REF: 'refs/heads/main' } })).error, 'runner_scope_invalid')
  assert.equal(mock.calls.length, 0)
  const directory = mkdtempSync(join(tmpdir(), 'mikka-docker-driver-'))
  try {
    for (const file of ['candidate-manifest.json','stop.patch','live.patch','remote-verify.sh','remote-verify.mjs']) cpSync(join(DIRECTORY, file), join(directory, file))
    writeFileSync(join(directory, 'stop.patch'), readFileSync(join(directory, 'stop.patch'), 'utf8') + '\n')
    assert.equal((await run(mock, { directory })).error, 'candidate_file_hash_mismatch'); assert.equal(mock.calls.length, 0)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('cleanup mode never needs candidate files, creates nothing and does not execute commands', async () => {
  const mock = fixture(), result = await run(mock, { mode: 'stop', directory: '/does-not-exist' })
  assert.equal(result.status, 'sandbox_stopped'); assert.equal(requests(mock, '/stop'), 1)
  assert.equal(requests(mock, '/processes/exec'), 0)
})
