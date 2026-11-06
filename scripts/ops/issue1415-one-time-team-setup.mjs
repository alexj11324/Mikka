import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'

export const SETUP = Object.freeze({
  repository: 'alexj11324/Mikka', repositoryId: 1427517699, ownerId: 183887963,
  branch: 'ops/issue1415-once-team-setup',
  workflowPath: '.github/workflows/issue1415-once-team-setup.yml',
  applicationSha: '8180f687d19e117437403b865692388a9c05b554',
  origin: 'https://app.aspectlylabs.com', issue: 1415,
  authorizationIssue: 1515, authorizationComment: 6694934529,
  authorizationBodySha256: 'fe40b6d0490479f426f85dccc7c139e7f128cc6407c5331665053b677119943e',
  policyEmailSha256: '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3',
})
// Root verified the current workspace owner and selected the existing team.
// The other current-owner team is the separately authorized issue 1506 fixture.
export const TEAM_BINDING = Object.freeze({
  ownerIdentityHash: '9fc5236d85a7528481f5fce2cc09d9a10df40cb884ff8a0f7ce1202d597f5d56',
  teamWorkspaceHash: 'fb00a1d8c63a0ae1c56ff3273bd259fd0756b8631b83e42f226926d389b3dade',
})
const REPORT = 'production-once-team-setup-report/report.json'
const sha = value => createHash('sha256').update(value).digest('hex')
const normalizedEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : ''
const uuid = value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200
const fixedCode = error => error instanceof SetupError ? error.code : 'unexpected_failure'
export class SetupError extends Error {
  constructor(code, options) { super(code, options); this.name = 'SetupError'; this.code = code }
}
const check = (condition, code) => { if (!condition) throw new SetupError(code) }

// Exact normal acceptance cookie jar; only actual server Set-Cookie enters it.
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
  check(env.GITHUB_REPOSITORY === SETUP.repository &&
    env.GITHUB_REPOSITORY_ID === String(SETUP.repositoryId) &&
    env.GITHUB_REPOSITORY_OWNER_ID === String(SETUP.ownerId) &&
    env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REF === 'refs/heads/' + SETUP.branch &&
    env.GITHUB_RUN_ATTEMPT === '1' && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') &&
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') &&
    env.GITHUB_WORKFLOW_REF === SETUP.repository + '/' + SETUP.workflowPath + '@refs/heads/' + SETUP.branch,
  'context_rejected')
  check(event?.repository?.id === SETUP.repositoryId &&
    event.repository.full_name === SETUP.repository &&
    event.repository.owner?.id === SETUP.ownerId &&
    event.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA && event.deleted === false,
  'context_rejected')
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'github_token_missing')
}

async function responseValue(response, json = true) {
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
    catch (cause) { throw new SetupError('response_invalid', { cause }) }
  } finally {
    try { await reader.cancel() } catch { /* Body disposal cannot replace the original failure. */ }
    reader.releaseLock()
  }
}

