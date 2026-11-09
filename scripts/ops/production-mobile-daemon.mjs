#!/usr/bin/env node
// One bounded normal-owner production API proof. It runs no daemon service,
// agents, model calls, cloud machines or SQL. Credentials never enter reports.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { encode, decode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { responseCookieJar } from '../acceptance/read-cache-production.mjs'
import { publishedActions } from '../acceptance/read-action-transport.mjs'
import { assertCurrentMain, waitForWebDeployment } from '../release/web-deploy.mjs'
import { DeployedTargetError, deployedTargetGuard, assertDeployedTarget, publicTargetFailure } from '../acceptance/deployed-target.mjs'
import { TeamWorkspaceError, selectTeamWorkspace, isTeamWorkspaceReadPath, isTeamWorkspaceSwitchRequest, publicTeamWorkspaceFailure } from '../acceptance/team-workspace.mjs'
import { CORE_MODE, CoreProductionError, coreProductionGuard, assertCoreProductionTarget, coreTargetFailure } from '../acceptance/self-hosted-production-target.mjs'
import { CORE_RPC_ACTIONS, CoreProbeError, readCoreCapabilities, coreLiveSocket, coreDeviceSocket } from '../acceptance/self-hosted-production-probes.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const BASE = '/mikka'
const OPS_REF = 'refs/heads/ops/issue1415-production-functional'
const SHA = /^[0-9a-f]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^orv_[A-Za-z0-9_-]{43}$/
const ACTIONS = ['agents.pollDevices', 'agents.setDeviceEnabled', 'agents.removeDevice']
const CODES = new Set(['configuration_invalid', 'deployment_mismatch', 'client_contract_unavailable',
  'request_rejected', 'transport_failed', 'response_invalid', 'sign_in_failed', 'session_identity',
  'mobile_home_failed', 'manifest_unavailable', 'resource_baseline_invalid', 'credential_ambiguous',
  'enrollment_failed', 'registration_failed', 'device_identity', 'device_disable_failed',
  'heartbeat_failed', 'token_revoke_failed', 'credential_still_admitted', 'offline_not_observed',
  'device_remove_failed', 'cleanup_failed', 'session_close_failed', 'proof_failed'])
class ProofError extends Error {
  constructor(code) { super(CODES.has(code) ? code : 'proof_failed'); this.code = this.message }
}
const check = (value, code) => { if (!value) throw new ProofError(code) }
const failureCode = error => error instanceof ProofError || error instanceof TeamWorkspaceError ? error.code : 'proof_failed'
const isUuid = value => typeof value === 'string' && UUID.test(value)
const sameIds = (left, right) => left.length === right.length && left.every(id => right.includes(id))
const tokenIdentity = token => JSON.stringify([token.id, token.name, token.createdAt, token.expiresAt,
  token.revokedAt, token.revokedBy, token.boundDeviceId])
const deviceIdentity = device => JSON.stringify([device.id, device.name, device.enabled,
  device.hostname, device.platform, device.arch, device.harnesses])
const resourceFingerprint = (kind, value) => createHash('sha256').update(kind + '\0' + value).digest('hex')

// Cleanup responses can contain cookies, credential values, owner ids or raw
// database errors. Keep a closed projection, including redacting unknown keys.
const CLEANUP_BODY_FIELDS = new Set(['error', 'code', 'detail', 'message', 'tokenId', 'revokedAt', 'revokedBy',
  'unattributedActiveRuns', 'version', 'ok', 'success', 'result', 'id', 'uninstall', 'revokedTokens',
  'tokens', 'devices', 'nextCursor', 'live', 'user'])
const CLEANUP_BODY_CODES = new Set(['originRejected', 'authRequired', 'unknownCredential', 'internal_error',
  'deviceNotFound', 'deviceHasActiveRuns', 'queued', 'not_possible'])
