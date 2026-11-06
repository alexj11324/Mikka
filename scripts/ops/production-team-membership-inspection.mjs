import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'

const ORIGIN = 'https://app.aspectlylabs.com'
const REPO = 'alexj11324/Mikka'
const REPO_ID = 1427517699
const OWNER_ID = 183887963
const API = 'https://api.github.com/repos/' + REPO
const BRANCH = 'ops/issue1415-team-membership-inspection'
const WORKFLOW = '.github/workflows/issue1415-team-membership-inspection.yml'
// Owner issue 1504 comment 6691409495. This is an identity comparison, never a login.
const POLICY_HASH = '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const email = value => typeof value === 'string' ? value.trim().toLowerCase() : ''
const emailValid = value => /^[^@\s]+@[^@\s]+$/.test(value) && value.length <= 320
const uuid = value => typeof value === 'string' && value.length === 36 && UUID.test(value)
const check = (ok, code) => { if (!ok) throw new InspectionError(code) }
class InspectionError extends Error {
  constructor(code, { cause } = {}) { super(code, { cause }); this.code = code }
}
const publicCode = error => error instanceof InspectionError ? error.code : 'inspection_failed'
const sameRepo = value => value?.id === REPO_ID && value.full_name === REPO && value.owner?.id === OWNER_ID

