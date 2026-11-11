import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID, generateKeyPairSync, sign, createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { inflateRawSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { enterprisePrincipal } from './principal'
import { Pool } from 'pg'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { createScimHandler } from './scim-http'
import { ScimStore, identityTokenHash } from './scim-store'
import { SCIM_GROUP, SCIM_PATCH, SCIM_USER } from './scim-protocol'
import { completeEnterpriseSignIn, enterpriseIdentityModels, enterpriseSessionFields, enterpriseSso, encryptSsoConfig, ssoSessionData, withEnterpriseAuthRequest } from './sso-plugin'
import { samlSpMetadata, samlSpSigningInput } from './saml-signing'
import { discoverEnterpriseOidcConfig } from './oidc-config'

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
function redirectSamlRequest(url: URL) {
  const raw = url.search.slice(1).split('&')
  return { query: Object.fromEntries(url.searchParams), octetString: ['SAMLRequest', 'SAMLResponse', 'RelayState', 'SigAlg'].flatMap(key => raw.filter(part => part.startsWith(`${key}=`))).join('&') }
}
class Cookies {
  values = new Map<string, string>()
  take(response: Response) { for (const entry of response.headers.getSetCookie()) { const [pair] = entry.split(';'); const at = pair.indexOf('='); this.values.set(pair.slice(0, at), pair.slice(at + 1)) } }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ') }
}

test('enterprise HTTP fixture: OIDC + signed SAML + SCIM lifecycle + scoped revocation', { skip: !target, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: target, max: 4 })
  // Native HTTP uses the production API request adapters, as the mobile DB fixture does.
  const requestContext = await import('../../apps/api/src/context')
  t.mock.module('next/headers', { namedExports: await import('../../apps/api/compat/headers') })
  t.mock.module('next-intl/server', { namedExports: await import('../../apps/api/compat/intl') })
  async function withMobileRequest<T>(request: Request, work: () => Promise<T>) {
    const scope = requestContext.createRequestScope(request)
    try { return await requestContext.runRequestScope(scope, work) }
    finally { await scope.after.finish() }
  }
  const previousKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  const organizationId = randomUUID(), connectionId = randomUUID(), samlConnectionId = randomUUID(), otherConnectionId = randomUUID()
  const otherOrganizationId = randomUUID(), adminId = randomUUID()
  const providerId = `enterprise-oidc-${randomBytes(5).toString('hex')}`, samlProviderId = `enterprise-saml-${randomBytes(5).toString('hex')}`, otherProviderId = `enterprise-other-${randomBytes(5).toString('hex')}`
  const fixtureId = randomBytes(6).toString('hex')
  const oidcDomain = `oidc-${fixtureId}.example.invalid`, samlDomain = `saml-${fixtureId}.example.invalid`, otherDomain = `other-${fixtureId}.example.invalid`
  const email = `${randomUUID()}@${oidcDomain}`, subject = `subject-${randomUUID()}`
  const samlSubject = `${randomUUID()}@${samlDomain}`
  let samlIdentity = samlSubject
  const bearer = `msc_${randomBytes(32).toString('base64url')}`, samlBearer = `msc_${randomBytes(32).toString('base64url')}`, otherBearer = `msc_${randomBytes(32).toString('base64url')}`
  const { synchronizeDirectoryUser, auditDirectoryGroup } = await import('./lifecycle')
  const { enterpriseWorkspaceAllowed } = await import('./access')
  let failNextUserDelivery = false, failNextGroupDelivery = false
  const scimStore = new ScimStore(pool, async change => {
    if (failNextUserDelivery) { failNextUserDelivery = false; throw new Error('Fixture delivery unavailable') }
    await synchronizeDirectoryUser(change)
  }, async (connection, groupId, eventId) => {
    if (failNextGroupDelivery) { failNextGroupDelivery = false; throw new Error('Fixture delivery unavailable') }
    await auditDirectoryGroup(connection, groupId, eventId)
  })
  const scim = createScimHandler(scimStore)
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' }
  const codes = new Map<string, { redirect: string; challenge: string; mode: string; subject: string; email: string }>()
  const upstreamSessions = new Set<string>()
  let discoveryMode: 'valid' | 'issuer' | 'private' | 'missing-logout' = 'valid'
  let upstreamLogoutUnavailable = false
  let upstreamLogoutRequests = 0
  let oidcIdentity = { subject, email }
  let mode = 'valid'
  let idpOrigin = '', appOrigin = ''
  let samlIdp: {
    createLoginResponse: (...args: unknown[]) => Promise<{ context: string }>
    createLogoutResponse: (...args: unknown[]) => { context: string }
    createLogoutRequest: (...args: unknown[]) => { context: string; id: string }
    parseLoginRequest: (...args: unknown[]) => Promise<unknown>
    parseLogoutRequest: (...args: unknown[]) => Promise<unknown>
    parseLogoutResponse: (...args: unknown[]) => Promise<unknown>
  }
  let samlSp: { getMetadata(): string }
  const idpServer = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url!, idpOrigin)
      const upstreamSession = /(?:^|;\s*)fixture_idp=([A-Za-z0-9_-]+)(?:;|$)/.exec(incoming.headers.cookie ?? '')?.[1]
      if (url.pathname === '/.well-known/openid-configuration') {
        outgoing.setHeader('content-type', 'application/json')
        outgoing.end(JSON.stringify({ issuer: discoveryMode === 'issuer' ? 'https://wrong.example.invalid' : idpOrigin,
          authorization_endpoint: `${idpOrigin}/authorize`, token_endpoint: `${idpOrigin}/token`, jwks_uri: `${idpOrigin}/jwks`,
          token_endpoint_auth_methods_supported: ['client_secret_post'], scopes_supported: ['openid', 'email', 'profile'],
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
          ...(discoveryMode === 'missing-logout' ? {} : { end_session_endpoint: discoveryMode === 'private' ? 'http://169.254.169.254/logout' : `${idpOrigin}/oidc-logout` }) }))
        return
      }
      if (url.pathname === '/upstream-session') {
        outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ active: Boolean(upstreamSession && upstreamSessions.has(upstreamSession)) })); return
      }
      if (url.pathname === '/oidc-logout') {
        upstreamLogoutRequests++
        if (upstreamLogoutUnavailable) { outgoing.writeHead(503); outgoing.end(); return }
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const params = incoming.method === 'POST' ? new URLSearchParams(Buffer.concat(chunks).toString()) : url.searchParams
        assert.equal(params.get('client_id'), 'mikka-fixture')
        assert.equal(params.get('post_logout_redirect_uri'), `${appOrigin}/api/auth/sso/oidc/logout/callback/${providerId}`)
        assert.match(params.get('state') ?? '', /^[A-Za-z0-9_-]{43}$/)
        for (const forbidden of ['id_token_hint', 'logout_hint', 'client_secret']) assert.equal(params.has(forbidden), false)
        // RP-Initiated Logout requires the OP to confirm a request without an ID
        // token hint. This fixture confirms via an actual second HTTP request.
        if (incoming.method === 'GET') {
          outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ confirmationRequired: true })); return
        }
        const returned = new URL(params.get('post_logout_redirect_uri')!)
        returned.searchParams.set('state', params.get('state')!)
        if (params.get('confirm') === 'yes') {
          if (upstreamSession) upstreamSessions.delete(upstreamSession)
          outgoing.setHeader('set-cookie', 'fixture_idp=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
        } else returned.searchParams.set('error', 'access_denied')
        outgoing.writeHead(302, { location: returned.href }); outgoing.end(); return
      }
      if (url.pathname === '/authorize') {
        if (!upstreamSession || !upstreamSessions.has(upstreamSession)) {
          const next = randomBytes(24).toString('base64url'); upstreamSessions.add(next)
          outgoing.setHeader('set-cookie', `fixture_idp=${next}; Path=/; HttpOnly; SameSite=Lax`)
        }
        const code = randomUUID()
        codes.set(code, { redirect: url.searchParams.get('redirect_uri')!, challenge: url.searchParams.get('code_challenge')!, mode, ...oidcIdentity })
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
          aud: 'mikka-fixture', sub: grant.subject, email: grant.email, email_verified: true, name: 'Enterprise fixture', iat: now,
          exp: grant.mode === 'expired' ? now - 3600 : now + 300 })).toString('base64url')
        const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), grant.mode === 'signature' ? wrongKeys.privateKey : keys.privateKey).toString('base64url')
        outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ access_token: randomBytes(24).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: `${header}.${claims}.${signature}` })); return
      }
      if (url.pathname === '/saml') {
        await samlIdp.parseLoginRequest(samlSp, 'redirect', redirectSamlRequest(url))
        const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString()
        const id = /\bID="([^"]+)"/.exec(xml)?.[1]
        assert.ok(id)
        const requestId = mode === 'request' ? `wrong-${randomUUID()}` : id
        // samlify's default IdP template omits AuthnStatement. Sign a real,
        // distinct SessionIndex on every login so SLO can select one root.
        const response = await samlIdp.createLoginResponse(samlSp, { extract: { request: { id: requestId } } }, 'post', { email: samlIdentity }, {
          customTagReplacement: (template: string) => {
            const responseId = `_${randomUUID()}`, now = new Date().toISOString(), expires = new Date(Date.now() + 300_000).toISOString()
            const acs = `${appOrigin}/api/auth/sso/saml2/sp/acs/${samlProviderId}`
            const authn = '<saml:AuthnStatement AuthnInstant="{IssueInstant}" SessionIndex="{ID}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>'
            return { id: responseId, context: saml.SamlLib.replaceTagsByValue(template.replace('{AuthnStatement}', authn), {
              ID: responseId, AssertionID: `_${randomUUID()}`, Destination: acs, Audience: `${appOrigin}/saml-sp`,
              EntityID: `${appOrigin}/saml-sp`, Issuer: `${idpOrigin}/saml-idp`, IssueInstant: now,
              SubjectRecipient: acs, AssertionConsumerServiceURL: acs, StatusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
              ConditionsNotBefore: now, ConditionsNotOnOrAfter: expires, SubjectConfirmationDataNotOnOrAfter: expires,
              NameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', NameID: samlIdentity,
              InResponseTo: requestId, AttributeStatement: '',
            }) }
          },
        })
        let encoded = response.context
        if (mode === 'tampered') encoded = Buffer.from(Buffer.from(encoded, 'base64').toString().replace(samlSubject, 'attacker@example.invalid')).toString('base64')
        outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ SAMLResponse: encoded, RelayState: url.searchParams.get('RelayState') })); return
      }
      if (url.pathname === '/saml-logout') {
        const parsed = await samlIdp.parseLogoutRequest(samlSp, 'redirect', redirectSamlRequest(url))
        const response = samlIdp.createLogoutResponse(samlSp, parsed, 'post', url.searchParams.get('RelayState') ?? '')
        assert.match(Buffer.from(response.context, 'base64').toString(), /SignatureValue/)
        outgoing.setHeader('content-type', 'application/json'); outgoing.end(JSON.stringify({ SAMLResponse: response.context, RelayState: url.searchParams.get('RelayState') })); return
      }
      outgoing.writeHead(404); outgoing.end()
    } catch (error) { outgoing.writeHead(500); outgoing.end(error instanceof Error ? /^[A-Z][A-Z0-9_]{1,99}$/.exec(error.message)?.[0] ?? error.name : 'FixtureError') }
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
      const governance = /^\/api\/workspaces\/([^/]+)\/governance(\/usage)?$/.exec(url.pathname)
      const mobileDetail = /^\/api\/mobile\/tasks\/([^/]+)$/.exec(url.pathname)
      const organizationIdentity = /^\/api\/organizations\/([^/]+)\/identity$/.exec(url.pathname)
      let response: Response
      if (resource) response = await scim(request, resource[1], resource[2]?.split('/') ?? [])
      else if (governance) {
        const context = { params: Promise.resolve({ workspaceId: governance[1] }) }
        if (governance[2]) response = await (await import('../../app/api/workspaces/[workspaceId]/governance/usage/route')).GET(request, context)
        else {
          const route = await import('../../app/api/workspaces/[workspaceId]/governance/route')
          response = request.method === 'GET' ? await route.GET(request, context) : await route.POST(request, context)
        }
      } else if (organizationIdentity && ['GET', 'POST'].includes(request.method)) {
        response = await withMobileRequest(request, async () => {
          const route = await import('../../app/api/organizations/[organizationId]/identity/route')
          const context = { params: Promise.resolve({ organizationId: organizationIdentity[1] }) }
          return request.method === 'GET' ? route.GET(request, context) : route.POST(request, context)
        })
      } else if (mobileDetail && request.method === 'GET') {
        response = await withMobileRequest(request, async () =>
          (await import('../../app/api/mobile/tasks/[id]/route')).GET(request, { params: Promise.resolve({ id: mobileDetail[1] }) }))
      } else if (url.pathname === '/api/web/begin') response = await (await import('../../app/api/web/begin/route')).POST(request)
      else if (url.pathname === '/api/web/return') response = await (await import('../../app/api/web/return/route')).GET(request)
      else if (url.pathname === '/api/web/exchange') response = await (await import('../../app/api/web/exchange/route')).POST(request)
      else if (url.pathname === '/api/live/ticket') response = await (await import('../../app/api/live/ticket/route')).GET(request)
      else if (url.pathname === '/api/enterprise/logout-target') response = await (await import('../../app/api/enterprise/logout-target/route')).GET(request)
      else if (url.pathname === '/api/account/deletion') response = await (await import('../../app/api/account/deletion/route')).POST(request)
      else if (url.pathname === '/api/mobile/push-tokens') {
        const route = await import('../../app/api/mobile/push-tokens/route')
        response = request.method === 'POST' ? await route.POST(request) : await route.DELETE(request)
      }
      else response = await handler(request)
      outgoing.writeHead(response.status, { ...Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie')), 'set-cookie': response.headers.getSetCookie() })
      outgoing.end(await response.text())
    } catch (error) { outgoing.writeHead(500); outgoing.end(error instanceof Error ? error.name : 'FixtureError') }
  })
  appOrigin = await listen(appServer)
  const auth = betterAuth({ database: pool, baseURL: appOrigin, basePath: '/api/auth', secret: randomBytes(32).toString('hex'),
    trustedOrigins: [appOrigin, idpOrigin], plugins: [enterpriseIdentityModels, enterpriseSso()],
    account: { encryptOAuthTokens: true, accountLinking: { trustedProviders: [] } }, rateLimit: { enabled: false },
    session: { storeSessionInDatabase: true, additionalFields: enterpriseSessionFields },
    databaseHooks: {
      session: {
      create: { before: async session => ({ data: { ...session, ...ssoSessionData(session.userId) } }) },
      delete: { after: async session => { (await import('./live-authority')).scheduleSessionLiveRevocation(session.userId) } },
    },
      account: { create: { before: async account => ({ data: { ...account, idToken: null } }) }, update: { before: async account => ({ data: { ...account, idToken: null } }) } },
    },
    hooks: { after: createAuthMiddleware(completeEnterpriseSignIn) },
    advanced: { database: { validateSchema: false }, useSecureCookies: false }, logger: { disabled: true },
  })
  handler = withEnterpriseAuthRequest(auth.handler)
  const fixtureDir = mkdtempSync(join(tmpdir(), 'mikka-saml-fixture-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixtureDir, 'key.pem'), '-out', join(fixtureDir, 'cert.pem'), '-days', '1', '-subj', '/CN=enterprise-fixture'], { stdio: 'ignore' })
  const privateKey = readFileSync(join(fixtureDir, 'key.pem'), 'utf8'), cert = readFileSync(join(fixtureDir, 'cert.pem'), 'utf8')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixtureDir, 'sp-key.pem'), '-out', join(fixtureDir, 'sp-cert.pem'), '-days', '1', '-subj', '/CN=enterprise-sp-fixture'], { stdio: 'ignore' })
  const spPrivateKey = readFileSync(join(fixtureDir, 'sp-key.pem'), 'utf8'), spCert = readFileSync(join(fixtureDir, 'sp-cert.pem'), 'utf8')
  assert.equal(samlSpSigningInput.safeParse({ cert: spCert, privateKey }).success, false, 'a different private key cannot configure SP signing')
  const require = createRequire(import.meta.url)
  const saml = createRequire(require.resolve('@better-auth/sso'))('samlify')
  const samlIssuer = `${appOrigin}/saml-sp`
  samlIdp = saml.IdentityProvider({ entityID: `${idpOrigin}/saml-idp`, privateKey, signingCert: cert,
    wantAuthnRequestsSigned: true, wantLogoutRequestSigned: true, wantLogoutResponseSigned: true,
    singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: `${idpOrigin}/saml` }],
    singleLogoutService: ['HTTP-Redirect', 'HTTP-POST'].map(binding => ({ Binding: `urn:oasis:names:tc:SAML:2.0:bindings:${binding}`, Location: `${idpOrigin}/saml-logout` })) })
  samlSp = saml.ServiceProvider({ metadata: samlSpMetadata({ issuer: samlIssuer, signing: { cert: spCert, privateKey: spPrivateKey },
    acsUrl: `${appOrigin}/api/auth/sso/saml2/sp/acs/${samlProviderId}`, sloUrl: `${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}` }),
    wantLogoutRequestSigned: true, wantLogoutResponseSigned: true })
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
  const oidcConfig = { ...await discoverEnterpriseOidcConfig(idpOrigin, 'client_secret_post'), pkce: true,
    clientId: 'mikka-fixture', clientSecret: 'fixture-secret', scopes: ['openid', 'email', 'profile'] }
  for (const [pid, org, config, protocol, host] of [
    [providerId, organizationId, oidcConfig, 'oidc', oidcDomain],
    [otherProviderId, otherOrganizationId, oidcConfig, 'oidc', otherDomain],
    [samlProviderId, organizationId, { issuer: samlIssuer, audience: samlIssuer, entryPoint: `${idpOrigin}/saml`, cert,
      wantAssertionsSigned: true, authnRequestsSigned: true, spMetadata: { metadata: samlSp.getMetadata(), privateKey: spPrivateKey },
      idpMetadata: { entityID: `${idpOrigin}/saml-idp`, cert,
        singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: `${idpOrigin}/saml` }],
        singleLogoutService: ['HTTP-Redirect', 'HTTP-POST'].map(binding => ({ Binding: `urn:oasis:names:tc:SAML:2.0:bindings:${binding}`, Location: `${idpOrigin}/saml-logout` })) } }, 'saml', samlDomain],
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
  async function oidcLogin(jar = new Cookies(), upstream = new Cookies()) {
    const { url } = await startSso(providerId, jar)
    const consent = await fetch(url, { headers: { cookie: upstream.header() }, redirect: 'manual' }); upstream.take(consent)
    const callback = await fetch(consent.headers.get('location')!, { headers: { cookie: jar.header() }, redirect: 'manual' })
    jar.take(callback)
    return { callback, jar, upstream }
  }
  async function samlLogin(nameID = samlSubject) {
    const { url, jar } = await startSso(samlProviderId)
    const previousIdentity = samlIdentity
    let assertion: Response
    try { samlIdentity = nameID; assertion = await fetch(url) } finally { samlIdentity = previousIdentity }
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
  const logoutTarget = (headers: HeadersInit, query = '') => fetch(`${appOrigin}/api/enterprise/logout-target${query}`, { headers, redirect: 'manual' })
  const logoutTargetFor = (token: string) => logoutTarget({ authorization: `Bearer ${token}` })
  async function applicationCookie(token: string) {
    const { auth: applicationAuth } = await import('../auth')
    const current = await applicationAuth.$context
    const signature = createHmac('sha256', current.secret).update(token).digest('base64')
    return `${current.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`
  }
  async function assertLogoutTarget(response: Response, target: { providerId: string; protocol: 'oidc' | 'saml' } | null) {
    assert.equal(response.status, 200, await response.clone().text())
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/)
    assert.equal(response.headers.has('set-cookie'), false)
    assert.deepEqual(await response.json(), { target }, 'only the current provider ID and protocol leave the server')
  }
  async function startOidcLogout(jar: Cookies, pid = providerId, body: Record<string, unknown> = {}, origin = appOrigin) {
    const response = await fetch(`${appOrigin}/api/auth/sso/oidc/logout/${pid}`, { method: 'POST',
      headers: { origin, cookie: jar.header(), 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' })
    jar.take(response); return response
  }
  async function pendingLogout() {
    const login = await oidcLogin(), active = await session(login.jar); assert.ok(active)
    const started = await startOidcLogout(login.jar)
    assert.equal(started.status, 200, await started.clone().text())
    const result = await started.json() as { url: string; localSessionRevoked: boolean; upstream: string }
    assert.equal(result.localSessionRevoked, true); assert.equal(result.upstream, 'requested')
    const endpoint = new URL(result.url), state = endpoint.searchParams.get('state')!
    const callback = new URL(endpoint.searchParams.get('post_logout_redirect_uri')!); callback.searchParams.set('state', state)
    const identifier = `enterprise-oidc-logout:${providerId}:${identityTokenHash(state)}`
    return { ...login, originalSessionId: active.session.id, endpoint, callback, identifier }
  }
  async function webHandoffFixture() {
    const saved = Object.fromEntries(['MIKKA_EDITION', 'MIKKA_OFFICIAL_WEB_URL', 'VERCEL', 'DEVICE_GATEWAY_URL', 'BETTER_AUTH_SECRET'].map(key => [key, process.env[key]]))
    const { auth: applicationAuth } = await import('../auth')
    const applicationContext = await applicationAuth.$context
    process.env.MIKKA_EDITION = 'community'
    process.env.MIKKA_OFFICIAL_WEB_URL = 'https://official-web.example.invalid/mikka'
    process.env.BETTER_AUTH_SECRET = applicationContext.secret
    delete process.env.VERCEL
    delete process.env.DEVICE_GATEWAY_URL
    const { challengeFor } = await import('../desktop-auth-server')
    const { webAuthStateHash } = await import('../web-connection/auth-server')
    const official = process.env.MIKKA_OFFICIAL_WEB_URL, callback = `${official}/api/web/complete`
    const sessions: string[] = [], states: string[] = []
    async function request(token: string) {
      const state = randomBytes(24).toString('base64url'), verifier = randomBytes(32).toString('base64url')
      states.push(webAuthStateHash(state))
      const post = (path: string, value: unknown) => fetch(`${appOrigin}${path}`, { method: 'POST', headers: {
        origin: new URL(official).origin, 'content-type': 'application/json',
      }, body: JSON.stringify(value), redirect: 'manual' })
      assert.equal((await post('/api/web/begin', { state, challenge: challengeFor(verifier), callback })).status, 200)
      // Real source token, application cookie signature and native verifier; no mocked auth.
      const signature = createHmac('sha256', applicationContext.secret).update(token).digest('base64')
      const cookie = `${applicationContext.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`
      const bound = await fetch(`${appOrigin}/api/web/return?${new URLSearchParams({ state, callback })}`, { headers: {
        cookie, 'sec-fetch-site': 'same-origin', referer: `${appOrigin}/sign-in`,
      }, redirect: 'manual' })
      assert.equal(bound.status, 303)
      const returned = new URL(bound.headers.get('location')!)
      assert.equal(returned.origin + returned.pathname, callback)
      const code = new URLSearchParams(returned.hash.slice(1)).get('code'); assert.ok(code)
      const exchanged = await post('/api/web/exchange', { state, verifier, code, callback,
        enterpriseOrganizationId: otherOrganizationId, enterpriseProviderId: otherProviderId, enterpriseIdentityId: randomUUID() })
      if (exchanged.status === 200) sessions.push(((await exchanged.clone().json()) as { session: { id: string } }).session.id)
      return exchanged
    }
    async function handoff(token: string) {
      const exchanged = await request(token)
      assert.equal(exchanged.status, 200)
      const result = await exchanged.json() as { token: string; session: { id: string } }
      assert.ok(result.token !== token, 'handoff issues an independent bearer')
      assert.equal(exchanged.headers.has('set-cookie'), false)
      return result
    }
    return { applicationContext, sessions, request, handoff, close: async () => {
      await pool.query('delete from desktop_auth_requests where "stateHash"=any($1::text[])', [states])
      await pool.query('delete from session where id=any($1::text[])', [sessions])
      const { builtinGateway } = await import('../builtin-gateway/runtime')
      await builtinGateway()?.stop()
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    } }
  }
  async function cacheNamespace(token: string, workspaceId: string) {
    const { getApiSession } = await import('../api-auth')
    const { authorizedCacheWorkspace } = await import('../swr/cache-scope')
    const active = await getApiSession({ headers: new Headers({ authorization: `Bearer ${token}` }), query: { disableCookieCache: true } })
    assert.ok(active)
    return authorizedCacheWorkspace({ id: active.user.id, [enterprisePrincipal]: { kind: 'session', sessionId: active.session.id } }, workspaceId)
  }
  async function phoneFixture(context: TestContext, workspaceId: string) {
    type Push = { to: string; title: string; body: string; data: { userId: string; botId: string; workspaceId?: string; issueId?: string; runId?: string } }
    const botId = randomUUID(), tokens: string[] = [], receipts: string[] = [], sent: Push[][] = [], failures: unknown[] = []
    await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,\'Enterprise phone fixture\')', [botId, userId, workspaceId])
    // Only external delivery and Workflow execution are intercepted. Native
    // session authentication, token registration, tenant checks and receipts
    // all use the production handlers and real PostgreSQL rows.
    const receiptWorkflow = async () => { throw new Error('unexpected_fixture_workflow_execution') }
    const workflow = context.mock.module(new URL('../../workflows/phone-push-receipts/workflow.ts', import.meta.url).href,
      { namedExports: { phonePushReceipts: receiptWorkflow } })
    const wake = context.mock.module('workflow/api', { namedExports: { start: async (work: unknown, args: unknown[]) => {
      try {
        assert.equal(work, receiptWorkflow)
        assert.equal(args.length, 1)
        const id = String(args[0]); assert.match(id, /^[0-9a-f-]{36}$/)
        receipts.push(id)
        // The delivery is still inside its APP transaction. Reuse its pinned
        // connection rather than asking the independent observer to see an
        // uncommitted receipt.
        const { pool: applicationPool } = await import('../db')
        assert.equal((await applicationPool.query('select id from mobile_push_receipts where id=$1 and user_id=$2', [id, userId])).rowCount, 1)
      } catch (error) { failures.push(error); throw error }
    } } })
    const originalFetch = globalThis.fetch
    const provider = context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== 'https://exp.host/--/api/v2/push/send') {
        if ([appOrigin, idpOrigin].includes(new URL(url).origin)) return originalFetch(input, init)
        const error = new Error('unexpected_phone_fixture_network'); failures.push(error); throw error
      }
      try {
        assert.equal(init?.method, 'POST')
        const payload = JSON.parse(String(init?.body)) as Push[]
        assert.ok(Array.isArray(payload) && payload.length > 0)
        for (const item of payload) {
          assert.ok(tokens.includes(item.to))
          assert.equal(item.data.userId, userId); assert.equal(item.data.botId, botId)
          assert.equal(item.body, 'Isolated enterprise reply')
        }
        sent.push(payload)
        return Response.json({ data: payload.map(() => ({ status: 'ok', id: randomUUID() })) })
      } catch (error) { failures.push(error); throw error }
    })
    let closed = false
    async function closeFixture() {
      if (closed) return
      closed = true
      provider.mock.restore(); wake.restore(); workflow.restore()
      await pool.query('delete from mobile_push_tokens where token=any($1::text[])', [tokens])
      await pool.query('delete from mobile_push_receipts where id=any($1::uuid[])', [receipts])
      await pool.query('delete from bots where id=$1', [botId])
      assert.equal(failures.length, 0, 'no unexpected external call or swallowed fixture assertion')
    }
    context.after(closeFixture)
    return {
      register: async (bearerToken: string, sessionId: string) => {
        const token = 'ExpoPushToken[' + randomUUID().replaceAll('-', '') + ']'; tokens.push(token)
        const registered = await fetch(appOrigin + '/api/mobile/push-tokens', { method: 'POST',
          headers: { authorization: 'Bearer ' + bearerToken, 'content-type': 'application/json' },
          body: JSON.stringify({ token, platform: 'ios', deviceName: 'Isolated enterprise fixture' }) })
        assert.equal(registered.status, 200)
        assert.equal((await pool.query('select "sessionId" from mobile_push_tokens where token=$1 and "userId"=$2', [token, userId])).rows[0]?.sessionId, sessionId)
        return token
      },
      push: async (task: { issueId: string; runId: string | null } | null = null) => {
        const offset = sent.length, oldEdition = process.env.MIKKA_EDITION
        process.env.MIKKA_EDITION = 'cloud'
        try {
          const { pushReply } = await import('../mobile-push')
          await pushReply(userId, botId, 'Isolated enterprise reply', task ? ['review'] : ['finished'], task)
          if (task) for (const item of sent.slice(offset).flat()) {
            assert.equal(item.data.workspaceId, workspaceId)
            assert.equal(item.data.issueId, task.issueId)
            assert.equal(item.data.runId, task.runId ?? undefined)
          }
          assert.equal(failures.length, 0)
          assert.equal((await pool.query('select count(*)::int as count from mobile_push_receipts where id=any($1::uuid[])', [receipts])).rows[0].count, receipts.length)
          return sent.slice(offset).flatMap(batch => batch.map(item => item.to))
        } finally {
          if (oldEdition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = oldEdition
        }
      },
      close: closeFixture,
    }
  }
  const oidcReturn = (url: URL, jar: Cookies) => fetch(url, { headers: { cookie: jar.header() }, redirect: 'manual' })
  const nonceCount = async (identifier: string) => (await pool.query('select count(*) from verification where identifier=$1', [identifier])).rows[0].count as string
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
    const audit = (await pool.query('select result,"correlationId" from mikka_organization_audit_events where "organizationId"=$1 and action=\'sso.signed_in\' and "targetId"=$2', [organizationId, signedIn!.session.id])).rows[0]
    assert.equal(audit.result, 'success'); assert.match(audit.correlationId, /^[0-9a-f-]{36}$/)
  })
  await t.test('logout target projects the actual OIDC or SAML session for Cookie and native clients without changing it', async () => {
    const oidc = await session(oidcCookies), samlLoginResult = await samlLogin()
    const samlSession = await session(samlLoginResult.jar)
    assert.ok(oidc); assert.ok(samlSession)
    const original = (await pool.query('select id,"enterpriseOrganizationId","enterpriseProviderId","enterpriseIdentityId","enterpriseDirectoryUserId" from session where id=any($1::text[]) order by id', [[oidc.session.id, samlSession.session.id]])).rows
    const oidcToken = (await pool.query('select token from session where id=$1', [oidc.session.id])).rows[0].token as string
    const samlToken = (await pool.query('select token from session where id=$1', [samlSession.session.id])).rows[0].token as string
    const logoutIntents = async () => (await pool.query("select count(*) from verification where identifier like 'enterprise-oidc-logout:%' or identifier like 'saml-logout-request:%'")).rows[0].count
    const intentsBefore = await logoutIntents()
    try {
      await assertLogoutTarget(await logoutTargetFor(oidcToken), { providerId, protocol: 'oidc' })
      await assertLogoutTarget(await logoutTarget({ cookie: await applicationCookie(oidcToken), 'x-mikka-workspace-id': randomUUID() }), { providerId, protocol: 'oidc' })
      await assertLogoutTarget(await logoutTargetFor(samlToken), { providerId: samlProviderId, protocol: 'saml' })
      await assertLogoutTarget(await logoutTarget({ cookie: await applicationCookie(oidcToken), authorization: `Bearer ${samlToken}` }), { providerId: samlProviderId, protocol: 'saml' })
      const exposed = await session(oidcCookies)
      assert.ok(exposed)
      for (const field of ['enterpriseOrganizationId', 'enterpriseProviderId', 'enterpriseIdentityId', 'enterpriseDirectoryUserId']) {
        assert.equal(Object.hasOwn(exposed.session, field), false, 'the native session DTO still hides assurance')
      }
      // The endpoint neither creates an upstream intent nor revokes/rewrites a session.
      assert.deepEqual((await pool.query('select id,"enterpriseOrganizationId","enterpriseProviderId","enterpriseIdentityId","enterpriseDirectoryUserId" from session where id=any($1::text[]) order by id', [[oidc.session.id, samlSession.session.id]])).rows, original)
      assert.equal(await logoutIntents(), intentsBefore)
      assert.equal((await session(samlLoginResult.jar))?.session.id, samlSession.session.id)
      assert.equal((await session(oidcCookies))?.session.id, oidc.session.id)
    } finally { await pool.query('delete from session where id=$1', [samlSession.session.id]) }
  })
  await t.test('logout target rejects PATs and forged or expired sessions and never accepts a caller-selected provider', async () => {
    const { auth: applicationAuth } = await import('../auth')
    const { getApiSession } = await import('../api-auth')
    const native = await applicationAuth.$context
    const ordinary = await native.internalAdapter.createSession(userId); assert.ok(ordinary)
    const revoked = await native.internalAdapter.createSession(userId); assert.ok(revoked)
    const active = await session(oidcCookies); assert.ok(active)
    const token = (await pool.query('select token from session where id=$1', [active.session.id])).rows[0].token as string
    const cookie = await applicationCookie(token)
    const workspaceId = randomUUID(), patId = randomUUID(), pat = `mkp_${randomBytes(32).toString('base64url')}`
    await pool.query('insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,\'Logout target PAT fixture\',\'team\')', [workspaceId, userId])
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,\'Directory user\',$3,\'member\',\'active\')', [workspaceId, userId, email])
    await pool.query('insert into personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint,scopes) values($1,$2,$3,\'Logout target fixture\',$4,\'test\',ARRAY[\'legacy:full\']::text[])', [patId, userId, workspaceId, identityTokenHash(pat)])
    try {
      await assertLogoutTarget(await logoutTargetFor(ordinary.token), null)
      await assertLogoutTarget(await logoutTarget({ authorization: `Bearer ${ordinary.token}`, cookie }), null)
      const verifiedPat = await getApiSession({ headers: new Headers({ authorization: `Bearer ${pat}` }), query: { disableCookieCache: true } })
      assert.equal(verifiedPat?.tokenWorkspaceId, workspaceId, 'the PAT is otherwise real and active')
      const revokedCookie = await applicationCookie(revoked.token)
      await pool.query('delete from session where id=$1', [revoked.id])
      const rejectedHeaders: HeadersInit[] = [
        {}, { authorization: 'Bearer invalid-native-session' },
        { authorization: `Bearer ${revoked.token}` }, { cookie: revokedCookie },
        { authorization: 'Bearer invalid-native-session', cookie },
        { authorization: `Bearer ${pat}` }, { authorization: `Bearer ${pat}`, cookie },
        { cookie: `${native.authCookies.sessionToken.name}=forged-session.signature` },
      ]
      for (const headers of rejectedHeaders) {
        const denied = await logoutTarget(headers)
        assert.equal(denied.status, 403)
        assert.deepEqual(await denied.json(), { error: { code: 'governance_denied', detail: 'access_denied' } })
      }
      for (const query of [`?providerId=${otherProviderId}`, `?organizationId=${otherOrganizationId}`, `?enterpriseIdentityId=${randomUUID()}`]) {
        const denied = await logoutTarget({ authorization: `Bearer ${token}` }, query)
        assert.equal(denied.status, 400)
        assert.deepEqual(await denied.json(), { error: { code: 'governance_denied', detail: 'invalid_request' } })
      }
      const ordinaryCookie = await applicationCookie(ordinary.token)
      await pool.query('update session set "expiresAt"=now()-interval \'1 second\' where id=$1', [ordinary.id])
      assert.equal((await logoutTarget({ cookie: ordinaryCookie })).status, 403, 'cookie cache cannot revive an expired session')
      assert.equal((await logoutTargetFor(ordinary.token)).status, 403)
      assert.equal((await session(oidcCookies))?.session.id, active.session.id, 'denied target discovery does not sign out another session')
    } finally {
      await pool.query('delete from personal_access_tokens where id=$1', [patId])
      await pool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspaceId])
      await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
      await pool.query('delete from session where id=any($1::text[])', [[ordinary.id, revoked.id]])
    }
  })
  await t.test('logout target rechecks identity, provider, directory and archive state on each read', async () => {
    const active = await session(oidcCookies); assert.ok(active)
    const original = (await pool.query('select token,"enterpriseIdentityId" from session where id=$1', [active.session.id])).rows[0]
    const expectTarget = async (valid: boolean) => assertLogoutTarget(await logoutTargetFor(original.token), valid ? { providerId, protocol: 'oidc' } : null)
    await expectTarget(true)
    try {
      await pool.query('update enterprise_identity set "userId"=$2 where id=$1', [original.enterpriseIdentityId, adminId])
      await expectTarget(false)
    } finally { await pool.query('update enterprise_identity set "userId"=$2 where id=$1', [original.enterpriseIdentityId, userId]) }
    await expectTarget(true)
    try {
      await pool.query('update session set "enterpriseOrganizationId"=$2 where id=$1', [active.session.id, otherOrganizationId])
      await expectTarget(false)
    } finally { await pool.query('update session set "enterpriseOrganizationId"=$2 where id=$1', [active.session.id, organizationId]) }
    try {
      await pool.query('update session set "enterpriseProviderId"=$2 where id=$1', [active.session.id, otherProviderId])
      await expectTarget(false)
    } finally { await pool.query('update session set "enterpriseProviderId"=$2 where id=$1', [active.session.id, providerId]) }
    try {
      await pool.query('update enterprise_sso_provider set "domainVerified"=false where "providerId"=$1', [providerId])
      await expectTarget(false)
    } finally { await pool.query('update enterprise_sso_provider set "domainVerified"=true where "providerId"=$1', [providerId]) }
    try {
      await pool.query('update enterprise_scim_user set active=false where id=$1', [directoryId])
      await expectTarget(false)
    } finally { await pool.query('update enterprise_scim_user set active=true where id=$1', [directoryId]) }
    try {
      await pool.query('update enterprise_scim_connection set "revokedAt"=now() where id=$1', [connectionId])
      await expectTarget(false)
    } finally { await pool.query('update enterprise_scim_connection set "revokedAt"=null where id=$1', [connectionId]) }
    try {
      await pool.query('insert into enterprise_org_policy("organizationId","archivedAt") values($1,now())', [organizationId])
      await expectTarget(false)
    } finally { await pool.query('delete from enterprise_org_policy where "organizationId"=$1', [organizationId]) }
    await expectTarget(true)
  })
  await t.test('OIDC rejects wrong issuer, wrong signature, expiration and uncorrelated state', async () => {
    for (const invalid of ['issuer', 'signature', 'expired']) {
      mode = invalid; const login = await oidcLogin(); assert.equal(await session(login.jar), null, invalid)
    }
    mode = 'valid'
    const unknown = await fetch(`${appOrigin}/api/auth/sso/callback/${providerId}?code=untrusted&state=untrusted`, { redirect: 'manual' })
    assert.equal(unknown.headers.getSetCookie().some(value => value.startsWith('better-auth.session_token=')), false)
    assert.ok(Number((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'sso.sign_in_failed\' and result=\'denied\'', [organizationId])).rows[0].count) >= 3)
  })
  await t.test('OIDC discovery retains logout capability from one validated metadata snapshot', async () => {
    try {
      assert.equal(oidcConfig.endSessionEndpoint, `${idpOrigin}/oidc-logout`)
      discoveryMode = 'issuer'; await assert.rejects(discoverEnterpriseOidcConfig(idpOrigin, 'client_secret_post'))
      discoveryMode = 'private'; await assert.rejects(discoverEnterpriseOidcConfig(idpOrigin, 'client_secret_post'))
      discoveryMode = 'missing-logout'; assert.equal((await discoverEnterpriseOidcConfig(idpOrigin, 'client_secret_post')).endSessionEndpoint, undefined)
    } finally { discoveryMode = 'valid' }
  })
  await t.test('OIDC RP-initiated logout revokes locally before confirmed upstream logout without persisting or sending an ID token', async () => {
    const pending = await pendingLogout()
    assert.equal(await session(pending.jar), null)
    assert.equal((await pool.query('select count(*) from session where id=$1', [pending.originalSessionId])).rows[0].count, '0')
    assert.equal(pending.endpoint.searchParams.get('client_id'), 'mikka-fixture')
    for (const forbidden of ['id_token_hint', 'logout_hint', 'client_secret']) assert.equal(pending.endpoint.searchParams.has(forbidden), false)
    const upstreamStatus = () => fetch(`${idpOrigin}/upstream-session`, { headers: { cookie: pending.upstream.header() } }).then(response => response.json())
    assert.deepEqual(await upstreamStatus(), { active: true })
    const confirmation = await fetch(pending.endpoint, { headers: { cookie: pending.upstream.header() } })
    assert.deepEqual(await confirmation.json(), { confirmationRequired: true })
    assert.deepEqual(await upstreamStatus(), { active: true }, 'a client_id-only request requires the OP confirmation step')
    const form = new URLSearchParams(pending.endpoint.search); form.set('confirm', 'yes')
    const finished = await fetch(`${idpOrigin}/oidc-logout`, { method: 'POST', headers: { cookie: pending.upstream.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' })
    pending.upstream.take(finished)
    assert.equal(finished.status, 302); assert.equal(finished.headers.get('location'), pending.callback.href)
    assert.deepEqual(await upstreamStatus(), { active: false })
    const returned = await oidcReturn(pending.callback, pending.jar)
    assert.equal(returned.status, 302); assert.equal(returned.headers.get('location'), `${appOrigin}/sign-in`)
    assert.equal(returned.headers.get('referrer-policy'), 'no-referrer')
    assert.match(returned.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(await nonceCount(pending.identifier), '0')
    assert.equal((await pool.query('select count(*) from account where "providerId"=$1 and "idToken" is not null', [providerId])).rows[0].count, '0')
    const reasons = (await pool.query('select metadata->>\'reason\' as reason from mikka_organization_audit_events where "organizationId"=$1 and "targetId"=$2 and action=\'sso.signed_out\' order by "createdAt"', [organizationId, pending.originalSessionId])).rows.map(row => row.reason)
    assert.deepEqual(reasons, ['oidc_upstream_requested', 'oidc_upstream_returned'])
    assert.equal((await session(oidcCookies))?.user.id, userId, 'the independent OIDC session remains active')
  })
  await t.test('OIDC logout rejects wrong principals, cross-origin starts and client-selected redirects before revoking a session', async () => {
    const login = await oidcLogin(), active = await session(login.jar); assert.ok(active)
    const before = upstreamLogoutRequests
    assert.equal((await startOidcLogout(login.jar, otherProviderId)).status, 403)
    assert.equal((await startOidcLogout(login.jar, providerId, {}, 'https://foreign.example.invalid')).status, 403)
    for (const [input, status] of [
      [{ post_logout_redirect_uri: 'https://foreign.example.invalid' }, 400],
      // Native Origin middleware refuses this callback before strict body parsing.
      [{ callbackURL: '//foreign.example.invalid' }, 403],
      [{ redirectTo: `${appOrigin}/sign-in?next=external` }, 400], [{ client_id: 'other-client' }, 400], [{ id_token_hint: 'untrusted' }, 400],
    ] as const) {
      assert.equal((await startOidcLogout(login.jar, providerId, input)).status, status, Object.keys(input)[0])
    }
    assert.equal((await session(login.jar))?.session.id, active.session.id)
    await pool.query('update session set "enterpriseOrganizationId"=null,"enterpriseProviderId"=null,"enterpriseDirectoryUserId"=null,"enterpriseIdentityId"=null where id=$1', [active.session.id])
    assert.equal((await startOidcLogout(login.jar)).status, 403, 'an ordinary local session has no provider logout authority')
    assert.equal((await session(login.jar))?.session.id, active.session.id)
    assert.equal(upstreamLogoutRequests, before)
  })
  await t.test('OIDC logout callback binds the browser and provider before atomic consumption, preserving a later login', async () => {
    const pending = await pendingLogout()
    assert.equal((await oidcReturn(pending.callback, new Cookies())).status, 400)
    const altered = new Cookies(); altered.values = new Map(pending.jar.values)
    const verifierName = [...altered.values.keys()].find(name => name.includes('enterprise_oidc_logout_'))!
    assert.ok(verifierName); altered.values.set(verifierName, `${altered.values.get(verifierName)!}x`)
    assert.equal((await oidcReturn(pending.callback, altered)).status, 400)
    const another = await pendingLogout()
    assert.equal((await oidcReturn(pending.callback, another.jar)).status, 400, 'another valid browser verifier cannot consume this request')
    const wrongProvider = new URL(pending.callback); wrongProvider.pathname = wrongProvider.pathname.replace(providerId, otherProviderId)
    assert.equal((await oidcReturn(wrongProvider, pending.jar)).status, 400)
    const badState = new URL(pending.callback); badState.searchParams.set('state', randomBytes(32).toString('base64url'))
    assert.equal((await oidcReturn(badState, pending.jar)).status, 400)
    const duplicate = new URL(pending.callback); duplicate.searchParams.append('state', badState.searchParams.get('state')!)
    assert.equal((await oidcReturn(duplicate, pending.jar)).status, 400)
    const missing = new URL(pending.callback); missing.search = ''
    assert.equal((await oidcReturn(missing, pending.jar)).status, 400)
    assert.equal(await nonceCount(pending.identifier), '1', 'invalid returns must not burn the original request')
    const newer = await oidcLogin(), newest = await session(newer.jar); assert.ok(newest)
    newer.jar.values.set(verifierName, pending.jar.values.get(verifierName)!)
    const concurrent = await Promise.all([oidcReturn(pending.callback, newer.jar), oidcReturn(pending.callback, newer.jar)])
    assert.deepEqual(concurrent.map(response => response.status).sort(), [302, 400])
    assert.equal(await nonceCount(pending.identifier), '0')
    for (const response of concurrent) {
      assert.equal(response.headers.getSetCookie().some(cookie => cookie.includes('session_token=') || cookie.includes('session_data=')), false)
      newer.jar.take(response)
    }
    assert.equal((await session(newer.jar))?.session.id, newest.session.id)
    assert.equal((await oidcReturn(pending.callback, newer.jar)).status, 400)
    assert.equal((await session(newer.jar))?.session.id, newest.session.id, 'a successful or replayed old logout must not clear a later session')
  })
  await t.test('OIDC logout expires state and invalidates the prior provider configuration binding', async () => {
    const expired = await pendingLogout()
    await pool.query('update verification set "expiresAt"=now()-interval \'1 second\' where identifier=$1', [expired.identifier])
    assert.equal((await oidcReturn(expired.callback, expired.jar)).status, 400)
    const changed = await pendingLogout()
    const previous = (await pool.query('select "oidcConfig" from enterprise_sso_provider where "providerId"=$1', [providerId])).rows[0].oidcConfig
    try {
      await pool.query('update enterprise_sso_provider set "oidcConfig"=$2 where "providerId"=$1', [providerId, encryptSsoConfig({ ...oidcConfig, clientId: 'replaced-client' }, 'oidcConfig')])
      assert.equal((await oidcReturn(changed.callback, changed.jar)).status, 400)
      assert.equal(await nonceCount(changed.identifier), '1')
    } finally { await pool.query('update enterprise_sso_provider set "oidcConfig"=$2 where "providerId"=$1', [providerId, previous]) }
  })
  await t.test('OIDC local logout survives missing capability, OP outage or cancellation and durable nonce failure', async () => {
    const previous = (await pool.query('select "oidcConfig" from enterprise_sso_provider where "providerId"=$1', [providerId])).rows[0].oidcConfig
    const unsupported = await oidcLogin()
    try {
      const { endSessionEndpoint: _logout, ...withoutLogout } = oidcConfig
      await pool.query('update enterprise_sso_provider set "oidcConfig"=$2 where "providerId"=$1', [providerId, encryptSsoConfig(withoutLogout, 'oidcConfig')])
      const result = await startOidcLogout(unsupported.jar)
      assert.equal(result.status, 200)
      assert.deepEqual(await result.json(), { localSessionRevoked: true, upstream: 'not_supported', url: `${appOrigin}/sign-in` })
      assert.equal(await session(unsupported.jar), null)
    } finally { await pool.query('update enterprise_sso_provider set "oidcConfig"=$2 where "providerId"=$1', [providerId, previous]) }
    const failed = await pendingLogout()
    try {
      upstreamLogoutUnavailable = true
      assert.equal((await fetch(failed.endpoint, { headers: { cookie: failed.upstream.header() } })).status, 503)
      assert.equal(await session(failed.jar), null, 'the provider outage cannot roll back local revocation')
    } finally { upstreamLogoutUnavailable = false }
    const form = new URLSearchParams(failed.endpoint.search); form.set('confirm', 'no')
    const declined = await fetch(`${idpOrigin}/oidc-logout`, { method: 'POST', headers: { cookie: failed.upstream.header(), 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' })
    const returned = await oidcReturn(new URL(declined.headers.get('location')!), failed.jar)
    assert.equal(returned.status, 302); assert.equal(returned.headers.get('location'), `${appOrigin}/sign-in`)
    assert.equal(await session(failed.jar), null)
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where "targetId"=$1 and action=\'sso.logout_failed\' and metadata->>\'reason\'=\'oidc_upstream_failed\' and result=\'failure\'', [failed.originalSessionId])).rows[0].count, '1')
    const unavailable = await oidcLogin(), constraint = `oidc_logout_nonce_${randomUUID().replaceAll('-', '')}`
    await pool.query(`alter table verification add constraint "${constraint}" check (identifier not like 'enterprise-oidc-logout:${providerId}:%') not valid`)
    try {
      const result = await startOidcLogout(unavailable.jar)
      assert.equal(result.status, 200)
      assert.deepEqual(await result.json(), { localSessionRevoked: true, upstream: 'unavailable', url: `${appOrigin}/sign-in` })
      assert.equal(await session(unavailable.jar), null)
    } finally { await pool.query(`alter table verification drop constraint "${constraint}"`) }
  })
  await t.test('OIDC logout audit failure withholds the redirect without restoring the revoked local session', async t => {
    const login = await oidcLogin(), active = await session(login.jar); assert.ok(active)
    const constraint = `oidc_logout_audit_${randomUUID().replaceAll('-', '')}`
    const report = t.mock.method(console, 'error', () => {})
    await pool.query(`alter table mikka_organization_audit_events add constraint "${constraint}" check ("organizationId"<>'${organizationId}'::uuid or action<>'sso.signed_out') not valid`)
    try {
      const refused = await startOidcLogout(login.jar)
      assert.equal(refused.status, 503)
      assert.equal(refused.headers.has('location'), false)
      assert.deepEqual(await refused.json(), { code: 'ENTERPRISE_AUDIT_UNAVAILABLE', message: 'Authentication unavailable' })
      assert.equal((await pool.query('select count(*) from session where id=$1', [active.session.id])).rows[0].count, '0')
      assert.equal(await session(login.jar), null)
      assert.equal(JSON.stringify(report.mock.calls.map(call => call.arguments)).includes('fixture-secret'), false)
    } finally { await pool.query(`alter table mikka_organization_audit_events drop constraint "${constraint}"`) }
  })
  await t.test('OIDC logout cannot claim local revocation or request the OP when native session deletion fails', async t => {
    const login = await oidcLogin(), active = await session(login.jar); assert.ok(active)
    const name = `oidc_logout_delete_${randomUUID().replaceAll('-', '')}`
    const report = t.mock.method(console, 'error', () => {})
    const before = (await pool.query('select count(*) from verification where identifier like $1', [`enterprise-oidc-logout:${providerId}:%`])).rows[0].count
    await pool.query(`create function "${name}"() returns trigger language plpgsql as $$ begin
      if old.id='${active.session.id}' then raise exception 'fixture_logout_delete_refused' using errcode='23514'; end if; return old; end; $$`)
    try {
      await pool.query(`create trigger "${name}" before delete on session for each row execute function "${name}"()`)
      const refused = await startOidcLogout(login.jar)
      assert.equal(refused.status, 503)
      assert.equal(refused.headers.has('location'), false)
      assert.deepEqual(await refused.json(), { code: 'ENTERPRISE_LOGOUT_UNAVAILABLE', message: 'Logout unavailable' })
      assert.equal((await pool.query('select count(*) from session where id=$1', [active.session.id])).rows[0].count, '1')
      assert.equal((await pool.query('select count(*) from verification where identifier like $1', [`enterprise-oidc-logout:${providerId}:%`])).rows[0].count, before)
      assert.deepEqual(report.mock.calls.map(call => call.arguments), [
        ['[enterprise] logout revocation unavailable', { name: 'error', code: '23514', constraint: null }],
      ], 'local logout failures retain only cause classification, never provider or database error bodies')
    } finally {
      await pool.query(`drop trigger if exists "${name}" on session`)
      await pool.query(`drop function "${name}"()`)
    }
  })
  await t.test('a signed OIDC login cannot publish a session cookie when its Organization audit transaction fails', async t => {
    mode = 'valid'
    const before = Number((await pool.query('select count(*) from session where "enterpriseProviderId"=$1', [providerId])).rows[0].count)
    const constraint = `enterprise_login_audit_${randomUUID().replaceAll('-', '')}`
    const report = t.mock.method(console, 'error', () => {})
    await pool.query(`alter table mikka_organization_audit_events add constraint "${constraint}" check ("organizationId"<>'${organizationId}'::uuid or action<>'sso.signed_in') not valid`)
    try {
      const denied = await oidcLogin()
      assert.equal(denied.callback.status, 503)
      assert.equal(denied.callback.headers.get('location'), null)
      assert.equal(denied.callback.headers.getSetCookie().length, 0)
      assert.deepEqual(await denied.callback.json(), { code: 'ENTERPRISE_AUDIT_UNAVAILABLE', message: 'Authentication unavailable' })
      assert.deepEqual(report.mock.calls.map(call => call.arguments), [
        ['[enterprise] authentication intent unavailable', { name: 'DrizzleQueryError', code: '23514', constraint }],
      ], 'authentication diagnostics keep the database cause classification without query text, parameters or credentials')
      assert.equal(await session(denied.jar), null)
      assert.equal(Number((await pool.query('select count(*) from session where "enterpriseProviderId"=$1', [providerId])).rows[0].count), before)
      assert.equal((await session(oidcCookies))?.user.id, userId)
    } finally { await pool.query(`alter table mikka_organization_audit_events drop constraint "${constraint}"`) }
  })
  await t.test('a same-email personal account requires fresh explicit one-use consent before a signed OIDC identity can bind', async () => {
    const { startIdentityLink } = await import('./management')
    const existingId = randomUUID(), existingEmail = `${randomUUID()}@${oidcDomain}`, linkedSubject = `existing-${randomUUID()}`
    await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,\'Existing personal profile\',$2,true,now(),now())', [existingId, existingEmail])
    const created = await requestScim('Users', 'POST', { schemas: [SCIM_USER], externalId: linkedSubject, userName: existingEmail, active: true })
    assert.equal(created.status, 201)
    const pending = (await created.json()).id
    const freshSession = async (id: string, userEmail: string) => {
      const sessionId = randomUUID()
      await pool.query('insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now(),now())', [sessionId, randomUUID(), id])
      return { user: { id, email: userEmail }, session: { id: sessionId } }
    }
    const jarWith = (ticket: string) => { const jar = new Cookies(); jar.values.set('mikka-sso-link', ticket); return jar }
    const assertUnlinked = async () => {
      assert.equal((await pool.query('select "userId" from enterprise_scim_user where id=$1', [pending])).rows[0].userId, null)
      assert.equal((await pool.query('select count(*) from enterprise_identity where "providerId"=$1 and subject=$2', [providerId, linkedSubject])).rows[0].count, '0')
    }
    const consenting = await freshSession(existingId, existingEmail)
    oidcIdentity = { subject: linkedSubject, email: existingEmail }
    try {
      assert.equal(await session((await oidcLogin()).jar), null, 'matching verified email is not account-link authority')
      await assertUnlinked()
      await pool.query('update session set "createdAt"=now()-interval \'10 minutes\' where id=$1', [consenting.session.id])
      await assert.rejects(startIdentityLink(consenting, providerId), error => (error as { detail?: string }).detail === 'access_denied')
      await pool.query('update session set "createdAt"=now() where id=$1', [consenting.session.id])
      const stranger = await freshSession(adminId, `${adminId}@fixture.example.invalid`)
      assert.equal(await session((await oidcLogin(jarWith(await startIdentityLink(stranger, providerId)))).jar), null)
      const expired = await startIdentityLink(consenting, providerId)
      await pool.query('update enterprise_link_ticket set "expiresAt"=now()-interval \'1 second\' where id=$1', [identityTokenHash(expired)])
      assert.equal(await session((await oidcLogin(jarWith(expired))).jar), null)
      const revoked = await freshSession(existingId, existingEmail)
      const revokedTicket = await startIdentityLink(revoked, providerId)
      await pool.query('delete from session where id=$1', [revoked.session.id])
      assert.equal(await session((await oidcLogin(jarWith(revokedTicket))).jar), null)
      await assertUnlinked()
      const ticket = await startIdentityLink(consenting, providerId)
      const linked = await oidcLogin(jarWith(ticket))
      assert.equal((await session(linked.jar))?.user.id, existingId)
      assert.equal((await pool.query('select "userId" from enterprise_scim_user where id=$1', [pending])).rows[0].userId, existingId)
      assert.equal((await pool.query('select count(*) from enterprise_link_ticket where id=$1', [identityTokenHash(ticket)])).rows[0].count, '0')
      assert.equal((await pool.query('select name from "user" where id=$1', [existingId])).rows[0].name, 'Existing personal profile')
      assert.equal((await pool.query('select role from mikka_organization_members where "organizationId"=$1 and "userId"=$2', [organizationId, existingId])).rows[0].role, 'member')
      assert.equal((await pool.query('select count(*) from mikka_workspace_members where "userId"=$1', [existingId])).rows[0].count, '0', 'linking identity cannot create Workspace membership')
    } finally { oidcIdentity = { subject, email } }
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
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'sso.signed_out\' and "targetId"=$2', [organizationId, signedIn.session.id])).rows[0].count, '1')
  })
  await t.test('SP-initiated SAML Single Logout requires signed, unexpired provider-bound one-use correlation', async () => {
    const wrongSession = await fetch(`${appOrigin}/api/auth/sso/saml2/logout/${samlProviderId}`, { method: 'POST', headers: {
      origin: appOrigin, 'content-type': 'application/json', cookie: oidcCookies.header(),
    }, body: '{}', redirect: 'manual' })
    assert.equal(wrongSession.status, 403)
    assert.equal((await session(oidcCookies))?.user.id, userId)
    const login = await samlLogin(), signedIn = await session(login.jar)
    assert.ok(signedIn)
    const start = await fetch(`${appOrigin}/api/auth/sso/saml2/logout/${samlProviderId}`, { method: 'POST', headers: {
      origin: appOrigin, 'content-type': 'application/json', cookie: login.jar.header(),
    }, body: JSON.stringify({ callbackURL: `${appOrigin}/signed-out` }), redirect: 'manual' })
    assert.equal(start.status, 302, await start.clone().text())
    login.jar.take(start); assert.equal(await session(login.jar), null)
    const idpReply = await fetch(start.headers.get('location')!)
    assert.equal(idpReply.status, 200, await idpReply.clone().text())
    const payload = await idpReply.json() as { SAMLResponse: string; RelayState: string }
    const nativeRequest = new URL(start.headers.get('location')!)
    const requestId = /\bID="([^"]+)"/.exec(inflateRawSync(Buffer.from(nativeRequest.searchParams.get('SAMLRequest')!, 'base64')).toString())?.[1]
    assert.ok(requestId)
    const identifier = `saml-logout-request:${requestId}`
    const send = (response: string) => fetch(`${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`, { method: 'POST', headers: {
      origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams({ ...payload, SAMLResponse: response }), redirect: 'manual' })
    const corrupted = Buffer.from(Buffer.from(payload.SAMLResponse, 'base64').toString().replace(/(<(?:\w+:)?SignatureValue>)([A-Za-z0-9+/])/, (_match, prefix: string, value: string) => prefix + (value === 'A' ? 'B' : 'A'))).toString('base64')
    assert.notEqual(corrupted, payload.SAMLResponse)
    assert.equal((await send(corrupted)).status, 400)
    assert.equal((await pool.query('select count(*) from verification where identifier=$1', [identifier])).rows[0].count, '1', 'invalid signatures cannot consume a real logout nonce')
    for (const id of [`unknown-${randomUUID()}`, '']) {
      const response = samlIdp.createLogoutResponse(samlSp, { extract: { request: { id } } }, 'post', appOrigin)
      assert.equal((await send(response.context)).status, 400, 'unknown/missing correlation is rejected despite a valid IdP signature')
    }
    await pool.query('update verification set value=$2 where identifier=$1', [identifier, otherProviderId])
    assert.equal((await send(payload.SAMLResponse)).status, 400, 'a different provider cannot consume this request')
    assert.equal((await pool.query('select count(*) from verification where identifier=$1', [identifier])).rows[0].count, '1')
    await pool.query('update verification set value=$2 where identifier=$1', [identifier, samlProviderId])
    const concurrent = await Promise.all([send(payload.SAMLResponse), send(payload.SAMLResponse)])
    assert.deepEqual(concurrent.map(response => response.status).sort(), [302, 400])
    assert.equal(concurrent.find(response => response.status === 302)?.headers.get('location'), `${appOrigin}/signed-out`)
    assert.equal((await send(payload.SAMLResponse)).status, 400, 'a completed signed response cannot be replayed')
    assert.equal((await pool.query('select count(*) from session where id=$1', [signedIn.session.id])).rows[0].count, '0')
    assert.equal((await session(oidcCookies))?.user.id, userId, 'SAML logout leaves the independent OIDC session intact')
  })
  await t.test('native SAML logout form preserves origin and callback fences and completes signed one-use SLO', async () => {
    const login = await samlLogin(), signedIn = await session(login.jar)
    assert.ok(signedIn)
    const startForm = (origin: string | null = appOrigin, callbackURL = `${appOrigin}/signed-out`, logoutProvider = samlProviderId) => {
      const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded', cookie: login.jar.header() })
      if (origin !== null) headers.set('origin', origin)
      return fetch(`${appOrigin}/api/auth/sso/saml2/logout/${logoutProvider}`, {
        method: 'POST', headers, body: new URLSearchParams({ callbackURL }), redirect: 'manual',
      })
    }
    for (const [origin, callbackURL, logoutProvider] of [
      ['https://foreign.example.invalid', `${appOrigin}/signed-out`, samlProviderId],
      [appOrigin, 'https://foreign.example.invalid/signed-out', samlProviderId],
      [null, `${appOrigin}/signed-out`, samlProviderId],
      [appOrigin, `${appOrigin}/signed-out`, otherProviderId],
    ] as const) {
      const denied = await startForm(origin, callbackURL, logoutProvider)
      assert.equal(denied.status, 403, await denied.clone().text())
      if (origin === null) assert.equal((await denied.clone().json()).code, 'MISSING_OR_NULL_ORIGIN')
      if (logoutProvider === otherProviderId) assert.equal((await denied.clone().json()).code, 'ENTERPRISE_LOGOUT_SESSION_MISMATCH')
      login.jar.take(denied)
      assert.equal((await session(login.jar))?.session.id, signedIn.session.id, 'a rejected form cannot revoke or clear the current session')
    }
    const originalCookie = login.jar.header()
    const start = await startForm()
    assert.equal(start.status, 302, await start.clone().text())
    login.jar.take(start)
    assert.equal(await session(login.jar), null, 'the accepted native form revokes its initiating session before navigation')
    assert.equal((await pool.query('select count(*) from session where id=$1', [signedIn.session.id])).rows[0].count, '0', 'the initiating session is deleted before any request to the IdP')
    const replayedSession = await fetch(`${appOrigin}/api/auth/get-session`, { headers: { cookie: originalCookie }, redirect: 'manual' })
    assert.equal(replayedSession.status, 200)
    assert.equal((await replayedSession.json()) === null, true, 'the original cookie cannot authenticate before navigation to the IdP')
    const nativeRequest = new URL(start.headers.get('location')!)
    const requestId = /\bID="([^"]+)"/.exec(inflateRawSync(Buffer.from(nativeRequest.searchParams.get('SAMLRequest')!, 'base64')).toString())?.[1]
    assert.ok(requestId)
    assert.ok(nativeRequest.searchParams.get('Signature'), 'the original native handler still signs the IdP redirect')
    const idpReply = await fetch(nativeRequest)
    assert.equal(idpReply.status, 200, await idpReply.clone().text())
    const payload = await idpReply.json() as { SAMLResponse: string; RelayState: string }
    const finish = () => fetch(`${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`, { method: 'POST', headers: {
      origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams(payload), redirect: 'manual' })
    const returned = await finish()
    assert.equal(returned.status, 302, await returned.clone().text())
    assert.equal(returned.headers.get('location'), `${appOrigin}/signed-out`)
    assert.equal((await pool.query('select count(*) from verification where identifier=$1', [`saml-logout-request:${requestId}`])).rows[0].count, '0')
    assert.equal((await finish()).status, 400, 'the form-started signed callback is still one-use')
    assert.equal((await pool.query('select count(*) from session where id=$1', [signedIn.session.id])).rows[0].count, '0')
    assert.equal((await session(oidcCookies))?.user.id, userId, 'the independent OIDC session is untouched')
  })
  await t.test('SP-initiated SAML Single Logout rejects a signed response after its persistent request expires', async () => {
    const login = await samlLogin()
    const start = await fetch(`${appOrigin}/api/auth/sso/saml2/logout/${samlProviderId}`, { method: 'POST', headers: {
      origin: appOrigin, 'content-type': 'application/json', cookie: login.jar.header(),
    }, body: JSON.stringify({ callbackURL: appOrigin }), redirect: 'manual' })
    assert.equal(start.status, 302)
    const nativeRequest = new URL(start.headers.get('location')!)
    const requestId = /\bID="([^"]+)"/.exec(inflateRawSync(Buffer.from(nativeRequest.searchParams.get('SAMLRequest')!, 'base64')).toString())?.[1]
    assert.ok(requestId)
    const payload = await (await fetch(nativeRequest)).json() as { SAMLResponse: string; RelayState: string }
    await pool.query('update verification set "expiresAt"=now()-interval \'1 second\' where identifier=$1', [`saml-logout-request:${requestId}`])
    const response = await fetch(`${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`, { method: 'POST', headers: {
      origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded',
    }, body: new URLSearchParams(payload), redirect: 'manual' })
    assert.equal(response.status, 400)
  })
  await t.test('IdP-initiated SAML Single Logout validates signed LogoutRequest before terminating its bound session', async () => {
    const login = await samlLogin(), signedIn = await session(login.jar)
    assert.ok(signedIn)
    const request = samlIdp.createLogoutRequest(samlSp, 'post', { logoutNameID: samlSubject })
    assert.match(Buffer.from(request.context, 'base64').toString(), /SignatureValue/)
    const send = (value: string) => fetch(`${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`, { method: 'POST', headers: {
      origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded', cookie: oidcCookies.header(),
    }, body: new URLSearchParams({ SAMLRequest: value, RelayState: `${appOrigin}/signed-out` }), redirect: 'manual' })
    const tampered = Buffer.from(Buffer.from(request.context, 'base64').toString().replace(samlSubject, 'attacker@example.invalid')).toString('base64')
    assert.notEqual(tampered, request.context)
    assert.equal((await send(tampered)).status, 400)
    assert.equal((await session(login.jar))?.session.id, signedIn.session.id)
    const response = await send(request.context)
    assert.equal(response.status, 200, await response.clone().text())
    oidcCookies.take(response)
    const encoded = /name="SAMLResponse"\s+value="([^"]+)"/.exec(await response.text())?.[1]
    assert.ok(encoded)
    await samlIdp.parseLogoutResponse(samlSp, 'post', { body: { SAMLResponse: encoded } })
    assert.equal(await session(login.jar), null)
    assert.equal((await session(oidcCookies))?.user.id, userId)
    assert.ok(Number((await pool.query('select count(*) from mikka_organization_audit_events where "organizationId"=$1 and action=\'sso.logout_failed\'', [organizationId])).rows[0].count) >= 2)
  })
  await t.test('IdP-initiated SAML logout persists one-use requests and cannot replay against a later session', async () => {
    const login = await samlLogin(), signedIn = await session(login.jar)
    assert.ok(signedIn)
    const request = samlIdp.createLogoutRequest(samlSp, 'post', { logoutNameID: samlSubject })
    const send = () => fetch(`${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`, { method: 'POST', headers: {
      origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded', cookie: oidcCookies.header(),
    }, body: new URLSearchParams({ SAMLRequest: request.context, RelayState: `${appOrigin}/signed-out` }), redirect: 'manual' })
    const concurrent = await Promise.all([send(), send()])
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 400], 'native persistent replay reservation has one winner')
    assert.equal(await session(login.jar), null)
    const later = await samlLogin(), laterSession = await session(later.jar)
    assert.ok(laterSession)
    assert.notEqual(laterSession.session.id, signedIn.session.id)
    assert.equal((await send()).status, 400, 'an earlier signed LogoutRequest cannot revoke a subsequent login')
    assert.equal((await session(later.jar))?.session.id, laterSession.session.id)
    assert.equal((await session(oidcCookies))?.user.id, userId)
  })
  await t.test('SAML Redirect Single Logout verifies detached signatures and the signed RelayState in both directions', async () => {
    const login = await samlLogin(), signedIn = await session(login.jar)
    assert.ok(signedIn)
    const request = samlIdp.createLogoutRequest(samlSp, 'redirect', { logoutNameID: samlSubject }, `${appOrigin}/signed-out`)
    const url = new URL(request.context)
    assert.ok(url.searchParams.get('Signature'))
    const tampered = new URL(url)
    tampered.searchParams.set('RelayState', 'https://untrusted.example.invalid')
    assert.equal((await fetch(tampered, { redirect: 'manual' })).status, 400)
    assert.equal((await session(login.jar))?.session.id, signedIn.session.id)
    const response = await fetch(url, { headers: { cookie: oidcCookies.header() }, redirect: 'manual' })
    assert.equal(response.status, 302, await response.clone().text())
    oidcCookies.take(response)
    const reply = new URL(response.headers.get('location')!)
    assert.ok(reply.searchParams.get('Signature'))
    await samlIdp.parseLogoutResponse(samlSp, 'redirect', redirectSamlRequest(reply))
    assert.equal(await session(login.jar), null)
    assert.equal((await session(oidcCookies))?.user.id, userId)
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
  await t.test('real governance HTTP usage, CSV and templates require the admitted SSO principal and current Workspace membership', async () => {
    const previousEdition = process.env.MIKKA_EDITION
    process.env.MIKKA_EDITION = 'cloud'
    const workspaceId = randomUUID(), templateId = randomUUID(), plainSessionId = randomUUID(), plainToken = randomBytes(32).toString('hex')
    const personalWorkspaceId = randomUUID(), personalTaskId = randomUUID(), organizationTaskId = randomUUID()
    const signedIn = await session(oidcCookies); assert.ok(signedIn)
    const assuredToken = (await pool.query('select token from session where id=$1', [signedIn.session.id])).rows[0].token as string
    await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Governance SSO fixture\',\'team\')', [workspaceId, userId])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Directory user\',$3,\'admin\',\'active\')', [workspaceId, userId, email])
    await pool.query('insert into mikka_organization_workspaces ("workspaceId","organizationId") values ($1,$2)', [workspaceId, organizationId])
    await pool.query('insert into mikka_organization_entitlements ("organizationId",plan,source,"seatLimit") values ($1,\'enterprise\',\'cloud\',20)', [organizationId])
    await pool.query('insert into enterprise_org_policy ("organizationId","enforceSso","allowMachineCredentials") values ($1,true,false)', [organizationId])
    await pool.query('insert into mikka_governance_approval_templates (id,"workspaceId",name,rules,"createdBy") values ($1,$2,\'Read only\',$3,$4)', [templateId, workspaceId, { approvalMode: 'read_only' }, userId])
    await pool.query('insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now(),now())', [plainSessionId, plainToken, userId])
    await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Mobile Personal fixture\',\'personal\')', [personalWorkspaceId, userId])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Directory user\',$3,\'admin\',\'active\')', [personalWorkspaceId, userId, email])
    for (const [id, taskWorkspaceId] of [[personalTaskId, personalWorkspaceId], [organizationTaskId, workspaceId]]) {
      await pool.query('insert into issues(id,"userId","workspaceId","ownershipState",title,content,status,priority) values($1,$2,$3,\'bound\',\'Mobile cookie fixture\',$4,\'todo\',\'normal\')',
        [id, userId, taskWorkspaceId, { type: 'doc' }])
    }
    const detailCall = (token: string, issueId: string, extraHeaders: Record<string, string> = {}) => fetch(`${appOrigin}/api/mobile/tasks/${issueId}`, {
      headers: { authorization: `Bearer ${token}`, 'x-mikka-locale': 'en', ...extraHeaders }, signal: AbortSignal.timeout(10_000),
    })
    const call = (token: string, apply = false, csv = false) => fetch(`${appOrigin}/api/workspaces/${workspaceId}/governance${apply ? '' : `/usage${csv ? '?format=csv' : ''}`}`, {
      method: apply ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(apply ? { body: JSON.stringify({ action: 'apply', templateId }) } : {}), signal: AbortSignal.timeout(10_000),
    })
    const templateCall = (token: string, input?: unknown) => fetch(`${appOrigin}/api/workspaces/${workspaceId}/governance`, {
      method: input === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10_000),
    })
    const templateInput = { action: 'save', template: { name: 'SSO template', rules: { approvalMode: 'read_only' } } }
    try {
      assert.equal((await call(plainToken)).status, 403, 'ordinary authenticated session cannot read enforced-SSO usage')
      assert.equal((await call(plainToken, false, true)).status, 403)
      assert.equal((await call(plainToken, true)).status, 403, 'Workspace admin alone cannot apply an enforced-SSO template')
      assert.equal((await templateCall(plainToken)).status, 403)
      assert.equal((await templateCall(plainToken, templateInput)).status, 403)
      assert.equal((await templateCall(plainToken, { action: 'delete', templateId })).status, 403)
      assert.equal((await pool.query('select count(*) from workspace_computer_policies where "workspaceId"=$1', [workspaceId])).rows[0].count, '0')
      const personal = await detailCall(plainToken, personalTaskId)
      assert.equal(personal.status, 200, 'the registered mobile detail route reads this plain session Personal task without a selection cookie')
      const personalBody = await personal.json()
      assert.equal(personalBody.task.id, personalTaskId)
      assert.deepEqual(personalBody.live, { workspaceId: personalWorkspaceId })
      const workspaceCookie = `mikka-workspace=${workspaceId}`
      const cookiePersonal = await detailCall(plainToken, personalTaskId, { cookie: workspaceCookie })
      assert.equal(cookiePersonal.status, 200, 'an unrelated enforced-SSO Workspace cookie must not gate this Personal task')
      assert.deepEqual(await cookiePersonal.json(), personalBody, 'changing only a Workspace preference preserves every authorized Task projection')
      const organizationHeaders: Record<string, string>[] = [{}, { cookie: workspaceCookie }]
      for (const extraHeaders of organizationHeaders) {
        const denied = await detailCall(plainToken, organizationTaskId, extraHeaders)
        assert.equal(denied.status, 404, 'the actual Task Organization still requires SSO assurance')
        assert.deepEqual(await denied.json(), { error: 'issueNotFound' })
      }
      const admitted = await detailCall(assuredToken, organizationTaskId, { cookie: workspaceCookie })
      assert.equal(admitted.status, 200)
      const admittedBody = await admitted.json()
      assert.equal(admittedBody.task.id, organizationTaskId)
      assert.deepEqual(admittedBody.live, { workspaceId })
      for (const selected of [workspaceId, 'not-a-workspace', randomUUID()]) {
        const denied = await detailCall(plainToken, personalTaskId, { cookie: workspaceCookie, 'x-mikka-workspace-id': selected })
        assert.equal(denied.status, 404, 'an explicit inaccessible or invalid Workspace never falls back to the Personal task')
        assert.deepEqual(await denied.json(), { error: 'issueNotFound' })
      }
      const explicitlyPersonal = await detailCall(plainToken, personalTaskId, { cookie: workspaceCookie, 'x-mikka-workspace-id': personalWorkspaceId })
      assert.equal(explicitlyPersonal.status, 200)
      assert.deepEqual(await explicitlyPersonal.json(), personalBody)
      assert.equal((await call(assuredToken)).status, 200, 'native bearer retains the real OIDC assurance through the governance lease')
      assert.equal((await call(assuredToken, false, true)).status, 200)
      const summary = await templateCall(assuredToken); assert.equal(summary.status, 200)
      assert.ok((await summary.json()).templates.some((row: { id: string }) => row.id === templateId))
      const saved = await templateCall(assuredToken, templateInput); assert.equal(saved.status, 200)
      const savedId = (await saved.json()).id as string; assert.ok(savedId)
      assert.equal((await templateCall(assuredToken, { action: 'delete', templateId: savedId })).status, 200)
      assert.equal((await call(assuredToken, true)).status, 200)
      assert.deepEqual((await pool.query('select cli_run_policy from workspace_computer_policies where "workspaceId"=$1', [workspaceId])).rows[0].cli_run_policy, { approvalMode: 'read_only' })
      await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspaceId, userId])
      assert.equal((await call(assuredToken)).status, 403, 'SSO assurance and Enterprise plan cannot restore Workspace membership')
      assert.equal((await call(assuredToken, true)).status, 403)
      assert.equal((await templateCall(assuredToken)).status, 403)
      assert.equal((await templateCall(assuredToken, templateInput)).status, 403)
    } finally {
      await pool.query('delete from issues where id=any($1::uuid[])', [[personalTaskId, organizationTaskId]])
      await pool.query('delete from workspace_subscription_shares where "ownerId"=$1 and "workspaceId"=$2', [userId, personalWorkspaceId])
      await pool.query('delete from session where id=$1', [plainSessionId])
      await pool.query('delete from workspace_computer_policies where "workspaceId"=$1', [workspaceId])
      await pool.query('delete from enterprise_org_policy where "organizationId"=$1', [organizationId])
      await pool.query('delete from mikka_organization_entitlements where "organizationId"=$1', [organizationId])
      await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [[workspaceId, personalWorkspaceId]])
      if (previousEdition === undefined) delete process.env.MIKKA_EDITION
      else process.env.MIKKA_EDITION = previousEdition
    }
  })
  await t.test('owner break-glass uses the real identity HTTP route, requires a fresh session and expires without changing Personal access', async () => {
    const previousEdition = process.env.MIKKA_EDITION
    const workspaceId = randomUUID(), personalWorkspaceId = randomUUID(), taskId = randomUUID(), personalTaskId = randomUUID()
    const sessionIds: string[] = [], reason = 'Isolated owner recovery acceptance'
    const priorMembership = (await pool.query('select role from mikka_organization_members where "organizationId"=$1 and "userId"=$2', [organizationId, userId])).rows[0]
    assert.equal(priorMembership.role, 'member')
    const { auth: applicationAuth } = await import('../auth')
    const applicationContext = await applicationAuth.$context
    const createSession = async (id: string) => {
      const value = await applicationContext.internalAdapter.createSession(id); assert.ok(value)
      sessionIds.push(value.id); return value
    }
    const identityCall = async (token: string, input?: unknown) => fetch(`${appOrigin}/api/organizations/${organizationId}/identity`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { cookie: await applicationCookie(token), origin: appOrigin, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(10_000),
    })
    const detailCall = (token: string, id: string) => fetch(`${appOrigin}/api/mobile/tasks/${id}`, {
      headers: { authorization: `Bearer ${token}`, 'x-mikka-locale': 'en' }, signal: AbortSignal.timeout(10_000),
    })
    const successState = async () => (await pool.query(`with successful_events as (
      select id from mikka_organization_audit_events where "organizationId"=$1 and action='sso.policy_changed'
        and result='success' and metadata->>'reason'='owner_break_glass' and metadata->>'enabled'='true')
      select (select count(*)::int from enterprise_break_glass where "organizationId"=$1) as grants,
      (select count(*)::int from successful_events) as events,
      (select count(*)::int from enterprise_audit_outbox where "organizationId"=$1 and
        (id in (select id from successful_events) or payload->>'result'='success' and payload->>'action'='sso.policy_changed'
          and payload->'metadata'->>'reason'='owner_break_glass' and payload->'metadata'->>'enabled'='true')) as intents`, [organizationId])).rows[0]
    const deniedIdentity = async (response: Response, status = 403, detail = 'access_denied') => {
      assert.equal(response.status, status)
      assert.deepEqual(await response.json(), { error: { code: 'governance_denied', detail } })
    }
    process.env.MIKKA_EDITION = 'cloud'
    try {
      await pool.query('update mikka_organization_members set role=\'admin\' where "organizationId"=$1 and "userId"=$2', [organizationId, userId])
      await pool.query('insert into enterprise_org_policy ("organizationId","enforceSso","allowMachineCredentials") values ($1,true,false)', [organizationId])
      await pool.query('insert into mikka_organization_entitlements ("organizationId",plan,source,"seatLimit") values ($1,\'enterprise\',\'cloud\',20)', [organizationId])
      for (const [id, kind] of [[workspaceId, 'team'], [personalWorkspaceId, 'personal']]) {
        await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Recovery fixture\',$3)', [id, adminId, kind])
        await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Fixture owner\',$3,\'admin\',\'active\')', [id, adminId, `${adminId}@fixture.example.invalid`])
      }
      await pool.query('insert into mikka_organization_workspaces ("workspaceId","organizationId") values ($1,$2)', [workspaceId, organizationId])
      for (const [id, boundWorkspaceId] of [[taskId, workspaceId], [personalTaskId, personalWorkspaceId]]) {
        await pool.query('insert into issues(id,"userId","workspaceId","ownershipState",title,content,status,priority) values ($1,$2,$3,\'bound\',\'Recovery fixture\',$4,\'todo\',\'normal\')', [id, adminId, boundWorkspaceId, { type: 'doc' }])
      }
      const owner = await createSession(adminId), otherOwnerSession = await createSession(adminId)
      const oldOwner = await createSession(adminId), nonOwner = await createSession(userId)
      await pool.query('update session set "createdAt"=now()-interval \'6 minutes\' where id=$1', [oldOwner.id])
      assert.equal((await pool.query('select count(*)::int as count from session where id=any($1::text[]) and "expiresAt">now() and "enterpriseIdentityId" is null', [sessionIds])).rows[0].count, 4)
      await deniedIdentity(await identityCall(owner.token))
      const locked = await detailCall(owner.token, taskId)
      assert.equal(locked.status, 404); assert.deepEqual(await locked.json(), { error: 'issueNotFound' })
      const personal = await detailCall(owner.token, personalTaskId)
      assert.equal(personal.status, 200)
      const personalBody = await personal.json()
      assert.equal(personalBody.task.id, personalTaskId); assert.deepEqual(personalBody.live, { workspaceId: personalWorkspaceId })
      const before = await successState(), input = { action: 'break-glass', reason }
      for (const token of [nonOwner.token, oldOwner.token]) {
        await deniedIdentity(await identityCall(token, input))
        assert.deepEqual(await successState(), before, 'a rejected activation creates neither a grant nor a successful recovery audit')
      }
      await deniedIdentity(await identityCall(owner.token, { ...input, expiresAt: '2099-01-01T00:00:00.000Z' }), 400, 'invalid_request')
      assert.deepEqual(await successState(), before, 'the client cannot supply or extend the recovery deadline')
      const startedAt = Date.now(), activated = await identityCall(owner.token, input), completedAt = Date.now()
      assert.equal(activated.status, 200)
      const result = await activated.json() as { expiresAt: string }
      assert.deepEqual(Object.keys(result), ['expiresAt'])
      const deadline = Date.parse(result.expiresAt)
      assert.ok(Number.isFinite(deadline) && deadline >= startedAt + 15 * 60_000 && deadline <= completedAt + 15 * 60_000, 'the server grants exactly fifteen minutes from activation')
      const grant = (await pool.query('select "userId","sessionId","expiresAt",reason from enterprise_break_glass where "organizationId"=$1', [organizationId])).rows
      assert.equal(grant.length, 1)
      assert.deepEqual(grant[0], { userId: adminId, sessionId: owner.id, expiresAt: new Date(result.expiresAt), reason })
      const grantedState = await successState()
      assert.deepEqual(grantedState, { grants: before.grants + 1, events: before.events + 1, intents: before.intents + 1 })
      const recovered = await identityCall(owner.token)
      assert.equal(recovered.status, 200)
      assert.deepEqual((await recovered.json()).policy, { enforceSso: true, allowMachineCredentials: false })
      const task = await detailCall(owner.token, taskId)
      assert.equal(task.status, 200)
      const taskBody = await task.json()
      assert.equal(taskBody.task.id, taskId); assert.deepEqual(taskBody.live, { workspaceId })
      await deniedIdentity(await identityCall(otherOwnerSession.token))
      const unaffected = await detailCall(owner.token, personalTaskId)
      assert.equal(unaffected.status, 200); assert.deepEqual(await unaffected.json(), personalBody)
      const expired = await pool.query('update enterprise_break_glass set "expiresAt"=now()-interval \'1 second\' where "organizationId"=$1 and "sessionId"=$2', [organizationId, owner.id])
      assert.equal(expired.rowCount, 1)
      await deniedIdentity(await identityCall(owner.token))
      const denied = await detailCall(owner.token, taskId)
      assert.equal(denied.status, 404); assert.deepEqual(await denied.json(), { error: 'issueNotFound' })
      const stillPersonal = await detailCall(owner.token, personalTaskId)
      assert.equal(stillPersonal.status, 200); assert.deepEqual(await stillPersonal.json(), personalBody)
      assert.deepEqual(await successState(), grantedState, 'expired recovery access cannot mint another successful grant or audit')
    } finally {
      await pool.query('delete from enterprise_break_glass where "organizationId"=$1 and "sessionId"=any($2::text[])', [organizationId, sessionIds])
      await pool.query('delete from issues where id=any($1::uuid[])', [[taskId, personalTaskId]])
      await pool.query('delete from workspace_subscription_shares where "ownerId"=$1 and "workspaceId"=$2', [adminId, personalWorkspaceId])
      await pool.query('delete from session where id=any($1::text[])', [sessionIds])
      await pool.query('delete from mikka_workspaces where id=any($1::uuid[])', [[workspaceId, personalWorkspaceId]])
      await pool.query('delete from enterprise_org_policy where "organizationId"=$1', [organizationId])
      await pool.query('delete from mikka_organization_entitlements where "organizationId"=$1', [organizationId])
      await pool.query('update mikka_organization_members set role=$3 where "organizationId"=$1 and "userId"=$2', [organizationId, userId, priorMembership.role])
      if (previousEdition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = previousEdition
    }
  })
  await t.test('real OIDC Web PKCE handoff retains only verified SSO assurance and live/cache/phone access enforces it', async t => {
    const web = await webHandoffFixture()
    const { applicationContext, sessions, handoff } = web
    const { readSessionLiveTicket } = await import('../live/session-ticket')
    const { builtinGatewayConfig } = await import('../builtin-gateway/config')
    const workspaceId = randomUUID()
    const source = await session(oidcCookies); assert.ok(source)
    const original = (await pool.query('select * from session where id=$1', [source.session.id])).rows[0]
    await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Web SSO fixture\',\'team\')', [workspaceId, userId])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Directory user\',$3,\'admin\',\'active\')', [workspaceId, userId, email])
    await pool.query('insert into mikka_organization_workspaces ("workspaceId","organizationId") values ($1,$2)', [workspaceId, organizationId])
    await pool.query('insert into mikka_organization_entitlements ("organizationId",plan,source,"seatLimit") values ($1,\'enterprise\',\'license\',20)', [organizationId])
    await pool.query('insert into enterprise_org_policy ("organizationId","enforceSso","allowMachineCredentials") values ($1,true,false)', [organizationId])
    const readWorkspace = (token: string) => fetch(`${appOrigin}/api/workspaces/${workspaceId}/governance/usage`, { headers: { authorization: `Bearer ${token}` } })
    const readLive = (token: string) => fetch(`${appOrigin}/api/live/ticket?workspace=${workspaceId}`, { headers: { authorization: `Bearer ${token}` } })
    const phone = await phoneFixture(t, workspaceId)
    try {
      assert.deepEqual(await cacheNamespace(original.token, workspaceId), { workspaceId, role: 'admin' })
      const derived = await handoff(original.token)
      const copied = (await pool.query('select "enterpriseOrganizationId","enterpriseProviderId","enterpriseIdentityId" from session where id=$1', [derived.session.id])).rows[0]
      assert.deepEqual(copied, { enterpriseOrganizationId: organizationId, enterpriseProviderId: providerId, enterpriseIdentityId: original.enterpriseIdentityId })
      assert.equal((await readWorkspace(derived.token)).status, 200)
      assert.deepEqual(await cacheNamespace(derived.token, workspaceId), { workspaceId, role: 'admin' })
      const live = await readLive(derived.token); assert.equal(live.status, 200)
      const ticket = await live.json(), gateway = builtinGatewayConfig(); assert.ok(gateway)
      const channel = /\/v1\/live\/([a-f0-9]{64})\/socket$/.exec(new URL(ticket.url).pathname)?.[1]; assert.ok(channel)
      assert.equal(readSessionLiveTicket(channel, ticket.protocol, gateway.secret)?.sessionId, derived.session.id)
      const plain = await applicationContext.internalAdapter.createSession(userId); assert.ok(plain); sessions.push(plain.id)
      assert.equal((await readWorkspace(plain.token)).status, 403)
      assert.equal((await readLive(plain.token)).status, 403)
      assert.equal(await cacheNamespace(plain.token, workspaceId), null, 'a plain session cannot hydrate an old SSO cache for the same user')
      const ssoPhone = await phone.register(derived.token, derived.session.id)
      await phone.register(plain.token, plain.id)
      assert.deepEqual(await phone.push(), [ssoPhone], 'only the phone bound to the actual SSO session receives enterprise content')
      await pool.query('insert into enterprise_break_glass ("organizationId","userId","sessionId","expiresAt",reason) values ($1,$2,$3,now()+interval \'5 minutes\',\'isolated fixture\')', [organizationId, userId, plain.id])
      assert.equal((await readWorkspace(plain.token)).status, 200)
      const ordinary = await handoff(plain.token)
      assert.equal((await readWorkspace(ordinary.token)).status, 403, 'handoff never copies session-bound break-glass permission')
      assert.equal((await readLive(ordinary.token)).status, 403)
      assert.equal((await pool.query('select "enterpriseIdentityId" from session where id=$1', [ordinary.session.id])).rows[0].enterpriseIdentityId, null)
      await pool.query('delete from enterprise_break_glass where "organizationId"=$1 and "sessionId"=$2', [organizationId, plain.id])
      await pool.query('update enterprise_identity set "userId"=$2 where id=$1', [original.enterpriseIdentityId, adminId])
      const invalidIdentity = await handoff(original.token)
      assert.equal((await readWorkspace(invalidIdentity.token)).status, 403)
      assert.equal((await readLive(invalidIdentity.token)).status, 403)
      assert.equal(await cacheNamespace(derived.token, workspaceId), null, 'cache authorization rechecks the original identity owner')
      assert.deepEqual(await phone.push(), [], 'identity ownership changes block the already registered SSO phone')
      assert.equal((await pool.query('select "enterpriseIdentityId" from session where id=$1', [invalidIdentity.session.id])).rows[0].enterpriseIdentityId, null)
      await pool.query('update enterprise_identity set "userId"=$2 where id=$1', [original.enterpriseIdentityId, userId])
      await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspaceId, userId])
      assert.equal((await readWorkspace(derived.token)).status, 403)
      assert.equal((await readLive(derived.token)).status, 403)
      assert.equal(await cacheNamespace(derived.token, workspaceId), null, 'SSO never restores a revoked cache membership')
      assert.deepEqual(await phone.push(), [], 'suspended Workspace membership blocks the already registered SSO phone')
      const afterMembershipRevoked = await handoff(original.token)
      assert.equal((await readWorkspace(afterMembershipRevoked.token)).status, 403)
      assert.equal((await readLive(afterMembershipRevoked.token)).status, 403)
    } finally {
      await pool.query('update enterprise_identity set "userId"=$2 where id=$1', [original.enterpriseIdentityId, userId])
      await phone.close()
      await web.close()
      await pool.query('delete from enterprise_org_policy where "organizationId"=$1', [organizationId])
      await pool.query('delete from mikka_organization_entitlements where "organizationId"=$1', [organizationId])
      await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    }
  })
  await t.test('Web handoff commits its audit outbox before releasing a bearer and reclaims the target on audit failure', async () => {
    const web = await webHandoffFixture()
    const source = await session(oidcCookies); assert.ok(source)
    const token = (await pool.query('select token from session where id=$1', [source.session.id])).rows[0].token as string
    const constraint = `handoff_audit_${randomUUID().replaceAll('-', '')}`
    const count = async () => (await pool.query('select count(*) from session where "userId"=$1', [source.user.id])).rows[0].count
    const before = await count()
    try {
      await pool.query(`alter table enterprise_audit_outbox add constraint "${constraint}" check (payload->'metadata'->>'reason' is distinct from 'web_handoff') not valid`)
      const denied = await web.request(token)
      assert.equal(denied.status, 400); assert.equal(denied.headers.has('set-cookie'), false)
      assert.equal(Object.hasOwn(await denied.json(), 'token'), false)
      assert.equal(await count(), before, 'a failed audit rolls back assurance and the native target is reclaimed')
      assert.equal((await session(oidcCookies))?.session.id, source.session.id)
      await pool.query(`alter table enterprise_audit_outbox drop constraint "${constraint}"`)
      const derived = await web.handoff(token)
      const { rows } = await pool.query('select payload from enterprise_audit_outbox where "organizationId"=$1 and payload->>\'targetId\'=$2', [organizationId, derived.session.id])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].payload.action, 'sso.signed_in')
      assert.deepEqual(rows[0].payload.metadata, { providerId, reason: 'web_handoff' })
      assert.ok(!JSON.stringify(rows[0]).includes(token) && !JSON.stringify(rows[0]).includes(derived.token), 'the durable intent contains no bearer')
    } finally {
      await pool.query(`alter table enterprise_audit_outbox drop constraint if exists "${constraint}"`)
      await web.close()
    }
  })
  await t.test('signed SAML Web handoffs preserve the original SLO family and reject missing native metadata', async () => {
    const web = await webHandoffFixture(), workspaceId = randomUUID(), roots: string[] = []
    const nativeContext = await auth.$context
    const cookieFor = (token: string) => {
      const jar = new Cookies(), signature = createHmac('sha256', nativeContext.secret).update(token).digest('base64')
      jar.values.set(nativeContext.authCookies.sessionToken.name, encodeURIComponent(`${token}.${signature}`)); return jar
    }
    const login = async () => {
      const result = await samlLogin(), active = await session(result.jar); assert.ok(active)
      roots.push(active.session.id)
      const row = (await pool.query('select * from session where id=$1', [active.session.id])).rows[0]
      return { ...result, ...active, token: row.token as string }
    }
    const first = await login(), samlUserId = first.user.id
    await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'SAML Web fixture\',\'team\')', [workspaceId, samlUserId])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'SAML user\',$3,\'admin\',\'active\')', [workspaceId, samlUserId, samlSubject])
    await pool.query('insert into mikka_organization_workspaces ("workspaceId","organizationId") values ($1,$2)', [workspaceId, organizationId])
    await pool.query('insert into mikka_organization_entitlements ("organizationId",plan,source,"seatLimit") values ($1,\'enterprise\',\'license\',20)', [organizationId])
    await pool.query('insert into enterprise_org_policy ("organizationId","enforceSso","allowMachineCredentials") values ($1,true,false)', [organizationId])
    const readWorkspace = (token: string) => fetch(`${appOrigin}/api/workspaces/${workspaceId}/governance/usage`, { headers: { authorization: `Bearer ${token}` } })
    const remaining = async (ids: string[]) => Number((await pool.query('select count(*) from session where id=any($1::text[])', [ids])).rows[0].count)
    const metadata = async (id: string) => JSON.parse((await pool.query('select value from verification where identifier=$1', [`enterprise-saml-session:${id}`])).rows[0].value) as { sessionId: string; providerId: string; nameID: string; sessionIndex?: string }
    const startLogout = (jar: Cookies, pid = samlProviderId) => fetch(`${appOrigin}/api/auth/sso/saml2/logout/${pid}`, { method: 'POST', headers: {
      origin: appOrigin, 'content-type': 'application/json', cookie: jar.header(),
    }, body: JSON.stringify({ callbackURL: `${appOrigin}/signed-out` }), redirect: 'manual' })
    const completeLogout = async (response: Response, expected: Awaited<ReturnType<typeof metadata>>) => {
      assert.equal(response.status, 302)
      const url = new URL(response.headers.get('location')!)
      const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString()
      assert.ok(xml.includes(expected.nameID))
      if (expected.sessionIndex) assert.ok(xml.includes(expected.sessionIndex), 'SP logout uses the original login SessionIndex')
      const idp = await fetch(url); assert.equal(idp.status, 200, 'the real IdP verifies the native SP signature')
      const payload = await idp.json() as { SAMLResponse: string; RelayState: string }
      const callback = await fetch(`${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`, { method: 'POST', headers: {
        origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded',
      }, body: new URLSearchParams(payload), redirect: 'manual' })
      assert.equal(callback.status, 302)
    }
    try {
      const auditConstraint = `saml_handoff_audit_${randomUUID().replaceAll('-', '')}`
      await pool.query(`alter table enterprise_audit_outbox add constraint "${auditConstraint}" check (payload->'metadata'->>'reason' is distinct from 'web_handoff') not valid`)
      try {
        const before = (await pool.query('select count(*) from session where "userId"=$1', [samlUserId])).rows[0].count
        assert.equal((await web.request(first.token)).status, 400)
        assert.equal((await pool.query('select count(*) from session where "userId"=$1', [samlUserId])).rows[0].count, before)
        assert.equal((await pool.query('select count(*) from enterprise_saml_session_lineage where "rootSessionId"=$1', [first.session.id])).rows[0].count, '1')
        assert.equal((await pool.query('select count(*) from verification where identifier=$1', [`enterprise-saml-session:${first.session.id}`])).rows[0].count, '1', 'audit failure preserves the root without publishing a child')
      } finally { await pool.query(`alter table enterprise_audit_outbox drop constraint "${auditConstraint}"`) }
      const child = await web.handoff(first.token), descendant = await web.handoff(child.token)
      assert.equal((await readWorkspace(child.token)).status, 200)
      assert.equal((await readWorkspace(descendant.token)).status, 200)
      await assertLogoutTarget(await logoutTargetFor(child.token), { providerId: samlProviderId, protocol: 'saml' })
      assert.deepEqual((await pool.query('select "rootSessionId" from enterprise_saml_session_lineage where "sessionId"=any($1::text[]) order by "sessionId"', [[child.session.id, descendant.session.id]])).rows,
        [{ rootSessionId: first.session.id }, { rootSessionId: first.session.id }])
      const snapshot = await metadata(child.session.id)
      assert.deepEqual(Object.keys(snapshot).sort(), ['nameID', 'providerId', 'sessionId', ...(snapshot.sessionIndex === undefined ? [] : ['sessionIndex'])].sort())
      assert.equal(snapshot.nameID, samlSubject); assert.equal(snapshot.providerId, samlProviderId)
      const request = samlIdp.createLogoutRequest(samlSp, 'post', { logoutNameID: snapshot.nameID, sessionIndex: snapshot.sessionIndex })
      const idpLogout = await fetch(`${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`, { method: 'POST', headers: {
        origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded', cookie: oidcCookies.header(),
      }, body: new URLSearchParams({ SAMLRequest: request.context, RelayState: `${appOrigin}/signed-out` }), redirect: 'manual' })
      assert.equal(idpLogout.status, 200)
      assert.equal(await remaining([first.session.id, child.session.id, descendant.session.id]), 0, 'native IdP logout revokes every derived bearer')
      assert.equal(await session(cookieFor(child.token)), null, 'the native session is gone after SLO')
      const revoked = await readWorkspace(child.token)
      assert.equal(revoked.status, 403, 'governance uses its existing access_denied response for a missing session')
      assert.deepEqual(await revoked.json(), { error: { code: 'governance_denied', detail: 'access_denied' } })

      const rootSp = await login(), rootChild = await web.handoff(rootSp.token), rootSnapshot = await metadata(rootSp.session.id)
      const afterRootSp = await login()
      await completeLogout(await startLogout(rootSp.jar), rootSnapshot)
      assert.equal(await remaining([rootSp.session.id, rootChild.session.id]), 0)
      assert.equal((await session(afterRootSp.jar))?.session.id, afterRootSp.session.id)

      const old = await login(), oldChild = await web.handoff(old.token), sibling = await web.handoff(oldChild.token)
      const oldSnapshot = await metadata(oldChild.session.id), later = await login(), childJar = cookieFor(oldChild.token)
      assert.equal((await startLogout(childJar, otherProviderId)).status, 403)
      assert.equal(await remaining([old.session.id, oldChild.session.id, sibling.session.id]), 3)
      const childLogout = await startLogout(childJar)
      assert.equal(childLogout.status, 302)
      assert.equal(await remaining([old.session.id, oldChild.session.id, sibling.session.id]), 0, 'the confirmed native SP redirect revokes only the initiating derived family before the IdP round trip')
      assert.equal((await session(later.jar))?.session.id, later.session.id, 'a later independent login survives local derived-family logout')
      await completeLogout(childLogout, oldSnapshot)
      assert.equal(await remaining([old.session.id, oldChild.session.id, sibling.session.id]), 0)
      assert.equal((await session(later.jar))?.session.id, later.session.id, 'a later same-NameID SAML login is independent')
      assert.equal((await session(oidcCookies))?.user.id, userId)

      const expiring = await login(), expiredChild = await web.handoff(expiring.token)
      await pool.query('update session set "expiresAt"=now()-interval \'1 second\' where id=$1', [expiring.session.id])
      assert.equal((await readWorkspace(expiredChild.token)).status, 403, 'child assurance cannot outlive its original root')
      await assertLogoutTarget(await logoutTargetFor(expiredChild.token), null)
      const unmapped = await login()
      await pool.query('update verification set value=$2 where identifier=$1', [`saml-session-by-id:${unmapped.session.id}`, `saml-session:${otherProviderId}:${samlSubject}`])
      assert.equal((await web.request(unmapped.token)).status, 400)
      await pool.query('delete from verification where identifier=$1', [`saml-session-by-id:${unmapped.session.id}`])
      const before = Number((await pool.query('select count(*) from session where "userId"=$1', [samlUserId])).rows[0].count)
      const refused = await web.request(unmapped.token)
      assert.equal(refused.status, 400); assert.equal(Object.hasOwn(await refused.json(), 'token'), false)
      assert.equal(Number((await pool.query('select count(*) from session where "userId"=$1', [samlUserId])).rows[0].count), before)
      assert.equal((await session(unmapped.jar))?.session.id, unmapped.session.id)
    } finally {
      await web.close()
      await pool.query('delete from session where id=any($1::text[])', [roots])
      await pool.query('delete from enterprise_org_policy where "organizationId"=$1', [organizationId])
      await pool.query('delete from mikka_organization_entitlements where "organizationId"=$1', [organizationId])
      await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    }
  })
  await t.test('verified IdP SAML logout selects the original SessionIndex and preserves later or unrelated logins', async t => {
    const web = await webHandoffFixture(), roots: string[] = []
    const errors: unknown[][] = []; t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args))
    const login = async (nameID = samlSubject) => {
      const result = await samlLogin(nameID), active = await session(result.jar); assert.ok(active); roots.push(active.session.id)
      const row = (await pool.query('select token from session where id=$1', [active.session.id])).rows[0]
      const snapshot = JSON.parse((await pool.query('select value from verification where identifier=$1', [`enterprise-saml-session:${active.session.id}`])).rows[0].value) as { nameID: string; sessionIndex?: string }
      return { ...active, ...result, token: row.token as string, snapshot }
    }
    const remaining = async (ids: string[]) => Number((await pool.query('select count(*) from session where id=any($1::text[])', [ids])).rows[0].count)
    const send = (request: string) => fetch(`${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`, { method: 'POST', headers: {
      origin: idpOrigin, 'content-type': 'application/x-www-form-urlencoded', cookie: oidcCookies.header(),
    }, body: new URLSearchParams({ SAMLRequest: request, RelayState: `${appOrigin}/signed-out` }), redirect: 'manual' })
    const signedRequest = (nameID: string, sessionIndex?: string | string[]) => {
      if (!Array.isArray(sessionIndex)) return samlIdp.createLogoutRequest(samlSp, 'post', { logoutNameID: nameID, ...(sessionIndex === undefined ? {} : { sessionIndex }) }).context
      return samlIdp.createLogoutRequest(samlSp, 'post', { logoutNameID: nameID }, {
        customTagReplacement: (template: string) => {
          const id = `_${randomUUID()}`
          const indices = sessionIndex.map((_value, index) => `<samlp:SessionIndex>{Index${index}}</samlp:SessionIndex>`).join('')
          return { id, context: saml.SamlLib.replaceTagsByValue(template.replace('<samlp:SessionIndex>{SessionIndex}</samlp:SessionIndex>', indices), {
            ID: id, IssueInstant: new Date().toISOString(), Destination: `${appOrigin}/api/auth/sso/saml2/sp/slo/${samlProviderId}`,
            Issuer: `${idpOrigin}/saml-idp`, EntityID: `${idpOrigin}/saml-idp`,
            NameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', NameID: nameID,
            ...Object.fromEntries(sessionIndex.map((value, index) => [`Index${index}`, value])),
          }) }
        },
      }).context
    }
    const otherSubject = `${randomUUID()}@${samlDomain}`
    assert.equal((await requestScim('Users', 'POST', { schemas: [SCIM_USER], externalId: otherSubject, userName: otherSubject, active: true }, samlConnectionId, samlBearer)).status, 201)
    try {
      const unrelated = await login(otherSubject)
      const old = await login(), child = await web.handoff(old.token), later = await login()
      assert.ok(old.snapshot.sessionIndex && later.snapshot.sessionIndex)
      assert.notEqual(old.snapshot.sessionIndex, later.snapshot.sessionIndex)
      const oldRequest = signedRequest(samlSubject, old.snapshot.sessionIndex)
      const tampered = Buffer.from(Buffer.from(oldRequest, 'base64').toString().replace(samlSubject, otherSubject)).toString('base64')
      assert.equal((await send(tampered)).status, 400)
      assert.equal(await remaining([old.session.id, child.session.id, later.session.id, unrelated.session.id]), 4)
      assert.equal((await send(oldRequest)).status, 200)
      assert.equal(await remaining([old.session.id, child.session.id]), 0)
      assert.equal(await remaining([later.session.id, unrelated.session.id]), 2)
      assert.ok(Number((await pool.query('select count(*) from verification where identifier=$1', [`saml-session:${samlProviderId}:${samlSubject}`])).rows[0].count) > 0, 'handled logout preserves the later canonical key')
      assert.equal((await send(oldRequest)).status, 400, 'native replay protection precedes the application callback')
      assert.equal((await send(signedRequest(samlSubject, later.snapshot.sessionIndex))).status, 200)
      assert.equal(await remaining([later.session.id]), 0, 'the later root is independently revocable without a Web clone')

      const selectedA = await login(), selectedB = await login(), unselected = await login()
      assert.ok(selectedA.snapshot.sessionIndex && selectedB.snapshot.sessionIndex)
      assert.equal((await send(signedRequest(samlSubject, [selectedA.snapshot.sessionIndex, selectedB.snapshot.sessionIndex]))).status, 200)
      assert.equal(await remaining([selectedA.session.id, selectedB.session.id]), 0, 'a signed multi-index request selects exactly its listed roots')
      assert.equal(await remaining([unselected.session.id, unrelated.session.id]), 2)

      const groupA = await login(), groupB = await login(), groupChild = await web.handoff(groupA.token)
      assert.equal((await send(signedRequest(samlSubject))).status, 200)
      assert.equal(await remaining([groupA.session.id, groupB.session.id, groupChild.session.id]), 0, 'absent SessionIndex closes the matching provider and NameID roots')
      assert.equal(await remaining([unrelated.session.id]), 1)
      assert.equal((await session(oidcCookies))?.user.id, userId)

      const failed = await login(), failedChild = await web.handoff(failed.token)
      const constraint = `saml_logout_audit_${randomUUID().replaceAll('-', '')}`
      await pool.query(`alter table enterprise_audit_outbox add constraint "${constraint}" check (payload->'metadata'->>'reason' is distinct from 'saml_idp_logout') not valid`)
      try {
        const response = await send(signedRequest(samlSubject, failed.snapshot.sessionIndex))
        assert.equal(response.status, 503)
        assert.equal(await remaining([failed.session.id, failedChild.session.id]), 2, 'audit failure rolls back the entire SLO family mutation')
      } finally { await pool.query(`alter table enterprise_audit_outbox drop constraint "${constraint}"`) }
      assert.equal((await send(signedRequest(samlSubject, failed.snapshot.sessionIndex))).status, 200)
      assert.equal(await remaining([failed.session.id, failedChild.session.id]), 0)
      assert.ok(errors.some(entry => entry[0] === '[enterprise] SAML logout unavailable'))
      assert.ok(!JSON.stringify(errors).includes(failed.token) && !JSON.stringify(errors).includes(failedChild.token))
    } finally {
      await web.close()
      await pool.query('delete from session where id=any($1::text[])', [roots])
    }
  })
  await t.test('SAML root deletion fences concurrent handoffs and bulk family revocation without a missed child or FK deadlock', async () => {
    const { inheritEnterpriseSession } = await import('./session-handoff')
    const { auth: applicationAuth } = await import('../auth')
    const { internalAdapter } = await applicationAuth.$context
    const created: string[] = []
    const source = async () => {
      const login = await samlLogin(), active = await session(login.jar); assert.ok(active); created.push(active.session.id)
      return active
    }
    const targetSession = async (id: string) => { const value = await internalAdapter.createSession(id); assert.ok(value); created.push(value.id); return value }
    const until = async (ready: () => Promise<boolean>) => {
      const deadline = Date.now() + 3000
      while (!await ready()) { assert.ok(Date.now() < deadline, 'the database lock barrier must become observable'); await delay(10) }
    }
    const blocker = await pool.connect(), revoker = await pool.connect()
    const blockerPid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid
    const revokerPid = (await revoker.query('select pg_backend_pid() as pid')).rows[0].pid
    const pending: Promise<unknown>[] = []
    try {
      const root = await source(), child = await targetSession(root.user.id)
      await blocker.query('begin'); await blocker.query('select id from session where id=$1 for update', [child.id])
      const derived = inheritEnterpriseSession(root.session.id, child.id, root.user.id).then(value => ({ value, code: undefined }), error => ({ value: false, code: error.code ?? error.name })); pending.push(derived)
      await until(async () => (await pool.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked', [blockerPid])).rows[0].blocked)
      await revoker.query('begin')
      const removed = revoker.query('delete from session where id=$1', [root.session.id]).then(() => ({ code: undefined }), error => ({ code: error.code ?? error.name })); pending.push(removed)
      await until(async () => (await pool.query('select cardinality(pg_blocking_pids($1))>0 as blocked', [revokerPid])).rows[0].blocked)
      await blocker.query('commit')
      assert.deepEqual(await derived, { value: true, code: undefined })
      assert.equal((await removed).code, undefined)
      await revoker.query('commit')
      assert.equal((await pool.query('select count(*) from session where id=any($1::text[])', [[root.session.id, child.id]])).rows[0].count, '0', 'root deletion cannot miss a child admitted while it waited')

      const lostRoot = await source(), lostTarget = await targetSession(lostRoot.user.id)
      await blocker.query('begin'); await blocker.query('delete from session where id=$1', [lostRoot.session.id])
      const refused = inheritEnterpriseSession(lostRoot.session.id, lostTarget.id, lostRoot.user.id).then(value => ({ value, code: undefined }), error => ({ value: true, code: error.code ?? error.name })); pending.push(refused)
      await until(async () => (await pool.query('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked', [blockerPid])).rows[0].blocked)
      await blocker.query('commit')
      assert.deepEqual(await refused, { value: false, code: undefined })
      assert.equal((await pool.query('select "enterpriseIdentityId" from session where id=$1', [lostTarget.id])).rows[0].enterpriseIdentityId, null)

      const family = await source(), familyChild = await targetSession(family.user.id)
      assert.equal(await inheritEnterpriseSession(family.session.id, familyChild.id, family.user.id), true)
      const spare = await targetSession(family.user.id)
      await pool.query(`update session target set ("enterpriseOrganizationId","enterpriseProviderId","enterpriseIdentityId","enterpriseSamlRootSessionId") =
        (select "enterpriseOrganizationId","enterpriseProviderId","enterpriseIdentityId",id from session where id=$2) where target.id=$1`, [spare.id, family.session.id])
      const identity = (await pool.query('select "enterpriseIdentityId" from session where id=$1', [family.session.id])).rows[0].enterpriseIdentityId
      const hashes = (await pool.query('select "nameIdHash","sessionIndexHash" from enterprise_saml_session_lineage where "sessionId"=$1', [family.session.id])).rows[0]
      for (const [rootId, uid, org, pid, identityId] of [[familyChild.id, family.user.id, organizationId, samlProviderId, identity],
        [family.session.id, adminId, organizationId, samlProviderId, identity], [family.session.id, family.user.id, otherOrganizationId, samlProviderId, identity],
        [family.session.id, family.user.id, organizationId, otherProviderId, identity], [family.session.id, family.user.id, organizationId, samlProviderId, randomUUID()]])
        await assert.rejects(pool.query('insert into enterprise_saml_session_lineage ("sessionId","rootSessionId","userId","organizationId","providerId","identityId","nameIdHash","sessionIndexHash") values($1,$2,$3,$4,$5,$6,$7,$8)',
          [spare.id, rootId, uid, org, pid, identityId, hashes.nameIdHash, hashes.sessionIndexHash]), error => (error as { code?: string }).code === '23514')
      await blocker.query('begin'); await blocker.query('delete from session where id=$1', [familyChild.id])
      await revoker.query('begin')
      const familyRemoved = revoker.query('delete from session where id=$1', [family.session.id]).then(() => ({ code: undefined }), error => ({ code: error.code ?? error.name })); pending.push(familyRemoved)
      await until(async () => (await pool.query('select cardinality(pg_blocking_pids($1))>0 as blocked', [revokerPid])).rows[0].blocked)
      await blocker.query('commit')
      assert.equal((await familyRemoved).code, undefined, 'a child deletion cannot deadlock root FK cascade')
      await revoker.query('commit')
      assert.equal((await pool.query('select count(*) from enterprise_saml_session_lineage where "rootSessionId"=$1', [family.session.id])).rows[0].count, '0')

      const bulk = await source(), bulkChild = await targetSession(bulk.user.id), bulkDescendant = await targetSession(bulk.user.id)
      assert.equal(await inheritEnterpriseSession(bulk.session.id, bulkChild.id, bulk.user.id), true)
      assert.equal(await inheritEnterpriseSession(bulkChild.id, bulkDescendant.id, bulk.user.id), true)
      await pool.query('delete from session where id=any($1::text[])', [[bulk.session.id, bulkChild.id, bulkDescendant.id]])
      assert.equal((await pool.query('select count(*) from session where id=any($1::text[])', [[bulk.session.id, bulkChild.id, bulkDescendant.id]])).rows[0].count, '0', 'native FK cascade also supports a single bulk DELETE containing root and descendants')
      assert.equal((await pool.query('select count(*) from enterprise_saml_session_lineage where "rootSessionId"=$1', [bulk.session.id])).rows[0].count, '0')
    } finally {
      await blocker.query('rollback'); blocker.release()
      await revoker.query('rollback'); revoker.release()
      await Promise.allSettled(pending)
      await pool.query('delete from session where id=any($1::text[])', [created])
    }
  })
  await t.test('SCIM user and group delivery failures persist and replay without duplicate identities or audit events', async () => {
    const document = { schemas: [SCIM_USER], externalId: `retry-${randomUUID()}`, userName: `${randomUUID()}@${oidcDomain}`, active: true }
    failNextUserDelivery = true
    assert.equal((await requestScim('Users', 'POST', document)).status, 500)
    const pending = (await pool.query('select u.id,u."userId",o.id as "eventId" from enterprise_scim_user u join enterprise_scim_outbox o on o."resourceId"=u.id where u."externalId"=$1 and o."deliveredAt" is null', [document.externalId])).rows[0]
    assert.ok(pending)
    const repeated = await requestScim('Users', 'POST', document)
    assert.equal(repeated.status, 200); assert.equal((await repeated.json()).id, pending.id)
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where id=$1', [pending.eventId])).rows[0].count, '1')
    assert.equal((await pool.query('select status from mikka_organization_members where "organizationId"=$1 and "userId"=$2', [organizationId, pending.userId])).rows[0].status, 'active')
    const group = { schemas: [SCIM_GROUP], externalId: `retry-group-${randomUUID()}`, displayName: 'Retry group', members: [{ value: pending.id }] }
    failNextGroupDelivery = true
    assert.equal((await requestScim('Groups', 'POST', group)).status, 500)
    const repeatedGroup = await requestScim('Groups', 'POST', group)
    assert.equal(repeatedGroup.status, 200)
    const groupId = (await repeatedGroup.json()).id
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where "targetId"=$1 and action=\'scim.group_changed\'', [groupId])).rows[0].count, '1')
    assert.equal((await pool.query('select count(*) from enterprise_scim_outbox where "connectionId"=$1 and "deliveredAt" is null', [connectionId])).rows[0].count, '0')
    assert.equal((await pool.query('select count(*) from mikka_workspace_members where "userId"=$1', [pending.userId])).rows[0].count, '0')
  })
  await t.test('account deletion retains Org SSO configuration, peer identities and audit while revoking only the departing account', async () => {
    const org = await import('../governance/organizations')
    const { deleteAccount } = await import('../account/delete')
    const { requestAccountDeletion, cancelAccountDeletion } = await import('../account/deletion-jobs')
    const { synchronizeEnterpriseLogin } = await import('./lifecycle')
    const creator = { id: randomUUID(), name: 'Provider creator', email: `${randomUUID()}@creator.example.invalid` }
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,true,now(),now())', [creator.id, creator.name, creator.email])
    const solelyOwned = await org.createOrganization(creator, { name: 'Account owner boundary fixture' })
    await org.addOrganizationMember(otherOrganizationId, adminId, { userId: creator.id, role: 'admin' })
    await pool.query('update enterprise_sso_provider set "userId"=$1 where "providerId"=$2', [creator.id, otherProviderId])
    const peerSubject = `retained-peer-${randomUUID()}`, peerEmail = `${randomUUID()}@${otherDomain}`
    const created = await requestScim('Users', 'POST', { schemas: [SCIM_USER], externalId: peerSubject, userName: peerEmail, active: true }, otherConnectionId, otherBearer)
    assert.equal(created.status, 201, await created.clone().text())
    const peerDirectoryId = (await created.json()).id as string
    const peer = (await pool.query('select * from enterprise_scim_user where id=$1', [peerDirectoryId])).rows[0]
    assert.ok(peer.userId)
    const loginPeer = async () => {
      const previous = oidcIdentity
      try {
        oidcIdentity = { subject: peerSubject, email: peerEmail }
        const { jar, url } = await startSso(otherProviderId)
        const authorize = await fetch(url, { redirect: 'manual' })
        assert.equal(authorize.status, 302)
        const callback = await fetch(authorize.headers.get('location')!, { headers: { cookie: jar.header() }, redirect: 'manual' })
        jar.take(callback)
        const authenticated = await session(jar)
        assert.equal(authenticated?.user.id, peer.userId)
        return authenticated!
      } finally { oidcIdentity = previous }
    }
    await loginPeer()
    const identity = (await pool.query('select id,"directoryUserId" from enterprise_identity where "userId"=$1 and "providerId"=$2', [peer.userId, otherProviderId])).rows[0]
    assert.equal(identity.directoryUserId, peerDirectoryId)

    // Both delayed identity writers reuse the same canonical account barrier.
    // These values come from a completed real OIDC/SCIM exchange, not a grant.
    const peerDeletion = await requestAccountDeletion(peer.userId, peerEmail, randomUUID(), { mainPool: pool, workspacePool: pool })
    assert.ok(peerDeletion.ok)
    await pool.query('delete from mikka_organization_members where "organizationId"=$1 and "userId"=$2', [otherOrganizationId, peer.userId])
    const pendingAccount = (error: unknown) => /account_deletion_pending/.test(String((error as { cause?: unknown }).cause ?? error))
    await assert.rejects(synchronizeEnterpriseLogin({ organizationId: otherOrganizationId, providerId: otherProviderId, directoryUserId: peerDirectoryId, identityId: identity.id, userId: peer.userId }), pendingAccount)
    const delayed = await requestScim(`Users/${peerDirectoryId}`, 'PATCH', { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'displayName', value: 'Retained peer' }] }, otherConnectionId, otherBearer)
    assert.equal(delayed.status, 500, 'committed SCIM state cannot recreate membership behind the deletion guard')
    assert.equal((await pool.query('select count(*) from mikka_organization_members where "organizationId"=$1 and "userId"=$2', [otherOrganizationId, peer.userId])).rows[0].count, '0')
    const intent = (await pool.query('select id from enterprise_scim_outbox where "connectionId"=$1 and "resourceId"=$2 and "deliveredAt" is null', [otherConnectionId, peerDirectoryId])).rows[0]
    assert.ok(intent)
    assert.equal(await cancelAccountDeletion(peer.userId, peerDeletion.id, { mainPool: pool, workspacePool: pool }), true)
    await scimStore.drain({ id: otherConnectionId, organizationId: otherOrganizationId, providerId: otherProviderId })
    assert.equal((await pool.query('select status from mikka_organization_members where "organizationId"=$1 and "userId"=$2', [otherOrganizationId, peer.userId])).rows[0].status, 'active')
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where id=$1', [intent.id])).rows[0].count, '1')
    assert.ok((await pool.query('select "deliveredAt" from enterprise_scim_outbox where id=$1', [intent.id])).rows[0].deliveredAt)

    const { auth: applicationAuth } = await import('../auth')
    const creatorSession = await (await applicationAuth.$context).internalAdapter.createSession(creator.id)
    assert.ok(creatorSession)
    const personal = randomUUID(), patId = randomUUID()
    await pool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,'Creator personal','personal')`, [personal, creator.id])
    await pool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$3,$4,'admin')`, [personal, creator.id, creator.name, creator.email])
    await pool.query(`insert into personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint,scopes) values($1,$2,$3,'Creator fixture',$4,'test',ARRAY['legacy:full']::text[])`, [patId, creator.id, personal, identityTokenHash(randomUUID())])
    const refused = await fetch(`${appOrigin}/api/account/deletion`, { method: 'POST',
      headers: { origin: appOrigin, cookie: await applicationCookie(creatorSession.token), 'content-type': 'application/json' },
      body: JSON.stringify({ email: creator.email, requestId: randomUUID() }) })
    assert.equal(refused.status, 409, await refused.clone().text())
    assert.deepEqual(await refused.json(), { error: 'accountLastOrganizationOwner' })
    assert.equal((await pool.query('select count(*) from account_deletion_guards where "subjectId"=$1', [creator.id])).rows[0].count, '0')
    assert.equal((await pool.query('select count(*) from session where id=$1', [creatorSession.id])).rows[0].count, '1')
    await org.addOrganizationMember(solelyOwned.id, creator.id, { userId: adminId, role: 'owner' })
    const configQuery = `select id,"providerId",issuer,domain,"domainVerified",
      encode(sha256(convert_to(coalesce("oidcConfig",''),'UTF8')),'hex') as "oidcDigest",
      encode(sha256(convert_to(coalesce("samlConfig",''),'UTF8')),'hex') as "samlDigest"
      from enterprise_sso_provider where "providerId"=$1`
    const beforeProvider = (await pool.query(configQuery, [otherProviderId])).rows
    const beforeAudit = (await pool.query('select * from mikka_organization_audit_events where "actorId"=$1 order by id', [creator.id])).rows
    assert.ok(beforeAudit.length > 0)
    let cleanupCalls = 0
    assert.deepEqual(await deleteAccount(creator.id, creator.email, { mainPool: pool, workspacePool: pool,
      externalCleanup: async owner => { assert.equal(owner, creator.id); cleanupCalls++; return [] },
      deleteObject: async () => { throw new Error('Unexpected fixture storage cleanup') } }), { ok: true })
    assert.equal(cleanupCalls, 1)
    assert.deepEqual((await pool.query(configQuery, [otherProviderId])).rows, beforeProvider, 'the shared provider and encrypted configuration are retained byte-for-byte')
    assert.equal((await pool.query('select "userId" from enterprise_sso_provider where "providerId"=$1', [otherProviderId])).rows[0].userId, null, 'the original FK removes only creator attribution')
    assert.equal((await pool.query('select count(*) from "user" where id=$1', [creator.id])).rows[0].count, '0')
    assert.equal((await pool.query('select count(*) from session where "userId"=$1', [creator.id])).rows[0].count, '0')
    assert.equal((await pool.query('select count(*) from personal_access_tokens where id=$1', [patId])).rows[0].count, '0')
    assert.equal((await pool.query('select count(*) from mikka_organization_members where "userId"=$1', [creator.id])).rows[0].count, '0')
    const afterAudit = (await pool.query('select * from mikka_organization_audit_events where "actorId"=$1 order by id', [creator.id])).rows
    const retainedIds = new Set(beforeAudit.map(row => row.id))
    assert.deepEqual(afterAudit.filter(row => retainedIds.has(row.id)), beforeAudit, 'every preexisting audit row is retained unchanged')
    const removals = afterAudit.filter(row => !retainedIds.has(row.id))
    assert.deepEqual(removals.map(row => row.organizationId).sort(), [otherOrganizationId, solelyOwned.id].sort())
    for (const event of removals) {
      assert.equal(event.action, 'organization.member_removed'); assert.equal(event.targetId, creator.id)
      assert.equal(event.result, 'success'); assert.deepEqual(event.metadata, { reason: 'account_deletion' })
    }
    assert.equal((await pool.query('select count(*) from enterprise_identity where id=$1 and "userId"=$2', [identity.id, peer.userId])).rows[0].count, '1')
    assert.equal((await requestScim(`Users/${peerDirectoryId}`, 'GET', undefined, otherConnectionId, otherBearer)).status, 200)
    await loginPeer()
    await org.renameOrganization(solelyOwned.id, adminId, { name: 'Still manageable by remaining owner' })
  })
  await t.test('completed account deletion drains pending SCIM intent without restoring the account or blocking the next member', async () => {
    const { requestAccountDeletion, resumeAccountDeletion } = await import('../account/deletion-jobs')
    const externalId = `departed-directory-${randomUUID()}`, directoryEmail = `${randomUUID()}@${otherDomain}`
    const created = await requestScim('Users', 'POST', { schemas: [SCIM_USER], externalId, userName: directoryEmail, active: true }, otherConnectionId, otherBearer)
    assert.equal(created.status, 201, await created.clone().text())
    const id = (await created.json()).id as string
    const subjectId = (await pool.query('select "userId" from enterprise_scim_user where id=$1', [id])).rows[0].userId as string
    assert.ok(subjectId)
    const previous = oidcIdentity
    try {
      oidcIdentity = { subject: externalId, email: directoryEmail }
      const { jar, url } = await startSso(otherProviderId)
      const authorize = await fetch(url, { redirect: 'manual' })
      assert.equal(authorize.status, 302)
      const callback = await fetch(authorize.headers.get('location')!, { headers: { cookie: jar.header() }, redirect: 'manual' })
      jar.take(callback); assert.equal((await session(jar))?.user.id, subjectId)
    } finally { oidcIdentity = previous }
    assert.equal((await pool.query('select count(*) from enterprise_identity where "userId"=$1', [subjectId])).rows[0].count, '1')
    const personal = randomUUID(), patId = randomUUID()
    await pool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,'Directory personal','personal')`, [personal, subjectId])
    await pool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,'Directory user',$3,'admin')`, [personal, subjectId, directoryEmail])
    await pool.query(`insert into personal_access_tokens(id,"userId","workspaceId",name,"tokenHash",hint,scopes) values($1,$2,$3,'Directory fixture',$4,'test',ARRAY['legacy:full']::text[])`, [patId, subjectId, personal, identityTokenHash(randomUUID())])
    let cleanups = 0
    const options = { mainPool: pool, workspacePool: pool, externalCleanup: async () => { cleanups++; return [] as string[] }, deleteObject: async () => { throw new Error('Unexpected directory fixture storage cleanup') } }
    const deletion = await requestAccountDeletion(subjectId, directoryEmail, randomUUID(), options)
    assert.ok(deletion.ok)
    const pending = await requestScim(`Users/${id}`, 'PATCH', { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'displayName', value: 'Directory-owned profile' }] }, otherConnectionId, otherBearer)
    assert.equal(pending.status, 500)
    const intent = (await pool.query('select id from enterprise_scim_outbox where "resourceId"=$1 and "deliveredAt" is null', [id])).rows[0]
    assert.ok(intent)
    assert.equal((await resumeAccountDeletion(deletion.id, options)).stage, 'completed')
    assert.equal(cleanups, 1)
    const retainedDirectory = (await pool.query('select id,"userId",active,deleted from enterprise_scim_user where id=$1', [id])).rows[0]
    assert.deepEqual(retainedDirectory, { id, userId: null, active: true, deleted: false }, 'the corporate directory remains SCIM-managed; only its deleted account link is cleared')
    for (const table of ['session', 'personal_access_tokens', 'enterprise_identity', 'mikka_organization_members', 'mikka_workspace_members']) {
      assert.equal((await pool.query(`select count(*) from "${table}" where "userId"=$1`, [subjectId])).rows[0].count, '0')
    }
    assert.equal((await pool.query('select count(*) from "user" where id=$1', [subjectId])).rows[0].count, '0')
    await scimStore.drain({ id: otherConnectionId, organizationId: otherOrganizationId, providerId: otherProviderId })
    assert.ok((await pool.query('select "deliveredAt" from enterprise_scim_outbox where id=$1', [intent.id])).rows[0].deliveredAt)
    const event = (await pool.query('select action,metadata from mikka_organization_audit_events where id=$1', [intent.id])).rows[0]
    assert.equal(event.action, 'scim.user_updated'); assert.equal(event.metadata.status, 'pending_link')
    await scimStore.drain({ id: otherConnectionId, organizationId: otherOrganizationId, providerId: otherProviderId })
    assert.equal((await pool.query('select count(*) from mikka_organization_audit_events where id=$1', [intent.id])).rows[0].count, '1')
    assert.equal((await pool.query('select count(*) from mikka_organization_members where "userId"=$1', [subjectId])).rows[0].count, '0')
    assert.equal((await pool.query('select count(*) from mikka_workspace_members where "userId"=$1', [subjectId])).rows[0].count, '0')
    const nextExternal = `after-deletion-${randomUUID()}`
    const next = await requestScim('Users', 'POST', { schemas: [SCIM_USER], externalId: nextExternal, userName: `${randomUUID()}@${otherDomain}`, active: true }, otherConnectionId, otherBearer)
    assert.equal(next.status, 201, await next.clone().text())
    const nextId = (await next.json()).id as string
    const nextUser = (await pool.query('select "userId" from enterprise_scim_user where id=$1', [nextId])).rows[0].userId
    assert.equal((await pool.query('select status from mikka_organization_members where "organizationId"=$1 and "userId"=$2', [otherOrganizationId, nextUser])).rows[0].status, 'active')
  })
  await t.test('SCIM disable revokes two organization workspaces, phone delivery and PATs while retaining personal/other organization identity', async t => {
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
    const cacheToken = (await pool.query('select token from session where id=$1', [signedIn.session.id])).rows[0].token as string
    assert.deepEqual(await cacheNamespace(cacheToken, wsA), { workspaceId: wsA, role: 'member' })
    const phone = await phoneFixture(t, wsA)
    const destination = await phone.register(cacheToken, signedIn.session.id)
    assert.deepEqual(await phone.push(), [destination])
    assert.equal(await enterpriseWorkspaceAllowed(userId, personal, { kind: 'session', sessionId: 'wrong' }), true)
    const tokenA = randomUUID(), tokenOther = randomUUID()
    for (const [id, workspaceId] of [[tokenA, wsA], [tokenOther, other]]) await pool.query('insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint,scopes) values ($1,$2,$3,\'Fixture\',$4,\'test\',ARRAY[\'legacy:full\']::text[])', [id, userId, workspaceId, identityTokenHash(randomUUID())])
    const issueId = randomUUID()
    await pool.query('insert into issues(id,"userId","workspaceId",title,content,status,priority) values($1,$2,$3,\'Enterprise phone target fixture\',$4,\'todo\',\'normal\')',
      [issueId, userId, wsA, { type: 'doc' }])
    t.after(async () => { await pool.query('delete from issues where id=$1', [issueId]) })
    const { actAs } = await import('../acting-user')
    const { tokenWorkspace } = await import('../tokens/principal')
    // This existing other-Workspace PAT cannot replace the registered phone's
    // real OIDC session when the target reader rechecks the enforced Org.
    const targetPush = () => actAs({ id: userId, [tokenWorkspace]: other,
      [enterprisePrincipal]: { kind: 'pat', tokenId: tokenOther, workspaceId: other } },
    () => phone.push({ issueId, runId: null }))
    assert.deepEqual(await targetPush(), [destination], 'task target authorization keeps the actual OIDC receiver despite a foreign ambient PAT')
    assert.equal(await enterpriseWorkspaceAllowed(userId, wsA, { kind: 'pat', tokenId: tokenA, workspaceId: wsA }), false)
    await pool.query('update enterprise_org_policy set "allowMachineCredentials"=true where "organizationId"=$1', [organizationId])
    assert.equal(await enterpriseWorkspaceAllowed(userId, wsA, { kind: 'pat', tokenId: tokenA, workspaceId: wsA }), true)
    const current = await requestScim(`Users/${directoryId}`)
    const invalidEtag = await requestScim(`Users/${directoryId}`, 'PATCH', { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] }, connectionId, bearer, { 'if-match': 'W/"0"' })
    assert.equal(invalidEtag.status, 412)
    const disabled = await requestScim(`Users/${directoryId}`, 'PATCH', { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] }, connectionId, bearer, { 'if-match': current.headers.get('etag')! })
    assert.equal(disabled.status, 200, await disabled.clone().text())
    assert.deepEqual(await phone.push(), [], 'committed SCIM suspension prevents delivery to a previously admitted native session')
    assert.deepEqual(await targetPush(), [], 'SCIM suspension also blocks a task target for the same registered OIDC receiver')
    await assertLogoutTarget(await logoutTargetFor(cacheToken), null)
    for (const id of [wsA, wsB]) {
      assert.equal(await enterpriseWorkspaceAllowed(userId, id, principal), false)
      assert.equal(await cacheNamespace(cacheToken, id), null, 'SCIM suspension cannot hydrate an earlier authorized cache namespace')
    }
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
  await t.test('revoking a provisioning connection closes unenforced workspace access and rejects old bearer replay', async () => {
    const listed = await requestScim('Users')
    const active = (await listed.json()).Resources.find((resource: { active: boolean }) => resource.active)
    assert.ok(active)
    const managedId = (await pool.query('select "userId" from enterprise_scim_user where id=$1', [active.id])).rows[0].userId
    const workspaceId = randomUUID()
    await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,\'Revocation fixture\',\'team\')', [workspaceId, managedId])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,\'Managed\',$3,\'member\',\'active\')', [workspaceId, managedId, active.userName])
    await pool.query('insert into mikka_organization_workspaces ("workspaceId","organizationId") values ($1,$2)', [workspaceId, organizationId])
    await pool.query('update enterprise_org_policy set "enforceSso"=false where "organizationId"=$1', [organizationId])
    assert.equal(await enterpriseWorkspaceAllowed(managedId, workspaceId), true)
    // A downstream outage cannot reopen access after the connection fence commits.
    failNextUserDelivery = true
    await assert.rejects(scimStore.revokeConnection(organizationId, connectionId), /Fixture delivery unavailable/)
    assert.equal(await enterpriseWorkspaceAllowed(managedId, workspaceId), false)
    assert.equal((await requestScim('Users')).status, 401)
    const adminSessionId = randomUUID()
    await pool.query('insert into session(id,token,"userId","expiresAt","createdAt","updatedAt") values($1,$2,$3,now()+interval \'1 hour\',now(),now())', [adminSessionId, randomUUID(), adminId])
    const { manageIdentity } = await import('./management')
    assert.deepEqual(await manageIdentity(organizationId, { user: { id: adminId }, session: { id: adminSessionId } },
      { action: 'revoke-scim', connectionId }, appOrigin), { revoked: true }, 'administrative retry must drain the outbox after releasing its Organization authorization lease')
    assert.equal((await pool.query('select status from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [workspaceId, managedId])).rows[0].status, 'suspended')
    assert.equal((await pool.query('select count(*) from enterprise_scim_outbox where "connectionId"=$1 and "deliveredAt" is null', [connectionId])).rows[0].count, '0')
    const denied = await oidcLogin(); assert.equal(await session(denied.jar), null)
  })
})
