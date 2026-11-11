import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'

const values = new Map<string, string>()
const platform = { OS: 'ios' }
const calls: { provider: string; idToken: { token: string; nonce: string; user?: { name: { firstName?: string; lastName?: string } } } }[] = []
let account = { id: 'legacy', server: { url: 'https://fixture.example/mikka' } }, lost = 0, randomness = 0, reads = 0
let nativeOptions: { nonce: string; requestedScopes: number[] } | undefined
let credential = { identityToken: 'fixture-private-token' as string | null, user: 'fixture-apple-user', fullName: { givenName: 'Apple', familyName: 'User' } as { givenName: string | null; familyName: string | null } | null }
let prompt: () => Promise<typeof credential> = async () => credential
let credentialState: () => Promise<number> = async () => 1
let storedWrite: (key: string, value: string) => Promise<void> = async (key, value) => { values.set(key, value) }
let sessionRead: () => Promise<{ data: { user: { id: string } } | null; error: unknown }> = async () => ({ data: { user: { id: 'fixture-user' } }, error: null })
let revoke: (() => void) | undefined, foreground: ((state: string) => void) | undefined
let revokeRemoved = false, foregroundRemoved = false
mock.module('expo-apple-authentication', { namedExports: {
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 }, AppleAuthenticationCredentialState: { REVOKED: 0, AUTHORIZED: 1, NOT_FOUND: 2 },
  signInAsync: async (options: typeof nativeOptions) => { nativeOptions = options; return prompt() },
  getCredentialStateAsync: async (user: string) => { assert.equal(user, 'fixture-apple-user'); return credentialState() },
  addRevokeListener: (listener: () => void) => { revoke = listener; return { remove: () => { revokeRemoved = true } } },
} })
mock.module('expo-crypto', { namedExports: {
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  getRandomBytesAsync: async (size: number) => { assert.equal(size, 32); return new Uint8Array(size).fill(++randomness) },
  digestStringAsync: async (algorithm: string, value: string) => { assert.equal(algorithm, 'SHA-256'); return createHash('sha256').update(value).digest('hex') },
} })
mock.module('expo-secure-store', { namedExports: {
  getItemAsync: async (key: string) => { reads++; return values.get(key) ?? null },
  setItemAsync: (key: string, value: string) => storedWrite(key, value),
  deleteItemAsync: async (key: string) => { values.delete(key) },
} })
mock.module('react-native', { namedExports: { Platform: platform, AppState: {
  addEventListener: (name: string, listener: (state: string) => void) => { assert.equal(name, 'change'); foreground = listener; return { remove: () => { foregroundRemoved = true } } },
} } })
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { authClient: {
  signIn: { social: async (input: typeof calls[number]) => { assert.equal(values.get('mikka_apple_user'), 'fixture-apple-user', 'the marker exists before a session can be published'); calls.push(input); return { data: { user: { id: 'fixture-user' } }, error: null } } },
  getSession: (input: unknown) => { assert.deepEqual(input, { query: { disableCookieCache: true } }); return sessionRead() },
} } })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => account } })
mock.module(new URL('../lib/session.ts', import.meta.url).href, { namedExports: { endLostSession: async () => { lost++ } } })
const { finishAppleDeletionHandoff, forgetAppleCredential, signInWithApple, watchAppleCredential } = await import('../lib/apple-auth.ts')
const flush = () => new Promise(resolve => setImmediate(resolve))
beforeEach(() => {
  values.clear(); calls.length = 0; lost = 0; reads = 0; nativeOptions = undefined; platform.OS = 'ios'; account = { id: 'legacy', server: { url: 'https://fixture.example/mikka' } }
  revoke = undefined; foreground = undefined; revokeRemoved = false; foregroundRemoved = false
  credential = { identityToken: 'fixture-private-token', user: 'fixture-apple-user', fullName: { givenName: 'Apple', familyName: 'User' } }
  prompt = async () => credential; credentialState = async () => 1
  storedWrite = async (key, value) => { values.set(key, value) }
  sessionRead = async () => ({ data: { user: { id: 'fixture-user' } }, error: null })
})

test('native sign-in hashes a fresh secure nonce and passes the first-consent name to the verified token endpoint', async () => {
  await signInWithApple()
  assert.deepEqual(nativeOptions?.requestedScopes, [0, 1])
  assert.equal(nativeOptions?.nonce, createHash('sha256').update(calls[0].idToken.nonce).digest('hex'))
  assert.match(calls[0].idToken.nonce, /^[a-f0-9]{64}\.[a-f0-9]{64}$/)
  assert.equal(calls[0].idToken.nonce.split('.')[1], createHash('sha256').update('https://fixture.example/mikka/api/auth').digest('hex'))
  assert.equal(calls[0].idToken.token, 'fixture-private-token')
  assert.deepEqual(calls[0].idToken.user, { name: { firstName: 'Apple', lastName: 'User' } })
  const first = calls[0].idToken.nonce
  await signInWithApple()
  assert.notEqual(calls[1].idToken.nonce, first)
})

