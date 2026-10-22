import assert from 'node:assert/strict'
import { test } from 'node:test'
import { betterAuth } from 'better-auth'
import { oAuthProxy } from 'better-auth/plugins'
import { authOAuthProxyOptions, authTrustedOrigins, resolveAppOrigin } from './auth-config'

const hub = 'https://app.aspectlylabs.com'
const preview = 'https://mikka-preview.example.com'
const proxyEnv = { BETTER_AUTH_OAUTH_PROXY_URL: hub, BETTER_AUTH_OAUTH_PROXY_SECRET: 'test-only-shared-proxy-secret-with-entropy' }

test('Preview chooses its deployment origin and keeps explicit configuration authoritative', () => {
  const env = { VERCEL_URL: 'mikka-preview.example.com', VERCEL_PROJECT_PRODUCTION_URL: 'app.aspectlylabs.com', VERCEL_ENV: 'preview' }
  assert.equal(resolveAppOrigin(env), preview)
  assert.equal(resolveAppOrigin({ ...env, BETTER_AUTH_URL: `${hub}/` }), hub)
  assert.equal(resolveAppOrigin({ ...env, VERCEL_ENV: 'production' }), hub)
  assert.equal(resolveAppOrigin({ V0_RUNTIME_URL: preview }), preview)
  assert.equal(resolveAppOrigin({ CF_PAGES_URL: preview }), preview)
  assert.equal(resolveAppOrigin({}), undefined)
})

test('trusts exact configured cloud origins in production and validates origin syntax', () => {
  assert.deepEqual(authTrustedOrigins({ NODE_ENV: 'production', VERCEL_URL: 'mikka-preview.example.com', V0_BUILD_URL: 'https://mikka-v0.example.com', CF_PAGES_URL: 'https://mikka-cf.example.com', AUTH_TRUSTED_ORIGINS: `${hub}, https://*.preview.example.com` }), [preview, 'https://mikka-v0.example.com', 'https://mikka-cf.example.com', hub, 'https://*.preview.example.com'])
  for (const value of ['http://localhost:3000', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com?query=1', 'https://example.com#fragment', 'https://*']) {
    assert.throws(() => authTrustedOrigins({ AUTH_TRUSTED_ORIGINS: value }))
  }
  assert.deepEqual(authTrustedOrigins({}), [])
})

test('proxy requires both explicit settings and an HTTPS hub origin', () => {
  assert.deepEqual(authOAuthProxyOptions(proxyEnv), { productionURL: hub, secret: proxyEnv.BETTER_AUTH_OAUTH_PROXY_SECRET })
  assert.equal(authOAuthProxyOptions({ BETTER_AUTH_OAUTH_PROXY_URL: hub }), undefined)
  assert.equal(authOAuthProxyOptions({ BETTER_AUTH_OAUTH_PROXY_SECRET: 'test-only' }), undefined)
  assert.throws(() => authOAuthProxyOptions({ ...proxyEnv, BETTER_AUTH_OAUTH_PROXY_URL: 'http://localhost:3000' }))
  assert.throws(() => authOAuthProxyOptions({ ...proxyEnv, BETTER_AUTH_OAUTH_PROXY_URL: 'https://*.example.com' }))
})

test('development and explicit hosted CI allow HTTP loopback origins while the proxy hub always requires HTTPS', () => {
  for (const origin of ['http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100']) {
    assert.deepEqual(authTrustedOrigins({ NODE_ENV: 'development', BETTER_AUTH_URL: origin }), [origin])
    assert.deepEqual(authTrustedOrigins({ CI: 'true', BETTER_AUTH_URL: origin }), [origin])
    assert.throws(() => authTrustedOrigins({ BETTER_AUTH_URL: origin }))
    assert.throws(() => authTrustedOrigins({ CI: 'false', BETTER_AUTH_URL: origin }))
    assert.throws(() => authOAuthProxyOptions({ ...proxyEnv, CI: 'true', BETTER_AUTH_OAUTH_PROXY_URL: origin }))
  }
  assert.throws(() => authTrustedOrigins({ CI: 'true', BETTER_AUTH_URL: 'http://preview.example.com' }))
  assert.throws(() => authTrustedOrigins({ CI: 'true', BETTER_AUTH_URL: 'http://localhost.attacker.com' }))
})

function previewAuth() {
  const env = { ...proxyEnv, BETTER_AUTH_URL: preview, AUTH_TRUSTED_ORIGINS: 'https://*.preview.example.com' }
  return betterAuth({
    baseURL: resolveAppOrigin(env),
    basePath: '/mikka/api/auth',
    secret: 'test-only-environment-secret-with-sufficient-entropy',
    trustedOrigins: authTrustedOrigins(env),
    socialProviders: { google: { clientId: 'test-client', clientSecret: 'test-secret' } },
    plugins: [oAuthProxy(authOAuthProxyOptions(env)!)],
    logger: { disabled: true },
  })
}

test('real Better Auth Preview initiation sends Google to the stable hub callback', async () => {
  const auth = previewAuth()
  const response = await auth.handler(new Request(`${preview}/mikka/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: preview },
    body: JSON.stringify({ provider: 'google', callbackURL: '/mikka', disableRedirect: true }),
  }))
  assert.equal(response.status, 200)
  const result = await response.json()
  const providerURL = new URL(result.url)
  assert.equal(providerURL.searchParams.get('redirect_uri'), `${hub}/mikka/api/auth/callback/google`)
  assert.ok(providerURL.searchParams.get('state'))
  assert.ok(response.headers.get('set-cookie'))
})

test('real Better Auth rejects foreign origins and lookalike callback hosts', async () => {
  const auth = previewAuth()
  const context = await auth.$context
  assert.equal(context.isTrustedOrigin('https://branch.preview.example.com'), true)
  for (const origin of ['https://unrelated.vercel.app', 'https://branch.preview.example.com.attacker.com', 'http://branch.preview.example.com']) {
    assert.equal(context.isTrustedOrigin(origin), false)
    const response = await auth.handler(new Request(`${preview}/mikka/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: 'probe=1' },
      body: JSON.stringify({ provider: 'google', callbackURL: origin, disableRedirect: true }),
    }))
    assert.equal(response.status, 403)
  }
})

