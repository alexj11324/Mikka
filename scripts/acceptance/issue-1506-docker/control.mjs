// Existing authorized Docker sandbox only. Credentials stay in this process.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SANDBOX = 'sandboxes/sbx_001m6rywbd7a5pjmqb79qs43vad'
export const BASE_SHA = 'e8dd7a1265027a0477819dde1a80178e7bcdb1ae'
const DIRECTORY = dirname(fileURLToPath(import.meta.url))
const MANAGEMENT = 'https://connect.docker.com/sandboxes/v1/'
const HUB = 'https://hub.docker.com/v2/auth/token'
const HEX = /^[0-9a-f]{64}$/
const STATES = ['creating', 'starting', 'running', 'stopping', 'stopped', 'failed', 'deleting', 'degraded']
const CHECKS = ['git-diff-check', 'stop-unit', 'stop-database', 'live-unit', 'live-hooks', 'typecheck', 'lint', 'polling-policy', 'idle-budget']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw new Error(code) }
const CODES = new Set(['mode_invalid', 'runner_scope_invalid', 'candidate_invalid', 'candidate_file_hash_mismatch',
  'docker_credentials_missing', 'docker_http_failed', 'docker_network_failed', 'docker_response_invalid',
  'sandbox_scope_mismatch', 'sandbox_state_unusable', 'sandbox_transition_timeout', 'sandbox_endpoint_invalid',
  'sandbox_etag_invalid', 'remote_exec_failed', 'remote_report_invalid', 'remote_verification_failed', 'sandbox_stop_failed'])
const safeError = error => ({ error: CODES.has(error?.message) ? error.message : 'docker_verification_failed',
  ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) })
export function redact(value, secrets = []) {
  let text = String(value ?? '')
  for (const secret of secrets.filter(value => typeof value === 'string' && value.length >= 4).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]')
  return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/(postgres(?:ql)?:\/\/[^\s:/]+:)[^\s@]+(@)/gi, '$1[redacted]$2')
}

export function loadCandidate(directory = DIRECTORY) {
  let manifest
  try { manifest = JSON.parse(readFileSync(join(directory, 'candidate-manifest.json'), 'utf8')) } catch { fail('candidate_invalid') }
  if (manifest?.schemaVersion !== 1 || manifest.baseSha !== BASE_SHA || !Array.isArray(manifest.patches) || manifest.patches.length !== 2) fail('candidate_invalid')
  const paths = new Set(), sources = {}, assets = new Map()
  for (const [index, name] of ['stop.patch', 'live.patch'].entries()) {
    const patch = manifest.patches[index]
    if (patch.file !== name || !HEX.test(patch.sha256 ?? '') || !patch.sources || !Object.keys(patch.sources).length) fail('candidate_invalid')
    const bytes = readFileSync(join(directory, name))
    if (bytes.length > 2_000_000 || digest(bytes) !== patch.sha256) fail('candidate_file_hash_mismatch')
    const diffPaths = [...bytes.toString('utf8').matchAll(/^diff --git a\/([A-Za-z0-9_./-]+) b\/([A-Za-z0-9_./-]+)$/gm)]
    if (diffPaths.length !== Object.keys(patch.sources).length || /^(?:new|old|deleted) file mode 120000|^new mode 120000|^GIT binary patch/m.test(bytes.toString('utf8'))) fail('candidate_invalid')
    for (const [path, sha] of Object.entries(patch.sources)) {
      if (!/^(lib|hooks|scripts|workflows)\/[A-Za-z0-9_./-]+\.(ts|tsx|mjs)$/.test(path) || path.includes('..') || paths.has(path) || !HEX.test(sha) ||
        diffPaths.filter(row => row[1] === path && row[2] === path).length !== 1) fail('candidate_invalid')
      paths.add(path); sources[path] = sha
    }
    assets.set(name, bytes)
  }
  for (const name of ['candidate-manifest.json', 'remote-verify.sh', 'remote-verify.mjs']) assets.set(name, readFileSync(join(directory, name)))
  return { manifest, sources, assets, hashes: Object.fromEntries([...assets].map(([name, bytes]) => [name, digest(bytes)])) }
}

