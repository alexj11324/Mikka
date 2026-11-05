import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundledAuth } from './bundled-auth'
import { bundledProtocol } from './bundled-protocol'
import { SessionVault, SESSION_CACHE_HEADER, responseSessionCache, type EncryptedStorage, type StoredSession } from './session-vault'

const identity = (id: string) => ({ user: { id, name: 'Native cache test', email: `${id}@example.invalid`, image: null }, session: { id: `public-${id}` } })
const first: StoredSession = { token: 'first-private-bearer-0123456789', identity: identity('first') }
const second: StoredSession = { token: 'second-private-bearer-0123456789', identity: identity('second') }
const proof = (name: string) => Buffer.from(`opaque-server-signed-session-data-${name}`).toString('base64url')
const rpc = (action: string, args: unknown[] = []) => ({ method: 'POST', body: JSON.stringify({ version: 1, action, args }) })

async function fixture(t: TestContext, beforeEncrypt: (value: string) => Promise<void> = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-cache-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const key = randomBytes(32)
  const encryption: EncryptedStorage = {
    available: async () => true,
    async encrypt(value) {
      await beforeEncrypt(value)
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const data = Buffer.concat([cipher.update(value), cipher.final()])
      return Buffer.concat([nonce, cipher.getAuthTag(), data])
    },
    async decrypt(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString()
    },
  }
  return { directory, vault: new SessionVault(directory, 'https://server.test/mikka', encryption) }
}

function broker(vault: SessionVault, fetch: (url: string, init?: RequestInit) => Promise<Response>) {
  return new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault, fetch, openExternal: async () => {}, returned: () => {}, changed: () => {} })
}

function cookieHeaders(...cookies: string[]): Headers {
  const headers = new Headers()
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return headers
}

test('REST cache fallback extracts only exact SDK cache cookies, including contiguous chunks', () => {
  const cache = proof('rest')
  assert.equal(responseSessionCache(cookieHeaders('better-auth.session_token=private-token; HttpOnly', 'oauth_state=private-state', 'other.better-auth.session_data=unrelated')), undefined)
  for (const prefix of ['', '__Secure-']) {
    assert.equal(responseSessionCache(cookieHeaders(`${prefix}better-auth.session_data=${cache}; Path=/; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT`)), cache)
    assert.equal(responseSessionCache(cookieHeaders(`${prefix}better-auth.session_data.1=${cache.slice(12)}; HttpOnly`, `${prefix}better-auth.session_data.0=${cache.slice(0, 12)}; HttpOnly`)), cache)
  }
  assert.equal(responseSessionCache(cookieHeaders('other="x, better-auth.session_data=spoof"; Path=/')), undefined)
  assert.equal(responseSessionCache(cookieHeaders('other="x, better-auth.session_data=spoof"; Path=/', `better-auth.session_data=${cache}`)), cache)
})

test('REST cache fallback rejects ambiguous versions, malformed chunks and oversized proof', () => {
  const invalid = [
    ['better-auth.session_data=one', 'better-auth.session_data=two'],
    ['better-auth.session_data=one', 'better-auth.session_data.0=two'],
    ['better-auth.session_data=one', '__Secure-better-auth.session_data=two'],
    ['better-auth.session_data.0=one', 'better-auth.session_data.0=two'],
    ['better-auth.session_data.0=one', 'better-auth.session_data.2=two'],
    ['better-auth.session_data.1=one'],
    ['better-auth.session_data.00=one'],
    ['better-auth.session_data.-1=one'],
    ['better-auth.session_data.foo=one'],
    ['better-auth.session_data.32=one'],
    ['better-auth.session_data=invalid%2Fproof'],
    ['better-auth.session_data=proof; Max-Age=invalid'],
    [`better-auth.session_data=${'a'.repeat(16_385)}`],
    [`better-auth.session_data.0=${'a'.repeat(8192)}`, `better-auth.session_data.1=${'b'.repeat(8193)}`],
  ]
  for (const cookies of invalid) assert.equal(responseSessionCache(cookieHeaders(...cookies)), '', `reject ${cookies.map(cookie => cookie.split('=')[0]).join(',')}`)
})

