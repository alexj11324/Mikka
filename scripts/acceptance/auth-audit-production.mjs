// #1597/#1600: normal human sessions, then a disposable PAT and read-only
// Factory probes. No sharing grant, task mutation, database or provider access.
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createSessionClient, smokeAcceptanceAccount } from './cloud-startup.mjs'
import { selectTeamWorkspace } from './team-workspace.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const check = (value, code) => { if (!value) throw new Error(code) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const codes = new Set(['target_refused', 'build_changed', 'login_failed', 'identity_failed', 'native_session_missing',
  'human_boundary_failed', 'workspace_missing', 'issue_missing', 'pat_create_failed', 'pat_scope_failed',
  'pat_refusal_failed', 'pat_cleanup_failed', 'session_cleanup_failed', 'acceptance_failed'])

export function auditTarget(env) {
  check(env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && /^[a-f0-9]{40}$/.test(env.APPLICATION_SHA ?? '')
    && env.GITHUB_SHA === env.APPLICATION_SHA, 'target_refused')
  return env.APPLICATION_SHA
}

/** A PAT is used only for GET. In particular, the sharing PATCH is never sent
 * with it, even with an invalid body: production never attempts a grant bypass. */
export function patReadAllowed(path, method = 'GET') {
  return method === 'GET' && (/^\/api\/factory\/tasks\?issueId=[a-f0-9-]{36}$/.test(path)
    || /^\/api\/factory\/tasks\/[a-f0-9-]{36}$/.test(path))
}

