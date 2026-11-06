// Finite owner API/native-gateway proof. It installs no daemon, claims no work,
// sends no model prompt and changes only this run's uniquely marked new device.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { alexSession, ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { normalDeviceRead, openPresenceConsumers, validatePresenceRead } from './presence-consumer.mjs'
import { preparePresenceSource } from './presence-source.mjs'
import { prepareBaselineSource } from './presence-baseline-source.mjs'
import { openBaselineConsumers, validateBaselineRead } from './presence-baseline-consumer.mjs'

const ORIGIN = 'https://app.aspectlylabs.com', BASE = ORIGIN + '/mikka'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^orv_[A-Za-z0-9_-]{43}$/, SHA = /^[0-9a-f]{40}$/
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const tokenIdentity = row => JSON.stringify([row.id, row.name, row.createdAt, row.expiresAt, row.revokedAt, row.revokedBy, row.boundDeviceId])
const deviceIdentity = row => JSON.stringify([row.id, row.name, row.enabled, row.hostname, row.platform, row.arch, row.harnesses])

/** Same positive before/after identity rule as scripts/ops/production-mobile-daemon.mjs. */
export function newCredential(before, after) {
  check(before.length < 100 && after.length <= 100
    && new Set(before.map(row => row.id)).size === before.length
    && new Set(after.map(row => row.id)).size === after.length
    && before.every(row => after.some(next => next.id === row.id && tokenIdentity(next) === tokenIdentity(row))), 'presence_credential_ambiguous')
  const added = after.filter(row => !before.some(old => old.id === row.id))
  check(added.length === 1 && UUID.test(added[0].id) && added[0].name === 'SSH'
    && Number.isFinite(Date.parse(added[0].createdAt)) && added[0].revokedAt === null
    && added[0].boundDeviceId === null && added[0].expiresAt === null, 'presence_credential_ambiguous')
  return added[0].id
}

export function retainedFixture(receipt, runKey) {
  check(receipt?.case === 'owner-device-presence' && receipt.mode === 'baseline' && receipt.status === 'baseline_captured'
    && receipt.runKey === runKey && SHA.test(receipt.applicationSha ?? '')
    && receipt.fixture?.marker === `presence-1212-${runKey}` && UUID.test(receipt.fixture.deviceId ?? '')
    && UUID.test(receipt.fixture.tokenId ?? '') && receipt.checks?.exactOwnerAndBuild === true
    && receipt.checks.baselineMeasured === true && receipt.cleanup?.deviceRetained === true
    && receipt.cleanup.credentialRevoked === true && receipt.cleanup.oldCredentialRejected === true
    && receipt.cleanup.deviceSocketClosed === true && receipt.cleanup.observersClosed === true
    && receipt.cleanup.verified === true && receipt.cleanup.signOut200 === true
    && receipt.idle?.elapsedMs >= 60_000 && receipt.idle.actualReads >= 3, 'presence_retained_receipt_invalid')
  return { deviceId: receipt.fixture.deviceId, marker: receipt.fixture.marker, applicationSha: receipt.applicationSha,
    originalTokenId: receipt.fixture.tokenId, baselineIdleReads: receipt.idle.actualReads }
}

export function parseRetainedReceipt(bytes, expectedHash) {
  check(/^[a-f0-9]{64}$/.test(expectedHash ?? '') && createHash('sha256').update(bytes).digest('hex') === expectedHash,
    'presence_retained_receipt_hash_invalid')
  try { return JSON.parse(bytes.toString('utf8')) }
  catch (cause) { throw Object.assign(new Error('presence_retained_receipt_invalid', { cause }), { code: 'presence_retained_receipt_invalid' }) }
}

export function validateDeviceTicket(ticket, deviceId) {
  let url
  try { url = new URL(ticket?.url) } catch { fail('presence_device_ticket_invalid') }
  check(url.protocol === 'wss:' && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === `/v1/devices/${deviceId}/socket` && typeof ticket.protocol === 'string'
    && /^mikka-ticket-\d+-[a-f0-9]{64}$/.test(ticket.protocol), 'presence_device_ticket_invalid')
  return { ...ticket, origin: url.origin }
}

