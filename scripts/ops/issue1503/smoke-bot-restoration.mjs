#!/usr/bin/env node
// Restore one fixed Smoke Bot identity through the normal HTTP API. No task, device, provider, model or database client.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isSmokeAccountEmail } from '../../../lib/smoke-account.ts'
import { encode, decode, DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/wire.ts'
import { responseCookieJar } from '../../acceptance/read-cache-production.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const BASE = '/mikka'
const SOURCE = 'ce67afe931e9b9d6e7b0d346a62aa4d9751195c8'
const BRANCH = 'refs/heads/ops/issue-1503-smoke-bot-restoration-ce67'
const TEAM_HASH = 'fb00a1d8c63a0ae1c56ff3273bd259fd0756b8631b83e42f226926d389b3dade'
const POLICY_ADMIN_EMAIL_HASH = '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3'
const FAILED_REPORT_SHA = 'f194a04f6e46359424ec33d334b6d8788ace99d11cb852b065400b055d003125'
const OBSERVATION_RUN_ID = 42406339107
const OBSERVATION_REPORT_SHA = '47488bbd4589549aad9028c160014b83faab355d5e023eae140000d565d42bd8'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REPORT_DIR = 'issue1503-smoke-bot-restoration-report'
const CODES = new Set(['configuration', 'version', 'transport', 'response', 'sign_in', 'session_identity',
  'workspace_identity', 'workspace_scope', 'membership', 'bootstrap_limit', 'bootstrap_response',
  'bootstrap_identity', 'request_scope', 'bots_limit', 'bot_inventory', 'bot_scope', 'bot_name_collision',
  'bot_create_limit', 'bot_create_response', 'bot_create_unconfirmed', 'bot_readback', 'runtime_list',
  'checkpoint', 'session_close', 'deadline', 'unexpected'])
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

// Counts only. The wider second ID predicate is the exact production-smoke contract.
export function summarizeBotDiscovery(value) {
  const rows = Array.isArray(value) ? value : null
  const named = rows?.filter(row => object(row) && row.name === 'Smoke Bot')
  return {
    shape: rows ? 'array' : 'non_array',
    totalCount: rows ? rows.length : null,
    exactNameMatchCount: named ? named.length : null,
    validUuidNameMatchCount: named ? named.filter(row => typeof row.id === 'string' && UUID.test(row.id.toLowerCase())).length : null,
    productionSmokeIdNameMatchCount: named ? named.filter(row => typeof row.id === 'string' && /^[0-9a-f-]{36}$/i.test(row.id)).length : null,
  }
}

// The existing database index is unique on owner/workspace/lower(name); this
// operator adds no idempotency header and never retries an uncertain POST.
const BOT_NAME = 'Smoke Bot'
function scopedBotInventory(reply, ownerId, workspaceId) {
  check(reply.status === 200 && Array.isArray(reply.body) && reply.body.length <= 4096, 'bot_inventory')
  check(reply.body.every(row => object(row) && typeof row.id === 'string' && UUID.test(row.id)
    && typeof row.name === 'string' && row.name.length > 0 && row.name.length <= 120
    && row.ownerId === ownerId && row.workspaceId === workspaceId)
    && new Set(reply.body.map(row => row.id)).size === reply.body.length, 'bot_scope')
  const named = reply.body.filter(row => row.name === BOT_NAME)
  const folded = reply.body.filter(row => row.name.toLowerCase() === BOT_NAME.toLowerCase())
  check(named.length <= 1 && folded.length === named.length, 'bot_name_collision')
  return named
}

function inventoryProjection(reply) {
  return { httpStatus: reply.status, ...summarizeBotDiscovery(reply.body),
    caseInsensitiveNameMatchCount: Array.isArray(reply.body)
      ? reply.body.filter(row => object(row) && typeof row.name === 'string'
        && row.name.toLowerCase() === BOT_NAME.toLowerCase()).length : null }
}

export async function restoreSmokeBot({ ownerId, workspaceId, readBots, prepareCreate, checkpoint,
  createBot, readRuntimes }, state) {
  const before = await readBots()
  state.before = inventoryProjection(before)
  const existing = scopedBotInventory(before, ownerId, workspaceId)
  let acknowledgedId = null
  if (existing.length === 0) {
    await prepareCreate()
    await checkpoint()
    state.create.attempted = true
    try {
      const created = await createBot({ name: BOT_NAME })
      state.create.httpStatus = created.status
      check(created.status === 201 && object(created.body) && typeof created.body.id === 'string'
        && UUID.test(created.body.id) && created.body.name === BOT_NAME
        && created.body.ownerId === ownerId && created.body.workspaceId === workspaceId, 'bot_create_response')
      acknowledgedId = created.body.id
      state.create.acknowledged = true
    } catch (cause) {
      // A committed INSERT followed by transport/notification failure is possible.
      // Keep the failure and do one readback; never issue a second POST.
      state.create.uncertain = true
      state.create.errorCode = safeCode(cause)
    }
  }
  const after = await readBots()
  state.after = inventoryProjection(after)
  const named = scopedBotInventory(after, ownerId, workspaceId)
  state.exactTargetPresentAfter = named.length === 1
  if (state.create.uncertain) {
    state.outcome = 'unconfirmed_create'
    throw new DiagnosticError('bot_create_unconfirmed')
  }
  check(named.length === 1 && named[0].id === (acknowledgedId ?? existing[0]?.id), 'bot_readback')
  state.botIdHash = sha256('smoke-bot\0' + named[0].id)
  state.create.readbackMatched = state.create.acknowledged
  const runtimes = await readRuntimes(named[0].id)
  state.runtimeList = { httpStatus: runtimes.status, array: Array.isArray(runtimes.body?.runtimes),
    count: Array.isArray(runtimes.body?.runtimes) ? runtimes.body.runtimes.length : null }
  check(runtimes.status === 200 && object(runtimes.body) && Array.isArray(runtimes.body.runtimes), 'runtime_list')
  state.outcome = existing.length ? 'already_present' : 'created_and_verified'
}

async function writeCreateIntent(value) {
  try {
    await mkdir(REPORT_DIR, { recursive: true, mode: 0o700 })
    await writeFile(REPORT_DIR + '/create-intent.json', JSON.stringify(value, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
  } catch { throw new DiagnosticError('checkpoint') }
}

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

export async function attestSmokeBotRestoration({ env = process.env, fetchImpl = fetch } = {}) {
  guard(env)
  return { version: 1, scope: 'issue1503-smoke-discovery-attestation', status: 'ready',
    observedAt: new Date().toISOString(), build: await publicVersion(fetchImpl),
    failedCoreRunId: 42401535378, failedCoreReportSha256: FAILED_REPORT_SHA,
    missingBotObservationRunId: OBSERVATION_RUN_ID, missingBotObservationSha256: OBSERVATION_REPORT_SHA }
}

export async function runSmokeBotRestoration({ env = process.env, fetchImpl = fetch, checkpoint = writeCreateIntent } = {}) {
  const report = { version: 1, scope: 'issue1503-smoke-bot-restoration', status: 'failed',
    startedAt: new Date().toISOString(), endedAt: null, sourcePin: SOURCE,
    failedCoreRunId: 42401535378, failedCoreReportSha256: FAILED_REPORT_SHA,
    missingBotObservationRunId: OBSERVATION_RUN_ID, missingBotObservationSha256: OBSERVATION_REPORT_SHA,
    build: { before: null, after: null },
    identity: { sessionOwner: false, workspaceOwner: false, sameFailedReportTeam: false,
      activeMembership: false, policyAdminMembership: false, bootstrapOwner: false, bootstrapTeam: false },
    observation: null, initialWorkspace: null,
    botRestoration: { outcome: 'not_started', before: null, after: null, exactTargetPresentAfter: false,
      create: { attempted: false, httpStatus: null, acknowledged: false, uncertain: false,
        errorCode: null, readbackMatched: false }, botIdHash: null, runtimeList: null },
    session: { signInAttempted: false, signInSucceeded: false, signOutAttempted: false,
      signOutSucceeded: false, formerCookieRejected: false },
    calls: { publicVersion: 0, http: 0, bootstrap: 0, bots: 0, botCreates: 0, runtimeLists: 0,
      sessionWrites: 0, businessReads: 0, businessWrites: 0 },
    errors: [], boundaries: { coreAcceptancePassed: false, modelRequests: 0, cloudComputerBoots: 0,
      deviceRegistrations: 0, directDatabaseAccess: false, workspaceSwitches: 0, otherConfigurationWrites: 0,
      botCreatePostLimit: 1, noAutomaticCreateRetry: true, noBotDeleteOrRename: true,
      actualDatabaseIndexInspected: false, productionSmokeAcceptancePassed: false } }
  const jar = responseCookieJar(Date.now)
  const mainDeadline = Date.now() + 90_000
  let phase = 'configuration', ownerId, workspaceId, role, runtimeBotId
  const error = cause => report.errors.push({ phase, code: safeCode(cause) })
  const remaining = deadline => { const ms = deadline - Date.now(); check(ms > 0, 'deadline'); return Math.min(15_000, ms) }

  async function owner(path, method = 'GET', body, { cookieOverride, deadline = mainDeadline } = {}) {
    const fixed = new Map([
      ['/api/auth/sign-in/email', 'POST'], ['/api/auth/sign-out', 'POST'],
      ['/api/auth/get-session?disableCookieCache=true', 'GET'], ['/api/workspace', 'GET'], ['/api/bots', 'GET'],
    ])
    const candidateRead = workspaceId && path === '/api/workspace?workspace=' + workspaceId && method === 'GET'
    const bootstrapRead = path === '/api/rpc' && method === 'POST' && workspaceId
      && body?.version === DESKTOP_RPC_VERSION && body?.action === 'desktop.bootstrap'
      && JSON.stringify(body.args) === JSON.stringify(encode([workspaceId]))
    const botCreate = path === '/api/bots' && method === 'POST' && object(body)
      && Object.keys(body).length === 1 && body.name === BOT_NAME
      && report.botRestoration.create.attempted && Object.values(report.identity).every(Boolean)
      && report.initialWorkspace?.selectedWorkspaceMatchesExpectedTeam === true
    const runtimeRead = runtimeBotId && UUID.test(runtimeBotId) && method === 'GET'
      && path === '/api/bots/' + runtimeBotId + '/computer/runtimes'
    check(fixed.get(path) === method || candidateRead || bootstrapRead || botCreate || runtimeRead, 'request_scope')
    if (path === '/api/bots' && method === 'GET') {
      check(report.calls.bots < 2, 'bots_limit')
      report.calls.bots++
    }
    if (botCreate) {
      check(report.calls.botCreates === 0, 'bot_create_limit')
      report.calls.botCreates++
    }
    if (runtimeRead) {
      check(report.calls.runtimeLists === 0, 'runtime_list')
      report.calls.runtimeLists++
    }
    check(method === 'POST' || body === undefined, 'request_scope')
    const url = new URL(BASE + path, ORIGIN)
    const cookie = cookieOverride ?? jar.header(url)
    let response
    try {
      report.calls.http++
      if (path.startsWith('/api/auth/') && method === 'POST') report.calls.sessionWrites++
      else if (botCreate) report.calls.businessWrites++
      else if (!path.startsWith('/api/auth/')) report.calls.businessReads++
      response = await fetchImpl(url, { method, redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/json', origin: ORIGIN, 'cache-control': 'no-store',
          ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(path === '/api/rpc' ? { 'x-mikka-rpc': '1' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(remaining(deadline)) })
    } catch (cause) { if (cause instanceof DiagnosticError) throw cause; throw new DiagnosticError('transport') }
    check(!response.redirected && (!response.url || response.url === url.href), 'response')
    jar.receive(url, response.headers)
    if (botCreate) report.botRestoration.create.httpStatus = response.status
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
    const initialId = initial.body.workspace?.id
    const initialIdValid = typeof initialId === 'string' && UUID.test(initialId)
    const initialHash = initialIdValid ? sha256('team-workspace\0' + initialId) : null
    report.initialWorkspace = {
      selectedWorkspaceIdentified: initialIdValid,
      selectedWorkspaceIsTeam: initial.body.workspace?.kind === 'team',
      selectedWorkspaceHash: initialHash,
      selectedWorkspaceMatchesExpectedTeam: initial.body.workspace?.kind === 'team' && initialHash === TEAM_HASH,
    }
    check(report.initialWorkspace.selectedWorkspaceMatchesExpectedTeam, 'workspace_scope')
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
    phase = 'bot_restoration'
    await restoreSmokeBot({
      ownerId, workspaceId,
      readBots: () => owner('/api/bots'),
      prepareCreate: async () => {
        phase = 'bot_create_preflight'
        report.calls.publicVersion++
        await publicVersion(fetchImpl)
        const current = await owner('/api/workspace')
        check(current.status === 200 && current.body?.currentUserId === ownerId
          && current.body.workspace?.id === workspaceId && current.body.workspace.kind === 'team', 'workspace_scope')
        // Reserve bounded time for the one POST and its reads; cleanup has its own budget.
        check(mainDeadline - Date.now() >= 45_000, 'deadline')
      },
      checkpoint: async () => {
        phase = 'bot_create_intent'
        await checkpoint({ version: 1, scope: 'issue1503-smoke-bot-create-intent',
          recordedAt: new Date().toISOString(), sourcePin: SOURCE, runId: env.GITHUB_RUN_ID, runAttempt: 1,
          workspaceHash: TEAM_HASH, exactName: BOT_NAME, method: 'POST', path: '/api/bots',
          beforeExactNameCount: 0, beforeCaseInsensitiveNameCount: 0, requestLimit: 1,
          recordedBeforeRequest: true, requestOrCommitProven: false })
      },
      createBot: async body => {
        phase = 'bot_create'
        return owner('/api/bots', 'POST', body)
      },
      readRuntimes: async botId => {
        phase = 'runtime_list'
        runtimeBotId = botId
        return owner('/api/bots/' + runtimeBotId + '/computer/runtimes')
      },
    }, report.botRestoration)
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
    runtimeBotId = undefined
  }
  if (report.build.before) {
    try {
      phase = 'version_after'
      report.calls.publicVersion++
      report.build.after = await publicVersion(fetchImpl)
    } catch (cause) { error(cause) }
  }
  if (!report.errors.length && report.observation && Object.values(report.identity).every(Boolean)
    && report.calls.bootstrap === 1 && report.calls.bots === 2 && report.calls.botCreates <= 1
    && report.calls.runtimeLists === 1
    && ['already_present', 'created_and_verified'].includes(report.botRestoration.outcome)
    && report.session.signOutSucceeded && report.session.formerCookieRejected
    && report.build.before === SOURCE && report.build.after === SOURCE) report.status = 'restored'
  report.endedAt = new Date().toISOString()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const attest = process.argv.includes('--attest')
  let report
  try { report = attest ? await attestSmokeBotRestoration() : await runSmokeBotRestoration() }
  catch (cause) { report = { version: 1, scope: 'issue1503-smoke-bot-restoration',
    status: 'failed', errors: [{ phase: 'entry', code: safeCode(cause) }] } }
  await mkdir(REPORT_DIR, { recursive: true, mode: 0o700 })
  await writeFile(REPORT_DIR + '/' + (attest ? 'attestation' : 'restoration') + '.json',
    JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
  process.exitCode = report.status === (attest ? 'ready' : 'restored') ? 0 : 1
}