// Verbatim existing server-response cookie handling from read-cache-production.mjs.
// Kept source-only here so this one-time inspection needs no dependency installation.
function responseCookieJar(now) {
  const cookies = new Map()
  const domainMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`)
  return {
    receive(url, headers) {
      for (const header of headers.getSetCookie()) {
        const parts = header.split(';').map(value => value.trim()), separator = parts[0].indexOf('=')
        if (separator < 1) continue
        const name = parts[0].slice(0, separator), value = parts[0].slice(separator + 1)
        if (!/^[!#$%&'*+\-.^_\x60|~0-9A-Za-z]+$/.test(name)) continue
        const attributes = Object.fromEntries(parts.slice(1).map(part => {
          const at = part.indexOf('=')
          return at < 0 ? [part.toLowerCase(), true] : [part.slice(0, at).toLowerCase(), part.slice(at + 1)]
        }))
        const domain = typeof attributes.domain === 'string' ? attributes.domain.replace(/^\./, '').toLowerCase() : url.hostname
        if (!domain || !domainMatches(url.hostname, domain)) continue
        const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/'
        const path = typeof attributes.path === 'string' && attributes.path.startsWith('/') ? attributes.path : defaultPath
        const maxAge = /^-?\d+$/.test(attributes['max-age'] ?? '') ? Number(attributes['max-age']) : NaN
        const expires = Number.isFinite(maxAge) ? now() + maxAge * 1000 : Date.parse(attributes.expires)
        const key = JSON.stringify([name, domain, path])
        if (expires <= now()) cookies.delete(key)
        else cookies.set(key, { name, value, domain, path, expires, secure: Boolean(attributes.secure) })
      }
    },
    header(url) {
      for (const [key, cookie] of cookies) if (cookie.expires <= now()) cookies.delete(key)
      return [...cookies.values()].filter(cookie => domainMatches(url.hostname, cookie.domain)
        && (!cookie.secure || url.protocol === 'https:')
        && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
        .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    },
    clear() { cookies.clear() },
  }
}

function context(env, event) {
  check(env.GITHUB_REPOSITORY === REPO && env.GITHUB_REPOSITORY_ID === String(REPO_ID) &&
    env.GITHUB_REPOSITORY_OWNER_ID === String(OWNER_ID) && env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REF === 'refs/heads/' + BRANCH && env.GITHUB_RUN_ATTEMPT === '1' &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
    Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) &&
    event?.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA && event.deleted === false &&
    sameRepo(event.repository), 'context_rejected')
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'github_token_missing')
}
function blank() {
  return {
    version: 1, kind: 'production-team-membership-inspection', status: 'blocked', code: null,
    businessExecutionVerified: false, workspaceSwitches: 0, invitationWrites: 0,
    memberWrites: 0, modelCalls: 0, directDatabaseCalls: 0,
    driverRevision: null, driverRunId: null, driverRunAttempt: null,
    applicationBefore: null, applicationAfter: null, targetUnchanged: null, targetAfterCode: null,
    documentedPolicyEqualsConfiguredAcme: null, configuredSmokeMatchesAcme: null,
    configuredSmokeMatchesPolicy: null, actorMatchesPolicy: null, actorMatchesConfiguredAcme: null,
    signInAttempted: false, normalSessionObserved: false, candidateCount: null, candidatesRead: 0,
    candidates: [], invitationCoverage: 'pending-invitations-in-visible-admin-workspaces-only',
    incomingUnjoinedInvitationsInspected: false,
    signOutAttempted: false, signOutSucceeded: false, anonymousAfterLogout: false,
    sessionClosed: false, cleanupSucceeded: false, cleanupCode: null,
  }
}
function counts(members, wanted, actor) {
  const matches = members.filter(member => hash(email(member.email)) === wanted)
  const admins = matches.filter(member => member.role === 'admin' && member.status === 'active')
  return { members: matches.length, activeAdmins: admins.length,
    nonActorActiveAdmins: admins.filter(member => member.userId !== actor).length }
}
function projectCandidate(value, id, actor, actorEmail, acmeHash) {
  check(value?.currentUserId === actor && email(value.currentUser?.email) === actorEmail &&
    value.workspace?.id === id && value.workspace.kind === 'team' &&
    ['admin', 'member'].includes(value.role), 'candidate_identity')
  check(Array.isArray(value.members) && value.members.length <= 10000 &&
    value.members.every(member => member && typeof member.userId === 'string' && member.userId.length > 0 &&
      emailValid(email(member.email)) && ['admin', 'member'].includes(member.role) &&
      ['active', 'suspended'].includes(member.status)) &&
    new Set(value.members.map(member => member.userId)).size === value.members.length, 'candidate_members_invalid')
  check(Array.isArray(value.invitations), 'candidate_invitations_invalid')
  if (value.role === 'admin') check(value.invitations.every(invite => invite?.status === 'pending'), 'candidate_invitations_invalid')
  return {
    teamWorkspaceHash: hash('team-workspace\0' + id), memberCount: value.members.length,
    activeAdminCount: value.members.filter(member => member.role === 'admin' && member.status === 'active').length,
    documentedPolicy: counts(value.members, POLICY_HASH, actor),
    configuredAcme: counts(value.members, acmeHash, actor),
    invitationsVisibleToActor: value.role === 'admin',
    visiblePendingInvitationCount: value.role === 'admin' ? value.invitations.length : null,
  }
}

export async function inspectTeamMembership({ env = process.env, event, fetchImpl = fetch, now = Date.now } = {}) {
  const report = blank(), jar = responseCookieJar(now), deadline = now() + 180_000
  let cleanupDeadline = 0, smoke, password, acme
  const knownTeams = new Set()
  const fail = code => { if (!report.code) report.code = code; report.status = 'failed' }
  async function request(url, { method = 'GET', body, owner = false, github = false, json = true, cleanup = false } = {}) {
    const parsed = new URL(url)
    if (github) {
      check(method === 'GET' && !owner && body === undefined &&
        [API + '/actions/runs/' + env.GITHUB_RUN_ID, API + '/issues/1415'].includes(url), 'request_rejected')
    } else {
      check(parsed.origin === ORIGIN && !parsed.hash, 'request_rejected')
      const path = parsed.pathname + parsed.search
      const candidate = path.startsWith('/mikka/api/workspace?workspace=') ? path.slice('/mikka/api/workspace?workspace='.length) : null
      const allowedGet = ['/mikka/api/version', '/mikka/api/auth/get-session', '/mikka/api/workspace'].includes(path) ||
        candidate !== null && uuid(candidate) && knownTeams.has(candidate)
      check(method === 'GET' && body === undefined && allowedGet ||
        method === 'POST' && ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'].includes(path), 'request_rejected')
      check(owner === (path !== '/mikka/api/version'), 'request_rejected')
    }
    const remaining = (cleanup ? cleanupDeadline : deadline) - now()
    check(remaining > 0, 'inspection_deadline')
    const headers = github
      ? { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + env.GH_TOKEN, 'X-GitHub-Api-Version': '2026-03-10' }
      : { Accept: 'application/json', 'Cache-Control': 'no-cache', Origin: ORIGIN,
        ...(owner && jar.header(parsed) ? { Cookie: jar.header(parsed) } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }
    let response
    try {
      response = await fetchImpl(url, { method, headers, redirect: 'error', credentials: 'omit',
        cache: 'no-store', signal: AbortSignal.timeout(Math.min(15_000, Math.max(1, remaining))),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (cause) { throw new InspectionError('http_transport_failed', { cause }) }
    check(!response.redirected && (!response.url || response.url === url), 'redirect_rejected')
    if (owner) jar.receive(parsed, response.headers)
    if (response.status !== 200) {
      try { await response.body?.cancel() } catch { /* Preserve closed HTTP failure. */ }
      throw new InspectionError('http_status_failed')
    }
    check(response.body, 'response_invalid')
    const reader = response.body.getReader(), parts = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        check(size <= 1_048_576, 'response_too_large')
        parts.push(Buffer.from(part.value))
      }
      if (!json) return null
      try { return JSON.parse(Buffer.concat(parts).toString('utf8')) }
      catch (cause) { throw new InspectionError('response_invalid', { cause }) }
    } finally {
      try { await reader.cancel() } catch { /* Only bounded response cleanup. */ }
      reader.releaseLock()
    }
  }
  const app = (path, options = {}) => request(ORIGIN + path, { owner: path !== '/mikka/api/version', ...options })
  async function version(cleanup = false) {
    const value = await app('/mikka/api/version', { cleanup })
    check(/^[a-f0-9]{40}$/.test(value?.build ?? ''), 'version_invalid')
    return value.build
  }
  try {
    context(env, event)
    report.driverRevision = env.GITHUB_SHA
    report.driverRunId = Number(env.GITHUB_RUN_ID)
    report.driverRunAttempt = 1
    smoke = email(env.SMOKE_OWNER_EMAIL); acme = email(env.ACME_DEMO_EMAIL); password = env.SMOKE_OWNER_PASSWORD
    check(emailValid(smoke) && emailValid(acme) && typeof password === 'string' && password.length > 0, 'credentials_required')
    report.documentedPolicyEqualsConfiguredAcme = hash(acme) === POLICY_HASH
    report.configuredSmokeMatchesAcme = smoke === acme
    report.configuredSmokeMatchesPolicy = hash(smoke) === POLICY_HASH
    // PRELOGIN_PROTECTED_ACTOR
    check(!report.configuredSmokeMatchesAcme && !report.configuredSmokeMatchesPolicy, 'protected_actor')
    check(isSmokeAccountEmail(smoke), 'smoke_account_required')
    const run = await request(API + '/actions/runs/' + env.GITHUB_RUN_ID, { github: true })
    check(run?.id === report.driverRunId && run.event === 'push' && run.head_branch === BRANCH &&
      run.head_sha === env.GITHUB_SHA && run.run_attempt === 1 && run.path === WORKFLOW &&
      run.status === 'in_progress' && sameRepo(run.repository) && sameRepo(run.head_repository), 'driver_context_mismatch')
    const issue = await request(API + '/issues/1415', { github: true })
    check(issue?.number === 1415 && issue.state === 'open' && issue.repository_url === API && !issue.pull_request, 'issue_not_open')
    report.applicationBefore = await version()
    report.signInAttempted = true
    await app('/mikka/api/auth/sign-in/email', { method: 'POST', body: { email: smoke, password }, json: false })
    const session = await app('/mikka/api/auth/get-session')
    check(session?.user && typeof session.user.id === 'string' && session.user.id.length > 0 &&
      email(session.user.email) === smoke, 'session_identity')
    report.normalSessionObserved = true
    report.actorMatchesPolicy = hash(email(session.user.email)) === POLICY_HASH
    report.actorMatchesConfiguredAcme = email(session.user.email) === acme
    const actor = session.user.id
    const initial = await app('/mikka/api/workspace')
    check(initial?.currentUserId === actor && email(initial.currentUser?.email) === smoke &&
      Array.isArray(initial.choices), 'workspace_identity')
    const teams = initial.choices.filter(choice => choice?.kind === 'team')
    check(teams.length <= 32 && teams.every(choice => uuid(choice.id)) &&
      new Set(teams.map(choice => choice.id)).size === teams.length, 'candidate_identity')
    report.candidateCount = teams.length
    for (const team of teams) knownTeams.add(team.id)
    for (const team of teams) {
      const candidate = await app('/mikka/api/workspace?workspace=' + team.id)
      report.candidates.push(projectCandidate(candidate, team.id, actor, smoke, hash(acme)))
      report.candidatesRead++
    }
    report.status = 'inspected'
  } catch (error) { fail(publicCode(error)) }
  finally {
    cleanupDeadline = now() + 40_000
    if (report.signInAttempted) {
      report.signOutAttempted = true
      try {
        await app('/mikka/api/auth/sign-out', { method: 'POST', body: {}, json: false, cleanup: true })
        report.signOutSucceeded = true
      } catch (error) { report.cleanupCode = publicCode(error) }
      try {
        report.anonymousAfterLogout = await app('/mikka/api/auth/get-session', { cleanup: true }) === null
        if (!report.anonymousAfterLogout && !report.cleanupCode) report.cleanupCode = 'session_not_closed'
      } catch (error) { if (!report.cleanupCode) report.cleanupCode = publicCode(error) }
      report.sessionClosed = report.signOutSucceeded && report.anonymousAfterLogout
      report.cleanupSucceeded = report.sessionClosed
      if (!report.cleanupSucceeded) fail('cleanup_failed')
    }
    jar.clear()
    if (report.applicationBefore) {
      try {
        report.applicationAfter = await version(true)
        report.targetUnchanged = report.applicationAfter === report.applicationBefore
        if (!report.targetUnchanged) { report.targetAfterCode = 'target_changed'; fail('target_changed') }
      } catch (error) { report.targetAfterCode = publicCode(error); fail(report.targetAfterCode) }
    }
  }
  if (report.status === 'inspected') {
    check(report.cleanupSucceeded && report.targetUnchanged === true, 'inspection_failed')
    report.code = 'inspection_completed'
  }
  return report
}
async function main() {
  let report
  try {
    check(process.argv.length === 2, 'arguments_rejected')
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    report = await inspectTeamMembership({ event })
  } catch (error) { report = { ...blank(), status: 'failed', code: publicCode(error) } }
  await mkdir('production-team-membership-inspection-report', { recursive: true, mode: 0o700 })
  await writeFile('production-team-membership-inspection-report/report.json',
    JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
  if (report.status !== 'inspected') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ status: 'failed', code: 'inspection_output_failed', businessExecutionVerified: false }))
    process.exitCode = 1
  })
}
