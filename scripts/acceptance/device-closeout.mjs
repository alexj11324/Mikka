import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { loadEnvironment, assertDeploymentIdentity } from '../test-accounts/environment.mjs'
import { acquireTestAccounts, recordAuthenticationSecrets, auditEvidence } from '../test-accounts/session.mjs'
import { connectDaemonInDataDir } from '../../packages/daemon/src/rpc/client.ts'

// Run with --import tsx against a separately started, matching Next build.
// No model, CLI fixture, provider, server replacement or guard override is used.
const environment = await loadEnvironment()
await assertDeploymentIdentity(environment)
const evidence = process.env.MIKKA_CLOSEOUT_EVIDENCE_DIR
assert.ok(evidence && resolve(evidence).startsWith('/tmp/'), 'Private evidence directory under /tmp required')
await mkdir(evidence, { recursive: true, mode: 0o700 })
const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
const children = [], logs = [], observations = []
const startedAt = new Date().toISOString()
let scope
let passed = false
async function waitFor(check, timeout = 30_000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(100)
  }
  throw new Error('Device closeout observation timed out')
}
async function status(directory) {
  let client
  try {
    client = await connectDaemonInDataDir(directory, { name: 'runtime-closeout', version: '1' })
    return await client.request('daemon.status')
  } catch { return null }
  finally { client?.close() }
}
async function boot(label) {
  const enrolled = await scope.owner.request('/api/devices/enrollment', { method: 'POST', headers: { origin: environment.origin } })
  assert.equal(enrolled.status, 200)
  const { token: grant } = await enrolled.json()
  await recordAuthenticationSecrets([grant], { environment })
  const directory = await mkdtemp(join(evidence, `${label}-`))
  const logPath = join(directory, 'process.log')
  const log = await open(logPath, 'wx', 0o600)
  logs.push(logPath)
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/acceptance/device-closeout-child.mts'], {
    cwd: process.cwd(), env: { ...process.env, MIKKA_CLOSEOUT_ORIGIN: environment.origin, MIKKA_CLOSEOUT_DATA_DIR: directory, MIKKA_CLOSEOUT_RESTART: '0' },
    stdio: ['pipe', log.fd, log.fd],
  })
  children.push(child)
  child.stdin.end(grant)
  await log.close()
  const ready = await waitFor(async () => {
    assert.equal(child.exitCode, null, 'Real daemon must remain alive')
    const value = await status(directory)
    return value?.server === 'online' ? value : null
  }, 60_000)
  const state = JSON.parse(await readFile(join(directory, 'device.json'), 'utf8'))
  logs.push(join(directory, 'logs', 'daemon.log'))
  assert.ok(state.deviceId && state.credential)
  await recordAuthenticationSecrets([state.credential], { environment })
  const token = (await pool.query('SELECT id FROM device_tokens WHERE "userId"=$1 AND "boundDeviceId"=$2 AND "revokedAt" IS NULL', [scope.owner.userId, state.deviceId])).rows
  assert.equal(token.length, 1)
  observations.push({ phase: 'registered', label, deviceId: state.deviceId, tokenId: token[0].id, pid: child.pid })
  return { directory, child, deviceId: state.deviceId, tokenId: token[0].id, credential: state.credential, ready }
}
async function deviceRequest(node, path, method = 'GET') {
  return fetch(`${environment.origin}/mikka${path}`, { method, headers: { authorization: `Bearer ${node.credential}`, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }), signal: AbortSignal.timeout(30_000), redirect: 'error' })
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try { await done } finally { clearTimeout(timer) }
}
try {
  scope = await acquireTestAccounts({ environment, runId: `device-closeout-${randomUUID()}`, workerId: 'two-processes', requestId: randomUUID() })
  const first = await boot('first'), second = await boot('second')
  assert.notEqual(first.deviceId, second.deviceId)
  const revokePath = `/api/device-tokens/${first.tokenId}/revoke`
  const revoke = { method: 'POST', headers: { origin: environment.origin } }
  assert.equal((await scope.peer.request(revokePath, revoke)).status, 404)
  assert.equal((await fetch(`${environment.origin}/mikka${revokePath}`, revoke)).status, 401)
  // The normal account helper pins Origin itself; use a credential-free request
  // for this negative origin probe instead of overriding its session guard.
  assert.equal((await fetch(`${environment.origin}/mikka${revokePath}`, { method: 'POST', headers: { origin: 'http://rejected.invalid' } })).status, 403)
  let pollFinished = false
  const pending = deviceRequest(first, `/v1/devices/${first.deviceId}/commands?wait=25`).finally(() => { pollFinished = true })
  // A committed device remains authorized before the owner revokes it.
  assert.equal((await deviceRequest(first, `/v1/devices/${first.deviceId}/runs`)).status, 200)
  await delay(300)
  assert.equal(pollFinished, false, 'An authorized command poll must remain in flight before revocation')
  const revokeStarted = performance.now()
  const revoked = await scope.owner.request(revokePath, revoke)
  assert.equal(revoked.status, 200)
  const receipt = await revoked.json()
  const again = await scope.owner.request(revokePath, revoke)
  assert.equal(again.status, 200)
  assert.deepEqual(await again.json(), receipt)
  assert.equal((await pending).status, 401)
  observations.push({ phase: 'pending-long-poll-refused', milliseconds: performance.now() - revokeStarted })
  const runId = randomUUID(), captureId = randomUUID(), requestId = randomUUID()
  const paths = [
    ['POST', '/v1/devices/register'], ['POST', `/v1/devices/${first.deviceId}/heartbeat`],
    ['GET', `/v1/devices/${first.deviceId}/runs`], ['GET', `/v1/devices/${first.deviceId}/repos`],
    ['GET', `/v1/devices/${first.deviceId}/commands?wait=0`], ['POST', `/v1/devices/${first.deviceId}/commands/ack`],
    ['POST', `/v1/devices/${first.deviceId}/coordinator`], ['GET', `/v1/devices/${first.deviceId}/fs/requests`],
    ['POST', `/v1/devices/${first.deviceId}/fs/requests/${requestId}`],
    ['POST', `/v1/devices/${first.deviceId}/computer`], ['POST', `/v1/devices/${first.deviceId}/runs/${runId}/claim`],
    ['POST', `/v1/devices/${first.deviceId}/runs/${runId}/credentials/login`], ['POST', `/v1/devices/${first.deviceId}/runs/${runId}/subscription`],
    ['GET', `/v1/devices/${first.deviceId}/runs/${runId}/computer-authority`], ['POST', `/v1/runs/${runId}/events`],
    ['PATCH', `/v1/runs/${runId}`], ['POST', `/v1/runs/${runId}/checkpoint`], ['POST', `/v1/runs/${runId}/complete`],
    ['POST', `/v1/runs/${runId}/captures`], ['POST', `/v1/runs/${runId}/captures/${captureId}`], ['PUT', `/v1/runs/${runId}/captures/${captureId}`],
    ['POST', `/v1/runs/${runId}/captures/${captureId}/complete`],
    ['POST', `/v1/runs/${runId}/screen`], ['GET', `/v1/runs/${runId}/skill-receipt`], ['POST', `/v1/runs/${runId}/tool-approval`],
  ]
  for (const [method, path] of paths) {
    const response = await deviceRequest(first, path, method)
    assert.equal(response.status, 401, `${method} ${path} must refuse the revoked credential`)
    await response.body?.cancel()
    observations.push({ phase: 'revoked-endpoint', method, path, status: response.status })
  }
  await waitFor(async () => (await status(first.directory))?.server === 'unregistered')
  observations.push({ phase: 'daemon-session-rejected', milliseconds: performance.now() - revokeStarted })
  assert.equal((await deviceRequest(second, `/v1/devices/${second.deviceId}/runs`)).status, 200)
  await stop(first.child)
  const restartLogPath = join(first.directory, 'restart.log')
  const restartLog = await open(restartLogPath, 'wx', 0o600)
  logs.push(restartLogPath)
  const restarted = spawn(process.execPath, ['--import', 'tsx', 'scripts/acceptance/device-closeout-child.mts'], {
    cwd: process.cwd(), env: { ...process.env, MIKKA_CLOSEOUT_ORIGIN: environment.origin, MIKKA_CLOSEOUT_DATA_DIR: first.directory, MIKKA_CLOSEOUT_RESTART: '1' },
    stdio: ['ignore', restartLog.fd, restartLog.fd],
  })
  children.push(restarted)
  await restartLog.close()
  await waitFor(async () => {
    assert.equal(restarted.exitCode, null)
    const value = await status(first.directory)
    return value?.server === 'unregistered' && value.signedIn === false
  })
  const registerAgain = await deviceRequest(first, '/v1/devices/register', 'POST')
  assert.equal(registerAgain.status, 401)
  observations.push({ phase: 'restarted-node-old-credential-refused', pid: restarted.pid, status: registerAgain.status })
  passed = true
  console.log('Normal enrollment, two independent daemon processes, owner/peer authorization, idempotent revocation and endpoint refusal passed')
} finally {
  for (const child of children) await stop(child)
  // Retain the audit/credential/device evidence intentionally. These accounts
  // must be quarantined rather than silently offered to another test executor.
  if (scope) await scope.release({ outcome: 'dirty' })
  await pool.end()
  await writeFile(join(evidence, 'result.json'), JSON.stringify({ version: 1, passed, deploymentSha: environment.deploymentSha, origin: environment.origin, startedAt, finishedAt: new Date().toISOString(), observations, limits: ['No active harness run or real model executed', 'Two independent processes share one Linux host', 'Retained fixtures quarantine their automatic account lease'] }, null, 2), { mode: 0o600 })
  if (logs.length) await auditEvidence(logs, { environment })
}