test('the trusted client binds Apple credentials to the exact selected server origin and base path', async () => {
  await signInWithApple()
  const first = calls[0].idToken.nonce.split('.')[1]
  account = { ...account, server: { url: 'https://other.example/mikka' } }
  await signInWithApple()
  assert.notEqual(calls[1].idToken.nonce.split('.')[1], first)
  account = { ...account, server: { url: 'https://fixture.example/other' } }
  await signInWithApple()
  assert.notEqual(calls[2].idToken.nonce.split('.')[1], first)
})

test('later Apple authorizations can omit the name', async () => {
  credential.fullName = null
  await signInWithApple()
  assert.equal(calls[0].idToken.user, undefined)
})

test('canceling the native prompt leaves the session and credential storage untouched', async () => {
  prompt = async () => { throw Object.assign(new Error('fixture-canceled'), { code: 'ERR_REQUEST_CANCELED' }) }
  assert.equal(await signInWithApple(), undefined)
  assert.equal(calls.length, 0); assert.equal(values.size, 0)
})

test('missing identity token, a changed account or failed secure storage cannot submit a token', async () => {
  credential.identityToken = null
  assert.deepEqual(await signInWithApple(), { error: { code: 'INVALID_TOKEN' } })
  credential.identityToken = 'fixture-private-token'
  prompt = async () => { account = { ...account, id: '2' }; return credential }
  assert.equal(await signInWithApple(), undefined)
  account = { id: 'legacy', server: { url: 'https://fixture.example/mikka' } }; prompt = async () => credential
  storedWrite = async () => { throw new Error('fixture-storage-unavailable') }
  await assert.rejects(signInWithApple(), /fixture-storage-unavailable/)
  assert.equal(calls.length, 0)
})

test('non-cancellation Apple errors retain their original cause', async () => {
  const error = Object.assign(new Error('fixture-native-error'), { code: 'ERR_REQUEST_FAILED' })
  prompt = async () => { throw error }
  await assert.rejects(signInWithApple(), value => value === error)
})

test('authorized credentials keep their session and system events check for later revocation', async () => {
  values.set('mikka_apple_user', 'fixture-apple-user')
  const stop = watchAppleCredential('legacy'); await flush()
  assert.equal(lost, 0)
  credentialState = async () => 0
  revoke?.(); await flush()
  assert.equal(lost, 1); assert.equal(values.has('mikka_apple_user'), false)
  stop(); assert.equal(revokeRemoved, true); assert.equal(foregroundRemoved, true)
})

test('returning to the foreground clears a credential that Apple no longer knows', async () => {
  const stop = watchAppleCredential('legacy'); await flush()
  values.set('mikka_apple_user', 'fixture-apple-user'); credentialState = async () => 2
  foreground?.('background'); await flush(); assert.equal(lost, 0)
  foreground?.('active'); await flush(); assert.equal(lost, 1)
  stop()
})

test('a late revocation check cannot sign out another account or an unmounted session', async () => {
  for (const change of ['account', 'unmount']) {
    account = { id: 'legacy', server: { url: 'https://fixture.example/mikka' } }; values.set('mikka_apple_user', 'fixture-apple-user')
    let resolve!: (value: number) => void
    credentialState = () => new Promise(done => { resolve = done })
    const stop = watchAppleCredential('legacy'); await flush()
    if (change === 'account') account = { ...account, id: '2' }
    else stop()
    resolve(0); await flush(); stop()
    assert.equal(lost, 0)
  }
})

test('unavailable Apple checks keep the session and report only the error type', async t => {
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  values.set('mikka_apple_user', 'fixture-apple-user')
  credentialState = async () => { throw new Error('fixture-private-provider-content') }
  const stop = watchAppleCredential('legacy'); await flush(); stop()
  assert.equal(lost, 0)
  assert.deepEqual(warnings, [['Apple credential check unavailable', 'Error']])
})

test('other sign-in methods clear only the current account Apple marker, and web has no native watcher', async () => {
  values.set('mikka_apple_user', 'legacy-user'); values.set('mikka_account_2_apple_user', 'other-user')
  await forgetAppleCredential()
  assert.equal(values.has('mikka_apple_user'), false); assert.equal(values.has('mikka_account_2_apple_user'), true)
  platform.OS = 'web'; watchAppleCredential('legacy')(); await forgetAppleCredential()
  assert.equal(reads, 0); assert.equal(revoke, undefined)
})

test('the deletion handoff offers manual Apple revocation only after a fresh check confirms session removal', async () => {
  values.set('mikka_apple_user', 'fixture-apple-user')
  assert.equal(await finishAppleDeletionHandoff('legacy'), false)
  sessionRead = async () => ({ data: null, error: { status: 503 } })
  assert.equal(await finishAppleDeletionHandoff('legacy'), false)
  assert.equal(lost, 0)
  sessionRead = async () => ({ data: null, error: null })
  assert.equal(await finishAppleDeletionHandoff('legacy'), true)
  assert.equal(lost, 1); assert.equal(values.has('mikka_apple_user'), false)
})

test('a late deletion result cannot clear another account session', async () => {
  values.set('mikka_apple_user', 'fixture-apple-user')
  sessionRead = async () => { account = { ...account, id: '2' }; return { data: null, error: null } }
  assert.equal(await finishAppleDeletionHandoff('legacy'), false)
  assert.equal(lost, 0); assert.equal(values.has('mikka_apple_user'), true)
})
