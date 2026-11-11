import assert from 'node:assert/strict'
import test from 'node:test'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { oAuthProxy } from 'better-auth/plugins'
import { expo } from '@better-auth/expo'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { authAppleOptions, authSignInMethods, requireAppleSignInNonce } from './auth-config'

test('Apple is enabled for cloud and requires an explicit bundle on community servers', () => {
  assert.equal(authAppleOptions({}), undefined)
  assert.equal(authSignInMethods({}).apple, false)
  assert.deepEqual(authAppleOptions({ MIKKA_EDITION: 'cloud' }), {
    clientId: 'com.aspectlylabs.mikka', appBundleIdentifier: 'com.aspectlylabs.mikka', requireEmailVerification: true,
  })
  assert.equal(authSignInMethods({ MIKKA_EDITION: 'cloud' }).apple, true)
  assert.equal(authAppleOptions({ APPLE_APP_BUNDLE_IDENTIFIER: ' com.example.self ' })?.appBundleIdentifier, 'com.example.self')
  assert.equal(authAppleOptions({ APPLE_APP_BUNDLE_IDENTIFIER: '  ' }), undefined)
})

test('native Apple verifies tokens, preserves verified email linking and refuses secretless browser authorization', async t => {
  const origin = 'https://apple-native.example.test'
  const apple = authAppleOptions({ MIKKA_EDITION: 'cloud' })!
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-apple-key', alg: 'RS256' }
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    assert.equal(String(input), 'https://appleid.apple.com/auth/keys')
    return Response.json({ keys: [jwk] })
  })
  const createAuth = (serverOrigin: string) => betterAuth({ baseURL: serverOrigin, basePath: '/api/auth',
    secret: 'fixture-apple-native-secret-with-sufficient-entropy', logger: { disabled: true },
    emailAndPassword: { enabled: true },
    hooks: { before: createAuthMiddleware(async ctx => { requireAppleSignInNonce(ctx) }) },
    trustedOrigins: [serverOrigin, 'mikka://'], socialProviders: { apple },
    account: { encryptOAuthTokens: true, accountLinking: { trustedProviders: [] } },
    databaseHooks: { account: {
      create: { before: async account => ({ data: { ...account, idToken: null } }) },
      update: { before: async account => ({ data: { ...account, idToken: null } }) },
    } },
    plugins: [expo(), oAuthProxy({ productionURL: 'https://stable-hub.example.test', secret: 'fixture-oauth-proxy-secret-with-sufficient-entropy' })],
  })
  const auth = createAuth(origin)
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const nonce = `${'a'.repeat(64)}.${hash(`${origin}/api/auth`)}`
  const token = (patch: Record<string, unknown> = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      sub: 'fixture-apple-subject', email: 'apple@example.test', email_verified: true, nonce: hash(nonce),
      iss: 'https://appleid.apple.com', aud: apple.appBundleIdentifier, iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300, ...patch,
    })).toString('base64url')
    const body = `${header}.${payload}`
    return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`
  }
  const signIn = (body: unknown, native = true) => auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(native ? { 'x-skip-oauth-proxy': 'true' } : { origin }) }, body: JSON.stringify(body),
  }))
  for (const patch of [{ aud: 'com.example.other' }, { iss: 'https://attacker.example' }, { nonce: 'wrong' }, { exp: 1 }]) {
    const response = await signIn({ provider: 'apple', idToken: { token: token(patch), nonce } })
    assert.equal(response.status, 401)
  }
  assert.equal((await signIn({ provider: 'apple', idToken: { token: token({ sub: 'unverified-apple-subject', email: 'unverified@example.test', email_verified: false }), nonce } })).status, 403)
  for (const missingNonce of [undefined, '', '   ']) {
    assert.equal((await signIn({ provider: 'apple', idToken: { token: token(), nonce: missingNonce } })).status, 401)
  }
  assert.equal((await signIn({ provider: 'apple', idToken: { token: token(), nonce: hash(nonce) } })).status, 401)
  assert.equal((await signIn({ provider: 'apple', idToken: { token: token({ nonce }), nonce } })).status, 401)
  assert.equal((await signIn({ provider: 'apple', idToken: { token: 'malformed', nonce } })).status, 401)
  const communityOrigin = 'https://community.example.test'
  const community = createAuth(communityOrigin)
  const communityNonce = `${'b'.repeat(64)}.${hash(`${communityOrigin}/api/auth`)}`
  const communityToken = token({ sub: 'community-subject', nonce: hash(communityNonce) })
  const acceptedCommunity = await community.handler(new Request(`${communityOrigin}/api/auth/sign-in/social`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-skip-oauth-proxy': 'true' },
    body: JSON.stringify({ provider: 'apple', idToken: { token: communityToken, nonce: communityNonce } }),
  }))
  assert.equal(acceptedCommunity.status, 200)
  assert.equal((await signIn({ provider: 'apple', idToken: { token: communityToken, nonce: communityNonce } })).status, 401)
  const existing = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Existing', email: 'existing@example.test', password: 'fixture-password-123' }),
  }))
  assert.equal(existing.status, 200)
  const existingUser = (await existing.json()).user
  await (await auth.$context).internalAdapter.updateUser(existingUser.id, { emailVerified: true })
  const collision = await signIn({ provider: 'apple', idToken: { token: token({ sub: 'existing-apple-subject', email: 'existing@example.test' }), nonce } })
  assert.equal(collision.status, 200)
  assert.equal((await collision.json()).user.id, existingUser.id)
  const rebound = await signIn({ provider: 'apple', idToken: { token: token({ sub: 'existing-apple-subject', email: 'changed@example.test' }), nonce } })
  assert.equal(rebound.status, 200)
  assert.equal((await rebound.json()).user.id, existingUser.id)
  const unverified = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Unverified', email: 'local-unverified@example.test', password: 'fixture-password-123' }),
  }))
  assert.equal(unverified.status, 200)
  const deniedLink = await signIn({ provider: 'apple', idToken: { token: token({ sub: 'unlinked-apple-subject', email: 'local-unverified@example.test' }), nonce } })
  assert.equal(deniedLink.status, 401)
  assert.equal((await deniedLink.json()).code, 'OAUTH_LINK_ERROR')
  const invalidSignature = token()
  const pieces = invalidSignature.split('.')
  pieces[2] = `${pieces[2][0] === 'a' ? 'b' : 'a'}${pieces[2].slice(1)}`
  assert.equal((await signIn({ provider: 'apple', idToken: { token: pieces.join('.'), nonce } })).status, 401)
  const response = await signIn({ provider: 'apple', idToken: { token: token(), nonce,
    user: { name: { firstName: 'Apple', lastName: 'User' } } } })
  assert.equal(response.status, 200)
  const session = await response.json()
  assert.equal(session.user.email, 'apple@example.test')
  assert.equal(session.user.name, 'Apple User')
  assert.ok(response.headers.get('set-cookie'))
  const browser = await signIn({ provider: 'apple', callbackURL: origin, disableRedirect: true }, false)
  assert.equal(browser.status, 500)
  assert.equal(browser.headers.get('location'), null)
})
