import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TARGET = Object.freeze({
  revision: 'aa50444a0b5012d2d35ca730c3ca722c0057d596',
  deployment: 'dpl_3w4SnCqaoFhayN8QCU6UGc4vuARw',
})
const ORIGIN = 'https://app.aspectlylabs.com'
const REPOSITORY = 'alexj11324/Mikka'
const REF = 'refs/heads/acceptance/proactive-1157-1163'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const MAX_SCOPES = 10
const MAX_BODY_BYTES = 512 * 1024
const OUTPUT = 'subscription-inventory-sanitized/results.json'
const ERROR_CODES = new Set([
  'inventory_execution_scope', 'inventory_node_version', 'inventory_source_revision', 'inventory_source_dirty',
  'inventory_source_unavailable', 'inventory_smoke_account_required', 'inventory_version_request',
  'inventory_version_http', 'inventory_version_shape', 'inventory_deployment_mismatch',
  'inventory_signin_request', 'inventory_signin_http', 'inventory_cookie_missing',
  'inventory_session_request', 'inventory_session_http', 'inventory_session_identity',
  'inventory_bots_request', 'inventory_bots_http', 'inventory_bot_scope', 'inventory_bots_missing',
  'inventory_model_request', 'inventory_model_http', 'inventory_menu_shape', 'inventory_output_rejected',
  'inventory_signout_request', 'inventory_signout_http', 'inventory_signout_unconfirmed',
  'inventory_response_body', 'inventory_failed',
])
class InventoryError extends Error { constructor(code) { super(code); this.code = code } }
const fail = code => { throw new InventoryError(code) }
const safeError = error => ERROR_CODES.has(error?.code) ? error.code : 'inventory_failed'

export function assertExecutionScope(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== REF || env.GITHUB_EVENT_NAME !== 'push') fail('inventory_execution_scope')
}

/** The source checkout is immutable and is the only source of the account guard. */
export async function verifiedSource() {
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('inventory_node_version')
  const directory = resolve('source')
  let revision
  try { revision = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { fail('inventory_source_unavailable') }
  if (revision !== TARGET.revision) fail('inventory_source_revision')
  try { execFileSync('git', ['-C', directory, 'diff', '--quiet', 'HEAD', '--'], { stdio: 'ignore' }) }
  catch { fail('inventory_source_dirty') }
  try {
    // This source file uses only erasable TypeScript and no package imports.
    const { isSmokeAccountEmail } = await import(pathToFileURL(resolve(directory, 'lib/smoke-account.ts')).href)
    if (typeof isSmokeAccountEmail !== 'function') fail('inventory_source_unavailable')
    return { revision, isSmokeAccountEmail }
  } catch { fail('inventory_source_unavailable') }
}

async function readJson(response) {
  const reader = response.body?.getReader()
  if (!reader) fail('inventory_response_body')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) { await reader.cancel(); fail('inventory_response_body') }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch { fail('inventory_response_body') }
}

function noSecret(value, secrets) {
  if ([...secrets].some(secret => secret.length >= 8 && value.includes(secret))) fail('inventory_output_rejected')
  return value
}

function publicLabel(value, secrets, { empty = false, provider = false } = {}) {
  if (empty && value === '') return ''
  const pattern = provider ? /^[a-z][a-z0-9_-]{0,39}$/ : /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('//')) fail('inventory_menu_shape')
  return noSecret(value, secrets)
}