const CLEANUP_BODY_NUMBERS = new Set(['version', 'unattributedActiveRuns', 'revokedTokens'])
function cleanupBody(value, field, depth = 0) {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return CLEANUP_BODY_NUMBERS.has(field) ? value : '[redacted]'
  if (typeof value === 'string') return ['error', 'code', 'detail', 'uninstall'].includes(field)
    && CLEANUP_BODY_CODES.has(value) ? value : '[redacted]'
  if (Array.isArray(value)) return { type: 'array', count: value.length }
  if (!value || typeof value !== 'object' || depth >= 3) return '[redacted]'
  const body = {}, entries = Object.entries(value)
  let redactedFields = 0
  for (const [key, item] of entries) {
    if (CLEANUP_BODY_FIELDS.has(key)) body[key] = cleanupBody(item, key, depth + 1)
    else redactedFields++
  }
  if (redactedFields) body.redactedFields = redactedFields
  return body
}

function cleanupOperation(path, body) {
  if (path === '/api/rpc') return body.action
  if (path.endsWith('/revoke')) return 'device-tokens.revoke'
  if (path.startsWith('/api/device-tokens')) return 'device-tokens.list'
  if (path === '/api/auth/sign-out') return 'auth.sign-out'
  return 'auth.get-session'
}

export function proofConfiguration(env, event) {
  if (env.MIKKA_ACCEPTANCE_TARGET_MODE === CORE_MODE) {
    const binding = coreProductionGuard(env, event)
    check(isSmokeAccountEmail(env.SMOKE_OWNER_EMAIL) && Boolean(env.SMOKE_OWNER_PASSWORD), 'configuration_invalid')
    return binding
  }
  if (env.MIKKA_ACCEPTANCE_TARGET_MODE === 'deployed-target') {
    const binding = deployedTargetGuard(env, event)
    check(isSmokeAccountEmail(env.SMOKE_OWNER_EMAIL) && Boolean(env.SMOKE_OWNER_PASSWORD), 'configuration_invalid')
    return binding
  }
  check(env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_REF === OPS_REF
    && ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    && SHA.test(env.GITHUB_SHA ?? '') && /^\d+$/.test(env.GITHUB_RUN_ID ?? '')
    && SHA.test(env.APPLICATION_SHA ?? '') && Boolean(env.GH_TOKEN)
    && isSmokeAccountEmail(env.SMOKE_OWNER_EMAIL) && Boolean(env.SMOKE_OWNER_PASSWORD),
  'configuration_invalid')
  return { applicationSha: env.APPLICATION_SHA, runnerSha: env.GITHUB_SHA }
}

/** Complete owner-visible snapshots, not a guessed token id or an arbitrary device. */
export function newEnrollmentCredential(before, after) {
  check(new Set(before.map(row => row.id)).size === before.length
    && new Set(after.map(row => row.id)).size === after.length
    && before.every(row => after.some(next => next.id === row.id && tokenIdentity(next) === tokenIdentity(row))),
  'credential_ambiguous')
  const added = after.filter(row => !before.some(old => old.id === row.id))
  check(added.length === 1 && isUuid(added[0].id) && added[0].name === 'SSH'
    && Number.isFinite(Date.parse(added[0].createdAt)) && added[0].revokedAt === null
    && added[0].boundDeviceId === null && added[0].expiresAt === null, 'credential_ambiguous')
  return added[0].id
}

async function repositoryClient() {
  const [{ HttpServerLink, SessionRejectedError }, { DAEMON_VERSION }, { DAEMON_PROTOCOL_VERSION }] =
    await Promise.all([import('../../packages/daemon/src/server-link-http.ts'),
      import('../../packages/daemon/src/paths.ts'), import('../../packages/protocol/src/daemon.ts')])
  check(/^\d+\.\d+\.\d+$/.test(DAEMON_VERSION) && Number.isSafeInteger(DAEMON_PROTOCOL_VERSION),
    'client_contract_unavailable')
  return { version: DAEMON_VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION,
    create: fetchImpl => new HttpServerLink(ORIGIN + BASE, fetchImpl),
    rejected: error => error instanceof SessionRejectedError }
}

async function normalDeploymentGate({ env, fetchImpl }) {
  try {
    await assertCurrentMain({ expectedBuild: env.APPLICATION_SHA, token: env.GH_TOKEN, fetchImpl, timeoutMs: 20_000 })
    await waitForWebDeployment({ expectedBuild: env.APPLICATION_SHA, token: env.GH_TOKEN, fetchImpl,
      maxWaitMs: 30_000, intervalMs: 1000 })
  } catch { throw new ProofError('deployment_mismatch') }
}

