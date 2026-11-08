// A real source-daemon process against the disposable Docker installation.
// No SQL, model, fake CLI, provider credential or operating-system service.
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encode, decode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { liveChannelId } from '../../lib/live/scope.ts'
import { liveSessionIdValid } from '../../lib/live/session-ticket.ts'
import { presenceReply, PRESENCE_MAX_TOKEN_BYTES } from '../../lib/live/presence.ts'

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

// This driver first proves that its disposable owner has no credentials or
// devices. Normal enrollment then creates one account-scoped SSH credential;
// boundDeviceId is for cloud workers, while local registration records the
// relationship in device_token_devices. Never select from an ambiguous list.
export function enrollmentToken(tokens) {
  check(Array.isArray(tokens) && tokens.length === 1 && UUID.test(tokens[0]?.id ?? '')
    && tokens[0].name === 'SSH' && tokens[0].boundDeviceId === null, 'TOKEN_IDENTITY')
  return tokens[0]
}

export function checkOwnedEnrollment(account, ownerId, deviceId) {
  check(UUID.test(deviceId ?? '') && account?.ownerId === ownerId && Array.isArray(account.deviceIds)
    && account.deviceIds.length === 1 && account.deviceIds[0] === deviceId, 'OWNER_DEVICE')
}

export function createOwnerRequest(session, fetchImpl = fetch) {
  return async (path, method = 'GET', body) => {
    check(path.startsWith('/api/') && !path.includes('://') && !path.includes('#'), 'OWNER_REQUEST')
    const response = await fetchImpl(ORIGIN + '/mikka' + path, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { origin: ORIGIN, cookie: session.cookie, 'content-type': 'application/json',
        ...(path === '/api/rpc' ? { 'x-mikka-rpc': '1' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    check(response.status === 200, 'OWNER_HTTP')
    return response.json()
  }
}

/** Only the signed-in owner's fresh read can supply a presence grant. Keep its
 * socket ticket and grant on this disposable installation's exact channel. */
export function presenceTarget(ticket, live, ownerId, now = Date.now()) {
  check(live?.ownerId === ownerId && UUID.test(live?.workspaceId ?? ''), 'PRESENCE_SCOPE')
  const proof = live.presence
  check(typeof proof?.token === 'string' && proof.token.length <= PRESENCE_MAX_TOKEN_BYTES
    && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(proof.token)
    && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > now && proof.expiresAt <= now + 305_000, 'PRESENCE_PROOF')
  let url
  try { url = new URL(ticket?.url) } catch { check(false, 'PRESENCE_TARGET') }
  const channel = liveChannelId({ ownerId, workspaceId: live.workspaceId })
  check(url.origin === ORIGIN.replace('http:', 'ws:') && url.pathname === `/mikka/v1/live/${channel}/socket`
    && !url.username && !url.password && !url.search && !url.hash, 'PRESENCE_TARGET')
  const protocol = /^mikka-live-v2-([0-9]{1,12})\.([A-Za-z0-9_-]{1,342})\.([a-f0-9]{64})$/.exec(ticket.protocol ?? '')
  const sessionId = protocol ? Buffer.from(protocol[2], 'base64url').toString('utf8') : null
  check(protocol && liveSessionIdValid(sessionId) && Buffer.from(sessionId).toString('base64url') === protocol[2]
    && Number.isSafeInteger(ticket.expiresAt) && ticket.expiresAt === Number(protocol[1]) * 1000
    && ticket.expiresAt > now && ticket.expiresAt <= now + 305_000, 'PRESENCE_TICKET')
  url.searchParams.set('revisions', '1'); url.searchParams.set('presence', '1')
  return { url: url.href, protocol: ticket.protocol, proof }
}

async function verifyPresence(ticket, live, ownerId) {
  const target = presenceTarget(ticket, live, ownerId)
  const socket = new WebSocket(target.url, target.protocol), id = 'daemon-acceptance'
  await new Promise((resolveAck, reject) => {
    let ready = false, finished = false
    const finish = code => {
      if (finished) return
      finished = true; clearTimeout(timer)
      socket.onmessage = null; socket.onerror = null; socket.onclose = null
      socket.close()
      if (code) reject(new Error(`SELF_HOSTED_DAEMON_${code}`)); else resolveAck()
    }
    const timer = setTimeout(() => finish('PRESENCE_TIMEOUT'), 15_000)
    socket.onerror = () => finish('PRESENCE_SOCKET')
    socket.onclose = () => finish('PRESENCE_CLOSED')
    socket.onmessage = message => {
      if (typeof message.data !== 'string' || message.data.length > 2_048) return
      let reply
      try { reply = presenceReply(JSON.parse(message.data)) } catch { return }
      if (reply?.type === 'presence_ready' && !ready) {
        ready = true
        socket.send(JSON.stringify({ type: 'presence_watch', id, token: target.proof.token }))
      } else if (reply?.id === id && reply.type === 'presence_unavailable') finish('PRESENCE_UNAVAILABLE')
      else if (reply?.id === id && reply.type === 'presence_ack') {
        if (!ready || reply.expiresAt !== Math.min(target.proof.expiresAt, ticket.expiresAt)
          || reply.expiresAt <= Date.now()) finish('PRESENCE_ACK')
        else finish()
      }
    }
  })
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
    owner = createOwnerRequest(session)
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
    checkOwnedEnrollment(await owner('/api/devices/enrollment'), session.ownerId, deviceId)
    const token = enrollmentToken((await owner('/api/device-tokens')).tokens)
    check(token.revokedAt === null, 'TOKEN_IDENTITY')
    tokenId = token.id
    check((await event('heartbeat')).deviceId === deviceId && (await event('gateway-pong')).deviceId === deviceId, 'TRANSPORT_IDENTITY')
    const deviceRead = await rpc('agents.pollDevices'), devices = deviceRead.devices
    check(devices?.length === 1 && devices[0].id === deviceId && devices[0].online === true, 'DEVICE_ONLINE')
    Object.assign(report.checks, { enrollment: true, realProcess: true, heartbeat: true, builtinGatewayPong: true, ownerDeviceOnline: true })
    check(deviceRead.live?.ownerId === session.ownerId && UUID.test(deviceRead.live?.workspaceId ?? ''), 'PRESENCE_SCOPE')
    const ticket = await owner(`/api/live/ticket?workspace=${deviceRead.live.workspaceId}`)
    await verifyPresence(ticket, deviceRead.live, session.ownerId)
    Object.assign(report.checks, { builtinPresenceReady: true, builtinPresenceAck: true })
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
          if (tokens.length) tokenId = enrollmentToken(tokens).id
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