test('Vercel branch aliases can sign out an authenticated session without trusting other deployments', async () => {
  const deployment = 'https://mikka-unique-deployment-mikka-dev.vercel.app'
  const branch = 'https://mikka-git-codex-cloud-preview-secrets-mikka-dev.vercel.app'
  const env = { VERCEL_ENV: 'preview', VERCEL_URL: new URL(deployment).host, VERCEL_BRANCH_URL: new URL(branch).host }
  assert.equal(resolveAppOrigin(env), deployment)
  const auth = betterAuth({
    baseURL: resolveAppOrigin(env), basePath: '/mikka/api/auth',
    secret: 'test-only-branch-alias-secret-with-sufficient-entropy',
    emailAndPassword: { enabled: true }, trustedOrigins: authTrustedOrigins(env), logger: { disabled: true },
  })
  const signedIn = await auth.api.signUpEmail({
    body: { name: 'Preview User', email: 'alias@example.com', password: 'test-only-preview-password' }, asResponse: true,
  })
  assert.equal(signedIn.status, 200)
  const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const session = await auth.handler(new Request(`${branch}/mikka/api/auth/get-session`, { headers: { cookie } }))
  assert.equal((await session.json()).user.email, 'alias@example.com')
  for (const origin of ['https://unrelated.vercel.app', branch]) {
    const signedOut = await auth.handler(new Request(`${branch}/mikka/api/auth/sign-out`, {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}',
    }))
    assert.equal(signedOut.status, origin === branch ? 200 : 403)
    if (origin === branch) assert.deepEqual(await signedOut.json(), { success: true })
  }
})