test('REST cache fallback accepts SDK direct/chunk transitions and explicit private clears win', () => {
  const cache = proof('transition')
  assert.equal(responseSessionCache(cookieHeaders('better-auth.session_data=; Max-Age=0', `better-auth.session_data.0=${cache.slice(0, 10)}`, `better-auth.session_data.1=${cache.slice(10)}`)), cache)
  assert.equal(responseSessionCache(cookieHeaders(`better-auth.session_data=${cache}`, 'better-auth.session_data.0=; Max-Age=0', 'better-auth.session_data.1=; Max-Age=0')), cache)
  assert.equal(responseSessionCache(cookieHeaders('better-auth.session_data=obsolete; Max-Age=0')), '')
  assert.equal(responseSessionCache(cookieHeaders('better-auth.session_data.0=; Max-Age=0', 'better-auth.session_data.1=; Max-Age=0')), '')
  assert.equal(responseSessionCache(cookieHeaders('better-auth.session_data=; Max-Age=0', `__Secure-better-auth.session_data=${cache}`)), cache)
  for (const explicit of ['', 'bad%proof', proof('explicit')]) {
    const headers = cookieHeaders(`better-auth.session_data=${cache}`)
    headers.set(SESSION_CACHE_HEADER, explicit)
    assert.equal(responseSessionCache(headers), explicit === '' || explicit === 'bad%proof' ? '' : explicit)
  }
})

test('a REST-only Set-Cookie renewal is retained encrypted and never forwarded to renderer', async t => {
  const { directory, vault } = await fixture(t)
  await vault.save({ ...first, sessionCache: proof('old-rest') })
  const cache = proof('renewed-rest')
  const auth = broker(vault, async () => Response.json({ ok: true }, { headers: cookieHeaders(
    'better-auth.session_token=private-session-cookie; HttpOnly',
    `__Secure-better-auth.session_data.0=${cache.slice(0, 16)}; HttpOnly`,
    `__Secure-better-auth.session_data.1=${cache.slice(16)}; HttpOnly`,
  ) }))
  await auth.restore()
  const response = await bundledProtocol(directory, auth)(Object.assign(new Request('mikka://app/mikka/api/coordinator/messages'), { initiatorOrigin: 'mikka://app' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get(SESSION_CACHE_HEADER), null)
  assert.equal((await vault.load())?.sessionCache, cache)
  const ciphertext = await readFile(join(directory, 'desktop-session.bin'))
  assert.equal(ciphertext.includes(cache), false)
  assert.equal(ciphertext.includes('private-session-cookie'), false)
})

test('signed cache survives encrypted cold restore but cannot cross the renderer header boundary', async t => {
  const { directory, vault } = await fixture(t)
  const initial = proof('initial')
  const refreshed = proof('refreshed')
  await vault.save({ ...first, sessionCache: initial })
  let expected: string | null = initial
  let responseCache = refreshed
  const fetch = async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), `Bearer ${first.token}`)
    assert.equal(headers.get(SESSION_CACHE_HEADER), expected)
    return Response.json({ ok: true }, { headers: { [SESSION_CACHE_HEADER]: responseCache } })
  }
  const auth = broker(vault, fetch)
  await auth.restore()
  const serve = bundledProtocol(directory, auth)
  const result = await serve(Object.assign(new Request('mikka://app/mikka/api/desktop/rpc', {
    ...rpc('desktop.bootstrap'), headers: { [SESSION_CACHE_HEADER]: 'attacker-supplied-cache' },
  }), { initiatorOrigin: 'mikka://app' }))
  assert.equal(result.status, 200)
  assert.equal(result.headers.get(SESSION_CACHE_HEADER), null)
  assert.deepEqual(auth.session(), first.identity)
  assert.equal(JSON.stringify(auth.session()).includes(refreshed), false)
  assert.equal((await vault.load())?.sessionCache, refreshed)
  const ciphertext = await readFile(join(directory, 'desktop-session.bin'))
  for (const secret of [initial, refreshed, first.token]) assert.equal(ciphertext.includes(secret), false)

  // A new main broker, as on process restart, sends the same server proof on
  // its very first read. It performs no refresh request or local TTL polling.
  const restored = broker(vault, fetch)
  await restored.restore()
  expected = refreshed
  responseCache = ''
  await restored.request('/api/desktop/rpc', rpc('desktop.bootstrap'))
  assert.equal((await vault.load())?.sessionCache, undefined)
  expected = null
  responseCache = 'a'.repeat(16_385)
  await restored.request('/api/desktop/rpc', { ...rpc('desktop.bootstrap'), headers: { [SESSION_CACHE_HEADER]: 'attacker-supplied-cache' } })
  assert.equal((await vault.load())?.sessionCache, undefined)
})

