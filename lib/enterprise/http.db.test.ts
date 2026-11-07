import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID, generateKeyPairSync, sign, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { inflateRawSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { betterAuth } from 'better-auth'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { createScimHandler } from './scim-http'
import { ScimStore, identityTokenHash } from './scim-store'
import { SCIM_GROUP, SCIM_PATCH, SCIM_USER } from './scim-protocol'
import { enterpriseIdentityModels, enterpriseSessionFields, enterpriseSso, encryptSsoConfig, ssoSessionData, withEnterpriseAuthRequest } from './sso-plugin'

const target = process.env.E2E_DATABASE_URL
if (target) { assertE2eTarget(target); assert.equal(process.env.MIKKA_DATABASE_URL, target); assert.equal(process.env.DATABASE_URL, target) }
if (!target && process.env.REQUIRE_DB === '1') throw new Error('Enterprise HTTP acceptance requires the isolated E2E database')

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}
async function close(server: Server) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
class Cookies {
  values = new Map<string, string>()
  take(response: Response) { for (const entry of response.headers.getSetCookie()) { const [pair] = entry.split(';'); const at = pair.indexOf('='); this.values.set(pair.slice(0, at), pair.slice(at + 1)) } }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ') }
}

test('enterprise HTTP fixture: OIDC + signed SAML + SCIM lifecycle + scoped revocation', { skip: !target, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: target, max: 4 })
  const previousKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  const organizationId = randomUUID(), connectionId = randomUUID(), samlConnectionId = randomUUID(), otherConnectionId = randomUUID()
  const otherOrganizationId = randomUUID(), adminId = randomUUID()
  const providerId = `enterprise-oidc-${randomBytes(5).toString('hex')}`, samlProviderId = `enterprise-saml-${randomBytes(5).toString('hex')}`, otherProviderId = `enterprise-other-${randomBytes(5).toString('hex')}`
  const email = `${randomUUID()}@enterprise-fixture.example.invalid`, subject = `subject-${randomUUID()}`
  const samlSubject = `${randomUUID()}@saml-fixture.example.invalid`
  const bearer = `msc_${randomBytes(32).toString('base64url')}`, samlBearer = `msc_${randomBytes(32).toString('base64url')}`, otherBearer = `msc_${randomBytes(32).toString('base64url')}`
  const { synchronizeDirectoryUser, auditDirectoryGroup } = await import('./lifecycle')
  const { enterpriseWorkspaceAllowed } = await import('./access')
  const scim = createScimHandler(new ScimStore(pool, synchronizeDirectoryUser, auditDirectoryGroup))
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' }
  const codes = new Map<string, { redirect: string; challenge: string; mode: string }>()
  let mode = 'valid'
  let idpOrigin = '', appOrigin = ''
  let samlIdp: { createLoginResponse: (...args: unknown[]) => Promise<{ context: string }> }
  let samlSp: unknown
  const idpServer = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url!, idpOrigin)
      if (url.pathname === '/authorize') {
        const code = randomUUID()
        codes.set(code, { redirect: url.searchParams.get('redirect_uri')!, challenge: url.searchParams.get('code_challenge')!, mode })
        const callback = new URL(url.searchParams.get('redirect_uri')!)
        callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state')!)
        outgoing.writeHead(302, { location: callback.href }); outgoing.end(); return
      }
      if (url.pathname === '/jwks') { outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ keys: [jwk] })); return }
      if (url.pathname === '/token') {
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const form = new URLSearchParams(Buffer.concat(chunks).toString())
        const grant = codes.get(form.get('code') ?? ''); codes.delete(form.get('code') ?? '')
        if (!grant || form.get('client_secret') !== 'fixture-secret' || form.get('redirect_uri') !== grant.redirect || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge) {
          outgoing.writeHead(400, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'invalid_grant' })); return
        }
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url')
        const now = Math.floor(Date.now() / 1000)
        const claims = Buffer.from(JSON.stringify({ iss: grant.mode === 'issuer' ? 'https://wrong.example.invalid' : idpOrigin,
          aud: 'mikka-fixture', sub: subject, email, email_verified: true, name: 'Enterprise fixture', iat: now,
          exp: grant.mode === 'expired' ? now - 3600 : now + 300 })).toString('base64url')
        const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), grant.mode === 'signature' ? wrongKeys.privateKey : keys.privateKey).toString('base64url')
        outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ access_token: randomBytes(24).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: `${header}.${claims}.${signature}` })); return
      }
      if (url.pathname === '/saml') {
        const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString()
        const id = /\bID="([^"]+)"/.exec(xml)?.[1]
        assert.ok(id)
        const response = await samlIdp.createLoginResponse(samlSp, { extract: { request: { id: mode === 'request' ? `wrong-${randomUUID()}` : id } } }, 'post', { email: samlSubject })
        let encoded = response.context
        if (mode === 'tampered') encoded = Buffer.from(Buffer.from(encoded, 'base64').toString().replace(samlSubject, 'attacker@example.invalid')).toString('base64')
        outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ SAMLResponse: encoded, RelayState: url.searchParams.get('RelayState') })); return
      }
      outgoing.writeHead(404); outgoing.end()
    } catch (error) { outgoing.writeHead(500); outgoing.end(error instanceof Error ? error.name : 'FixtureError') }
  })
  idpOrigin = await listen(idpServer)
  let handler: (request: Request) => Promise<Response>
  const appServer = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value)
      const request = new Request(`${appOrigin}${incoming.url}`, { method: incoming.method, headers,
        ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }) })
      const url = new URL(request.url)
      const resource = /^\/scim\/([^/]+)(?:\/(.*))?$/.exec(url.pathname)
      const response = resource ? await scim(request, resource[1], resource[2]?.split('/') ?? []) : await handler(request)
      outgoing.writeHead(response.status, { ...Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie')), 'set-cookie': response.headers.getSetCookie() })
      outgoing.end(await response.text())
    } catch (error) { outgoing.writeHead(500); outgoing.end(error instanceof Error ? error.name : 'FixtureError') }
  })
  appOrigin = await listen(appServer)
  const auth = betterAuth({ database: pool, baseURL: appOrigin, basePath: '/api/auth', secret: randomBytes(32).toString('hex'),
    trustedOrigins: [appOrigin, idpOrigin], plugins: [enterpriseIdentityModels, enterpriseSso()],
    account: { accountLinking: { trustedProviders: [] } }, rateLimit: { enabled: false },
    session: { storeSessionInDatabase: true, additionalFields: enterpriseSessionFields },
    databaseHooks: { session: { create: { before: async session => ({ data: { ...session, ...ssoSessionData(session.userId) } }) } } },
    advanced: { database: { validateSchema: false }, useSecureCookies: false }, logger: { disabled: true },
  })
  handler = withEnterpriseAuthRequest(auth.handler)
  const fixtureDir = mkdtempSync(join(tmpdir(), 'mikka-saml-fixture-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixtureDir, 'key.pem'), '-out', join(fixtureDir, 'cert.pem'), '-days', '1', '-subj', '/CN=enterprise-fixture'], { stdio: 'ignore' })
  const privateKey = readFileSync(join(fixtureDir, 'key.pem'), 'utf8'), cert = readFileSync(join(fixtureDir, 'cert.pem'), 'utf8')
  const require = createRequire(import.meta.url)
  const saml = createRequire(require.resolve('@better-auth/sso'))('samlify')
  const samlIssuer = `${appOrigin}/saml-sp`
  samlIdp = saml.IdentityProvider({ entityID: `${idpOrigin}/saml-idp`, privateKey, signingCert: cert,
    singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: `${idpOrigin}/saml` }] })
  samlSp = saml.ServiceProvider({ entityID: samlIssuer, wantAssertionsSigned: true,
    assertionConsumerService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: `${appOrigin}/api/auth/sso/saml2/sp/acs/${samlProviderId}` }] })
  t.after(async () => {
    await Promise.all([close(appServer), close(idpServer)])
    await pool.end()
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
    await Promise.all([appPool.end(), workspacePool.end()])
    rmSync(fixtureDir, { recursive: true, force: true })
    if (previousKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = previousKey
  })
  await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Enterprise owner\',$2,true,now(),now())', [adminId, `${adminId}@fixture.example.invalid`])
  for (const id of [organizationId, otherOrganizationId]) {
    await pool.query('insert into mikka_organizations (id,name,"createdBy") values ($1,\'Enterprise fixture\',$2)', [id, adminId])
    await pool.query('insert into mikka_organization_members ("organizationId","userId",role,name,email) values ($1,$2,\'owner\',\'Fixture owner\',$3)', [id, adminId, `${adminId}@fixture.example.invalid`])
  }
  const oidcConfig = { issuer: idpOrigin, pkce: true, clientId: 'mikka-fixture', clientSecret: 'fixture-secret',
    authorizationEndpoint: `${idpOrigin}/authorize`, tokenEndpoint: `${idpOrigin}/token`, jwksEndpoint: `${idpOrigin}/jwks`, discoveryEndpoint: `${idpOrigin}/.well-known/openid-configuration`,
    tokenEndpointAuthentication: 'client_secret_post', scopes: ['openid', 'email', 'profile'] }
  for (const [pid, org, config, protocol, host] of [
    [providerId, organizationId, oidcConfig, 'oidc', 'enterprise-fixture.example.invalid'],
    [otherProviderId, otherOrganizationId, oidcConfig, 'oidc', 'other-fixture.example.invalid'],
    [samlProviderId, organizationId, { issuer: samlIssuer, audience: samlIssuer, entryPoint: `${idpOrigin}/saml`, cert,
      wantAssertionsSigned: true, idpMetadata: { entityID: `${idpOrigin}/saml-idp`, cert, singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: `${idpOrigin}/saml` }] } }, 'saml', 'saml-fixture.example.invalid'],
  ] as const) {
    await pool.query('insert into enterprise_sso_provider (id,"providerId","organizationScopeId","userId",issuer,domain,"domainVerified","oidcConfig","samlConfig","domainTokenHash") values ($1,$2,$3,$4,$5,$6,true,$7,$8,$9)',
      [randomUUID(), pid, org, adminId, protocol === 'oidc' ? idpOrigin : samlIssuer, host, protocol === 'oidc' ? encryptSsoConfig(config, 'oidcConfig') : null, protocol === 'saml' ? encryptSsoConfig(config, 'samlConfig') : null, identityTokenHash(randomUUID())])
  }
  for (const [id, org, pid, token] of [[connectionId, organizationId, providerId, bearer], [samlConnectionId, organizationId, samlProviderId, samlBearer], [otherConnectionId, otherOrganizationId, otherProviderId, otherBearer]])
    await pool.query('insert into enterprise_scim_connection (id,"organizationId","providerId","tokenHash") values ($1,$2,$3,$4)', [id, org, pid, identityTokenHash(token)])
  const requestScim = (resource: string, method = 'GET', input?: unknown, connection = connectionId, token = bearer, headers: Record<string, string> = {}) => fetch(`${appOrigin}/scim/${connection}/${resource}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json', ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
  let directoryId = '', userId = '', samlDirectoryId = ''
  let oidcCookies = new Cookies()
  async function startSso(pid = providerId, jar = new Cookies()) {
    const response = await fetch(`${appOrigin}/api/auth/sign-in/sso`, { method: 'POST', headers: { 'content-type': 'application/json', origin: appOrigin, cookie: jar.header() }, body: JSON.stringify({ providerId: pid, callbackURL: `${appOrigin}/signed-in` }), redirect: 'manual' })
    jar.take(response); assert.equal(response.status, 200, await response.clone().text())
    const { url } = await response.json() as { url: string }
    return { url, jar }
  }
  async function oidcLogin() {
    const { url, jar } = await startSso()
    const consent = await fetch(url, { redirect: 'manual' })
    const callback = await fetch(consent.headers.get('location')!, { headers: { cookie: jar.header() }, redirect: 'manual' })
    jar.take(callback)
    return { callback, jar }
  }
  async function samlLogin() {
    const { url, jar } = await startSso(samlProviderId)
    const assertion = await fetch(url)
    assert.equal(assertion.status, 200, await assertion.clone().text())
    const payload = await assertion.json() as { SAMLResponse: string; RelayState: string }
    const send = () => fetch(`${appOrigin}/api/auth/sso/saml2/sp/acs/${samlProviderId}`, { method: 'POST',
      headers: { origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() }, body: new URLSearchParams(payload), redirect: 'manual' })
    const callback = await send(); jar.take(callback)
    return { callback, jar, send }
  }
  async function session(jar: Cookies) {
    const response = await fetch(`${appOrigin}/api/auth/get-session`, { headers: { cookie: jar.header() } })
    return response.json() as Promise<{ user: { id: string }; session: { id: string } } | null>
  }
  await t.test('SCIM creates one user on concurrent replay and supports filtered paginated HTTP reads', async () => {
    const user = { schemas: [SCIM_USER], externalId: subject, userName: email, displayName: 'Directory fixture', active: true }
    const deliveries = await Promise.all([requestScim('Users', 'POST', user), requestScim('Users', 'POST', user)])
    assert.deepEqual(deliveries.map(response => response.status).sort(), [200, 201])
    const resources = await Promise.all(deliveries.map(response => response.json()))
    assert.equal(resources[0].id, resources[1].id); directoryId = resources[0].id
    const listed = await requestScim(`Users?filter=${encodeURIComponent(`externalId eq "${subject}"`)}&startIndex=1&count=1`)
    const list = await listed.json(); assert.equal(list.totalResults, 1); assert.equal(list.Resources[0].id, directoryId)
    userId = (await pool.query('select "userId" from enterprise_scim_user where id=$1', [directoryId])).rows[0].userId
    const created = await requestScim('Users', 'POST', { schemas: [SCIM_USER], externalId: samlSubject, userName: samlSubject, active: true }, samlConnectionId, samlBearer)
    assert.equal(created.status, 201, await created.clone().text()); samlDirectoryId = (await created.json()).id
    assert.equal((await requestScim(`Users/${directoryId}`, 'GET', undefined, otherConnectionId, otherBearer)).status, 404)
    assert.equal((await requestScim('Users', 'GET', undefined, otherConnectionId, bearer)).status, 401)
  })
  await t.test('OIDC performs real authorization, PKCE, JWKS signature verification and records scoped assurance', async () => {
    mode = 'valid'
    const login = await oidcLogin(); oidcCookies = login.jar
    assert.equal(login.callback.headers.get('location'), `${appOrigin}/signed-in`, await login.callback.clone().text())
    const signedIn = await session(login.jar); assert.equal(signedIn?.user.id, userId)
    const proof = (await pool.query('select "enterpriseOrganizationId","enterpriseProviderId","enterpriseDirectoryUserId" from session where id=$1', [signedIn!.session.id])).rows[0]
    assert.deepEqual(proof, { enterpriseOrganizationId: organizationId, enterpriseProviderId: providerId, enterpriseDirectoryUserId: directoryId })
    assert.equal((await pool.query('select "oidcConfig" from enterprise_sso_provider where "providerId"=$1', [providerId])).rows[0].oidcConfig.includes('fixture-secret'), false)
  })
  await t.test('OIDC rejects wrong issuer, wrong signature, expiration and uncorrelated state', async () => {
    for (const invalid of ['issuer', 'signature', 'expired']) {
      mode = invalid; const login = await oidcLogin(); assert.equal(await session(login.jar), null, invalid)
    }
    mode = 'valid'
    const unknown = await fetch(`${appOrigin}/api/auth/sso/callback/${providerId}?code=untrusted&state=untrusted`, { redirect: 'manual' })
    assert.equal(unknown.headers.getSetCookie().some(value => value.startsWith('better-auth.session_token=')), false)
  })
  await t.test('SAML signs an actual assertion, validates the SP request, and rejects replay/tampering', async () => {
    mode = 'valid'
    const login = await samlLogin()
    assert.equal(login.callback.headers.get('location'), `${appOrigin}/signed-in`, await login.callback.clone().text())
    const signedIn = await session(login.jar); assert.ok(signedIn)
    const proof = (await pool.query('select "enterpriseProviderId","enterpriseDirectoryUserId" from session where id=$1', [signedIn.session.id])).rows[0]
    assert.equal(proof.enterpriseProviderId, samlProviderId); assert.equal(proof.enterpriseDirectoryUserId, samlDirectoryId)
    const before = Number((await pool.query('select count(*) from session where "enterpriseProviderId"=$1', [samlProviderId])).rows[0].count)
    await login.send()
    assert.equal(Number((await pool.query('select count(*) from session where "enterpriseProviderId"=$1', [samlProviderId])).rows[0].count), before)
    for (const invalid of ['tampered', 'request']) { mode = invalid; const denied = await samlLogin(); assert.equal(await session(denied.jar), null, invalid) }
    mode = 'valid'
    const logout = await fetch(`${appOrigin}/api/auth/sign-out`, { method: 'POST', headers: { origin: appOrigin, cookie: login.jar.header(), 'content-type': 'application/json' }, body: '{}' })
    login.jar.take(logout); assert.equal(await session(login.jar), null)
  })
  await t.test('SCIM Groups are connection-scoped directory data and cannot grant workspace membership', async () => {
    const created = await requestScim('Groups', 'POST', { schemas: [SCIM_GROUP], externalId: 'engineering', displayName: 'Engineering', members: [{ value: directoryId }] })
    assert.equal(created.status, 201); const group = await created.json()
    const cross = await requestScim('Groups', 'POST', { schemas: [SCIM_GROUP], displayName: 'Other tenant', members: [{ value: directoryId }] }, otherConnectionId, otherBearer)
    assert.equal(cross.status, 400)
    assert.equal((await pool.query('select count(*) from mikka_workspace_members where "userId"=$1', [userId])).rows[0].count, '0')
    const patch = await requestScim(`Groups/${group.id}`, 'PATCH', { schemas: [SCIM_PATCH], Operations: [{ op: 'remove', path: `members[value eq "${directoryId}"]` }] })
    assert.equal(patch.status, 200); assert.equal((await patch.json()).members.length, 0)
    assert.equal((await requestScim(`Groups/${group.id}`, 'DELETE')).status, 204)
  })
  await t.test('SCIM disable revokes two organization workspaces and PATs while retaining personal/other organization identity', async () => {
    const wsA = randomUUID(), wsB = randomUUID(), personal = randomUUID(), other = randomUUID()
    for (const [id, kind, org] of [[wsA, 'team', organizationId], [wsB, 'team', organizationId], [personal, 'personal', null], [other, 'team', otherOrganizationId]]) {
      await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Scoped identity fixture\',$3)', [id, userId, kind])
      await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Directory user\',$3,\'member\',\'active\')', [id, userId, email])
      if (org) await pool.query('insert into mikka_organization_workspaces ("workspaceId","organizationId") values ($1,$2)', [id, org])
    }
    await pool.query('insert into enterprise_org_policy ("organizationId","enforceSso","allowMachineCredentials") values ($1,true,false)', [organizationId])
    const signedIn = await session(oidcCookies); assert.ok(signedIn)
    const principal = { kind: 'session' as const, sessionId: signedIn.session.id }
    assert.equal(await enterpriseWorkspaceAllowed(userId, wsA, principal), true)
    assert.equal(await enterpriseWorkspaceAllowed(userId, wsB, principal), true)
    assert.equal(await enterpriseWorkspaceAllowed(userId, personal, { kind: 'session', sessionId: 'wrong' }), true)
    const tokenA = randomUUID(), tokenOther = randomUUID()
    for (const [id, workspaceId] of [[tokenA, wsA], [tokenOther, other]]) await pool.query('insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint) values ($1,$2,$3,\'Fixture\',$4,\'test\')', [id, userId, workspaceId, identityTokenHash(randomUUID())])
    assert.equal(await enterpriseWorkspaceAllowed(userId, wsA, { kind: 'pat', tokenId: tokenA, workspaceId: wsA }), false)
    await pool.query('update enterprise_org_policy set "allowMachineCredentials"=true where "organizationId"=$1', [organizationId])
    assert.equal(await enterpriseWorkspaceAllowed(userId, wsA, { kind: 'pat', tokenId: tokenA, workspaceId: wsA }), true)
    const current = await requestScim(`Users/${directoryId}`)
    const invalidEtag = await requestScim(`Users/${directoryId}`, 'PATCH', { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] }, connectionId, bearer, { 'if-match': 'W/"0"' })
    assert.equal(invalidEtag.status, 412)
    const disabled = await requestScim(`Users/${directoryId}`, 'PATCH', { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] }, connectionId, bearer, { 'if-match': current.headers.get('etag')! })
    assert.equal(disabled.status, 200, await disabled.clone().text())
    for (const id of [wsA, wsB]) assert.equal(await enterpriseWorkspaceAllowed(userId, id, principal), false)
    assert.equal(await enterpriseWorkspaceAllowed(userId, personal, principal), true)
    assert.equal(await enterpriseWorkspaceAllowed(userId, other, principal), true)
    const memberships = (await pool.query('select "workspaceId",status from mikka_workspace_members where "userId"=$1', [userId])).rows
    assert.equal(memberships.find(row => row.workspaceId === wsA).status, 'suspended')
    assert.equal(memberships.find(row => row.workspaceId === wsB).status, 'suspended')
    assert.equal(memberships.find(row => row.workspaceId === personal).status, 'active')
    assert.equal(memberships.find(row => row.workspaceId === other).status, 'active')
    assert.ok((await pool.query('select "revokedAt" from personal_access_tokens where id=$1', [tokenA])).rows[0].revokedAt)
    assert.equal((await pool.query('select "revokedAt" from personal_access_tokens where id=$1', [tokenOther])).rows[0].revokedAt, null)
    assert.equal((await session(oidcCookies))?.user.id, userId, 'the person can still access their personal account')
    const denied = await oidcLogin(); assert.equal(await session(denied.jar), null)
    assert.equal((await requestScim(`Users/${directoryId}`, 'DELETE')).status, 204)
    assert.equal((await requestScim(`Users/${directoryId}`, 'DELETE')).status, 204)
    assert.equal((await requestScim(`Users/${directoryId}`)).status, 404)
    assert.ok((await pool.query('select id from "user" where id=$1', [userId])).rows[0])
    assert.ok(Number((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'scim.user_suspended\'', [organizationId])).rows[0].count) >= 1)
  })
})
