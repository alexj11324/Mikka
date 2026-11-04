/** Issue #1225 source diagnosis only. The caller supplies credentials in memory.
 * No Vault access, credential changes, model calls, fixtures, logs or file writes. */
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { AcceptanceError, CASES, ORIGIN, assertVersion, publicFailure } from './model-provider-fallback.mjs'

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const check = (condition, code) => { if (!condition) throw new AcceptanceError(code) }
const connectionStates = ['pending', 'connected', 'reconnect_required', 'disconnected', 'other']
const sourceId = entry => entry?.source?.kind === 'api_key' ? entry.source.keyId : entry?.source?.connectionId

function sourceCounts({ order, keys, connections }, ownerId) {
  check(Array.isArray(order?.candidates) && Array.isArray(order?.entries)
    && Array.isArray(keys?.keys) && Array.isArray(connections?.connections), 'response_invalid')
  const candidates = order.candidates
  check(candidates.every(row => row && typeof row === 'object')
    && keys.keys.every(row => row && typeof row === 'object' && uuid(row.id))
    && connections.connections.every(row => row && typeof row === 'object' && uuid(row.id)), 'response_invalid')
  const subscriptions = Object.fromEntries(['claude', 'codex'].map(provider => {
    const own = connections.connections.filter(row => row.provider === provider)
    const states = Object.fromEntries(connectionStates.map(state => [state, 0]))
    for (const row of own) states[connectionStates.includes(row.state) ? row.state : 'other']++
    return [provider, { total: own.length, paused: own.filter(row => row.paused === true).length,
      connectedUnpaused: own.filter(row => row.state === 'connected' && !row.paused).length, states }]
  }))
  return {
    candidateCount: candidates.length,
    orderEntryCount: order.entries.length,
    candidateOwnerFieldPresent: candidates.filter(row => typeof row.credentialOwnerId === 'string').length,
    candidateOwnerMatched: candidates.filter(row => row.credentialOwnerId === ownerId).length,
    location: ['cloud', 'local'].includes(order.location) ? order.location : 'unknown',
    cloudReady: order.cloudReady === true,
    ownApiKeys: { total: keys.keys.length, deepseek: keys.keys.filter(row => row.provider === 'deepseek').length },
    ownSubscriptions: subscriptions,
    cases: CASES.map(item => {
      // These are the same predicates as the paid driver's first ownedSource
      // selection. A count diagnoses its refusal; it does not authorize a run.
      const own = item.kind === 'api_key'
        ? keys.keys.filter(row => row.provider === item.provider).map(row => row.id)
        : connections.connections.filter(row => row.provider === item.provider && row.state === 'connected' && !row.paused).map(row => row.id)
      const exactModel = candidates.filter(row => row.model === item.model)
      const harnessAndKind = exactModel.filter(row => row.harness === item.harness && row.source?.kind === item.kind)
      const ownSource = harnessAndKind.filter(row => own.includes(sourceId(row)))
      return { case: item.id, model: item.model, ownSourcePool: own.length,
        offeredForHarnessAndKind: candidates.filter(row => row.harness === item.harness && row.source?.kind === item.kind).length,
        counts: { exactModel: exactModel.length, harnessAndKind: harnessAndKind.length,
          ownSourceId: ownSource.length, credentialOwnerMatch: ownSource.filter(row => row.credentialOwnerId === ownerId).length } }
    }),
  }
}

/**
 * env contract:
 * - MIKKA_EXPECTED_DEPLOYMENT_SHA: the fixed, real production 40-character SHA.
 * - MIKKA_SOURCE_PREFLIGHT_SOURCE: "smoke" (default) or "documented_test_vault".
 * - smoke uses SMOKE_OWNER_EMAIL / SMOKE_OWNER_PASSWORD.
 * - documented_test_vault uses MIKKA_SOURCE_PREFLIGHT_EMAIL / MIKKA_SOURCE_PREFLIGHT_PASSWORD,
 *   injected by the caller from the already authorized test-account source.
 * This marker grants no Vault access and is never accepted by the paid driver.
 */