export async function runMobileDaemonProof({ env = process.env, event, attestation, fetchImpl = fetch, now = Date.now,
  wait = delay, clientLoader = repositoryClient, deploymentGate = normalDeploymentGate, socketFactory } = {}) {
  const core = env.MIKKA_ACCEPTANCE_TARGET_MODE === CORE_MODE
  const report = { version: 1, scope: 'production-mobile-and-source-daemon-http', status: 'fail',
    applicationSha: SHA.test(env.APPLICATION_SHA ?? '') ? env.APPLICATION_SHA : null,
    runnerSha: SHA.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null,
    teamAdminMembershipVerified: false,
    client: { version: null, protocolVersion: null, osInstallationExercised: false },
    checks: { deployment: false, sessionOwner: false, mobileHomeOwner: false, publishedActions: false,
      enrollment: false, registration: false, deviceOwner: false, schedulingDisabled: false,
      heartbeat: false, finalDeployment: false },
    resources: { enrollmentAttempts: 0, issuedGrants: 0, credentialExchangeAttempts: 0, issuedCredentials: 0, registeredDevices: 0 },
    cleanup: { credentialRevoked: false, oldCredentialRejected: false, deviceRemoved: false,
      originalDevicesPreserved: false, originalCredentialsPreserved: false, sessionClosed: false },
    requests: { owner: 0, device: 0 }, errors: [] }
  if (core) {
    report.scope = 'mikka-cloud-core-compatibility'
    Object.assign(report.checks, { discoveryAndFlags: false, liveHandshake: false, liveDeviceList: false, deviceGateway: false })
    Object.assign(report.cleanup, { liveSocketClosed: true, deviceSocketClosed: true })
    report.boundaries = { modelRequestsByDriver: 0, cloudComputerBoots: 0, databaseAccessByDriver: false,
      browserExercised: false, providerLoginExercised: false, quotaEnforcementExercised: false, settlementExercised: false }
  }
  const jar = responseCookieJar(now)
  const marker = (core ? 'selfhost-core-' : 'm1415-wire-') + randomUUID()
  // The normal owner can match a later complete inventory to these exact
  // resources, without publishing ids, the nonce or a usable credential.
  report.resourceBindings = { algorithm: 'sha256', credentialId: null, deviceId: null,
    deviceNonce: resourceFingerprint('device-nonce', marker) }
  const unusedDeviceId = randomUUID()
  let phase = 'configuration', ownerId, teamWorkspaceId, teamRole, ownerLiveWorkspaceId, tokenId, credential, deviceId, client, contract
  let liveSocket, deviceSocket
  let beforeTokens, beforeDevices, registrationAttempted = false, signInStarted = false, signedIn = false, primaryPassed = false
  let cleanupResponse
  let targetProof = attestation
  const error = cause => {
    if (cause instanceof DeployedTargetError) report.targetFailure = publicTargetFailure(cause)
    if (cause instanceof TeamWorkspaceError) report.teamFailure = publicTeamWorkspaceFailure(cause)
    if (cause instanceof CoreProductionError) report.targetFailure = coreTargetFailure(cause)
    report.errors.push({ phase, ...(cause instanceof CoreProductionError || cause instanceof CoreProbeError
      ? { code: cause.code, detail: cause.detail } : { code: cause instanceof DeployedTargetError ? cause.code : failureCode(cause) }),
    ...(cleanupResponse?.phase === phase ? { http: cleanupResponse.http } : {}) })
  }
  const verifyDeployment = async () => {
    if (core) {
      targetProof = await assertCoreProductionTarget({ env, event, attestation: targetProof, fetchImpl, now })
      Object.assign(report, { targetMode: CORE_MODE, applicationSha: targetProof.applicationSha,
        driverRevision: targetProof.driverRevision, driverRunId: targetProof.driverRunId, driverRunAttempt: targetProof.driverRunAttempt,
        webDeployRunId: targetProof.webDeployRunId, webAttempt: targetProof.webAttempt, webDeployJobId: targetProof.webDeployJobId,
        openIssues: targetProof.openIssues })
      report.client.sourceRevision = targetProof.driverRevision
      return
    }
    if (env.MIKKA_ACCEPTANCE_TARGET_MODE !== 'deployed-target') return deploymentGate({ env, fetchImpl })
    const proof = await assertDeployedTarget({ env, event, attestation: targetProof, fetchImpl, now })
    targetProof = proof
    Object.assign(report, { targetMode: proof.targetMode, applicationSha: proof.applicationSha,
      driverRevision: proof.driverRevision, driverRunId: proof.driverRunId, driverRunAttempt: proof.driverRunAttempt,
      webDeployRunId: proof.webDeployRunId, webAttempt: proof.webAttempt, webDeployJobId: proof.webDeployJobId,
      deploymentId: proof.deploymentId })
    // This client comes from the real driver checkout, not the separately deployed application.
    report.client.sourceRevision = proof.driverRevision
  }

  async function json(response, cleanupHttp) {
    const text = await response.text()
    if (cleanupHttp) cleanupHttp.body = { format: 'non-json', bytes: Buffer.byteLength(text) }
    check(Buffer.byteLength(text) <= 8_000_000, 'response_invalid')
    let body
    try { body = JSON.parse(text) } catch { throw new ProofError('response_invalid') }
    if (cleanupHttp) cleanupHttp.body = cleanupBody(body)
    return body
  }
  async function owner(path, method = 'GET', body, cookieOverride) {
    const known = new Set(['/api/auth/sign-in/email', '/api/auth/sign-out',
      '/api/auth/get-session?disableCookieCache=true', '/api/auth/get-session', '/api/workspace', '/api/mobile/home',
      '/api/device-tokens', '/api/devices/enrollment', '/api/rpc', '/renderer-manifest.json'])
    check(known.has(path) || (core && method === 'GET' && body === undefined && (path === '/api/desktop/discovery'
      || ownerLiveWorkspaceId && path === '/api/live/ticket?workspace=' + ownerLiveWorkspaceId))
      || (method === 'GET' && body === undefined && isTeamWorkspaceReadPath(BASE + path))
      || (method === 'GET' && body === undefined && path.startsWith('/api/device-tokens?cursor=')
        && isUuid(path.slice('/api/device-tokens?cursor='.length)))
      || (tokenId && path === '/api/device-tokens/' + tokenId + '/revoke'),
      'request_rejected')
    const url = new URL(BASE + path, ORIGIN)
    const cookie = cookieOverride ?? jar.header(url)
    const cleanupHttp = phase.startsWith('cleanup-') || phase === 'sign-out'
      ? { operation: cleanupOperation(path, body), method, status: null, body: { format: 'unavailable' } } : undefined
    if (cleanupHttp) cleanupResponse = { phase, http: cleanupHttp }
    let response
    try {
      report.requests.owner++
      response = await fetchImpl(url, { method, redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json', origin: ORIGIN, 'cache-control': 'no-store',
          ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(path === '/api/rpc' ? { 'x-mikka-rpc': '1' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
    } catch { throw new ProofError('transport_failed') }
    if (cleanupHttp) cleanupHttp.status = response.status
    check(!response.redirected && (!response.url || response.url === url.href), 'response_invalid')
    jar.receive(url, response.headers)
    return { status: response.status, body: await json(response, cleanupHttp) }
  }
  async function rpc(action, args = []) {
    check(ACTIONS.includes(action) || core && CORE_RPC_ACTIONS.includes(action), 'request_rejected')
    const response = await owner('/api/rpc', 'POST', { version: DESKTOP_RPC_VERSION, action, args: encode(args) })
    check(response.status === 200 && response.body?.version === DESKTOP_RPC_VERSION
      && response.body.ok === true && Object.hasOwn(response.body, 'result') && !response.body.error, 'response_invalid')
    const data = decode(response.body.result)
    check(data && !data.error, 'response_invalid')
    return data
  }
  async function tokens() {
    const rows = [], seen = new Set()
    let cursor = null
    // Bound operator work while refusing an incomplete snapshot. Never truncate
    // history or weaken the before/after preservation proof to fit one page.
    for (let page = 0; page < 100; page++) {
      const response = await owner('/api/device-tokens' + (cursor ? '?cursor=' + cursor : ''))
      const batch = response.body?.tokens
      check(response.status === 200 && Array.isArray(batch) && batch.length <= 100
        && batch.every(row => isUuid(row.id) && typeof row.name === 'string'
          && Number.isFinite(Date.parse(row.createdAt)) && !seen.has(row.id))
        && new Set(batch.map(row => row.id)).size === batch.length, 'resource_baseline_invalid')
      for (const row of batch) { rows.push(row); seen.add(row.id) }
      // Earlier deployed targets are reusable only when their page is complete.
      if (!Object.hasOwn(response.body, 'nextCursor')) {
        check(batch.length < 100, 'resource_baseline_invalid'); return rows
      }
      const next = response.body.nextCursor
      if (next === null) return rows
      check(batch.length === 100 && isUuid(next) && next === batch.at(-1).id && next !== cursor, 'resource_baseline_invalid')
      cursor = next
    }
    throw new ProofError('resource_baseline_invalid')
  }
  async function devices() {
    const data = await rpc('agents.pollDevices')
    check(Array.isArray(data.devices) && data.devices.every(row => isUuid(row.id)
      && typeof row.name === 'string' && typeof row.enabled === 'boolean'
      && typeof row.online === 'boolean' && Array.isArray(row.harnesses))
      && new Set(data.devices.map(row => row.id)).size === data.devices.length, 'resource_baseline_invalid')
    if (core) {
      check(data.live?.ownerId === ownerId && isUuid(data.live.workspaceId)
        && (!ownerLiveWorkspaceId || ownerLiveWorkspaceId === data.live.workspaceId), 'resource_baseline_invalid')
      ownerLiveWorkspaceId = data.live.workspaceId
    }
    return data.devices
  }
  async function deviceFetch(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = (init.method ?? 'GET').toUpperCase(), headers = new Headers(init.headers)
    const target = deviceId ?? unusedDeviceId
    check(url.origin === ORIGIN && !url.search && !url.hash
      && ((method === 'POST' && url.pathname === BASE + '/v1/devices/register')
        || (method === 'POST' && deviceId && url.pathname === BASE + '/v1/devices/' + deviceId + '/heartbeat')
        || (core && method === 'GET' && deviceId && url.pathname === BASE + '/v1/devices/' + deviceId + '/gateway')
        || (method === 'GET' && url.pathname === BASE + '/v1/devices/' + target + '/repos'))
      && headers.get('authorization') === 'Bearer ' + credential && !headers.has('cookie')
      && headers.get('x-mikka-client-version') === contract.version, 'request_rejected')
    report.requests.device++
    return fetchImpl(input, init)
  }
  async function locateDevice() {
    const rows = await devices()
    const matches = rows.filter(row => row.name === marker && !beforeDevices.some(old => old.id === row.id))
    check(matches.length <= 1, 'device_identity')
    // A returned id alone never authorizes a mutation of a differently named
    // device. Lost replies can only adopt this run's fresh nonce.
    if (deviceId) check(matches.length === 1 && matches[0].id === deviceId, 'device_identity')
    if (matches.length) {
      check(matches[0].platform === process.platform && matches[0].arch === process.arch
        && matches[0].harnesses.length === 0, 'device_identity')
      if (deviceId) check(matches[0].id === deviceId, 'device_identity')
      deviceId = matches[0].id
      report.resourceBindings.deviceId = resourceFingerprint('device-id', deviceId)
    }
    return rows
  }

  try {
    proofConfiguration(env, event)
    phase = 'deployment'
    await verifyDeployment()
    report.checks.deployment = true
    phase = 'client'
    contract = await clientLoader()
    check(/^\d+\.\d+\.\d+$/.test(contract.version) && Number.isSafeInteger(contract.protocolVersion),
      'client_contract_unavailable')
    report.client.version = contract.version
    report.client.protocolVersion = contract.protocolVersion
    client = contract.create(deviceFetch)
    phase = 'sign-in'
    signInStarted = true
    const login = await owner('/api/auth/sign-in/email', 'POST',
      { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD })
    check(login.status === 200, 'sign_in_failed')
    signedIn = true
    const session = await owner('/api/auth/get-session?disableCookieCache=true')
    check(session.status === 200 && typeof session.body?.user?.id === 'string'
      && session.body.user.email?.toLowerCase() === env.SMOKE_OWNER_EMAIL.toLowerCase(), 'session_identity')
    ownerId = session.body.user.id
    report.checks.sessionOwner = true
    phase = 'team-workspace'
    Object.assign(report, await selectTeamWorkspace({ ownerId, json: async (path, body) => {
      check(body === undefined
        ? isTeamWorkspaceReadPath(path) || path === BASE + '/api/auth/get-session'
        : path === BASE + '/api/rpc' && isTeamWorkspaceSwitchRequest(body), 'request_rejected')
      const response = await owner(path.slice(BASE.length), body === undefined ? 'GET' : 'POST', body)
      check(response.status === 200, 'response_invalid')
      if (path === BASE + '/api/workspace') { teamWorkspaceId = response.body?.workspace?.id; teamRole = response.body?.role }
      return response.body
    } }))
    phase = 'mobile-home'
    const home = await owner('/api/mobile/home')
    check(home.status === 200 && home.body?.user?.id === ownerId
      && home.body.user.email?.toLowerCase() === env.SMOKE_OWNER_EMAIL.toLowerCase()
      && home.body.workspace?.id === teamWorkspaceId && home.body.workspace.kind === 'team'
      && Array.isArray(home.body.workspaces) && Array.isArray(home.body.bots)
      && Number.isSafeInteger(home.body.threads?.running) && Number.isSafeInteger(home.body.threads?.waiting)
      && home.body.live?.ownerId === ownerId
      && (home.body.live.workspaceId === null || isUuid(home.body.live.workspaceId)), 'mobile_home_failed')
    report.checks.mobileHomeOwner = true
    if (core) {
      phase = 'core-capabilities'
      report.core = await readCoreCapabilities({ owner, rpc, ownerId, workspaceId: teamWorkspaceId, role: teamRole,
        applicationSha: report.applicationSha })
      report.checks.discoveryAndFlags = true
    }
    phase = 'resource-baseline'
    const manifest = await owner('/renderer-manifest.json')
    check(manifest.status === 200, 'manifest_unavailable')
    const used = publishedActions(manifest.body)
    check(ACTIONS.every(action => used.has(action)), 'manifest_unavailable')
    report.checks.publishedActions = true
    beforeTokens = await tokens()
    beforeDevices = await devices()
    check(!beforeDevices.some(row => row.name === marker || row.id === unusedDeviceId), 'resource_baseline_invalid')
    if (core) {
      phase = 'core-live-handshake'
      const response = await owner('/api/live/ticket?workspace=' + ownerLiveWorkspaceId)
      check(response.status === 200, 'response_invalid')
      liveSocket = coreLiveSocket(response.body, { ownerId, workspaceId: ownerLiveWorkspaceId, now, socketFactory })
      report.cleanup.liveSocketClosed = false
      await liveSocket.ready()
      report.checks.liveHandshake = true
    }
    phase = 'enrollment'
    report.resources.enrollmentAttempts++
    const enrollment = await owner('/api/devices/enrollment', 'POST')
    check(enrollment.status === 200 && TOKEN.test(enrollment.body?.token ?? ''), 'enrollment_failed')
    report.resources.issuedGrants++
    let issued
    try {
      report.resources.credentialExchangeAttempts++
      report.requests.device++
      const response = await fetchImpl(ORIGIN + BASE + '/v1/devices/enroll', {
        method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + enrollment.body.token,
          accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
      check(response.status === 200 && !response.redirected, 'enrollment_failed')
      issued = await json(response)
    } finally { enrollment.body.token = undefined }
    check(TOKEN.test(issued?.credential ?? ''), 'enrollment_failed')
    credential = issued.credential
    issued.credential = undefined
    report.resources.issuedCredentials++
    report.checks.enrollment = true
    phase = 'credential-identity'
    tokenId = newEnrollmentCredential(beforeTokens, await tokens())
    report.resourceBindings.credentialId = resourceFingerprint('device-token-id', tokenId)
    phase = 'register'
    const liveReceipt = liveSocket?.expectDeviceList()
    registrationAttempted = true
    const registered = await client.registerDevice(credential, {
      name: marker, hostname: marker, platform: process.platform, arch: process.arch,
      daemonVersion: contract.version, protocolVersion: contract.protocolVersion,
      harnesses: [], computerUse: { installed: false, version: null }, deviceType: 'server' })
    check(isUuid(registered?.deviceId) && !beforeDevices.some(row => row.id === registered.deviceId), 'registration_failed')
    deviceId = registered.deviceId
    report.resources.registeredDevices++
    report.checks.registration = true
    phase = 'device-owner'
    const own = (await locateDevice()).find(row => row.id === deviceId)
    check(own?.name === marker && own.harnesses.length === 0, 'device_identity')
    report.checks.deviceOwner = true
    if (core) {
      phase = 'core-live-device-list'
      await liveReceipt()
      report.checks.liveDeviceList = true
    }
    phase = 'disable-scheduling'
    const disabled = await rpc('agents.setDeviceEnabled', [{ deviceId, enabled: false }])
    check(disabled.success === true && (await devices()).find(row => row.id === deviceId)?.enabled === false,
      'device_disable_failed')
    report.checks.schedulingDisabled = true
    if (core) {
      phase = 'core-device-gateway'
      const ticket = await client.deviceGateway(deviceId)
      deviceSocket = coreDeviceSocket(ticket, { deviceId, now, socketFactory })
      report.cleanup.deviceSocketClosed = false
      await deviceSocket.ping()
      report.checks.deviceGateway = true
    }
    phase = 'heartbeat'
    const beat = await client.heartbeat(deviceId, { harnesses: [], runs: [], worktreeDiskBytes: 0,
      computerUse: { installed: false, version: null }, deviceType: 'server' })
    check(beat && typeof beat.leases === 'object' && Object.keys(beat.leases).length === 0
      && (beat.revoked ?? []).length === 0 && (beat.deviceCommands ?? []).length === 0
      && !beat.cloudCredential, 'heartbeat_failed')
    const present = (await devices()).find(row => row.id === deviceId)
    check(present?.name === marker && present.online === true && present.enabled === false, 'heartbeat_failed')
    report.checks.heartbeat = true
    primaryPassed = true
  } catch (cause) { error(cause) }
  finally {
    for (const [socket, key] of [[deviceSocket, 'deviceSocketClosed'], [liveSocket, 'liveSocketClosed']]) {
      if (!socket) continue
      try { phase = 'cleanup-socket'; await socket.close(); report.cleanup[key] = true }
      catch (cause) { error(cause) }
    }
    // No mutation is replayed. A lost register reply is reconciled only against
    // this nonce and the complete pre-existing owner-visible device snapshot.
    if (signedIn && beforeTokens && report.resources.credentialExchangeAttempts) {
      try {
        phase = 'cleanup-credential'
        // The exchange must have returned its valid credential. An uncertain
        // exchange cannot adopt an unrelated concurrent SSH token by timing.
        check(report.resources.issuedCredentials === 1 && credential, 'credential_ambiguous')
        if (!tokenId) {
          tokenId = newEnrollmentCredential(beforeTokens, await tokens())
          report.resourceBindings.credentialId = resourceFingerprint('device-token-id', tokenId)
        }
        const revoked = await owner('/api/device-tokens/' + tokenId + '/revoke', 'POST')
        check(revoked.status === 200 && revoked.body?.tokenId === tokenId
          && revoked.body.revokedBy === ownerId && Number.isFinite(Date.parse(revoked.body.revokedAt)),
        'token_revoke_failed')
        report.cleanup.credentialRevoked = true
        // This is an actual read using the original repository transport and
        // credential; its 401 must be the client's typed session rejection.
        let rejected = false
        try {
          await client.listRepos(deviceId ?? unusedDeviceId)
        } catch (cause) {
          rejected = contract.rejected(cause)
        }
        check(rejected, 'credential_still_admitted')
        report.cleanup.oldCredentialRejected = true
      } catch (cause) { error(cause) }
    }
    if (signedIn && beforeDevices && registrationAttempted) {
      try {
        phase = 'cleanup-device'
        let rows = await locateDevice()
        if (deviceId) {
          if (rows.find(row => row.id === deviceId)?.enabled === true) {
            const disabled = await rpc('agents.setDeviceEnabled', [{ deviceId, enabled: false }])
            check(disabled.success === true, 'device_disable_failed')
            rows = await devices()
          }
          // Revoke first, then let the normal 60-second presence window lapse.
          // The probe has no installed OS service and never fabricates an
          // uninstall receipt. Normal offline removal leaves only audit history.
          check(report.cleanup.credentialRevoked && report.cleanup.oldCredentialRejected, 'cleanup_failed')
          const deadline = now() + 90_000
          while (rows.find(row => row.id === deviceId)?.online === true && now() < deadline) {
            await wait(Math.min(3_000, deadline - now()))
            rows = await devices()
          }
          const own = rows.find(row => row.id === deviceId)
          check(own?.name === marker && own.enabled === false && own.online === false, 'offline_not_observed')
          const removed = await rpc('agents.removeDevice', [deviceId])
          check(removed.id === deviceId && removed.uninstall === 'not_possible', 'device_remove_failed')
          report.cleanup.deviceRemoved = true
        } else report.cleanup.deviceRemoved = true
      } catch (cause) { error(cause) }
    } else if (!registrationAttempted) report.cleanup.deviceRemoved = true
    if (signedIn && beforeTokens && beforeDevices) {
      try {
        phase = 'cleanup-audit'
        const remainingTokens = await tokens(), remainingDevices = await devices()
        report.cleanup.originalCredentialsPreserved = beforeTokens.every(row =>
          remainingTokens.some(next => next.id === row.id && tokenIdentity(row) === tokenIdentity(next)))
        report.cleanup.originalDevicesPreserved = sameIds(beforeDevices.map(row => row.id), remainingDevices.map(row => row.id))
          && beforeDevices.every(row => remainingDevices.some(next => next.id === row.id && deviceIdentity(row) === deviceIdentity(next)))
        check(report.cleanup.originalCredentialsPreserved && report.cleanup.originalDevicesPreserved, 'cleanup_failed')
        if (tokenId) check(remainingTokens.find(row => row.id === tokenId)?.revokedAt != null, 'cleanup_failed')
      } catch (cause) { error(cause) }
    }
    if (signInStarted) {
      try {
        phase = 'sign-out'
        const formerCookie = jar.header(new URL(BASE + '/api/auth/get-session', ORIGIN))
        check(Boolean(formerCookie), 'session_close_failed')
        const response = await owner('/api/auth/sign-out', 'POST', {})
        check(response.status === 200 && response.body?.success === true, 'session_close_failed')
        const closed = await owner('/api/auth/get-session?disableCookieCache=true', 'GET', undefined, formerCookie)
        check(closed.status === 200 && !closed.body?.user, 'session_close_failed')
        report.cleanup.sessionClosed = true
      } catch (cause) { error(cause) }
    }
    jar.clear()
    credential = undefined
  }
  if ((core || env.MIKKA_ACCEPTANCE_TARGET_MODE === 'deployed-target') && report.checks.deployment) {
    // Failure attribution needs an actual after-observation too. This never
    // suppresses the original business or cleanup errors, nor repeats a mutation.
    try {
      phase = 'final-deployment'
      await verifyDeployment()
      report.checks.finalDeployment = true
      report.targetAfter = { verified: true, status: 'ready' }
    } catch (cause) {
      const failure = core ? coreTargetFailure(cause) : publicTargetFailure(cause)
      report.targetAfter = { verified: false, ...failure }
      report.targetFailure ??= failure
      error(cause)
    }
  }
  if (primaryPassed && !report.errors.length) {
    try {
      phase = 'final-deployment'
      if (!core && env.MIKKA_ACCEPTANCE_TARGET_MODE !== 'deployed-target') {
        await verifyDeployment()
        report.checks.finalDeployment = true
      }
      check(Object.values(report.checks).every(Boolean) && Object.values(report.cleanup).every(Boolean), 'cleanup_failed')
      report.status = 'pass'
    } catch (cause) { error(cause) }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try {
    const deployed = process.env.MIKKA_ACCEPTANCE_TARGET_MODE === 'deployed-target'
    const event = deployed ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : undefined
    const attestation = deployed
      ? JSON.parse(await readFile('production-read-cache-report/attestation.json', 'utf8')) : undefined
    report = await runMobileDaemonProof({ event, attestation })
  }
  catch { report = { version: 1, scope: 'production-mobile-and-source-daemon-http', status: 'fail',
    errors: [{ phase: 'entry', code: 'proof_failed' }] } }
  await mkdir('production-transport-proof-report', { recursive: true, mode: 0o700 })
  await writeFile('production-transport-proof-report/mobile-daemon.json', JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ scope: report.scope, status: report.status, errors: report.errors }))
  if (report.status !== 'pass') process.exitCode = 1
}