function clients({ env, fetchImpl, now, report }) {
  const deadline = now() + 240_000
  async function request(url, { method = 'GET', body, actor, github = false, json = true, cleanup = false } = {}) {
    const parsed = new URL(url)
    check(github ? parsed.origin === 'https://api.github.com' && method === 'GET' : parsed.origin === SETUP.origin, 'request_rejected')
    const headers = { accept: 'application/json', 'cache-control': 'no-store' }
    if (github) {
      headers.authorization = 'Bearer ' + env.GH_TOKEN
      headers['x-github-api-version'] = '2022-11-28'
    } else {
      const path = parsed.pathname + parsed.search
      const read = path === '/mikka/api/version' || path === '/mikka/api/auth/get-session' ||
        path === '/mikka/api/workspace' ||
        parsed.pathname === '/mikka/api/workspace' && parsed.search === '?workspace=' + parsed.searchParams.get('workspace') && uuid(parsed.searchParams.get('workspace'))
      const post = ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out', '/mikka/api/rpc'].includes(path)
      check(method === 'GET' && read && body === undefined || method === 'POST' && post && body !== undefined, 'request_rejected')
      check(path === '/mikka/api/version' ? !actor : Boolean(actor), 'request_rejected')
      if (actor) {
        const cookie = actor.jar.header(parsed)
        if (cookie) headers.cookie = cookie
      }
      if (method === 'POST') {
        headers.origin = SETUP.origin
        headers['content-type'] = 'application/json'
        if (path === '/mikka/api/rpc') headers['x-mikka-rpc'] = '1'
      }
    }
    const remaining = cleanup ? 15_000 : deadline - now()
    check(remaining > 0, 'setup_timeout')
    let response
    try {
      response = await fetchImpl(url, { method, headers, redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(15_000, Math.max(1, remaining))),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch (cause) { throw new SetupError('http_transport_failed', { cause }) }
    if (actor) actor.jar.receive(parsed, response.headers)
    check(!response.redirected && (!response.url || response.url === url), 'redirect_rejected')
    if (response.status !== 200) {
      try { await response.body?.cancel() } catch { /* No response contents enter errors or reports. */ }
      throw new SetupError('http_status_failed')
    }
    return responseValue(response, json)
  }
  const gh = path => request('https://api.github.com/repos/' + SETUP.repository + path, { github: true })
  const app = (path, actor, options = {}) => request(SETUP.origin + path, { actor, ...options })
  async function version(cleanup = false) {
    const value = await app('/mikka/api/version', undefined, { cleanup })
    check(value?.build === SETUP.applicationSha, 'target_changed')
    return SETUP.applicationSha
  }
  async function preflight() {
    context(env, report.event)
    const run = await gh('/actions/runs/' + env.GITHUB_RUN_ID)
    check(run.id === Number(env.GITHUB_RUN_ID) && run.repository?.id === SETUP.repositoryId &&
      run.repository.full_name === SETUP.repository && run.repository.owner?.id === SETUP.ownerId &&
      run.head_sha === env.GITHUB_SHA && run.head_branch === SETUP.branch &&
      run.event === 'push' && run.path === SETUP.workflowPath && run.run_attempt === 1 && run.status === 'in_progress',
    'run_identity_rejected')
    const issue = await gh('/issues/' + SETUP.issue)
    check(issue.number === SETUP.issue && issue.state === 'open' && !issue.pull_request, 'issue_not_open')
    const comment = await gh('/issues/comments/' + SETUP.authorizationComment)
    check(comment.id === SETUP.authorizationComment && comment.user?.id === SETUP.ownerId &&
      comment.user.login === 'alexj11324' && comment.author_association === 'OWNER' &&
      comment.issue_url === 'https://api.github.com/repos/' + SETUP.repository + '/issues/' + SETUP.authorizationIssue &&
      typeof comment.body === 'string' && sha(comment.body) === SETUP.authorizationBodySha256,
    'authorization_changed')
    await version()
  }
  async function session(actor, cleanup = false) {
    const value = await app('/mikka/api/auth/get-session', actor, { cleanup })
    check(value?.user && identifier(value.user.id) && normalizedEmail(value.user.email) === actor.email &&
      (!actor.id || value.user.id === actor.id), 'session_identity')
    actor.id = value.user.id
    return value
  }
  async function login(actor) {
    actor.attempted = true
    report.cleanup[actor.label].attempted = true
    await app('/mikka/api/auth/sign-in/email', actor, { method: 'POST', body: { email: actor.email, password: actor.password }, json: false })
    await session(actor)
    actor.authenticated = true
  }
  const reads = new Set(['personal-policy.getSharePolicy', 'personal-policy.getSubscriptionShare', 'model-api-keys.getApiKeys', 'model-order.getModelOrder'])
  const writes = new Set(['workspace.switchWorkspace', 'workspace.createWorkspaceInvitation', 'workspace.acceptWorkspaceInvitation', 'personal-policy.updateSubscriptionShare', 'model-api-keys.updateApiKeyShare'])
  async function rpc(actor, action, args, onAttempt) {
    check(reads.has(action) || writes.has(action), 'rpc_rejected')
    if (writes.has(action)) {
      await version()
      await session(actor)
      onAttempt?.()
    }
    const value = await app('/mikka/api/rpc', actor, { method: 'POST', body: { version: DESKTOP_RPC_VERSION, action, args: encode(args) } })
    check(value?.version === DESKTOP_RPC_VERSION && value.ok === true && Object.hasOwn(value, 'result'), 'rpc_response_invalid')
    let result
    try { result = decode(value.result) } catch (cause) { throw new SetupError('rpc_response_invalid', { cause }) }
    check(result && typeof result === 'object' && !Array.isArray(result), 'rpc_response_invalid')
    if (action.startsWith('workspace.')) {
      check(result.ok === true && Object.hasOwn(result, 'data'), 'rpc_business_failed')
      return result.data
    }
    check(!Object.hasOwn(result, 'error') || result.error === undefined, 'rpc_business_failed')
    return result
  }
  async function close(actor) {
    const out = report.cleanup[actor.label]
    if (!actor.attempted) return
    try {
      await app('/mikka/api/auth/sign-out', actor, { method: 'POST', body: {}, json: false, cleanup: true })
      out.signout = true
    } catch { out.code = 'signout_failed' }
    try { out.anonymous = await app('/mikka/api/auth/get-session', actor, { cleanup: true }) === null }
    catch { out.code ??= 'anonymous_check_failed' }
    out.succeeded = out.signout && out.anonymous
    actor.jar.clear()
  }
  return { app, gh, version, preflight, session, login, rpc, close }
}

function workspace(value, actor, expectedId) {
  check(value?.currentUserId === actor.id && normalizedEmail(value.currentUser?.email) === actor.email &&
    value.workspace && uuid(value.workspace.id) && (!expectedId || value.workspace.id === expectedId) &&
    ['team', 'personal'].includes(value.workspace.kind) && ['admin', 'member'].includes(value.role) &&
    Array.isArray(value.members) && Array.isArray(value.invitations), 'workspace_response_invalid')
  const seen = new Set()
  for (const member of value.members) {
    check(identifier(member?.userId) && !seen.has(member.userId) &&
      typeof member.email === 'string' && member.email.trim().length > 0 &&
      ['admin', 'member'].includes(member.role) && ['active', 'suspended'].includes(member.status),
    'workspace_response_invalid')
    seen.add(member.userId)
  }
  for (const invite of value.invitations) {
    check(uuid(invite?.id) && typeof invite.email === 'string' && ['admin', 'member'].includes(invite.role) &&
      invite.status === 'pending' && Number.isFinite(Date.parse(invite.expiresAt)), 'workspace_response_invalid')
  }
  return value
}
function activeAdmin(value, id) {
  return value.members.find(member => member.userId === id && member.status === 'active' && member.role === 'admin')
}
function safeWorkspaceName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 &&
    ![...value].some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127 || char === '@') ? value : null
}
function shareView(value) {
  check(value?.personal === false && typeof value.shared === 'boolean' && typeof value.allowOthers === 'boolean' &&
    typeof value.allowed === 'boolean' && Array.isArray(value.own) &&
    value.own.every(provider => ['claude', 'codex'].includes(provider)) &&
    Array.isArray(value.available) && value.available.every(item => ['claude', 'codex'].includes(item?.provider)), 'subscription_response_invalid')
  return value
}
function keysView(value) {
  check(value && Array.isArray(value.keys) && value.keys.length <= 100 && typeof value.canShare === 'boolean', 'keys_response_invalid')
  const seen = new Set()
  for (const key of value.keys) {
    check(uuid(key?.id) && !seen.has(key.id) && typeof key.shared === 'boolean', 'keys_response_invalid')
    seen.add(key.id)
  }
  return value
}
function newReport(env) {
  return {
    version: 1, kind: 'issue1415-one-time-team-setup', status: 'blocked', code: null,
    applicationSha: SETUP.applicationSha, driverRevision: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null,
    driverRunId: /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') ? Number(env.GITHUB_RUN_ID) : null,
    driverRunAttempt: Number(env.GITHUB_RUN_ATTEMPT) || null,
    authorization: { issue: 1515, comment: 6694934529, ownerConfirmed: false, ordinaryAcceptanceUsesSmokeOnly: true },
    applicationBefore: null, applicationAfter: null, phase: 'preflight',
    team: { candidates: 0, selfAdminCandidates: 0, boundSelfAdminCandidates: 0,
      ownerIdentityBindingVerified: false,
      selectionBasis: 'verified-current-owner-and-team-hash',
      rootEvidence: 'root-readonly-binding-and-owner-comment-1506-6694431207',
      unique: false, hash: null, name: null,
      existingTeamContainsCurrentAlexAdmin: false, actorSnapshotEmailMatchesCanonical: null, staleSnapshot: false },
    membership: { alreadyActive: false, inviteAttempted: false, inviteResponseObserved: false, inviteOutcomeUnresolved: false,
      acceptAttempted: false, acceptResponseObserved: false, acceptReconciled: false, confirmed: false, pendingAfterUnknownInvite: false },
    sharing: { policyAllowed: null, subscriptionShareAttempted: false, subscriptionShareConfirmed: false,
      ownProviderCount: 0, missingRequestedSubscriptionProviders: [], ownKeyCount: 0, keyShareAttemptCount: 0, allKeysShared: false },
    visibility: { sameTeam: false, alexAdminConfirmed: false, expectedSubscriptionProvidersVisible: false,
      allOwnedKeyCandidatesVisible: false, ownSubscriptionProviders: [], sharedSubscriptionProviderCount: 0, sharedApiKeySourceCount: 0 },
    cleanup: {
      alex: { attempted: false, signout: false, anonymous: false, succeeded: true, code: null },
      smoke: { attempted: false, signout: false, anonymous: false, succeeded: true, code: null },
    },
    targetAfterVerified: false, membershipAndSharesCompleted: false, setupCompleted: false, productionAcceptancePassed: false, modelPrompts: 0,
    newTeams: 0, newCredentials: 0, teamPolicyWrites: 0, sqlCalls: 0, automaticMutationRetries: 0,
    catalogueReadMayRefreshExistingMetadata: true, requestedSetupPreserved: true,
  }
}