export async function runAuthAudit({ env = process.env, fetchImpl = fetch } = {}) {
  const report = { issues: [1597, 1600], startedAt: new Date().toISOString(), status: 'failed',
    checks: {}, cleanup: {}, limitations: ['human MCP checks use an invalid body and cannot mutate grants',
      'browser cookie and native bearer HTTP contracts; no OS UI or OAuth-provider round trip'] }
  const client = createSessionClient(ORIGIN, fetchImpl)
  let token, teamId, originalWorkspaceId, signedIn = false, nativeToken
  const raw = (path, init = {}) => fetchImpl(ORIGIN + '/mikka' + path, { ...init, redirect: 'error',
    signal: AbortSignal.timeout(30000), headers: { origin: ORIGIN, 'cache-control': 'no-store', ...init.headers } })
  const pin = async () => {
    const response = await raw('/api/version'), version = await response.json()
    check(response.ok && version.build === report.applicationSha, 'build_changed')
    report.overlaySha = version.overlaySha ?? null
  }
  const humanBoundary = async request => {
    const response = await request('/api/integrations/mcp/shares', { method: 'PATCH',
      headers: { 'content-type': 'application/json' }, body: '{}' })
    const body = await response.json()
    check(response.status === 400 && body?.error === 'invalidPluginInput', 'human_boundary_failed')
    return { httpStatus: response.status, authenticated: true, noGrantMutation: true }
  }
  try {
    report.applicationSha = auditTarget(env)
    const { email, password } = smokeAcceptanceAccount(env)
    await pin()
    const login = await client.request('/api/auth/sign-in/email', post({ email, password }))
    check(login.status === 200, 'login_failed'); signedIn = true
    const identity = await client.json('/api/auth/get-session?disableCookieCache=true')
    check(identity.user?.email?.toLowerCase() === email.toLowerCase(), 'identity_failed')
    report.checks.browserLogin = true
    report.checks.browserMcpHuman = await humanBoundary(client.request)
    // Better Auth's existing bearer plugin supplies a signed human session.
    nativeToken = login.headers.get('set-auth-token')
    check(typeof nativeToken === 'string' && nativeToken.length >= 32, 'native_session_missing')
    const native = (path, init = {}) => raw(path, { ...init,
      headers: { ...init.headers, authorization: 'Bearer ' + nativeToken } })
    const nativeSession = await native('/api/auth/get-session?disableCookieCache=true')
    const nativeIdentity = await nativeSession.json()
    check(nativeSession.ok && nativeIdentity.user?.id === identity.user.id, 'identity_failed')
    report.checks.nativeLogin = true
    report.checks.nativeMcpHuman = await humanBoundary(native)
    originalWorkspaceId = (await client.json('/api/workspace')).workspace?.id
    const selected = await selectTeamWorkspace({ ownerId: identity.user.id,
      onSelected: selection => { teamId = selection.workspaceId },
      json: (path, body) => client.json(path.slice('/mikka'.length), body ? { ...post(body),
        headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' } } : undefined) })
    report.team = selected
    const settings = await client.json('/api/workspace')
    const other = settings.choices.find(row => row.id !== teamId && row.kind === 'personal')
    check(uuid(teamId) && uuid(other?.id), 'workspace_missing')
    // Both resources come from normal owner reads; no guessed foreign ID.
    const ownIssues = await client.rpc('issues.listWorkspaceIssues', [teamId])
    const otherIssues = await client.rpc('issues.listWorkspaceIssues', [other.id])
    const own = ownIssues.find(row => uuid(row.id)), foreign = otherIssues.find(row => uuid(row.id))
    check(own && foreign, 'issue_missing')
    const foreignPath = '/api/factory/tasks?issueId=' + foreign.id
    const baseline = await client.json(foreignPath)
    check(Array.isArray(baseline.tasks), 'issue_missing')
    token = await client.rpc('tokens.createAccessToken', [{ name: '测试 audit ' + randomUUID(),
      expiresAt: new Date(Date.now() + 600000).toISOString() }, teamId])
    check(uuid(token?.id) && /^mkp_[A-Za-z0-9_-]{43}$/.test(token.token ?? ''), 'pat_create_failed')
    const pat = async path => {
      check(patReadAllowed(path), 'pat_scope_failed')
      const response = await raw(path, { headers: { authorization: 'Bearer ' + token.token } })
      return { status: response.status, body: await response.json() }
    }
    const positive = await pat('/api/factory/tasks?issueId=' + own.id)
    check(positive.status === 200, 'pat_scope_failed')
    const denied = await pat(foreignPath)
    check(denied.status === 404 && denied.body?.error === 'factoryNotFound', 'pat_refusal_failed')
    report.checks.patOwnWorkspace = { httpStatus: positive.status }
    report.checks.patOtherWorkspaceList = { httpStatus: denied.status, noMutation: true }
    const task = baseline.tasks.find(row => uuid(row.id))
    if (task) {
      const detail = await pat('/api/factory/tasks/' + task.id)
      check(detail.status === 404 && detail.body?.error === 'factoryNotFound', 'pat_refusal_failed')
      report.checks.patOtherWorkspaceDetail = { httpStatus: detail.status, noMutation: true }
    } else report.limitations.push('other workspace has no existing Factory task; detail boundary remains database-CI evidence')
    await pin()
    report.status = 'passed'
  } catch (error) { report.error = codes.has(error?.message) ? error.message : 'acceptance_failed' }
  finally {
    if (token?.id && teamId) {
      try {
        await client.rpc('tokens.revokeAccessToken', [{ id: token.id }, teamId])
        const remaining = await client.rpc('tokens.listAccessTokens', [teamId])
        check(!remaining.some(row => row.id === token.id), 'pat_cleanup_failed')
        report.cleanup.ownPatRevoked = true
      } catch { report.cleanup.error = 'pat_cleanup_failed'; report.status = 'failed' }
    }
    if (signedIn) {
      if (uuid(originalWorkspaceId)) {
        try { await client.rpc('workspace.switchWorkspace', [originalWorkspaceId]); report.cleanup.workspaceRestored = true }
        catch { report.cleanup.error = 'session_cleanup_failed'; report.status = 'failed' }
      }
      try { const response = await client.request('/api/auth/sign-out', post({})); check(response.ok, 'session_cleanup_failed'); report.cleanup.ownSessionClosed = true }
      catch { report.cleanup.error = 'session_cleanup_failed'; report.status = 'failed' }
    }
    client.clear(); token = nativeToken = undefined
    report.finishedAt = new Date().toISOString()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runAuthAudit()
  await mkdir('production-auth-audit-report', { recursive: true })
  await writeFile('production-auth-audit-report/report.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (report.status !== 'passed') process.exitCode = 1
}
