import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw new Error('Organization security requires isolated PG17')

/** An independent RFC 6238 authenticator consumes the base32 secret in the native otpauth URI. */
function authenticatorCode(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...secret.replace(/=+$/, '').toUpperCase()].map(character => {
    const value = alphabet.indexOf(character)
    assert.ok(value >= 0)
    return value.toString(2).padStart(5, '0')
  }).join('')
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = digest.at(-1)! & 15
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
}

class Browser {
  readonly cookies = new Map<string, string>()
  // Separate people have separate stable fixture clients; native rate limits remain enabled.
  readonly ip = `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`
  take(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'), at = pair.indexOf('=')
      const name = pair.slice(0, at), value = pair.slice(at + 1)
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  headers(origin: string, token?: string) {
    return new Headers({ origin, 'content-type': 'application/json', 'x-forwarded-for': this.ip,
      ...(token ? { authorization: `Bearer ${token}` } : { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') }) })
  }
}

test('native second-factor verification enforces Organization security without denying personal recovery', { skip: !target, timeout: 120_000 }, async t => {
  const database = new Pool({ connectionString: target })
  const { auth, authBaseURL } = await import('../lib/auth')
  const { pool } = await import('../lib/db')
  const { workspacePool, workspaceDb } = await import('../lib/workspace-db')
  const { createRequestScope, runRequestScope } = await import('../apps/api/src/context')
  const org = await import('../lib/governance/organizations')
  const security = await import('../lib/governance/organization-security')
  const factors = await import('../lib/enterprise/two-factor')
  const { requireWorkspace } = await import('../lib/workspace-access')
  const { requireEnterpriseOrganization } = await import('../lib/enterprise/access')
  const policyRoute = await import('../app/api/organizations/[organizationId]/security/route')
  const personalRoute = await import('../app/api/me/security/route')
  const domainRoute = await import('../app/api/organizations/[organizationId]/allowed-domains/[domainId]/verify/route')
  const invitation = await import('../lib/governance/organization-invitations')
  const { BASE_PATH } = await import('../lib/base-path')
  assert.ok(authBaseURL)
  const origin = new URL(authBaseURL).origin
  const context = await auth.$context
  const people = ['owner', 'member', 'other-workspace', 'invitee'].map(name => ({
    id: randomUUID(), name, email: `${randomUUID()}@security.example.invalid`,
  }))
  const [owner, member, outsider, invitee] = people
  const organizations: string[] = [], workspaces: string[] = []
  t.after(async () => {
    try {
      await database.query('delete from enterprise_org_policy where "organizationId"=any($1::uuid[])', [organizations])
      await database.query('delete from mikka_organizations where id=any($1::uuid[])', [organizations])
      await database.query('delete from mikka_workspaces where id=any($1::uuid[])', [workspaces])
      await database.query('delete from "user" where id=any($1::text[])', [people.map(user => user.id)])
    } finally {
      await (await import('../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
      await Promise.all([database.end(), pool.end(), workspacePool.end()])
    }
  })
  for (const user of people) await database.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())',
    [user.id, user.name, user.email])
  const password = randomBytes(24).toString('base64url')
  await database.query('insert into account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") values ($1,$2,$3,$2,$4,now(),now())',
    [randomUUID(), owner.id, 'credential', await context.password.hash(password)])
  const organizationId = (await org.createOrganization(owner, { name: 'Second factor required' })).id
  organizations.push(organizationId, (await org.createOrganization(outsider, { name: 'Independent security' })).id)
  await org.addOrganizationMember(organizationId, owner.id, { userId: member.id })
  for (const [id, user, organization] of [[randomUUID(), owner, organizationId], [randomUUID(), outsider, organizations[1]]] as const) {
    workspaces.push(id)
    await database.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,$3,$4)', [id, user.id, 'Security fixture', 'team'])
    await database.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role) values ($1,$2,$3,$4,$5)', [id, user.id, user.name, user.email, 'admin'])
    await database.query('insert into mikka_organization_workspaces ("organizationId","workspaceId") values ($1,$2)', [organization, id])
  }
  await database.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role) values ($1,$2,$3,$4,$5)',
    [workspaces[0], member.id, member.name, member.email, 'member'])
  const ownerBrowser = new Browser(), memberBrowser = new Browser(), outsiderBrowser = new Browser()
  const memberSession = await context.internalAdapter.createSession(member.id)
  const outsiderSession = await context.internalAdapter.createSession(outsider.id)
  assert.ok(memberSession && outsiderSession)
  async function scoped(request: Request, work: () => Promise<Response>): Promise<Response> {
    const scope = createRequestScope(request)
    try {
      const response = await runRequestScope(scope, work)
      const headers = new Headers(response.headers)
      scope.cookies.commit(headers)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    } finally { await scope.after.finish() }
  }
  async function authRequest(path: string, browser: Browser, body: unknown, token?: string, extra?: Record<string, string>) {
    const headers = browser.headers(origin, token)
    for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value)
    const request = new Request(`${origin}${BASE_PATH}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const response = await scoped(request, () => auth.handler(request))
    browser.take(response)
    return response
  }
  async function session(browser: Browser) {
    const active = await auth.api.getSession({ headers: browser.headers(origin), query: { disableCookieCache: true } })
    assert.ok(active)
    return active
  }
  async function policy(method: 'GET' | 'PATCH', browser: Browser, token?: string, body?: unknown, id = organizationId) {
    const request = new Request(`${origin}/api/organizations/${id}/security`, { method, headers: browser.headers(origin, token),
      ...(method === 'PATCH' ? { body: JSON.stringify(body) } : {}) })
    return scoped(request, () => policyRoute[method](request, { params: Promise.resolve({ organizationId: id }) }))
  }
  async function personal(browser: Browser, token?: string) {
    const request = new Request(`${origin}/api/me/security`, { headers: browser.headers(origin, token) })
    return scoped(request, () => personalRoute.GET(request))
  }
  let ownerSessionId = '', secret = '', backupCodes: string[] = []
  let otherSessionToken = '', otherSessionId = ''
  const secondBrowser = new Browser()
  // Same account/client origin keeps the real endpoint limiter and its rejection observable.
  Object.defineProperty(secondBrowser, 'ip', { value: ownerBrowser.ip })
  await t.test('enrollment uses native encrypted TOTP and requires proof before policy enablement', async () => {
    assert.equal((await authRequest('/two-factor/enable', new Browser(), {})).status, 401)
    const login = await authRequest('/sign-in/email', ownerBrowser, { email: owner.email, password })
    assert.equal(login.status, 200)
    ownerSessionId = (await session(ownerBrowser)).session.id
    assert.deepEqual(await factors.twoFactorSessionState(owner.id, ownerSessionId), { enabled: false, verified: false })
    assert.equal((await policy('PATCH', ownerBrowser, undefined, { requireTwoFactor: true, gracePeriodDays: 7 })).status, 403)
    assert.equal((await authRequest('/two-factor/enable', ownerBrowser, {})).status, 400, 'credential accounts still need their password')
    const enroll = await authRequest('/two-factor/enable', ownerBrowser, { password })
    assert.equal(enroll.status, 200)
    const setup = await enroll.json() as { totpURI: string; backupCodes: string[] }
    secret = new URL(setup.totpURI).searchParams.get('secret')!
    backupCodes = setup.backupCodes
    assert.ok(secret && backupCodes.length > 1)
    const { rows: [stored] } = await database.query('select secret,"backupCodes",verified from "twoFactor" where "userId"=$1', [owner.id])
    assert.notEqual(stored.secret, secret)
    assert.equal(stored.backupCodes.includes(backupCodes[0]), false)
    assert.equal(stored.verified, false)
    assert.deepEqual(await factors.twoFactorSessionState(owner.id, ownerSessionId), { enabled: false, verified: false })
    const bad = await authRequest('/two-factor/verify-totp', ownerBrowser, { code: 'invalid' })
    assert.equal(bad.status, 401)
    assert.equal((await factors.twoFactorSessionState(owner.id, ownerSessionId)).verified, false)
    const code = authenticatorCode(secret)
    assert.equal((await authRequest('/two-factor/verify-totp', ownerBrowser, { code })).status, 200)
    const active = await session(ownerBrowser)
    assert.notEqual(active.session.id, ownerSessionId)
    ownerSessionId = active.session.id
    assert.deepEqual(await factors.twoFactorSessionState(owner.id, ownerSessionId), { enabled: true, verified: true })
    assert.equal((await database.query('select "twoFactorMethod" from session where id=$1', [ownerSessionId])).rows[0].twoFactorMethod, 'totp')
  })
  await t.test('fresh routes reject ordinary members and foreign workspace administrators', async () => {
    for (const [browser, token] of [[memberBrowser, memberSession.token], [outsiderBrowser, outsiderSession.token]] as const) {
      assert.equal((await policy('GET', browser, token)).status, 403)
      assert.equal((await policy('PATCH', browser, token, { requireTwoFactor: false })).status, 403)
    }
    const unauthenticated = new Browser()
    assert.equal((await personal(unauthenticated)).status, 403)
    assert.equal((await policy('PATCH', unauthenticated, undefined, { requireTwoFactor: true })).status, 403)
    assert.equal((await policy('PATCH', ownerBrowser, undefined, { requireTwoFactor: true, gracePeriodDays: -1 })).status, 400)
    const enabled = await policy('PATCH', ownerBrowser, undefined, { requireTwoFactor: true, gracePeriodDays: 1 })
    assert.equal(enabled.status, 200)
    const enabledPolicy = (await enabled.json()).policy
    assert.equal(enabledPolicy.requireTwoFactor, true)
    assert.equal(enabledPolicy.gracePeriodDays, 1)
    assert.equal(Date.parse(enabledPolicy.graceEndsAt) - Date.parse(enabledPolicy.requiredAt), 86_400_000)
    const independent = await policy('GET', outsiderBrowser, outsiderSession.token, undefined, organizations[1])
    assert.equal(independent.status, 200)
    assert.equal((await independent.json()).policy.requireTwoFactor, false)
    const memberView = await personal(memberBrowser, memberSession.token)
    assert.equal(memberView.status, 200)
    assert.equal((await memberView.json()).organizations[0].status, 'grace')
    const domains = await import('../lib/governance/organization-join-domains')
    const rule = await domains.addAllowedDomain(organizationId, owner, { domain: 'security.example.invalid' })
    for (const [browser, token] of [[memberBrowser, memberSession.token], [outsiderBrowser, outsiderSession.token]] as const) {
      const request = new Request(`${origin}/api/organizations/${organizationId}/allowed-domains/${rule.domain.id}/verify`,
        { method: 'POST', headers: browser.headers(origin, token) })
      const denied = await scoped(request, () => domainRoute.POST(request, { params: Promise.resolve({ organizationId, domainId: rule.domain.id }) }))
      assert.equal(denied.status, 403)
    }
    const foreignRead = new Request(`${origin}/api/me/security?userId=${owner.id}`, { headers: outsiderBrowser.headers(origin, outsiderSession.token) })
    const ownView = await scoped(foreignRead, () => personalRoute.GET(foreignRead))
    assert.equal(ownView.status, 200)
    assert.deepEqual((await ownView.json()).organizations.map((row: { organizationId: string }) => row.organizationId), [organizations[1]],
      'personal security has no client-selectable subject')
    await workspaceDb.transaction(tx => requireWorkspace(tx, workspaces[0], member.id, false, { kind: 'session', sessionId: memberSession.id }))
  })
  await t.test('an enrolled account still requires second-factor proof for each new human session', async () => {
    // This is the actual native session constructor also used by OAuth callbacks.
    // It proves session assurance, without substituting a fake OAuth provider or authenticator.
    const other = await context.internalAdapter.createSession(owner.id)
    assert.ok(other)
    otherSessionToken = other.token; otherSessionId = other.id
    assert.deepEqual(await factors.twoFactorSessionState(owner.id, other.id), { enabled: true, verified: false })
    for (const path of ['/two-factor/get-totp-uri', '/two-factor/generate-backup-codes', '/two-factor/disable']) {
      assert.equal((await authRequest(path, secondBrowser, { password }, other.token)).status, 403,
        'first-factor possession cannot reveal or replace the enrolled authenticator')
    }
    await database.query('update enterprise_org_policy set "twoFactorRequiredAt"=now()-interval \'2 days\' where "organizationId"=$1', [organizationId])
    await assert.rejects(requireEnterpriseOrganization(owner.id, organizationId, other.id), { code: 'workspaceAccessDenied' })
    await assert.rejects(requireEnterpriseOrganization(member.id, organizationId, memberSession.id), { code: 'workspaceAccessDenied' })
    await assert.rejects(workspaceDb.transaction(tx => requireWorkspace(tx, workspaces[0], member.id, false,
      { kind: 'session', sessionId: memberSession.id })), { code: 'workspaceAccessDenied' })
    assert.equal((await policy('GET', secondBrowser, other.token)).status, 403)
    assert.equal((await personal(memberBrowser, memberSession.token)).status, 200, 'personal recovery remains accessible')
    const view = await security.readPersonalSecurity(owner.id, other.id)
    assert.equal(view.organizations[0].status, 'verification_required')
    assert.equal((await security.readPersonalSecurity(member.id, memberSession.id)).organizations[0].status, 'enrollment_required')
    await requireEnterpriseOrganization(owner.id, organizationId, ownerSessionId)
    await requireEnterpriseOrganization(outsider.id, organizations[1], outsiderSession.id)
  })
  await t.test('native password challenge publishes neither an authenticated session nor a desktop proof', async () => {
    const passwordBrowser = new Browser()
    Object.defineProperty(passwordBrowser, 'ip', { value: ownerBrowser.ip })
    const countBefore = (await database.query('select count(*)::int n from session where "userId"=$1', [owner.id])).rows[0].n
    const audits = async () => (await database.query('select payload from workspace_audit_outbox where "workspaceId"=$1 and payload->>\'action\'=\'auth.signed_in\'', [workspaces[0]])).rows
    const auditsBefore = (await audits()).length
    const pending = await authRequest('/sign-in/email', passwordBrowser, { email: owner.email, password }, undefined, { 'x-mikka-client': 'desktop' })
    assert.equal(pending.status, 200)
    assert.equal((await pending.json()).twoFactorRedirect, true)
    assert.ok(!pending.headers.get('x-mikka-session-cache'))
    assert.equal(await auth.api.getSession({ headers: passwordBrowser.headers(origin), query: { disableCookieCache: true } }), null)
    assert.equal((await database.query('select count(*)::int n from session where "userId"=$1', [owner.id])).rows[0].n, countBefore)
    assert.equal((await audits()).length, auditsBefore, 'an unfinished password challenge cannot audit a usable sign-in')
    const code = authenticatorCode(secret)
    assert.equal((await authRequest('/two-factor/verify-totp', passwordBrowser, { code })).status, 200)
    const signedIn = await session(passwordBrowser)
    assert.equal((await factors.twoFactorSessionState(owner.id, signedIn.session.id)).verified, true)
    assert.ok((await audits()).some(row => row.payload.targetId === signedIn.session.id && row.payload.metadata.method === 'totp'))
    const rateBrowser = new Browser()
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await authRequest('/two-factor/verify-totp', rateBrowser, { code: 'invalid' }, otherSessionToken)).status, 401)
    }
    const limited = await authRequest('/two-factor/verify-totp', rateBrowser, { code }, otherSessionToken)
    assert.equal(limited.status, 429, 'the native per-endpoint rate limiter remains active')
    assert.equal((await factors.twoFactorSessionState(owner.id, otherSessionId)).verified, false)
  })
  await t.test('native recovery codes are single-use and only assure their authenticated session', async () => {
    const recover = await authRequest('/two-factor/verify-backup-code', secondBrowser, { code: backupCodes[0] }, otherSessionToken)
    assert.equal(recover.status, 200)
    assert.equal((await factors.twoFactorSessionState(owner.id, otherSessionId)).verified, true)
    assert.equal((await database.query('select "twoFactorMethod" from session where id=$1', [otherSessionId])).rows[0].twoFactorMethod, 'recovery')
    const third = await context.internalAdapter.createSession(owner.id)
    assert.ok(third)
    assert.equal((await authRequest('/two-factor/verify-backup-code', secondBrowser, { code: backupCodes[0] }, third.token)).status, 401)
    assert.equal((await factors.twoFactorSessionState(owner.id, third.id)).verified, false)
    assert.equal((await authRequest('/two-factor/disable', ownerBrowser, { password })).status, 403,
      'organization policy prevents disabling 2FA even with a verified session')
    await requireEnterpriseOrganization(owner.id, organizationId, otherSessionId)
  })
  await t.test('a native second-factor sign-in with failed audit never publishes a session or cookie journal', async t => {
    const browser = new Browser()
    const pending = await authRequest('/sign-in/email', browser, { email: owner.email, password })
    assert.equal(pending.status, 200)
    assert.equal((await pending.json()).twoFactorRedirect, true)
    const sessions = async () => (await database.query('select count(*)::int n from session where "userId"=$1', [owner.id])).rows[0].n
    const before = await sessions()
    const constraint = `two_factor_audit_${randomUUID().replaceAll('-', '')}`
    await database.query(`alter table workspace_audit_outbox add constraint ${constraint} check ("workspaceId"<>'${workspaces[0]}'::uuid) not valid`)
    const logs: unknown[] = []
    t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args) })
    try {
      const denied = await authRequest('/two-factor/verify-backup-code', browser, { code: backupCodes[1] }, undefined, { 'x-mikka-client': 'desktop' })
      assert.equal(denied.status, 503)
      assert.equal((await denied.json()).code, 'AUTH_AUDIT_UNAVAILABLE')
      assert.equal(denied.headers.getSetCookie().length, 0)
      assert.equal(denied.headers.has('x-mikka-session-cache'), false)
      assert.equal(denied.headers.has('set-auth-token'), false)
      assert.equal(await sessions(), before)
      for (const value of [password, secret, ...backupCodes]) assert.equal(JSON.stringify(logs).includes(value), false)
    } finally { await database.query(`alter table workspace_audit_outbox drop constraint ${constraint}`) }
  })
  await t.test('passwordless accounts enroll with native verification; invitations respect the deadline', async () => {
    const created = (await invitation.issueOrganizationInvitations(organizationId, owner.id, { emails: [invitee.email] })).outcomes[0]
    assert.ok(created.created)
    const inviteeSession = await context.internalAdapter.createSession(invitee.id)
    assert.ok(inviteeSession)
    await assert.rejects(invitation.acceptOrganizationInvitation({ invitationId: created.id }, invitee), { code: 'workspaceAccessDenied' })
    await assert.rejects(invitation.acceptOrganizationInvitation({ invitationId: created.id }, invitee, inviteeSession.id), { code: 'workspaceAccessDenied' })
    const enrollment = await authRequest('/two-factor/enable', memberBrowser, {}, memberSession.token)
    assert.equal(enrollment.status, 200)
    const setup = await enrollment.json() as { totpURI: string }
    const code = authenticatorCode(new URL(setup.totpURI).searchParams.get('secret')!)
    assert.equal((await authRequest('/two-factor/verify-totp', memberBrowser, { code }, memberSession.token)).status, 200)
    const active = await session(memberBrowser)
    await workspaceDb.transaction(tx => requireWorkspace(tx, workspaces[0], member.id, false, { kind: 'session', sessionId: active.session.id }))
    assert.equal((await security.readPersonalSecurity(member.id, active.session.id)).organizations[0].status, 'verified')
    assert.equal((await policy('PATCH', memberBrowser, undefined, { requireTwoFactor: false })).status, 403)
    assert.equal((await policy('PATCH', ownerBrowser, undefined, { requireTwoFactor: false })).status, 200)
    assert.equal((await authRequest('/two-factor/disable', ownerBrowser, { password })).status, 200)
    assert.equal((await factors.twoFactorSessionState(owner.id, otherSessionId)).verified, false,
      'disabling invalidates receipts on the other sessions as well')
    assert.equal((await database.query('select 1 from session where "userId"=$1 and "twoFactorVerifiedAt" is not null', [owner.id])).rowCount, 0)
    assert.equal((await invitation.acceptOrganizationInvitation({ invitationId: created.id }, invitee, inviteeSession.id)).role, 'member')
  })
})
