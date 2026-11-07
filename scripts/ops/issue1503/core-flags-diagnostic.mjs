#!/usr/bin/env node
// One normal-session observation. No full Core run, device, provider, model or database client.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isSmokeAccountEmail } from '../../../lib/smoke-account.ts'
import { encode, decode, DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/wire.ts'
import { responseCookieJar } from '../../acceptance/read-cache-production.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const BASE = '/mikka'
const SOURCE = '0c12a8064c1ab350c9739fa4c6ad84129f8a12a4'
const BRANCH = 'refs/heads/ops/issue-1503-core-flags-diagnostic-0c12'
const TEAM_HASH = 'fb00a1d8c63a0ae1c56ff3273bd259fd0756b8631b83e42f226926d389b3dade'
const POLICY_ADMIN_EMAIL_HASH = '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3'
const FAILED_REPORT_SHA = 'f194a04f6e46359424ec33d334b6d8788ace99d11cb852b065400b055d003125'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REPORT_DIR = 'issue1503-core-flags-report'
const CODES = new Set(['configuration', 'version', 'transport', 'response', 'sign_in', 'session_identity',
  'workspace_identity', 'workspace_scope', 'membership', 'bootstrap_limit', 'bootstrap_response',
  'bootstrap_identity', 'request_scope', 'session_close', 'deadline', 'unexpected'])
class DiagnosticError extends Error {
  constructor(code) { super(CODES.has(code) ? code : 'unexpected'); this.code = this.message }
}
const check = (ok, code) => { if (!ok) throw new DiagnosticError(code) }
const safeCode = error => error instanceof DiagnosticError ? error.code : 'unexpected'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const lower = value => typeof value === 'string' ? value.trim().toLowerCase() : ''
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const observedBoolean = (container, key) => !object(container) || !Object.hasOwn(container, key)
  ? { state: 'missing' }
  : typeof container[key] === 'boolean' ? { state: 'boolean', value: container[key] }
    : { state: 'non_boolean' }

function guard(env, credentials = false) {
  check(env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_REPOSITORY_OWNER === 'alexj11324'
    && env.GITHUB_REF === BRANCH && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_RUN_ATTEMPT === '1'
    && /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? ''),
  'configuration')
  if (credentials) check(isSmokeAccountEmail(env.SMOKE_OWNER_EMAIL)
    && typeof env.SMOKE_OWNER_PASSWORD === 'string' && env.SMOKE_OWNER_PASSWORD.length > 0, 'configuration')
}

async function parseJson(response) {
  const text = await response.text()
  check(Buffer.byteLength(text) <= 512_000, 'response')
  try { return JSON.parse(text) } catch { throw new DiagnosticError('response') }
}

async function publicVersion(fetchImpl) {
  const url = ORIGIN + BASE + '/api/version'
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { accept: 'application/json', 'cache-control': 'no-store' }, signal: AbortSignal.timeout(10_000) })
  } catch { throw new DiagnosticError('transport') }
  check(response.status === 200 && !response.redirected && (!response.url || response.url === url), 'version')
  const value = await parseJson(response)
  check(value?.build === SOURCE, 'version')
  return value.build
}

export async function attestCoreFlagsDiagnostic({ env = process.env, fetchImpl = fetch } = {}) {
  guard(env)
  return { version: 1, scope: 'issue1503-core-flags-attestation', status: 'ready',
    observedAt: new Date().toISOString(), build: await publicVersion(fetchImpl),
    failedCoreRunId: 42401535378, failedCoreReportSha256: FAILED_REPORT_SHA }
}