test('changing v0 hosts complete signed proxy login through a hub that trusts only itself', async (t) => {
  const tokenEndpoint = 'https://github.com/login/oauth/access_token'
  const providerRequests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    providerRequests.push(url)
    if (url === tokenEndpoint) return Response.json({ access_token: 'test-provider-access-token', token_type: 'bearer', scope: 'read:user,user:email' })
    if (url === 'https://api.github.com/user') return Response.json({ id: 123, login: 'preview-user', name: 'Preview User', email: 'preview@example.com' })
    if (url === 'https://api.github.com/user/emails') return Response.json([{ email: 'preview@example.com', primary: true, verified: true }])
    throw new Error(`Unexpected provider request: ${url}`)
  })
  function cloudAuth(env: Record<string, string>) {
    return betterAuth({
      baseURL: resolveAppOrigin(env), basePath: '/mikka/api/auth',
      secret: `test-only-independent-main-secret-${resolveAppOrigin(env)}`,
      trustedOrigins: authTrustedOrigins(env),
      socialProviders: { github: { clientId: 'test-client', clientSecret: 'test-client-secret' } },
      plugins: [oAuthProxy(authOAuthProxyOptions(env)!)],
      logger: { disabled: true },
    })
  }
  const hubAuth = cloudAuth({ ...proxyEnv, BETTER_AUTH_URL: hub })
  const hubContext = await hubAuth.$context
  assert.deepEqual([...new Set(hubContext.trustedOrigins)], [hub])
  for (const origin of ['https://ios-kn1ogl39.v0.build', 'https://ios-next-preview.v0.build']) {
    assert.equal(hubContext.isTrustedOrigin(origin), false)
    const auth = cloudAuth({ ...proxyEnv, V0_RUNTIME_URL: origin })
    const initiation = await auth.handler(new Request(`${origin}/mikka/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ provider: 'github', callbackURL: '/mikka', disableRedirect: true }),
    }))
    assert.equal(initiation.status, 200)
    const providerURL = new URL((await initiation.json()).url)
    assert.equal(providerURL.searchParams.get('redirect_uri'), `${hub}/mikka/api/auth/callback/github`)
    const callback = new URL(`${hub}/mikka/api/auth/callback/github`)
    callback.search = new URLSearchParams({ code: 'test-provider-code', state: providerURL.searchParams.get('state')! }).toString()
    const forgedCallback = new URL(callback)
    forgedCallback.searchParams.set('state', 'not-a-valid-encrypted-proxy-state')
    const requestsBeforeForgery = providerRequests.length
    const rejected = await hubAuth.handler(new Request(forgedCallback))
    assert.equal(new URL(rejected.headers.get('location')!).origin, hub)
    assert.equal(providerRequests.length, requestsBeforeForgery)
    const relayed = await hubAuth.handler(new Request(callback))
    assert.equal(relayed.status, 302)
    const completionURL = new URL(relayed.headers.get('location')!)
    assert.equal(completionURL.origin, origin)
    assert.equal(completionURL.pathname, '/mikka/api/auth/callback/github/oauth-proxy')
    assert.ok(completionURL.searchParams.get('profile'))
    assert.equal(relayed.headers.get('set-cookie'), null)
    const cookie = initiation.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const completed = await auth.handler(new Request(completionURL, { headers: { cookie } }))
    assert.equal(completed.status, 302)
    assert.equal(completed.headers.get('location'), '/mikka')
    const sessionCookie = completed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const session = await auth.handler(new Request(`${origin}/mikka/api/auth/get-session`, { headers: { cookie: sessionCookie } }))
    assert.equal((await session.json()).user.email, 'preview@example.com')
  }
  assert.equal(providerRequests.filter(url => url === tokenEndpoint).length, 2)
})
