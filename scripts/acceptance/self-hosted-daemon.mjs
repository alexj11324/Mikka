// A real source-daemon process against the disposable Docker installation.
// No SQL, model, fake CLI, provider credential or operating-system service.
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encode, decode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'

const ORIGIN = 'http://localhost:3000'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const check = (condition, code) => { if (!condition) throw new Error(`SELF_HOSTED_DAEMON_${code}`) }
function checkRunner(env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka'
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && Boolean(env.RUNNER_TEMP) && Boolean(env.GITHUB_WORKSPACE), 'CI_TARGET')
}
export function checkSessionTarget(session, env) {
  checkRunner(env)
  check(session.origin === ORIGIN && session.revision === env.GITHUB_SHA && UUID.test(session.workspaceId)
    && typeof session.ownerId === 'string' && session.ownerId.length > 0 && session.ownerId.length <= 128
    && typeof session.cookie === 'string' && session.cookie.length > 0 && session.cookie.length < 16_384
    && !/[\r\n\0]/.test(session.cookie), 'SESSION_TARGET')
}

export async function runDaemonAcceptance(env = process.env) {
  const report = { kind: 'isolated-source-daemon', revision: env.GITHUB_SHA, origin: ORIGIN, status: 'failed',
    checks: {}, cleanup: {}, taskCompletion: false, subscriptionAcceptance: false, modelRequests: false }
  checkRunner(env)
  const directory = join(await realpath(env.RUNNER_TEMP), 'mikka-selfhost-daemon')
  const handoff = join(directory, 'session.json'), dataDir = join(directory, 'daemon')
  let session, child, deviceId, credential, tokenId, log, owner, ownedDirectory = false
  const observed = new Map(), listeners = new Set()
  let processFailed = false
  function event(phase) {
    return new Promise((resolveEvent, reject) => {
      const finish = error => { clearTimeout(timer); listeners.delete(notify); if (error) reject(error); else resolveEvent(observed.get(phase)) }
      const notify = () => {
        if (processFailed) finish(new Error('SELF_HOSTED_DAEMON_PROCESS_EXITED'))
        else if (observed.has(phase)) finish()
      }
      const timer = setTimeout(() => finish(new Error('SELF_HOSTED_DAEMON_OBSERVATION_TIMEOUT')), 45_000)
      listeners.add(notify); notify()
    })
  }
  try {
    check((await realpath(directory)) === directory && (await lstat(directory)).isDirectory()
      && ((await lstat(directory)).mode & 0o777) === 0o700, 'PRIVATE_DIRECTORY')
    ownedDirectory = true
    const metadata = await lstat(handoff)
    check(metadata.isFile() && (metadata.mode & 0o777) === 0o600 && metadata.size < 20_000, 'PRIVATE_SESSION')
    session = JSON.parse(await readFile(handoff, 'utf8'))
    checkSessionTarget(session, env)
    await rm(handoff)
    check(await realpath(process.cwd()) === await realpath(env.GITHUB_WORKSPACE)
      && execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === env.GITHUB_SHA, 'CHECKOUT_REVISION')
    owner = async (path, method = 'GET', body) => {
      check(path.startsWith('/api/') && !path.includes('://') && !path.includes('#'), 'OWNER_REQUEST')
      const response = await fetch(ORIGIN + '/mikka' + path, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { origin: ORIGIN, cookie: session.cookie, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      check(response.status === 200, 'OWNER_HTTP')
      return response.json()
    }
    const rpc = async (action, args = []) => {
      check(['agents.pollDevices', 'agents.removeDevice'].includes(action), 'RPC_ACTION')
      const response = await owner('/api/rpc', 'POST', { version: DESKTOP_RPC_VERSION, action, args: encode(args) })
      check(response.ok === true && response.version === DESKTOP_RPC_VERSION, 'RPC_RESPONSE')
      const data = decode(response.result); check(data && !data.error, 'RPC_RESULT'); return data
    }
    check((await owner('/api/version')).build === env.GITHUB_SHA, 'APPLICATION_REVISION')
    const identity = await owner('/api/auth/get-session?disableCookieCache=true')
    check(identity.user?.id === session.ownerId && identity.user.emailVerified === true
      && (await owner('/api/workspace')).workspace?.id === session.workspaceId, 'OWNER_IDENTITY')
    check((await owner('/api/device-tokens')).tokens?.length === 0 && (await rpc('agents.pollDevices')).devices?.length === 0, 'FRESH_OWNER')
    report.checks.target = true
    const enrollment = await owner('/api/devices/enrollment', 'POST')
    check(/^orv_[A-Za-z0-9_-]{43}$/.test(enrollment.token ?? ''), 'ENROLLMENT')
    await mkdir(dataDir, { mode: 0o700 }); await chmod(dataDir, 0o700)
    log = await open(join(directory, 'process.private.log'), 'wx', 0o600)
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./device-closeout-child.mts', import.meta.url))], {
      cwd: process.cwd(), env: { PATH: env.PATH, LANG: 'C.UTF-8', HOME: env.HOME, TMPDIR: directory, NODE_ENV: 'production',
        MIKKA_CLOSEOUT_ORIGIN: ORIGIN, MIKKA_CLOSEOUT_DATA_DIR: dataDir, MIKKA_CLOSEOUT_TRANSPORT_ONLY: '1' },
      stdio: ['pipe', log.fd, log.fd, 'ipc'],
    })
    child.on('message', message => {
      if (message && ['ready', 'heartbeat', 'gateway-pong', 'revocation-sync'].includes(message.phase)) {
        observed.set(message.phase, message); for (const notify of listeners) notify()
      }
    })
    const failed = () => { processFailed = true; for (const notify of listeners) notify() }
    child.on('error', failed); child.on('exit', failed); child.stdin.on('error', failed)
    child.stdin.end(enrollment.token); delete enrollment.token
    const ready = (await event('ready')).status
    check(ready?.server === 'online' && ready.signedIn === true && UUID.test(ready.deviceId) && ready.pid === child.pid, 'PROCESS_STATUS')
    deviceId = ready.deviceId
    const stored = JSON.parse(await readFile(join(dataDir, 'device.json'), 'utf8'))
    check(stored.deviceId === deviceId && /^orv_[A-Za-z0-9_-]{43}$/.test(stored.credential ?? ''), 'DEVICE_IDENTITY')
    credential = stored.credential
    const tokens = (await owner('/api/device-tokens')).tokens
    check(tokens?.length === 1 && UUID.test(tokens[0].id) && tokens[0].boundDeviceId === deviceId && tokens[0].revokedAt === null, 'TOKEN_IDENTITY')
    tokenId = tokens[0].id
    check((await event('heartbeat')).deviceId === deviceId && (await event('gateway-pong')).deviceId === deviceId, 'TRANSPORT_IDENTITY')
    const devices = (await rpc('agents.pollDevices')).devices
    check(devices?.length === 1 && devices[0].id === deviceId && devices[0].online === true, 'DEVICE_ONLINE')
    Object.assign(report.checks, { enrollment: true, realProcess: true, heartbeat: true, builtinGatewayPong: true, ownerDeviceOnline: true })
    report.process = { pid: ready.pid, daemonVersion: ready.daemonVersion, protocolVersion: ready.protocolVersion }
    report.status = 'passed'
  } catch (error) {
    report.code = /^SELF_HOSTED_DAEMON_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'SELF_HOSTED_DAEMON_UNEXPECTED_FAILURE'
  } finally {
    // Only this fresh fixture owner's sole token can be reconciled after a
    // lost child reply; never choose an arbitrary token or another device.
    if (owner) {
      try {
        if (!tokenId && child) {
          const tokens = (await owner('/api/device-tokens')).tokens
          check(Array.isArray(tokens) && tokens.length <= 1, 'CLEANUP_TOKEN_SCOPE')
          if (tokens.length) { check(UUID.test(tokens[0].id) && (!deviceId || tokens[0].boundDeviceId === deviceId), 'CLEANUP_TOKEN_SCOPE'); tokenId = tokens[0].id }
        }
        if (tokenId) {
          const revoked = await owner(`/api/device-tokens/${tokenId}/revoke`, 'POST')
          check(revoked.tokenId === tokenId && revoked.revokedBy === session.ownerId, 'REVOKE')
          report.cleanup.credentialRevoked = true
        }
        if (credential && deviceId) {
          const denied = await fetch(`${ORIGIN}/mikka/v1/devices/${deviceId}/runs`, { redirect: 'error',
            headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(10_000) })
          check(denied.status === 401, 'REVOKED_HTTP'); await denied.body?.cancel()
          child.send({ command: 'sync-after-revocation' })
          const rejected = (await event('revocation-sync')).status
          check(rejected?.server === 'unregistered' && rejected.signedIn === false && rejected.pid === child.pid, 'REVOKED_STATUS')
          report.cleanup.revokedCredentialRefused = true; report.cleanup.daemonUnregistered = true
          report.cleanup.revocationCheckedOnNextSync = true
          const response = await owner('/api/rpc', 'POST', { version: DESKTOP_RPC_VERSION, action: 'agents.removeDevice', args: encode([deviceId]) })
          check(response.ok === true && decode(response.result)?.id === deviceId, 'REMOVE_DEVICE')
          report.cleanup.deviceRemoved = true
        }
      } catch { report.status = 'failed'; report.cleanup.resources = false }
      try { await owner('/api/auth/sign-out', 'POST', {}); report.cleanup.sessionClosed = true }
      catch { report.status = 'failed'; report.cleanup.sessionClosed = false }
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 8_000)
      try { await ended } finally { clearTimeout(timer) }
    }
    await log?.close(); credential = undefined; session = undefined
    if (ownedDirectory) { await rm(directory, { recursive: true, force: true }); report.cleanup.privateFilesRemoved = true }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let report
  try { report = await runDaemonAcceptance() }
  catch { report = { kind: 'isolated-source-daemon', status: 'failed', code: 'SELF_HOSTED_DAEMON_GUARD', taskCompletion: false, subscriptionAcceptance: false } }
  await mkdir('.artifacts/self-hosted', { recursive: true })
  await writeFile('.artifacts/self-hosted/daemon.json', `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
  if (report.status !== 'passed') process.exitCode = 1
}