export async function runCoreFlagsDiagnostic({ env = process.env, fetchImpl = fetch } = {}) {
  const report = { version: 1, scope: 'issue1503-core-flags-diagnostic', status: 'failed',
    startedAt: new Date().toISOString(), endedAt: null, sourcePin: SOURCE,
    failedCoreRunId: 42401535378, failedCoreReportSha256: FAILED_REPORT_SHA,
    build: { before: null, after: null },
    identity: { sessionOwner: false, workspaceOwner: false, sameFailedReportTeam: false,
      activeMembership: false, policyAdminMembership: false, bootstrapOwner: false, bootstrapTeam: false },
    observation: null,
    session: { signInAttempted: false, signInSucceeded: false, signOutAttempted: false,
      signOutSucceeded: false, formerCookieRejected: false },
    calls: { publicVersion: 0, http: 0, bootstrap: 0, sessionWrites: 0, businessReads: 0 },
    errors: [], boundaries: { coreAcceptancePassed: false, modelRequests: 0, cloudComputerBoots: 0,
      deviceRegistrations: 0, directDatabaseAccess: false, workspaceSwitches: 0, configurationWrites: 0 } }
  const jar = responseCookieJar(Date.now)
  const mainDeadline = Date.now() + 90_000
  let phase = 'configuration', ownerId, workspaceId, role
  const error = cause => report.errors.push({ phase, code: safeCode(cause) })
  const remaining = deadline => { const ms = deadline - Date.now(); check(ms > 0, 'deadline'); return Math.min(15_000, ms) }

  async function owner(path, method = 'GET', body, { cookieOverride, deadline = mainDeadline } = {}) {
    const fixed = new Map([
      ['/api/auth/sign-in/email', 'POST'], ['/api/auth/sign-out', 'POST'],
      ['/api/auth/get-session?disableCookieCache=true', 'GET'], ['/api/workspace', 'GET'],
    ])
    const candidateRead = workspaceId && path === '/api/workspace?workspace=' + workspaceId && method === 'GET'
    const bootstrapRead = path === '/api/rpc' && method === 'POST' && workspaceId
      && body?.version === DESKTOP_RPC_VERSION && body?.action === 'desktop.bootstrap'
      && JSON.stringify(body.args) === JSON.stringify(encode([workspaceId]))
    check(fixed.get(path) === method || candidateRead || bootstrapRead, 'request_scope')
    check(method === 'POST' || body === undefined, 'request_scope')
    const url = new URL(BASE + path, ORIGIN)
    const cookie = cookieOverride ?? jar.header(url)
    let response
    try {
      report.calls.http++
      if (path.startsWith('/api/auth/') && method === 'POST') report.calls.sessionWrites++
      else if (!path.startsWith('/api/auth/')) report.calls.businessReads++
      response = await fetchImpl(url, { method, redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json', origin: ORIGIN, 'cache-control': 'no-store',
          ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(path === '/api/rpc' ? { 'x-mikka-rpc': '1' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(remaining(deadline)) })
    } catch (cause) { if (cause instanceof DiagnosticError) throw cause; throw new DiagnosticError('transport') }
    check(!response.redirected && (!response.url || response.url === url.href), 'response')
    jar.receive(url, response.headers)
    return { status: response.status, body: await parseJson(response) }
  }

  try {
    guard(env, true)
    phase = 'version_before'
    report.calls.publicVersion++
    report.build.before = await publicVersion(fetchImpl)
    phase = 'sign_in'
    report.session.signInAttempted = true
    const login = await owner('/api/auth/sign-in/email', 'POST',
      { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD })
    check(login.status === 200, 'sign_in')
    report.session.signInSucceeded = true
    phase = 'session_identity'
    const session = await owner('/api/auth/get-session?disableCookieCache=true')
    check(session.status === 200 && typeof session.body?.user?.id === 'string' && session.body.user.id.length > 0
      && lower(session.body.user.email) === lower(env.SMOKE_OWNER_EMAIL), 'session_identity')
    ownerId = session.body.user.id
    report.identity.sessionOwner = true

    phase = 'workspace_identity'
    const initial = await owner('/api/workspace')
    check(initial.status === 200 && initial.body?.currentUserId === ownerId && Array.isArray(initial.body.choices),
      'workspace_identity')
    report.identity.workspaceOwner = true
    const teams = initial.body.choices.filter(choice => choice?.kind === 'team')
    check(teams.length > 0 && teams.length <= 32
      && teams.every(choice => typeof choice.id === 'string' && UUID.test(choice.id)
        && initial.body.choices.filter(other => other?.id === choice.id).length === 1), 'workspace_scope')
    const matches = teams.filter(choice => sha256('team-workspace\0' + choice.id) === TEAM_HASH)
    check(matches.length === 1, 'workspace_scope')
    workspaceId = matches[0].id
    report.identity.sameFailedReportTeam = true
    phase = 'membership'
    const selected = await owner('/api/workspace?workspace=' + workspaceId)
    const settings = selected.body
    check(selected.status === 200 && settings?.currentUserId === ownerId && settings.workspace?.id === workspaceId
      && settings.workspace.kind === 'team' && ['member', 'admin'].includes(settings.role)
      && Array.isArray(settings.members), 'membership')
    role = settings.role
    check(settings.members.every(member => object(member) && typeof member.userId === 'string'
      && member.userId.length > 0 && typeof member.email === 'string' && lower(member.email).length > 0
      && ['member', 'admin'].includes(member.role) && ['active', 'suspended'].includes(member.status))
      && new Set(settings.members.map(member => member.userId)).size === settings.members.length, 'membership')
    const own = settings.members.filter(member => member.userId === ownerId)
    check(own.length === 1 && own[0].status === 'active' && own[0].role === role, 'membership')
    report.identity.activeMembership = true
    const policyAdmins = settings.members.filter(member => member.userId !== ownerId && member.role === 'admin'
      && member.status === 'active' && sha256(lower(member.email)) === POLICY_ADMIN_EMAIL_HASH)
    check(policyAdmins.length === 1, 'membership')
    report.identity.policyAdminMembership = true

    phase = 'bootstrap'
    check(report.calls.bootstrap === 0, 'bootstrap_limit')
    report.calls.bootstrap++
    const response = await owner('/api/rpc', 'POST',
      { version: DESKTOP_RPC_VERSION, action: 'desktop.bootstrap', args: encode([workspaceId]) })
    check(response.status === 200 && response.body?.version === DESKTOP_RPC_VERSION && response.body.ok === true
      && Object.hasOwn(response.body, 'result') && !response.body.error, 'bootstrap_response')
    let bootstrap
    try { bootstrap = decode(response.body.result) } catch { throw new DiagnosticError('bootstrap_response') }
    check(bootstrap?.user?.id === ownerId && bootstrap.edition === 'cloud', 'bootstrap_identity')
    report.identity.bootstrapOwner = true
    check(bootstrap.cacheWorkspace?.workspaceId === workspaceId && bootstrap.cacheWorkspace.role === role,
      'bootstrap_identity')
    report.identity.bootstrapTeam = true
    const flags = bootstrap.features?.flags
    report.observation = {
      flagsBooleanMap: flags === undefined ? { state: 'missing' }
        : { state: 'boolean', value: object(flags) && Object.values(flags).every(value => typeof value === 'boolean') },
      cloudComputer: observedBoolean(bootstrap.features, 'cloudComputer'),
      computerBilling: observedBoolean(flags, 'mikka-computer-billing'),
      computerTabOff: observedBoolean(flags, 'mikka-computer-tab-off'),
      emailEnabled: observedBoolean(bootstrap, 'emailEnabled'),
    }
  } catch (cause) { error(cause) }
  finally {
    if (report.session.signInAttempted) {
      const cleanupDeadline = Date.now() + 30_000
      try {
        phase = 'sign_out'
        const formerCookie = jar.header(new URL(BASE + '/api/auth/get-session', ORIGIN))
        check(Boolean(formerCookie), 'session_close')
        report.session.signOutAttempted = true
        const closed = await owner('/api/auth/sign-out', 'POST', {}, { deadline: cleanupDeadline })
        check(closed.status === 200 && closed.body?.success === true, 'session_close')
        report.session.signOutSucceeded = true
        const after = await owner('/api/auth/get-session?disableCookieCache=true', 'GET', undefined,
          { cookieOverride: formerCookie, deadline: cleanupDeadline })
        check(after.status === 200 && !after.body?.user, 'session_close')
        report.session.formerCookieRejected = true
      } catch (cause) { error(cause) }
    }
    jar.clear()
    ownerId = undefined
    workspaceId = undefined
  }
  if (report.build.before) {
    try {
      phase = 'version_after'
      report.calls.publicVersion++
      report.build.after = await publicVersion(fetchImpl)
    } catch (cause) { error(cause) }
  }
  if (!report.errors.length && report.observation && Object.values(report.identity).every(Boolean)
    && report.calls.bootstrap === 1 && report.session.signOutSucceeded && report.session.formerCookieRejected
    && report.build.before === SOURCE && report.build.after === SOURCE) report.status = 'observed'
  report.endedAt = new Date().toISOString()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attest = process.argv.includes('--attest')
  let report
  try { report = attest ? await attestCoreFlagsDiagnostic() : await runCoreFlagsDiagnostic() }
  catch (cause) { report = { version: 1, scope: 'issue1503-core-flags-diagnostic',
    status: 'failed', errors: [{ phase: 'entry', code: safeCode(cause) }] } }
  await mkdir(REPORT_DIR, { recursive: true, mode: 0o700 })
  await writeFile(REPORT_DIR + '/' + (attest ? 'attestation' : 'observation') + '.json',
    JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
  process.exitCode = report.status === (attest ? 'ready' : 'observed') ? 0 : 1
}