export async function runSourcePreflight({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const expectedSha = env.MIKKA_EXPECTED_DEPLOYMENT_SHA
  check(typeof expectedSha === 'string' && /^[a-f0-9]{40}$/.test(expectedSha), 'configuration_required')
  check(!env.MIKKA_ACCEPTANCE_BASE_URL || env.MIKKA_ACCEPTANCE_BASE_URL === ORIGIN + '/mikka', 'origin_rejected')
  const credentialSource = env.MIKKA_SOURCE_PREFLIGHT_SOURCE ?? 'smoke'
  check(['smoke', 'documented_test_vault'].includes(credentialSource), 'configuration_required')
  const email = credentialSource === 'smoke' ? env.SMOKE_OWNER_EMAIL : env.MIKKA_SOURCE_PREFLIGHT_EMAIL
  const password = credentialSource === 'smoke' ? env.SMOKE_OWNER_PASSWORD : env.MIKKA_SOURCE_PREFLIGHT_PASSWORD
  check(typeof email === 'string' && email === email.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && (credentialSource !== 'smoke' || isSmokeAccountEmail(email))
    && typeof password === 'string' && password.length > 0, 'account_required')
  const report = { issue: 1225, purpose: 'source_preflight', credentialSource, revision: expectedSha,
    status: 'observing', not_called_models: true, not_created_fixtures: true,
    workspaceScope: 'current_default_workspace_own_bots',
    ownerVerified: false, ownedWorkspaceCount: 0, workspaceLimit: 10, workspaces: [],
    versionPin: { start: false, end: false }, sessionClosed: false, startedAt: new Date(now()).toISOString() }
  let cookie = ''
  async function request(path, body) {
    const url = new URL('/mikka' + path, ORIGIN)
    check(url.origin === ORIGIN && url.pathname.startsWith('/mikka/') && !url.username && !url.password, 'origin_rejected')
    // Only the normal authentication boundary may write anything.
    check(body === undefined || ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(path), 'configuration_required')
    try {
      return await fetchImpl(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(30_000), headers: { origin: ORIGIN, 'cache-control': 'no-store',
          ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch { throw new AcceptanceError('request_failed') }
  }
  async function json(path) {
    const response = await request(path)
    const value = await response.json().catch(() => null)
    if (!response.ok || value?.error) throw new AcceptanceError('http_refused', 'blocked', {
      httpStatus: response.status, serverCode: value?.error,
    })
    check(value !== null, 'response_invalid')
    return value
  }
  const pin = async () => assertVersion((await json('/api/version')).build, expectedSha)
  try {
    await pin()
    report.versionPin.start = true
    const login = await request('/api/auth/sign-in/email', { email, password })
    cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
    check(login.ok, 'sign_in_failed')
    check(Boolean(cookie), 'session_missing')
    const session = await json('/api/auth/get-session')
    check(typeof session?.user?.email === 'string' && session.user.email.toLowerCase() === email.toLowerCase()
      && typeof session.user.id === 'string' && session.user.id.length > 0 && session.user.id.trim() === session.user.id, 'session_identity')
    report.ownerVerified = true
    const ownerId = session.user.id
    // This route lists the owner's bots in the current default workspace.
    // The count describes this visible Bot set, not every account workspace.
    const bots = await json('/api/bots')
    check(Array.isArray(bots) && bots.length > 0 && bots.every(bot => bot && bot.ownerId === ownerId && uuid(bot.workspaceId)), 'workspace_missing')
    const workspaces = [...new Set(bots.map(bot => bot.workspaceId))]
    report.ownedWorkspaceCount = workspaces.length
    if (workspaces.length > report.workspaceLimit) {
      report.status = 'ambiguous'
      report.code = 'workspace_limit'
    } else {
      for (const [index, workspaceId] of workspaces.entries()) {
        const entry = { ordinal: index + 1, ownerMatched: true, status: 'observing' }
        try {
          const query = new URLSearchParams({ workspace: workspaceId })
          const reads = await Promise.allSettled([
            json(`/api/settings/model-order?${query}`), json(`/api/settings/api-keys?${query}`), json(`/api/subscriptions?${query}`),
          ])
          const failed = reads.find(read => read.status === 'rejected')
          if (failed) throw failed.reason
          const [order, keys, connections] = reads.map(read => read.value)
          Object.assign(entry, sourceCounts({ order, keys, connections }, ownerId), { status: 'observed' })
        } catch (error) { Object.assign(entry, publicFailure(error)) }
        report.workspaces.push(entry)
      }
      report.status = report.workspaces.every(entry => entry.status === 'observed') ? 'observed' : 'partial'
    }
  } catch (error) { Object.assign(report, publicFailure(error)) }
  finally {
    if (report.versionPin.start) {
      try { await pin(); report.versionPin.end = true }
      catch (error) { Object.assign(report, publicFailure(error)) }
    }
    if (cookie) {
      report.sessionClosed = await request('/api/auth/sign-out', {}).then(response => response.ok).catch(() => false)
      if (!report.sessionClosed) {
        report.status = 'failed'
        report.code = 'cleanup_incomplete'
      }
    }
    cookie = ''
    report.finishedAt = new Date(now()).toISOString()
  }
  return report
}