/** Only public menu IDs and status fields survive. Labels, URLs and quota bodies do not. */
export function projectMenu(menu, secrets = new Set()) {
  if (!menu || !Array.isArray(menu.groups) || menu.groups.length > 100 || !menu.current) fail('inventory_menu_shape')
  const subscriptionOptions = []
  for (const group of menu.groups) {
    if (group?.kind !== 'subscription') continue
    if (!Array.isArray(group.options) || group.options.length > 200) fail('inventory_menu_shape')
    for (const option of group.options) {
      if (!UUID.test(option?.id ?? '') || !['claude', 'codex'].includes(option?.provider)) fail('inventory_menu_shape')
      subscriptionOptions.push({ id: option.id, provider: option.provider, modelId: publicLabel(option.modelId, secrets) })
      if (subscriptionOptions.length > 500) fail('inventory_menu_shape')
    }
  }
  const current = menu.current
  if (!['hosted', 'subscription', 'apiKey', 'shared'].includes(current.kind) || typeof current.available !== 'boolean'
    || current.availability !== undefined && !['available', 'checking', 'exhausted'].includes(current.availability)) fail('inventory_menu_shape')
  return {
    subscriptionOptions,
    current: {
      kind: current.kind,
      provider: publicLabel(current.provider, secrets, { provider: true }),
      modelId: publicLabel(current.modelId, secrets, { empty: current.kind === 'hosted' }),
      available: current.available,
      availability: current.availability ?? null,
    },
  }
}