export async function preflightOneTimeTeamSetup({ env, event, fetchImpl = fetch, now = Date.now }) {
  const report = newReport(env)
  const api = clients({ env, fetchImpl, now, report: { ...report, event } })
  try {
    await api.preflight()
    report.authorization.ownerConfirmed = true
    report.applicationBefore = SETUP.applicationSha
    report.status = 'ready'
  } catch (error) { report.code = fixedCode(error) }
  return report
}

export async function runOneTimeTeamSetup({ env, event, fetchImpl = fetch, now = Date.now, teamBinding = TEAM_BINDING }) {
  const report = newReport(env), internal = { ...report, event }
  const api = clients({ env, fetchImpl, now, report: internal })
  const alex = { label: 'alex', jar: responseCookieJar(now), email: normalizedEmail(env.ACME_DEMO_EMAIL), password: env.ACME_DEMO_PASSWORD, attempted: false }
  const smoke = { label: 'smoke', jar: responseCookieJar(now), email: normalizedEmail(env.SMOKE_OWNER_EMAIL), password: env.SMOKE_OWNER_PASSWORD, attempted: false }
  let targetId, selected
  try {
    await api.preflight()
    report.authorization.ownerConfirmed = true
    report.applicationBefore = SETUP.applicationSha
    check(teamBinding && /^[a-f0-9]{64}$/.test(teamBinding.ownerIdentityHash ?? '') &&
      /^[a-f0-9]{64}$/.test(teamBinding.teamWorkspaceHash ?? ''), 'team_binding_invalid')
    check(sha(alex.email) === SETUP.policyEmailSha256 && isSmokeAccountEmail(smoke.email) && smoke.email !== alex.email &&
      typeof alex.password === 'string' && alex.password.length > 0 &&
      typeof smoke.password === 'string' && smoke.password.length > 0, 'credentials_rejected')
    report.phase = 'alex-session'
    await api.login(alex)
    check(sha('workspace-owner\0' + alex.id) === teamBinding.ownerIdentityHash, 'owner_identity_mismatch')
    report.team.ownerIdentityBindingVerified = true
    const initial = workspace(await api.app('/mikka/api/workspace', alex), alex)
    check(Array.isArray(initial.choices) && initial.choices.length <= 64, 'workspace_response_invalid')
    const teamIds = initial.choices.filter(item => item?.kind === 'team').map(item => item.id)
    check(teamIds.length <= 32 && teamIds.every(uuid) && new Set(teamIds).size === teamIds.length, 'workspace_response_invalid')
    report.team.candidates = teamIds.length
    const matches = []
    report.phase = 'team-selection'
    for (const id of teamIds) {
      const value = workspace(await api.app('/mikka/api/workspace?workspace=' + id, alex), alex, id)
      check(value.workspace.kind === 'team', 'workspace_response_invalid')
      const admin = activeAdmin(value, alex.id)
      if (admin) {
        check(value.role === 'admin', 'workspace_response_invalid')
        matches.push({ value, admin })
      }
    }
    report.team.selfAdminCandidates = matches.length
    report.team.existingTeamContainsCurrentAlexAdmin = matches.length > 0
    const bound = matches.filter(item => sha('team-workspace\0' + item.value.workspace.id) === teamBinding.teamWorkspaceHash)
    report.team.boundSelfAdminCandidates = bound.length
    check(bound.length > 0, 'bound_team_missing')
    check(bound.length === 1, 'bound_team_ambiguous')
    selected = bound[0].value
    targetId = selected.workspace.id
    report.team.unique = true
    report.team.hash = sha('team-workspace\0' + targetId)
    report.team.actorSnapshotEmailMatchesCanonical = normalizedEmail(bound[0].admin.email) === alex.email
    report.team.staleSnapshot = !report.team.actorSnapshotEmailMatchesCanonical
    check(!report.team.staleSnapshot, 'staleSnapshot')
    report.team.name = safeWorkspaceName(selected.workspace.name)

    report.phase = 'team-policy'
    const policy = await api.rpc(alex, 'personal-policy.getSharePolicy', [targetId])
    check(typeof policy.allowed === 'boolean' && policy.canEdit === true, 'policy_response_invalid')
    report.sharing.policyAllowed = policy.allowed
    check(policy.allowed, 'team_policy_disabled')
    const ownSubscription = shareView(await api.rpc(alex, 'personal-policy.getSubscriptionShare', [targetId]))
    const originalKeys = keysView(await api.rpc(alex, 'model-api-keys.getApiKeys', [targetId]))
    check(ownSubscription.allowed && originalKeys.canShare, 'team_policy_disabled')
    const providers = [...new Set(ownSubscription.own)].sort()
    report.sharing.ownProviderCount = providers.length
    report.sharing.ownKeyCount = originalKeys.keys.length
    report.visibility.ownSubscriptionProviders = providers
    report.sharing.missingRequestedSubscriptionProviders = ['claude', 'codex'].filter(provider => !providers.includes(provider))

    report.phase = 'smoke-session'
    await api.login(smoke)
    check(smoke.id !== alex.id, 'session_identity')
    selected = workspace(await api.app('/mikka/api/workspace?workspace=' + targetId, alex), alex, targetId)
    check(activeAdmin(selected, alex.id) && normalizedEmail(activeAdmin(selected, alex.id).email) === alex.email, 'team_changed')
    const existing = selected.members.find(member => member.userId === smoke.id)
    check(!existing || existing.status === 'active', 'existing_member_suspended')
    if (existing) {
      report.membership.alreadyActive = true
    } else {
      check(!selected.members.some(member => normalizedEmail(member.email) === smoke.email), 'member_identity_conflict')
      const baselineInvites = selected.invitations.filter(invite => normalizedEmail(invite.email) === smoke.email)
      check(baselineInvites.length <= 1, 'invite_identity_conflict')
      report.phase = 'invite'
      let invitation
      try {
        invitation = await api.rpc(alex, 'workspace.createWorkspaceInvitation', [{ workspaceId: targetId, emails: [smoke.email], role: 'member' }],
          () => { report.membership.inviteAttempted = true })
        check(Array.isArray(invitation) && invitation.length === 1 &&
          normalizedEmail(invitation[0]?.email) === smoke.email &&
          typeof invitation[0]?.path === 'string' && /^\/invite\/[a-f0-9]{64}$/.test(invitation[0].path), 'invite_response_invalid')
        report.membership.inviteResponseObserved = true
      } catch (error) {
        if (!report.membership.inviteAttempted) throw error
        report.membership.inviteOutcomeUnresolved = true
        try {
          const after = workspace(await api.app('/mikka/api/workspace?workspace=' + targetId, alex), alex, targetId)
          report.membership.pendingAfterUnknownInvite = after.invitations.some(invite => normalizedEmail(invite.email) === smoke.email)
        } catch { /* Without the original token no new invitation is adopted or resent. */ }
        throw new SetupError('invite_response_unknown', { cause: error })
      }
      report.phase = 'accept'
      try {
        const accepted = await api.rpc(smoke, 'workspace.acceptWorkspaceInvitation', [invitation[0].path.slice('/invite/'.length)],
          () => { report.membership.acceptAttempted = true })
        check(accepted?.workspaceId === targetId, 'accept_response_invalid')
        report.membership.acceptResponseObserved = true
      } catch (error) {
        if (!report.membership.acceptAttempted) throw error
        try {
          const observed = workspace(await api.app('/mikka/api/workspace?workspace=' + targetId, smoke), smoke, targetId)
          const member = observed.members.find(item => item.userId === smoke.id)
          report.membership.acceptReconciled = observed.workspace.kind === 'team' &&
            member?.status === 'active' && Boolean(activeAdmin(observed, alex.id))
        } catch { /* A lost response never causes another acceptance POST. */ }
        if (!report.membership.acceptReconciled) throw new SetupError('accept_response_unknown', { cause: error })
      }
      invitation = undefined
    }

    report.phase = 'select-and-confirm'
    for (const actor of [alex, smoke]) {
      const switched = await api.rpc(actor, 'workspace.switchWorkspace', [targetId])
      check(switched?.workspaceId === targetId, 'switch_response_invalid')
      const current = workspace(await api.app('/mikka/api/workspace', actor), actor, targetId)
      check(current.workspace.kind === 'team' && activeAdmin(current, alex.id) &&
        normalizedEmail(activeAdmin(current, alex.id).email) === alex.email &&
        current.members.some(member => member.userId === smoke.id && member.status === 'active'), 'membership_unconfirmed')
      await api.session(actor)
    }
    report.membership.confirmed = true

    report.phase = 'subscription-share'
    if (!(ownSubscription.shared && ownSubscription.allowOthers)) {
      const result = shareView(await api.rpc(alex, 'personal-policy.updateSubscriptionShare', [{ shared: true, allowOthers: true }, targetId],
        () => { report.sharing.subscriptionShareAttempted = true }))
      check(result.shared && result.allowOthers && result.allowed, 'subscription_share_failed')
    }
    const confirmedSubscription = shareView(await api.rpc(alex, 'personal-policy.getSubscriptionShare', [targetId]))
    check(confirmedSubscription.shared && confirmedSubscription.allowOthers && confirmedSubscription.allowed, 'subscription_share_failed')
    report.sharing.subscriptionShareConfirmed = true

    report.phase = 'key-share'
    for (const key of originalKeys.keys) {
      if (!key.shared) {
        const result = keysView(await api.rpc(alex, 'model-api-keys.updateApiKeyShare', [{ id: key.id, shared: true }, targetId],
          () => { report.sharing.keyShareAttemptCount++ }))
        check(result.keys.some(item => item.id === key.id && item.shared), 'key_share_failed')
      }
    }
    const finalKeys = keysView(await api.rpc(alex, 'model-api-keys.getApiKeys', [targetId]))
    check(finalKeys.keys.length === originalKeys.keys.length &&
      originalKeys.keys.every(key => finalKeys.keys.some(item => item.id === key.id && item.shared)), 'key_share_failed')
    report.sharing.allKeysShared = true
    report.membershipAndSharesCompleted = report.membership.confirmed && report.sharing.subscriptionShareConfirmed

    report.phase = 'smoke-visibility'
    const current = workspace(await api.app('/mikka/api/workspace', smoke), smoke, targetId)
    report.visibility.sameTeam = current.workspace.kind === 'team'
    report.visibility.alexAdminConfirmed = Boolean(activeAdmin(current, alex.id)) &&
      normalizedEmail(activeAdmin(current, alex.id)?.email) === alex.email
    const smokeSubscriptions = shareView(await api.rpc(smoke, 'personal-policy.getSubscriptionShare', [targetId]))
    report.visibility.sharedSubscriptionProviderCount = new Set(smokeSubscriptions.available.map(item => item.provider)).size
    // The normal catalogue read can refresh existing metadata; it sends no model prompt.
    const modelOrder = await api.rpc(smoke, 'model-order.getModelOrder', [targetId])
    check(Array.isArray(modelOrder.candidates) && modelOrder.candidates.length <= 10_000, 'models_response_invalid')
    const alexCandidates = modelOrder.candidates.filter(item => item?.credentialOwnerId === alex.id)
    report.visibility.expectedSubscriptionProvidersVisible = ['claude', 'codex'].every(provider =>
      providers.includes(provider) &&
      smokeSubscriptions.available.some(item => item.provider === provider) &&
      alexCandidates.some(item => item.provider === provider && item.source?.kind === 'subscription'))
    const visibleKeys = new Set(alexCandidates.filter(item => item.source?.kind === 'api_key').map(item => item.source.keyId))
    report.visibility.sharedApiKeySourceCount = originalKeys.keys.filter(key => visibleKeys.has(key.id)).length
    report.visibility.allOwnedKeyCandidatesVisible = originalKeys.keys.every(key => visibleKeys.has(key.id))
    check(report.visibility.sameTeam && report.visibility.alexAdminConfirmed &&
      report.visibility.expectedSubscriptionProvidersVisible && report.visibility.allOwnedKeyCandidatesVisible, 'visibility_incomplete')
    await api.session(smoke)
    report.setupCompleted = true
    report.status = 'passed'
    report.phase = 'complete'
  } catch (error) {
    report.code = fixedCode(error)
    report.status = alex.attempted || smoke.attempted ? 'failed' : 'blocked'
  } finally {
    await api.close(smoke)
    await api.close(alex)
    if (report.applicationBefore) {
      try {
        report.applicationAfter = await api.version(true)
        report.targetAfterVerified = true
      } catch {
        if (!report.code) report.code = 'target_changed'
        report.status = 'failed'
      }
    }
    if (!report.cleanup.alex.succeeded || !report.cleanup.smoke.succeeded) {
      report.cleanupFailure = 'cleanup_failed'
      report.code ??= 'cleanup_failed'
      report.status = 'failed'
    }
  }
  return report
}

async function main() {
  let result
  try {
    const mode = process.argv[2]
    check(process.argv.length === 3 && ['--preflight', '--run'].includes(mode), 'mode_rejected')
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    result = await (mode === '--preflight' ? preflightOneTimeTeamSetup : runOneTimeTeamSetup)({ env: process.env, event })
  } catch (error) { result = { version: 1, kind: 'issue1415-one-time-team-setup', status: 'blocked', code: fixedCode(error), productionAcceptancePassed: false } }
  const path = process.argv[2] === '--preflight' ? 'production-once-team-setup-report/preflight.json' : REPORT
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify({ status: result.status, code: result.code ?? null, report: path }) + '\n')
  if (!['ready', 'passed'].includes(result.status)) process.exitCode = 1
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => { process.stderr.write('one_time_team_setup_report_write_failed\n'); process.exitCode = 1 })
}