/** The established daemon gateway wire: keep-alive is WS ping/pong only. */
export async function openDeviceSocket(ticket, { WebSocketClass = WebSocket, now = Date.now } = {}) {
  const socket = new WebSocketClass(ticket.url, ticket.protocol)
  let timer, closed = false, fault = null, lastPongAt = null, pings = 0, pongs = 0
  const listeners = new Set()
  const seen = () => { for (const listener of [...listeners]) listener() }
  const waitUntil = (predicate, timeoutMs, honorFault = true) => new Promise(resolve => {
    const finish = value => { clearTimeout(timeout); listeners.delete(checkState); resolve(value) }
    const checkState = () => { if (predicate()) finish(true); else if (honorFault && fault) finish(false) }
    const timeout = setTimeout(() => finish(false), timeoutMs)
    listeners.add(checkState); checkState()
  })
  const ping = () => {
    if (closed || socket.readyState !== 1) return
    try { socket.send('ping'); pings++ } catch { fault = 'presence_device_socket_failed'; seen(); return }
    timer = setTimeout(ping, 30_000)
  }
  socket.addEventListener('open', () => { ping(); seen() })
  socket.addEventListener('message', event => {
    if (event.data === 'pong') { lastPongAt = now(); pongs++; seen() }
    // No work/command subscription or claim is made by this fixture.
  })
  socket.addEventListener('error', () => { fault = 'presence_device_socket_failed'; seen() })
  socket.addEventListener('close', () => { clearTimeout(timer); closed = true; seen() })
  const close = async () => {
    clearTimeout(timer)
    if (socket.readyState < 2) socket.close()
    const result = await waitUntil(() => socket.readyState === 3, 5_000, false)
    check(result, 'presence_device_close_failed')
  }
  if (!await waitUntil(() => socket.readyState === 1 && pongs > 0, 15_000)) { await close().catch(() => {}); fail('presence_device_open_failed') }
  return { stopPings() { clearTimeout(timer) }, close,
    state() { return { readyState: socket.readyState, lastPongAt, pings, pongs, fault } } }
}

// Closed evidence codes only. Provider/server text and thrown messages never enter reports.
const publicCode = error => typeof error?.code === 'string' && /^presence_[a-z_]{1,60}$/.test(error.code)
  ? error.code : 'presence_failed'

