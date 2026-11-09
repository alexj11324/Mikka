// Normal signed-in settings reads only. No message, model, card, balance,
// workspace, grant or provider mutation; only this job's session is created.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const origin = 'https://app.aspectlylabs.com'
const base = '74cf21e78eb3bfca373744519995f6dc78586e60'
const prefix = 'ops: inspect private cloud production subscriptions final wallet settings audit'
const paths = ['.github/workflows/infisical-cloud-capabilities.yml', 'scripts/ops/self-hosted-wallet-settings-audit.mjs']
const demand = (ok, code) => { if (!ok) throw new Error(code) }
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const report = { schema: 1, startedAt: new Date().toISOString(), status: 'running', modelCalls: 0, virtualMachines: 0, billingMutationsRequested: 0, quotaAcceptanceClaimed: false, http: [], workspaces: [], cleanup: { ownSessionSignedOut: false } }
let cookie = ''
async function request(path, body) {
  demand(['/api/auth/sign-in/email', '/api/auth/sign-out', '/api/auth/get-session?disableCookieCache=true', '/api/version', '/api/workspace/switcher'].includes(path)
    || /^\/api\/settings\/(credit-billing|card-verification)\?workspace=[a-f0-9-]{36}$/.test(path), 'REQUEST_SCOPE')
  const response = await fetch(origin + '/mikka' + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { origin, 'cache-control': 'no-store', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  report.http.push({ operation: path.split('?')[0], status: response.status })
  return response
}
async function json(path) { const r = await request(path); demand(r.ok || (r.status === 403 && path.startsWith('/api/settings/')), 'SETTINGS_HTTP'); return r.json() }
try {
  const e = process.env
  demand(e.GITHUB_ACTIONS === 'true' && e.GITHUB_EVENT_NAME === 'push' && e.GITHUB_ACTOR === 'alexj11324' && e.GITHUB_RUN_ATTEMPT === '1'
    && e.GITHUB_REPOSITORY === 'alexj11324/Mikka' && e.GITHUB_REPOSITORY_ID === '1427517699' && e.GITHUB_REPOSITORY_OWNER_ID === '183887963'
    && e.GITHUB_REF === 'refs/heads/ops/infisical-cloud-capabilities', 'EXECUTION_SCOPE')
  const event = JSON.parse(await readFile(e.GITHUB_EVENT_PATH, 'utf8'))
  demand(event.after === e.GITHUB_SHA && !event.deleted && !event.forced && event.head_commit?.message?.startsWith(prefix)
    && event.repository?.id === 1427517699 && event.repository.owner?.id === 183887963 && event.repository.fork === false, 'EVENT_SCOPE')
  demand(git('rev-parse', 'HEAD') === e.GITHUB_SHA && git('rev-parse', 'HEAD^') === base
    && JSON.stringify(git('diff', '--name-only', 'HEAD^', 'HEAD').split('\n').sort()) === JSON.stringify([...paths].sort()), 'SOURCE_SCOPE')
  report.driver = { head: e.GITHUB_SHA, parent: base, run: e.GITHUB_RUN_ID, attempt: 1 }
  if (e.MIKKA_WALLET_AUDIT_PREFLIGHT === '1') { console.log(JSON.stringify({ preflight: 'passed', ...report.driver })); process.exit(0) }
  demand(typeof e.SMOKE_OWNER_EMAIL === 'string' && /^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(e.SMOKE_OWNER_EMAIL) && e.SMOKE_OWNER_PASSWORD, 'SMOKE_ACCOUNT_REQUIRED')
  report.publicBefore = (await json('/api/version')).build
  demand(/^[a-f0-9]{40}$/.test(report.publicBefore ?? ''), 'VERSION_SCHEMA')
  const login = await request('/api/auth/sign-in/email', { email: e.SMOKE_OWNER_EMAIL, password: e.SMOKE_OWNER_PASSWORD })
  // Capture only our own session even if the server subsequently rejects login.
  cookie = login.headers.getSetCookie().map(s => s.split(';', 1)[0]).join('; ')
  await login.body?.cancel(); demand(login.ok && cookie, 'LOGIN')
  const identity = await json('/api/auth/get-session?disableCookieCache=true')
  demand(identity.user?.email?.toLowerCase() === e.SMOKE_OWNER_EMAIL.toLowerCase(), 'IDENTITY')
  const switcher = await json('/api/workspace/switcher')
  const own = switcher.accounts?.find(a => a.id === identity.user.id)
  demand(Array.isArray(own?.choices) && own.choices.length > 0 && own.choices.length <= 20, 'WORKSPACE_SCHEMA')
  for (const workspace of own.choices) {
    demand(/^[a-f0-9-]{36}$/.test(workspace.id), 'WORKSPACE_ID')
    const billing = await json('/api/settings/credit-billing?workspace=' + workspace.id)
    const card = await json('/api/settings/card-verification?workspace=' + workspace.id)
    const balanceKnown = Number.isFinite(billing.balancePoints)
    report.workspaces.push({ workspaceHash: createHash('sha256').update(workspace.id).digest('hex').slice(0, 16),
      balanceKnown, ownBalanceZero: balanceKnown ? billing.balancePoints === 0 : null, ownBalancePositive: balanceKnown ? billing.balancePoints > 0 : null,
      billingReadDenied: typeof billing.error === 'string', cardStatus: ['verified', 'unverified', 'pending', 'unavailable'].includes(card.status) ? card.status : 'unknown',
      // An empty Team wallet can borrow personal credit; it is not proof of an
      // exhausted effective payer and does not establish cloud_quota_exhausted.
      effectivePayerExhaustionProven: false })
  }
  report.publicAfter = (await json('/api/version')).build
  report.publicSourceUnchanged = report.publicBefore === report.publicAfter
  report.status = 'settings_observed'
} catch (error) {
  const allowed = ['REQUEST_SCOPE', 'SETTINGS_HTTP', 'EXECUTION_SCOPE', 'EVENT_SCOPE', 'SOURCE_SCOPE', 'SMOKE_ACCOUNT_REQUIRED', 'VERSION_SCHEMA', 'LOGIN', 'IDENTITY', 'WORKSPACE_SCHEMA', 'WORKSPACE_ID']
  report.status = 'failed'; report.code = allowed.includes(error?.message) ? error.message : 'AUDIT_FAILED'
  process.exitCode = 1
} finally {
  if (cookie) { try { const r = await request('/api/auth/sign-out', {}); await r.body?.cancel(); report.cleanup.ownSessionSignedOut = r.ok } catch { /* No raw errors or credentials. */ } }
  if (cookie && !report.cleanup.ownSessionSignedOut) { report.status = 'failed'; report.code = 'SESSION_CLEANUP'; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  if (process.env.MIKKA_WALLET_AUDIT_PREFLIGHT !== '1') { await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/self-hosted-wallet-settings-audit.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)) }
}