test('native email handoff carries existing auth cache privately before its first bootstrap', async t => {
  const { vault } = await fixture(t)
  const initial = proof('email')
  const current = proof('get-session')
  const paths: string[] = []
  const auth = broker(vault, async (url, init) => {
    const headers = new Headers(init?.headers)
    paths.push(new URL(url).pathname)
    if (url.endsWith('/sign-in/email')) return Response.json({ token: first.token }, { headers: { [SESSION_CACHE_HEADER]: initial } })
    if (url.endsWith('/get-session')) {
      assert.equal(headers.get(SESSION_CACHE_HEADER), initial)
      assert.equal(headers.get('cookie'), null)
      return Response.json(first.identity, { headers: { [SESSION_CACHE_HEADER]: current } })
    }
    assert.equal(headers.get(SESSION_CACHE_HEADER), current)
    return Response.json({ ok: true })
  })
  assert.equal(await auth.signInEmail({ email: first.identity.user.email, password: 'test-only-password' }), null)
  await auth.request('/api/desktop/rpc', rpc('desktop.bootstrap'))
  assert.deepEqual(paths, ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/get-session', '/mikka/api/desktop/rpc'])
  assert.equal((await vault.load())?.sessionCache, current)
  assert.deepEqual(auth.session(), first.identity)
})

test('password rotation cannot replay the previous bearer cache, and revocation clears the encrypted record', async t => {
  const { vault } = await fixture(t)
  await vault.save({ ...first, sessionCache: proof('old-token') })
  const rotated = 'rotated-private-bearer-0123456789'
  const fresh = proof('new-token')
  let revoked = false
  const auth = broker(vault, async (url, init) => {
    const headers = new Headers(init?.headers)
    if (url.endsWith('/get-session')) {
      assert.equal(headers.get('authorization'), `Bearer ${rotated}`)
      assert.equal(headers.get(SESSION_CACHE_HEADER), null)
      return Response.json(first.identity, { headers: { [SESSION_CACHE_HEADER]: fresh } })
    }
    if (revoked) return new Response(null, { status: 401 })
    return Response.json({ ok: true }, { headers: { 'x-mikka-session-token': rotated, [SESSION_CACHE_HEADER]: '' } })
  })
  await auth.restore()
  await auth.request('/api/desktop/rpc', rpc('account.changePassword'))
  assert.equal((await vault.load())?.token, rotated)
  assert.equal((await vault.load())?.sessionCache, fresh)
  revoked = true
  assert.equal((await auth.request('/api/desktop/rpc', rpc('desktop.bootstrap'))).status, 401)
  assert.equal(await vault.loadAccounts(), null)
  assert.equal(auth.session(), null)
})

test('an old account cache response cannot overwrite the active account during encrypted commit', async t => {
  let entered!: () => void
  let release!: () => void
  const writing = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let pause = false
  const { vault } = await fixture(t, async value => {
    if (pause && JSON.parse(value).value.activeUserId === 'second') { pause = false; entered(); await held }
  })
  await vault.saveAccounts({ activeUserId: 'first', accounts: [{ ...first, sessionCache: proof('first') }, { ...second, sessionCache: proof('second') }] })
  let finish!: (response: Response) => void
  const stale = new Promise<Response>(resolve => { finish = resolve })
  const auth = broker(vault, async url => url.endsWith('/api/coordinator/messages') ? stale : Response.json({ version: 1, ok: true, result: { ok: true } }))
  await auth.restore()
  const oldRead = auth.request('/api/coordinator/messages')
  pause = true
  const switched = auth.request('/api/desktop/rpc', rpc('workspace.switchWorkspace', [{ accountId: 'second' }]))
  await writing
  finish(Response.json({ ok: true }, { headers: { [SESSION_CACHE_HEADER]: proof('late-first') } }))
  await new Promise(resolve => setImmediate(resolve))
  release()
  assert.equal((await switched).status, 200)
  assert.equal((await oldRead).status, 409)
  const saved = await vault.loadAccounts()
  assert.equal(saved?.activeUserId, 'second')
  assert.equal(saved?.accounts.find(account => account.identity.user.id === 'first')?.sessionCache, proof('late-first'))
  assert.equal(saved?.accounts.find(account => account.identity.user.id === 'second')?.sessionCache, proof('second'))
  assert.equal(auth.session()?.user.id, 'second')
})

test('signout during encrypted sign-in commit cannot resurrect that account after restart', async t => {
  let entered!: () => void
  let release!: () => void
  const writing = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let pause = true
  const { vault } = await fixture(t, async value => {
    if (pause && JSON.parse(value).value.activeUserId === 'second') { pause = false; entered(); await held }
  })
  await vault.save({ ...first, sessionCache: proof('first') })
  const auth = broker(vault, async url => {
    if (url.endsWith('/sign-in/email')) return Response.json({ token: second.token }, { headers: { [SESSION_CACHE_HEADER]: proof('second') } })
    if (url.endsWith('/get-session')) return Response.json(second.identity)
    return Response.json({ success: true })
  })
  await auth.restore()
  const signingIn = auth.signInEmail({ email: second.identity.user.email, password: 'test-only-password' })
  await writing
  const signedOut = auth.signOut()
  release()
  await Promise.all([signingIn, signedOut])
  const restarted = broker(vault, async () => { throw new Error('No backend request is needed to restore') })
  await restarted.restore()
  assert.equal(restarted.session(), null)
  assert.equal(await vault.loadAccounts(), null)
})

test('five maximum-size signed proofs fit only inside the bounded encrypted vault', async t => {
  const { directory, vault } = await fixture(t)
  const accounts = Array.from({ length: 5 }, (_, index) => ({ token: `private-token-${index}-0123456789`, identity: identity(String(index)), sessionCache: 'a'.repeat(16_384) }))
  await vault.saveAccounts({ activeUserId: '0', accounts })
  const size = (await stat(join(directory, 'desktop-session.bin'))).size
  assert.ok(size > 64 * 1024 && size <= 128 * 1024)
  assert.equal((await vault.loadAccounts())?.accounts.length, 5)
})

test('an existing bootstrap quietly refreshes only the current safe profile without another auth read', async t => {
  const { vault } = await fixture(t)
  await vault.save({ ...first, sessionCache: proof('first') })
  let calls = 0
  let changes = 0
  let identity = { ...first.identity, user: { ...first.identity.user, name: 'Updated name', image: 'https://example.invalid/new-avatar.png' } }
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault,
    openExternal: async () => {}, returned: () => {}, changed: () => { changes++ }, fetch: async url => {
      calls++
      assert.ok(url.endsWith('/api/desktop/rpc'))
      return Response.json({ version: 1, ok: true, result: { ...identity, features: { flags: {} }, token: 'must-not-be-retained' } })
    },
  })
  await auth.restore()
  await auth.request('/api/desktop/rpc', rpc('desktop.bootstrap'))
  assert.deepEqual(auth.session(), identity)
  assert.deepEqual((await vault.load())?.identity, identity)
  assert.equal(calls, 1)
  assert.equal(changes, 0, 'a profile update must not cause another bootstrap loop')
  const accepted = auth.session()
  identity = { ...identity, user: { ...identity.user, id: 'foreign-owner' } }
  await auth.request('/api/desktop/rpc', rpc('desktop.bootstrap'))
  assert.deepEqual(auth.session(), accepted)
  assert.equal(calls, 2)
  assert.equal(changes, 0)
})

test('a bootstrap body arriving after signout cannot restore the safe profile or escape its scope', async t => {
  const { vault } = await fixture(t)
  await vault.save(first)
  let body!: ReadableStreamDefaultController<Uint8Array>
  const auth = broker(vault, async url => url.endsWith('/sign-out') ? Response.json({ success: true }) : new Response(new ReadableStream({ start(controller) { body = controller } }), { headers: { 'content-type': 'application/json' } }))
  await auth.restore()
  const reading = auth.request('/api/desktop/rpc', rpc('desktop.bootstrap'))
  await new Promise(resolve => setImmediate(resolve))
  await auth.signOut()
  body.enqueue(new TextEncoder().encode(JSON.stringify({ version: 1, ok: true, result: first.identity })))
  body.close()
  assert.equal((await reading).status, 409)
  assert.equal(auth.session(), null)
  assert.equal(await vault.loadAccounts(), null)
})
