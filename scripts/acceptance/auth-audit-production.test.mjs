import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditTarget, patReadAllowed, runAuthAudit } from './auth-audit-production.mjs'
import { encode, decode } from '../../lib/desktop-rpc/wire.ts'

const sha = 'a'.repeat(40)
const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: sha, APPLICATION_SHA: sha }
test('production auth acceptance requires an exact main driver and explicit dispatch', () => {
  assert.equal(auditTarget(env), sha)
  for (const bad of [{ GITHUB_REF: 'refs/heads/attacker' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_SHA: 'b'.repeat(40) }, { APPLICATION_SHA: 'main' }, { GITHUB_REPOSITORY: 'another/Mikka' }]) {
    assert.throws(() => auditTarget({ ...env, ...bad }), /target_refused/)
  }
})
test('PAT production probes cannot mutate a Factory task or a sharing grant', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  for (const path of ['/api/factory/tasks?issueId=' + id, '/api/factory/tasks/' + id]) {
    assert.equal(patReadAllowed(path), true)
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) assert.equal(patReadAllowed(path, method), false)
  }
  for (const path of ['/api/integrations/mcp/shares', '/api/factory/tasks/route',
    '/api/factory/tasks?issueId=' + id + '&other=true', 'https://elsewhere.invalid/']) assert.equal(patReadAllowed(path), false)
})
test('a refused target makes no request and cannot leak supplied credentials', async () => {
  let calls = 0
  const report = await runAuthAudit({ env: { ...env, GITHUB_REF: 'refs/heads/attacker',
    SMOKE_OWNER_EMAIL: 'PRIVATE_EMAIL', SMOKE_OWNER_PASSWORD: 'PRIVATE_PASSWORD' },
    fetchImpl: () => { calls++; throw new Error('PRIVATE_HTTP_ERROR') } })
  assert.equal(calls, 0)
  assert.equal(report.status, 'failed')
  assert.equal(report.error, 'target_refused')
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/)
})

function fixture({ leak = false } = {}) {
  const id = n => '10000000-0000-4000-8000-' + String(n).padStart(12, '0')
  const owner = id(1), team = id(2), personal = id(3), ownIssue = id(4), otherIssue = id(5), task = id(6), tokenId = id(7)
  const token = 'mkp_' + 't'.repeat(43), bearer = 'n'.repeat(43), cookie = 'cookie-PRIVATE'
  const credentials = { ...env, SMOKE_OWNER_EMAIL: 'owner+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'password-PRIVATE' }
  let workspace = personal, revoked = false, loggedOut = false
  const actions = []
  const ok = (body, status = 200, headers) => Response.json(body, { status, headers })
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), path = url.pathname.slice('/mikka'.length), headers = new Headers(init.headers)
    const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined
    assert.equal(url.origin, 'https://app.aspectlylabs.com')
    if (headers.get('authorization') === 'Bearer ' + token) {
      assert.equal(method, 'GET')
      assert.equal(headers.has('cookie'), false)
      assert.equal(patReadAllowed(path + url.search), true)
      if (url.searchParams.get('issueId') === ownIssue) return ok({ tasks: [] })
      return leak ? ok({ tasks: [{ id: task }] }) : ok({ error: 'factoryNotFound' }, 404)
    }
    if (path === '/api/version') return ok({ build: sha, overlaySha: 'b'.repeat(40) })
    if (path === '/api/auth/sign-in/email') return ok({}, 200, { 'set-auth-token': bearer,
      'set-cookie': 'better-auth.session_token=' + cookie + '; Path=/mikka; Secure; HttpOnly' })
    assert.ok(headers.get('cookie')?.includes(cookie) || headers.get('authorization') === 'Bearer ' + bearer)
    if (headers.has('authorization')) assert.equal(headers.has('cookie'), false)
    if (path === '/api/auth/sign-out') { loggedOut = true; return ok({ success: true }) }
    if (path === '/api/auth/get-session') return ok({ user: { id: owner, email: credentials.SMOKE_OWNER_EMAIL } })
    if (path === '/api/integrations/mcp/shares') {
      assert.equal(method, 'PATCH'); assert.deepEqual(body, {})
      return ok({ error: 'invalidPluginInput' }, 400)
    }
    if (path === '/api/workspace') {
      const chosen = url.searchParams.get('workspace') ?? workspace
      return ok({ currentUserId: owner, role: 'member', workspace: { id: chosen, kind: chosen === team ? 'team' : 'personal' },
        choices: [{ id: team, kind: 'team' }, { id: personal, kind: 'personal' }], members: chosen === team ? [
          { userId: owner, email: credentials.SMOKE_OWNER_EMAIL, role: 'member', status: 'active' },
          { userId: 'admin', email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' },
        ] : [] })
    }
    if (path === '/api/factory/tasks') return ok({ tasks: [{ id: task }] })
    assert.equal(path, '/api/rpc')
    actions.push(body.action)
    const args = decode(body.args)
    let data
    switch (body.action) {
      case 'workspace.switchWorkspace': workspace = args[0]; data = { ok: true, data: { workspaceId: workspace } }; break
      case 'issues.listWorkspaceIssues': data = [{ id: args[0] === team ? ownIssue : otherIssue }]; break
      case 'tokens.createAccessToken': assert.equal(args[1], team); data = { ok: true, data: { id: tokenId, token } }; break
      case 'tokens.revokeAccessToken': assert.equal(args[0].id, tokenId); revoked = true; data = { ok: true, data: { id: tokenId } }; break
      case 'tokens.listAccessTokens': data = { ok: true, data: revoked ? [] : [{ id: tokenId }] }; break
      default: assert.fail('unapproved production action')
    }
    return ok({ version: 1, ok: true, result: encode(data) })
  }
  return { env: credentials, fetchImpl, closed: () => revoked && loggedOut && workspace === personal, actions }
}
for (const leak of [false, true]) test(`safe production driver ${leak ? 'detects isolation failure' : 'checks human and PAT paths'} and closes its own resources`, async () => {
  const f = fixture({ leak }), report = await runAuthAudit(f)
  assert.equal(report.status, leak ? 'failed' : 'passed', JSON.stringify(report))
  assert.equal(f.closed(), true)
  assert.equal(report.checks.nativeMcpHuman.noGrantMutation, true)
  if (leak) assert.equal(report.error, 'pat_refusal_failed')
  else assert.equal(report.checks.patOtherWorkspaceDetail.httpStatus, 404)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|mkp_|n{43}|t{43}|example.invalid/)
})