export async function control({ mode = 'verify', env = process.env, directory = DIRECTORY, fetcher = fetch,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), checkpoint = true } = {}) {
  const started = Date.now(), deadline = started + 16 * 60_000, secrets = [], report = { schemaVersion: 1, issue: 1506,
    phase: 'owned-docker-verification', mode, sandbox: SANDBOX, baseSha: BASE_SHA, status: 'failed', requests: [],
    createdSandboxes: 0, productionRequests: 0, cleanup: { attempted: false, stopped: false } }
  let token = null, tokenExpiry = 0, authorized = false, candidate
  const save = () => {
    if (!checkpoint) return
    mkdirSync('issue-1506-docker-report', { recursive: true })
    const path = `issue-1506-docker-report/${mode === 'stop' ? 'stop' : 'verification'}.json`
    writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path)
  }
  const http = async (kind, url, { method = 'GET', body, headers = {}, timeoutMs = 30_000, raw = false, cleanup = false } = {}) => {
    const at = Date.now(), row = { operation: kind, method, status: null }; report.requests.push(row)
    const remaining = cleanup ? timeoutMs : Math.min(timeoutMs, Math.max(1, deadline - Date.now()))
    try {
      let response
      try { response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(remaining), headers,
        ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}) }) } catch { fail('docker_network_failed') }
      row.status = response.status
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(body?.code ?? '')) row.errorCode = body.code
        const error = new Error('docker_http_failed'); error.httpStatus = response.status; throw error
      }
      if (raw) return Buffer.from(await response.arrayBuffer())
      try { return await response.json() } catch { fail('docker_response_invalid') }
    } finally { row.durationMs = Date.now() - at; save() }
  }
  const access = async cleanup => {
    if (token && Date.now() < tokenExpiry) return token
    const body = await http('docker.authenticate', HUB, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: { identifier: env.DOCKER_ID, secret: env.DOCKER_PAT }, cleanup })
    if (typeof body.access_token !== 'string' || !body.access_token) fail('docker_response_invalid')
    token = body.access_token; secrets.push(token); tokenExpiry = Date.now() + 600_000; authorized = true
    return token
  }
  const management = async (kind, suffix = '', options = {}) => http(kind, MANAGEMENT + SANDBOX + suffix, { ...options,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + await access(options.cleanup), ...options.headers } })
  const state = value => {
    if (value?.name !== SANDBOX || !STATES.includes(value.core?.status)) fail('sandbox_scope_mismatch')
    return value
  }
  const etag = value => {
    if (typeof value.core?.etag !== 'string' || !/^"[^"\x00-\x20\x7f]+"$/.test(value.core.etag)) fail('sandbox_etag_invalid')
    return value.core.etag
  }
  // External Docker lifecycle convergence only; no product polling and no
  // mutation retry. 202 explicitly requires observing this external resource.
  const transition = async (value, wanted, cleanup = false) => {
    let current = state(value)
    const until = Date.now() + 120_000
    for (let index = 0; current.core.status !== wanted && index < 60 && Date.now() < until; index++) {
      if (!['starting', 'stopping'].includes(current.core.status)) fail('sandbox_state_unusable')
      await wait(2000)
      current = state(await management('sandbox.observe_transition', '', { cleanup, timeoutMs: Math.max(1, Math.min(10_000, until - Date.now())) }))
    }
    if (current.core.status !== wanted) fail('sandbox_transition_timeout')
    return current
  }
  const stop = async () => {
    report.cleanup.attempted = true; save()
    try {
      let current = state(await management('sandbox.cleanup_state', '', { cleanup: true }))
      if (current.core.status === 'stopping') current = await transition(current, 'stopped', true)
      if (current.core.status !== 'stopped') {
        current = await management('sandbox.stop', '/stop', { method: 'POST', body: {}, cleanup: true,
          headers: { 'if-match': etag(current), 'idempotency-key': `issue-1506-stop-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` } })
        current = await transition(current, 'stopped', true)
      }
      report.cleanup.stopped = current.core.status === 'stopped'
    } catch (error) { Object.assign(report.cleanup, safeError(error)) }
    save()
  }
  try {
    if (!['validate', 'verify', 'stop'].includes(mode)) fail('mode_invalid')
    if (mode !== 'stop') { candidate = loadCandidate(directory); report.sourceHashes = candidate.sources; report.assetHashes = candidate.hashes }
    if (mode === 'validate') { report.status = 'candidate_validated'; save(); return report }
    if (env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || env.GITHUB_REF !== 'refs/heads/acceptance/issues-1504-1506' ||
      !/^\d{1,24}$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d{1,4}$/.test(env.GITHUB_RUN_ATTEMPT ?? '1')) fail('runner_scope_invalid')
    if (!env.DOCKER_ID || !env.DOCKER_PAT) fail('docker_credentials_missing')
    secrets.push(env.DOCKER_ID, env.DOCKER_PAT)
    await access(false)
    if (mode === 'stop') { await stop(); report.status = report.cleanup.stopped ? 'sandbox_stopped' : 'failed'; return report }
    let sandbox = state(await management('sandbox.initial_state'))
    report.initialState = sandbox.core.status
    if (sandbox.core.status === 'stopping') sandbox = await transition(sandbox, 'stopped')
    if (sandbox.core.status === 'stopped') {
      sandbox = await management('sandbox.start', '/start', { method: 'POST', body: {}, headers: { 'if-match': etag(sandbox),
        'idempotency-key': `issue-1506-start-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` } })
      report.startRequested = true
    }
    sandbox = await transition(sandbox, 'running')
    const endpoint = sandbox.core.endpoint
    let uri
    try { uri = new URL(endpoint.uri) } catch { fail('sandbox_endpoint_invalid') }
    if (uri.protocol !== 'https:' || uri.username || uri.password || uri.search || uri.hash || endpoint.sandbox !== SANDBOX ||
      endpoint.apiVersion !== 'v1' || endpoint.protocol !== 'http' || endpoint.authentication?.scheme !== 'scopedBearer') fail('sandbox_endpoint_invalid')
    const endpointBase = uri.toString().replace(/\/$/, '') + '/v1/'
    const endpointToken = async permissions => {
      const credential = await management('sandbox.endpoint_credential', '/endpoint-credentials', { method: 'POST', body: { permissions } })
      if (typeof credential.token !== 'string' || !credential.token) fail('docker_response_invalid')
      secrets.push(credential.token); return credential.token
    }
    const runKey = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`, prefix = `/tmp/mikka-1506-${runKey}-`
    report.worktree = `/workspace/Mikka-1506-verify-${runKey}`
    const uploadToken = await endpointToken(['sandboxesFilesWrite'])
    for (const [name, bytes] of candidate.assets) {
      await http('sandbox.upload_' + name, endpointBase + 'files/content?' + new URLSearchParams({ path: prefix + name, mode: String(0o600) }), {
        method: 'PUT', body: bytes, raw: true, headers: { authorization: 'Bearer ' + uploadToken, 'content-type': 'application/octet-stream' } })
    }
    const executionToken = await endpointToken(['sandboxesExec'])
    const executed = await http('sandbox.verify_process', endpointBase + 'processes/exec', { method: 'POST', timeoutMs: 870_000,
      headers: { authorization: 'Bearer ' + executionToken, 'content-type': 'application/json' }, body: {
        cmd: ['timeout', '--signal=TERM', '--kill-after=15s', '840s', 'env', '-i',
          'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node24/bin', 'LANG=C.UTF-8',
          'bash', '--noprofile', '--norc', prefix + 'remote-verify.sh', prefix + 'candidate-manifest.json', prefix + 'stop.patch',
          prefix + 'live.patch', prefix + 'remote-verify.mjs', prefix + 'report.json', report.worktree], workingDir: '/workspace', user: 'root',
      } })
    report.exec = { exitCode: Number.isInteger(executed.exitCode) ? executed.exitCode : null, incomplete: executed.incomplete === true,
      stdout: redact(Buffer.from(executed.stdout ?? '', 'base64').toString('utf8'), secrets),
      stderr: redact(Buffer.from(executed.stderr ?? '', 'base64').toString('utf8'), secrets) }; save()
    const readToken = await endpointToken(['sandboxesFilesRead'])
    const reportBytes = await http('sandbox.read_report', endpointBase + 'files/content?' + new URLSearchParams({ path: prefix + 'report.json' }),
      { raw: true, headers: { authorization: 'Bearer ' + readToken } })
    if (reportBytes.length > 30_000_000) fail('remote_report_invalid')
    let remote
    try { remote = JSON.parse(redact(reportBytes.toString('utf8'), secrets)) } catch { fail('remote_report_invalid') }
    report.verification = remote
    if (remote?.schemaVersion !== 1 || remote.baseSha !== BASE_SHA || remote.worktree !== report.worktree ||
      !Array.isArray(remote.checks) || JSON.stringify(Object.keys(remote.sourceHashes ?? {}).sort()) !== JSON.stringify(Object.keys(candidate.sources).sort()) ||
      Object.entries(candidate.sources).some(([path, sha]) => remote.sourceHashes[path] !== sha)) fail('remote_report_invalid')
    if (executed.exitCode !== 0 || executed.incomplete || remote.status !== 'passed' || remote.bootstrapPassed !== true ||
      CHECKS.some(name => remote.checks.filter(row => row.name === name && row.exitCode === 0).length !== 1)) fail('remote_verification_failed')
    report.status = 'verification_passed'
  } catch (error) { Object.assign(report, safeError(error)); report.status = 'failed' }
  finally {
    if (mode === 'verify' && authorized) await stop()
    if (mode === 'verify' && !report.cleanup.stopped && report.status === 'verification_passed') { report.status = 'failed'; report.error = 'sandbox_stop_failed' }
    report.durationMs = Date.now() - started; save()
    token = null; secrets.fill(''); secrets.length = 0
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await control({ mode: process.argv[2] ?? 'validate' })
  console.log(JSON.stringify(report))
  if (!['candidate_validated', 'verification_passed', 'sandbox_stopped'].includes(report.status)) process.exitCode = 1
}