/** A single normal Smoke session. Inventory GETs never refresh or select a model. */
export async function runInventory({ env = process.env, fetchImpl = fetch, verifySource = verifiedSource, now = () => new Date().toISOString() } = {}) {
  assertExecutionScope(env)
  const source = await verifySource()
  if (source?.revision !== TARGET.revision || typeof source.isSmokeAccountEmail !== 'function') fail('inventory_source_revision')
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  if (!source.isSmokeAccountEmail(email) || typeof password !== 'string' || !password) fail('inventory_smoke_account_required')
  const secrets = new Set()
  const remember = value => {
    if (typeof value !== 'string' || !value) return
    for (const variant of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) secrets.add(variant)
  }
  remember(email); remember(password)
  const cookies = new Map()
  const report = {
    schemaVersion: 1, status: 'failed', sourceRevision: TARGET.revision, expectedDeployment: TARGET.deployment,
    startedAt: now(), completedAt: null, versionBefore: null, versionAfter: null,
    authentication: { loginAttempted: false, loginStatus: null, sessionVerified: false, signOutAttempted: false, signOutStatus: null, sessionEnded: false },
    coverage: { scopeBoundary: 'current-session-visible-owned-bots', scopesSeen: 0, scopesRead: 0, limit: MAX_SCOPES, truncated: false },
    scopes: [], errors: [],
    interpretation: { ownOptionsMayBeEmptyWithPooledCurrent: true, menuWasNotRefreshed: true, modelExecutionPerformed: false },
  }
  function collectCookies(response) {
    for (const header of response.headers.getSetCookie()) {
      remember(header)
      const first = header.split(';', 1)[0], separator = first.indexOf('=')
      if (separator < 1) continue
      const name = first.slice(0, separator), value = first.slice(separator + 1)
      remember(value)
      if (!value || /;\s*max-age=0(?:;|$)/i.test(header)) cookies.delete(name)
      else cookies.set(name, value)
    }
  }
  async function request(path, label, { method = 'GET', body, authenticated = true } = {}) {
    let response
    try {
      response = await fetchImpl(ORIGIN + '/mikka' + path, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        headers: { origin: ORIGIN, 'cache-control': 'no-store',
          ...(authenticated && cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch { fail(`inventory_${label}_request`) }
    if (authenticated) collectCookies(response)
    return response
  }
  async function version() {
    const response = await request('/api/version', 'version', { authenticated: false })
    if (response.status !== 200) fail('inventory_version_http')
    const body = await readJson(response)
    if (typeof body?.build !== 'string' || !/^(?:dpl_[A-Za-z0-9]+|[a-f0-9]{40})$/.test(body.build)) fail('inventory_version_shape')
    return body.build
  }
  let startedAgainstExpectedVersion = false
  try {
    report.versionBefore = await version()
    if (report.versionBefore !== TARGET.deployment) fail('inventory_deployment_mismatch')
    startedAgainstExpectedVersion = true
    report.authentication.loginAttempted = true
    const login = await request('/api/auth/sign-in/email', 'signin', { method: 'POST', body: { email, password } })
    report.authentication.loginStatus = login.status
    await login.body?.cancel()
    if (login.status !== 200) fail('inventory_signin_http')
    if (!cookies.size) fail('inventory_cookie_missing')
    const sessionResponse = await request('/api/auth/get-session', 'session')
    if (sessionResponse.status !== 200) fail('inventory_session_http')
    const identity = await readJson(sessionResponse)
    remember(identity?.session?.token)
    if (identity?.user?.email?.toLowerCase() !== email.toLowerCase() || typeof identity.user.id !== 'string' || !identity.user.id
      || identity.session?.userId !== identity.user.id) fail('inventory_session_identity')
    report.authentication.sessionVerified = true
    const botResponse = await request('/api/bots', 'bots')
    if (botResponse.status !== 200) fail('inventory_bots_http')
    const bots = await readJson(botResponse)
    if (!Array.isArray(bots) || !bots.length || bots.length > 1000) fail('inventory_bots_missing')
    const scopes = new Map()
    for (const bot of bots) {
      if (!UUID.test(bot?.id ?? '') || !UUID.test(bot?.workspaceId ?? '') || bot.ownerId !== identity.user.id) fail('inventory_bot_scope')
      if (!scopes.has(bot.workspaceId)) scopes.set(bot.workspaceId, bot.id)
    }
    report.coverage.scopesSeen = scopes.size
    report.coverage.truncated = scopes.size > MAX_SCOPES
    for (const [workspaceId, botId] of [...scopes].slice(0, MAX_SCOPES)) {
      const response = await request(`/api/mobile/model?bot=${encodeURIComponent(botId)}`, 'model')
      if (response.status !== 200) fail('inventory_model_http')
      const menu = projectMenu(await readJson(response), secrets)
      report.scopes.push({ workspaceId, botId, ...menu })
      report.coverage.scopesRead++
    }
  } catch (error) { report.errors.push(safeError(error)) }
  finally {
    if (cookies.size) {
      report.authentication.signOutAttempted = true
      try {
        const response = await request('/api/auth/sign-out', 'signout', { method: 'POST', body: {} })
        report.authentication.signOutStatus = response.status
        if (response.status !== 200) fail('inventory_signout_http')
        if ((await readJson(response))?.success !== true) fail('inventory_signout_unconfirmed')
        report.authentication.sessionEnded = true
      } catch (error) { report.errors.push(safeError(error)) }
      cookies.clear()
    }
    if (startedAgainstExpectedVersion) {
      try {
        report.versionAfter = await version()
        if (report.versionAfter !== TARGET.deployment) fail('inventory_deployment_mismatch')
      } catch (error) { report.errors.push(safeError(error)) }
    }
  }
  report.completedAt = now()
  report.status = report.errors.length === 0 && report.authentication.sessionEnded && report.coverage.scopesRead > 0 ? 'passed' : 'failed'
  noSecret(JSON.stringify(report), secrets)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--verify-source')) {
    try { assertExecutionScope(process.env); const source = await verifiedSource(); console.log(JSON.stringify({ sourceVerified: source.revision })) }
    catch (error) { console.log(JSON.stringify({ status: 'failed', error: safeError(error) })); process.exitCode = 1 }
  } else {
    let report
    try { report = await runInventory() }
    catch (error) { report = { schemaVersion: 1, status: 'failed', sourceRevision: TARGET.revision, expectedDeployment: TARGET.deployment, errors: [safeError(error)], scopes: [] } }
    mkdirSync(resolve('subscription-inventory-sanitized'), { recursive: true, mode: 0o700 })
    writeFileSync(resolve(OUTPUT), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    const summary = { status: report.status, sourceRevision: TARGET.revision, deployment: TARGET.deployment,
      scopesRead: report.scopes.length, sessionEnded: report.authentication?.sessionEnded ?? false, errors: report.errors }
    console.log(JSON.stringify(summary))
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Read-only subscription inventory\n\nStatus: ${summary.status}. Scopes read: ${summary.scopesRead}. Session ended: ${summary.sessionEnded}. Model calls: 0.\n`)
    if (report.status !== 'passed') process.exitCode = 1
  }
}