export async function runPresenceProof({ env = process.env, mode = env.MIKKA_PRESENCE_MODE ?? 'after', expectedSha = env.MIKKA_ACCEPTANCE_SHA,
  runKey = env.MIKKA_PRESENCE_RUN_KEY, sourceRoot = env.MIKKA_PRESENCE_SOURCE_ROOT,
  resumeReceipt = null, sessionRunner = alexSession,
  sourceLoader = mode === 'baseline' ? prepareBaselineSource : preparePresenceSource,
  openConsumers = mode === 'baseline' ? openBaselineConsumers : openPresenceConsumers,
  fetchImpl = globalThis.fetch, WebSocketClass = WebSocket, now = Date.now, wait = delay,
  checkpoint = () => {} } = {}) {
  const report = { schemaVersion: 1, issue: 1212, case: 'owner-device-presence', mode, status: 'failed',
    applicationSha: SHA.test(expectedSha ?? '') ? expectedSha : null,
    runnerSha: SHA.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null,
    runKey, fixture: null, checks: {}, cleanup: {}, errors: [], requests: { owner: 0, device: 0 },
    startedAt: new Date(now()).toISOString() }
  let source, sessionRequests, phase = 'configuration'
  const error = cause => { report.errors.push({ phase, code: publicCode(cause) }); checkpoint(report) }
  try {
    check(['baseline', 'after'].includes(mode) && SHA.test(expectedSha ?? '') && /^[a-z0-9][a-z0-9-]{0,32}$/.test(runKey ?? ''), 'presence_configuration_invalid')
    check(mode === 'after' || !resumeReceipt, 'presence_configuration_invalid')
    const retained = resumeReceipt ? retainedFixture(resumeReceipt, runKey) : null
    if (retained) report.originBaseline = retained
    source = sourceLoader(sourceRoot)
    check(/^\d+\.\d+\.\d+$/.test(source.version) && Number.isSafeInteger(source.protocolVersion)
      && source.heartbeatWindowMs === 60_000, 'presence_source_contract_invalid')
    report.source = { base: source.sourceBase, clientPatchSha256: source.clientPatchSha256, hashes: source.hashes }
    report.client = { version: source.version, protocolVersion: source.protocolVersion, installedDaemon: false }
    const fixture = { marker: `presence-1212-${runKey}`, deviceId: retained?.deviceId ?? null, tokenId: null }
    report.fixture = fixture
    await sessionRunner(async session => {
      sessionRequests = session.requests
      check(session.identity.userId === ALEX_OWNER_ID && session.version.build === expectedSha, 'presence_session_identity_invalid')
      report.checks.exactOwnerAndBuild = true
      let credential, issuedCredential = false, credentialExchangeAttempted = false, registrationAttempted = false, tokenBefore, devicesBefore
      let deviceSocket, consumers, lastSeenAt = null, lastDeviceTicket
      const tokens = async () => {
        const value = await session.json('/api/device-tokens')
        check(Array.isArray(value?.tokens) && value.tokens.length <= 100 && value.tokens.every(row => UUID.test(row.id)), 'presence_tokens_invalid')
        return value.tokens
      }
      const read = async () => {
        const value = await normalDeviceRead(session)
        check(value.devices.every(row => UUID.test(row.id) && typeof row.name === 'string' && typeof row.enabled === 'boolean'
          && typeof row.online === 'boolean' && Array.isArray(row.harnesses)), 'presence_devices_invalid')
        return value
      }
      const locate = value => {
        const matches = value.devices.filter(row => row.name === fixture.marker
          && (!devicesBefore.some(old => old.id === row.id) || retained?.deviceId === row.id))
        check(matches.length <= 1, 'presence_device_identity_invalid')
        if (fixture.deviceId) check(matches.length === 1 && matches[0].id === fixture.deviceId, 'presence_device_identity_invalid')
        if (matches.length) {
          check(matches[0].harnesses.length === 0 && matches[0].platform === 'linux' && matches[0].arch === 'x64', 'presence_device_identity_invalid')
          fixture.deviceId = matches[0].id
          lastSeenAt = new Date(matches[0].lastSeenAt).getTime()
        }
        return matches[0]
      }
      const deviceRequest = async (path, { body, method = body === undefined ? 'GET' : 'POST', enrollment, allowUnauthorized = false } = {}) => {
        const allowed = enrollment ? path === '/v1/devices/enroll' : path === '/v1/devices/register'
          || fixture.deviceId && [
            `/v1/devices/${fixture.deviceId}/heartbeat`, `/v1/devices/${fixture.deviceId}/gateway`,
            `/v1/devices/${fixture.deviceId}/repos`,
          ].includes(path)
        check(allowed && TOKEN.test(enrollment ?? credential ?? ''), 'presence_device_request_invalid')
        report.requests.device++
        const response = await fetchImpl(BASE + path, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { authorization: 'Bearer ' + (enrollment ?? credential), accept: 'application/json',
            'x-mikka-client-version': source.version, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        if (allowUnauthorized) return response.status
        check(response.ok && !response.redirected, 'presence_device_http_failed')
        return response.json()
      }
      try {
        phase = 'baseline'
        tokenBefore = await tokens(); devicesBefore = (await read()).devices
        check(tokenBefore.length < 100 && devicesBefore.length < (retained ? 17 : 16), 'presence_fixture_baseline_invalid')
        if (retained) {
          const own = locate({ devices: devicesBefore })
          check(own?.id === retained.deviceId && own.enabled === false
            && tokenBefore.find(row => row.id === retained.originalTokenId)?.revokedAt != null, 'presence_retained_fixture_invalid')
          report.checks.sameBaselineDevice = true
        } else check(!devicesBefore.some(row => row.name === fixture.marker), 'presence_fixture_baseline_invalid')
        report.existingCounts = { devices: devicesBefore.length, credentials: tokenBefore.length }
        phase = 'enrollment'
        const grant = await session.json('/api/devices/enrollment', {}, 'POST')
        check(TOKEN.test(grant?.token ?? ''), 'presence_enrollment_invalid')
        let issued
        credentialExchangeAttempted = true
        try { issued = await deviceRequest('/v1/devices/enroll', { method: 'POST', enrollment: grant.token }) }
        finally { grant.token = undefined }
        check(TOKEN.test(issued?.credential ?? ''), 'presence_enrollment_invalid')
        credential = issued.credential; issued.credential = undefined; issuedCredential = true
        fixture.tokenId = newCredential(tokenBefore, await tokens())
        phase = 'registration'
        registrationAttempted = true
        const registered = await deviceRequest('/v1/devices/register', { body: { name: fixture.marker, hostname: fixture.marker,
          platform: 'linux', arch: 'x64', daemonVersion: source.version, protocolVersion: source.protocolVersion,
          harnesses: [], computerUse: { installed: false, version: null }, deviceType: 'server',
          ...(retained ? { deviceId: retained.deviceId } : {}) } })
        check(UUID.test(registered?.deviceId ?? '') && (retained ? registered.deviceId === retained.deviceId
          : !devicesBefore.some(row => row.id === registered.deviceId)), 'presence_registration_invalid')
        fixture.deviceId = registered.deviceId
        locate(await read())
        const disabled = await session.rpc('agents.setDeviceEnabled', [{ deviceId: fixture.deviceId, enabled: false }])
        check(disabled.success === true && locate(await read())?.enabled === false, 'presence_device_disable_failed')
        report.checks.fixtureDispatchDisabled = true; checkpoint(report)
        phase = 'heartbeat'
        const beat = await deviceRequest(`/v1/devices/${fixture.deviceId}/heartbeat`, { body: { harnesses: [], runs: [],
          worktreeDiskBytes: 0, computerUse: { installed: false, version: null }, deviceType: 'server' } })
        check(beat && typeof beat.leases === 'object' && Object.keys(beat.leases).length === 0
          && !(beat.revoked ?? []).length && !(beat.deviceCommands ?? []).length && !beat.cloudCredential, 'presence_heartbeat_invalid')
        report.checks.singleEmptyHeartbeat = true
        lastDeviceTicket = validateDeviceTicket(await deviceRequest(`/v1/devices/${fixture.deviceId}/gateway`), fixture.deviceId)
        deviceSocket = await openDeviceSocket(lastDeviceTicket, { WebSocketClass, now })
        const initialRead = (mode === 'baseline' ? validateBaselineRead : validatePresenceRead)(await read(), fixture, ALEX_OWNER_ID)
        const initialDevice = locate(initialRead)
        check(initialDevice.online && Number.isFinite(lastSeenAt), 'presence_initial_online_invalid')
        phase = 'observe'
        consumers = await openConsumers(session, initialRead, { fixture, source, expectedSha,
          gatewayOrigin: lastDeviceTicket.origin, checkpoint: value => { report.live = value; checkpoint(report) } })
        if (mode === 'after') report.checks.threeExactAcknowledgements = true
        else report.checks.threeOldClients = true
        // Let only the existing legacy heartbeat deadline run. This local wait
        // makes no application request; the real core owns any deadline read.
        await wait(Math.max(0, lastSeenAt + Math.max(source.heartbeatWindowMs, 90_000) + 2_500 - now()))
        await consumers.settle()
        check(deviceSocket.state().readyState === 1 && deviceSocket.state().lastPongAt !== null
          && now() - deviceSocket.state().lastPongAt < 45_000, 'presence_device_not_healthy')
        report.idleStartsAfterHeartbeatMs = now() - lastSeenAt
        phase = 'idle'
        report.idle = await consumers.quiet(65_000)
        check(deviceSocket.state().readyState === 1 && now() - deviceSocket.state().lastPongAt < 45_000, 'presence_device_not_healthy')
        if (mode === 'baseline') {
          check(report.idle.actualReads >= 3 && report.idle.allOldFallbacksActive === true, 'presence_baseline_window_invalid')
          report.checks.baselineMeasured = true
          return
        }
        report.checks.healthyIdleZeroReads = true
        if (retained) report.baselineComparison = { sameDevice: fixture.deviceId === retained.deviceId,
          beforeApplicationSha: retained.applicationSha, afterApplicationSha: expectedSha,
          beforeIdleReads: retained.baselineIdleReads, afterIdleReads: report.idle.actualReads }
        phase = 'disconnect'
        let marker = consumers.begin('disconnect')
        await deviceSocket.close(); deviceSocket = null
        report.disconnect = await consumers.waitState(marker, false, 15_000)
        report.checks.disconnectPushReadsBounded = true
        phase = 'reconnect'
        marker = consumers.begin('reconnect')
        lastDeviceTicket = validateDeviceTicket(await deviceRequest(`/v1/devices/${fixture.deviceId}/gateway`), fixture.deviceId)
        deviceSocket = await openDeviceSocket(lastDeviceTicket, { WebSocketClass, now })
        report.reconnect = await consumers.waitState(marker, true, 15_000)
        report.checks.reconnectPushReadsBounded = true
        phase = 'natural-expiry'
        marker = consumers.begin('natural-expiry')
        deviceSocket.stopPings()
        const lastPong = deviceSocket.state().lastPongAt
        report.expiry = await consumers.waitState(marker, false, 110_000)
        report.expiry.sinceLastPongMs = now() - lastPong
        report.expiry.socketStillOpen = deviceSocket.state().readyState === 1
        check(report.expiry.socketStillOpen && report.expiry.sinceLastPongMs >= 88_000, 'presence_natural_expiry_invalid')
        report.checks.naturalExpiryPushReadsBounded = true
      } catch (cause) { error(cause) }
      finally {
        phase = 'close-observers'
        if (consumers) {
          try {
            report.live = await consumers.close()
            report.cleanup.observersClosed = report.live.closed && report.live.tabs.length === 3
              && report.live.tabs.every(row => row.closed && (mode === 'baseline' || row.unwatches >= 1))
            check(report.cleanup.observersClosed, 'presence_observer_cleanup_failed')
          } catch (cause) { error(cause) }
        } else report.cleanup.observersClosed = true
        if (deviceSocket) { try { await deviceSocket.close(); report.cleanup.deviceSocketClosed = true } catch (cause) { error(cause) } }
        else report.cleanup.deviceSocketClosed = true
        phase = 'revoke-fixture-credential'
        if (issuedCredential && tokenBefore) {
          try {
            fixture.tokenId ??= newCredential(tokenBefore, await tokens())
            const revoked = await session.json(`/api/device-tokens/${fixture.tokenId}/revoke`, {}, 'POST')
            check(revoked?.tokenId === fixture.tokenId && revoked.revokedBy === ALEX_OWNER_ID
              && Number.isFinite(Date.parse(revoked.revokedAt)), 'presence_revoke_failed')
            report.cleanup.credentialRevoked = true
            if (fixture.deviceId) {
              check(await deviceRequest(`/v1/devices/${fixture.deviceId}/repos`, { allowUnauthorized: true }) === 401, 'presence_revoked_credential_admitted')
              report.cleanup.oldCredentialRejected = true
            }
          } catch (cause) { error(cause) }
        } else {
          report.cleanup.credentialRevoked = !credentialExchangeAttempted
          if (credentialExchangeAttempted) error(Object.assign(new Error(), { code: 'presence_credential_exchange_uncertain' }))
        }
        phase = 'remove-fixture-device'
        if (registrationAttempted && devicesBefore) {
          try {
            let own = locate(await read())
            if (own) {
              if (own.enabled) await session.rpc('agents.setDeviceEnabled', [{ deviceId: fixture.deviceId, enabled: false }])
              check(report.cleanup.credentialRevoked && report.cleanup.deviceSocketClosed, 'presence_cleanup_not_safe')
              if (own.online) {
                check(Number.isFinite(lastSeenAt), 'presence_cleanup_deadline_invalid')
                await wait(Math.max(1_000, lastSeenAt + source.heartbeatWindowMs + 2_500 - now()))
                own = locate(await read()) // One final known-deadline read, no polling loop.
              }
              check(own?.online === false && own.enabled === false, 'presence_cleanup_not_offline')
              if (mode === 'baseline' && report.checks.baselineMeasured && !report.errors.length) report.cleanup.deviceRetained = true
              else {
                const removed = await session.rpc('agents.removeDevice', [fixture.deviceId])
                check(removed.id === fixture.deviceId && removed.uninstall === 'not_possible', 'presence_remove_failed')
                report.cleanup.deviceRemoved = true
              }
            } else fail('presence_registration_uncertain')
          } catch (cause) { error(cause) }
        } else report.cleanup.deviceRemoved = true
        credential = undefined
        phase = 'audit-fixtures'
        if (devicesBefore && tokenBefore) {
          try {
            const remaining = (await read()).devices, currentTokens = await tokens()
            const originals = devicesBefore.filter(row => row.id !== retained?.deviceId)
            const expectedCount = originals.length + (report.cleanup.deviceRetained ? 1 : 0)
            report.cleanup.originalDevicesPreserved = expectedCount === remaining.length && originals.every(row => remaining.some(next => deviceIdentity(next) === deviceIdentity(row)))
            report.cleanup.originalCredentialsPreserved = tokenBefore.every(row => currentTokens.some(next => tokenIdentity(next) === tokenIdentity(row)))
            check(report.cleanup.originalDevicesPreserved && report.cleanup.originalCredentialsPreserved
              && (!fixture.deviceId || (report.cleanup.deviceRetained
                ? remaining.some(row => row.id === fixture.deviceId && row.name === fixture.marker && row.enabled === false && row.online === false)
                : !remaining.some(row => row.id === fixture.deviceId)))
              && (!fixture.tokenId || currentTokens.find(row => row.id === fixture.tokenId)?.revokedAt), 'presence_cleanup_audit_failed')
            report.cleanup.verified = true
          } catch (cause) { error(cause) }
        }
        phase = 'final-build'
        try { check((await session.json('/api/version')).build === expectedSha, 'presence_deployment_changed'); report.checks.finalBuildMatched = true }
        catch (cause) { error(cause) }
      }
    }, { env, expectedSha, fetchImpl })
  } catch (cause) { error(cause) }
  finally {
    source?.close()
    report.requests.owner = sessionRequests?.length ?? 0
    report.cleanup.signOut200 = sessionRequests?.some(row => row.path.endsWith('/api/auth/sign-out') && row.status === 200) ?? false
    report.finishedAt = new Date(now()).toISOString()
    if (!report.errors.length && report.cleanup.verified && report.cleanup.signOut200) {
      if (mode === 'after' && report.checks.naturalExpiryPushReadsBounded) report.status = 'passed'
      if (mode === 'baseline' && report.checks.baselineMeasured && report.cleanup.deviceRetained) report.status = 'baseline_captured'
    }
    checkpoint(report)
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = resolve(process.env.MIKKA_PRESENCE_REPORT_DIR ?? 'presence-acceptance-report')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let resumeReceipt = null
  if (process.env.MIKKA_PRESENCE_FIXTURE_RECEIPT) resumeReceipt = parseRetainedReceipt(
    readFileSync(process.env.MIKKA_PRESENCE_FIXTURE_RECEIPT), process.env.MIKKA_PRESENCE_RECEIPT_SHA256)
  const report = await runPresenceProof({ resumeReceipt, checkpoint: value => writeFileSync(resolve(directory, 'presence.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }) })
  console.log(JSON.stringify(report))
  if (!['passed', 'baseline_captured'].includes(report.status)) process.exitCode = 1
}
