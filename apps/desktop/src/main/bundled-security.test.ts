import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowedApiPath, normalizedRendererPath, RENDERER_CSP, RENDERER_URL, rendererAssetPath, safeAppNext } from './bundled-policy'
import { isTrustedFrame, navigationDecision, originOf, trustedIpcSender } from './security'
import { bundledProtocol } from './bundled-protocol'
import { SessionVault, type EncryptedStorage, type StoredSession } from './session-vault'
import { BundledAuth } from './bundled-auth'
import { BundledLive } from './bundled-live'
import { startBundledLoopback } from './bundled-loopback'
import { BundledViewer, validViewerGrant } from './bundled-viewer'

const identity = { user: { id: '84c182d1-661c-461b-bca2-10410cb646d4', name: 'Desktop Test', email: 'desktop@example.invalid', image: null }, session: { id: 'public-session-id' } }
const secret = 'main-session-secret-0123456789'
const stored: StoredSession = { identity, token: secret }

function encryption(): EncryptedStorage {
  const key = randomBytes(32)
  return {
    available: async () => true,
    async encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]) },
    async decrypt(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8') },
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-bundled-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('custom origin is explicit; opaque, lookalike, embedded and resource frames are unprivileged', () => {
  assert.equal(originOf(RENDERER_URL), 'mikka://app')
  for (const url of ['mikka://app.evil/mikka', 'mikka://user@app/mikka', 'mikka://app:80/mikka', 'file:///mikka', 'data:text/html,x', 'mikka://app/mikka/api/artifacts/a/versions/1/frame', 'mikka://app/mikka/%61pi/artifacts/a/versions/1/frame', 'mikka://app/mikka/assets/app.js']) assert.equal(isTrustedFrame(url, RENDERER_URL), false, url)
  assert.equal(isTrustedFrame('mikka://app/mikka/en?issue=a', RENDERER_URL), true)
  assert.equal(trustedIpcSender({ url: RENDERER_URL, parent: {} }, RENDERER_URL), false)
  assert.equal(trustedIpcSender(null, RENDERER_URL), false)
  assert.equal(trustedIpcSender({ url: RENDERER_URL, parent: null }, RENDERER_URL), true)
  assert.equal(navigationDecision('https://app.aspectlylabs.com/mikka', RENDERER_URL), 'external')
  assert.equal(navigationDecision('javascript:alert(1)', RENDERER_URL), 'deny')
  assert.equal(navigationDecision('mikka://app/', RENDERER_URL), 'allow')
  assert.equal(isTrustedFrame('mikka://app/', RENDERER_URL), false)
})

test('path policy rejects traversal, encoded delimiters, absolute targets and unknown API routes', () => {
  for (const path of ['/mikka/../secret', '/mikka/%2e%2e/secret', '/mikka/%252e%252e/secret', '/mikka/%2fapi/auth/token', '/mikka/a\\b', '//evil.test/api', '/mikka/a%00b']) assert.equal(normalizedRendererPath(path), null, path)
  assert.equal(rendererAssetPath('/safe/root', '/mikka/assets/file.js'), '/safe/root/assets/file.js')
  assert.equal(normalizedRendererPath('/mikka'), '/')
  assert.equal(allowedApiPath('/api/desktop/rpc', 'POST'), true)
  for (const path of ['/api/auth/get-session', '/api/auth/token', '/api/auth/one-time-token/verify', '/api/live/ticket', '/api/devices/enrollment', '/api/desktop/exchange', '/api/cron/schedules', '/api/arbitrary']) assert.equal(allowedApiPath(path, 'GET'), false, path)
  assert.equal(allowedApiPath('/api/desktop/rpc', 'GET'), false)
  assert.equal(allowedApiPath('/api/settings/preferences', 'GET'), true)
  assert.equal(allowedApiPath('/api/settings/preferences', 'POST'), false)
  assert.equal(allowedApiPath(`/api/bots/${identity.user.id}/computer/viewer`, 'POST'), false)
  assert.equal(allowedApiPath(`/api/bots/${identity.user.id}/computer/takeover`, 'POST'), false)
  assert.equal(safeAppNext('//evil.test'), '/')
  assert.equal(safeAppNext('/\\evil.test'), '/')
})

test('renderer CSP has no remote code, eval, inline scripts, external fetch, workers or object', () => {
  assert.match(RENDERER_CSP, /script-src 'self';/)
  assert.doesNotMatch(RENDERER_CSP, /unsafe-eval|script-src[^;]*unsafe-inline/)
  assert.match(RENDERER_CSP, /connect-src 'self';/)
  assert.match(RENDERER_CSP, /object-src 'none'/)
  assert.match(RENDERER_CSP, /worker-src 'none'/)
})

test('local entry/assets load without backend; missing assets and symlink escape fail closed', async t => {
  const root = await fixture(t)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<main>local</main>')
  await writeFile(join(root, 'assets', 'app.js'), 'export{}')
  const outside = join(root, '..', `${root.split('/').at(-1)}-outside`)
  await writeFile(outside, 'private')
  t.after(() => rm(outside, { force: true }))
  await symlink(outside, join(root, 'assets', 'escape.js'))
  const serve = bundledProtocol(root, { request: async () => { throw new Error('Backend must not be contacted') } })
  assert.equal(await (await serve(new Request(`${RENDERER_URL}/en?issue=a`))).text(), '<main>local</main>')
  assert.equal((await serve(new Request(`${RENDERER_URL}/assets/app.js`))).headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal((await serve(new Request(`${RENDERER_URL}/assets/missing.js`))).status, 404)
  assert.equal((await serve(new Request(`${RENDERER_URL}/assets/escape.js`))).status, 403)
  const redirect = await serve(new Request('mikka://app/?workspace=choice'))
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), `${RENDERER_URL}?workspace=choice`)
})

test('proxy strips credentials, cookies, redirects and remote policy; preserves streaming resume headers', async t => {
  const root = await fixture(t)
  let calls = 0
  const serve = bundledProtocol(root, { request: async (path, init) => {
    calls++
    assert.equal(path, '/api/coordinator/stream?after=1')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), null)
    assert.equal(headers.get('cookie'), null)
    assert.equal(headers.get('x-mikka-stream-key'), 'opaque-replay-cursor')
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); controller.close() } })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'set-cookie': `session_token=${secret}`, authorization: secret, 'x-mikka-session-token': secret, 'content-security-policy': "default-src * 'unsafe-eval'", 'x-mikka-stream-key': 'next-cursor' } })
  } })
  const response = await serve(Object.assign(new Request(`${RENDERER_URL}/api/coordinator/stream?after=1`, { headers: { authorization: 'Bearer malicious', cookie: 'session_token=malicious', 'x-mikka-stream-key': 'opaque-replay-cursor' } }), { initiatorOrigin: 'mikka://app' }))
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('authorization'), null)
  assert.equal(response.headers.get('x-mikka-session-token'), null)
  assert.equal(response.headers.get('x-mikka-stream-key'), 'next-cursor')
  assert.equal(response.headers.get('content-security-policy'), RENDERER_CSP)
  assert.match(await response.text(), /data: first/)
  for (const request of [new Request(`${RENDERER_URL}/api/auth/token`), new Request(`${RENDERER_URL}/api/desktop/rpc`, { method: 'POST', headers: { origin: 'https://evil.test' } }), new Request(`${RENDERER_URL}/api/desktop/rpc`, { method: 'POST', headers: { origin: 'null' } }), new Request(`${RENDERER_URL}/api/workspace`, { headers: { 'sec-fetch-site': 'cross-site' } })]) assert.equal((await serve(request)).status, 403)
  // Electron removes Origin:null before dispatch, but retains this trusted
  // browser-provided field even for GETs that have no Origin or fetch metadata.
  for (const initiatorOrigin of ['null', 'https://evil.test', 'mikka://app.evil']) {
    const request = Object.assign(new Request(`${RENDERER_URL}/api/workspace`), { initiatorOrigin })
    assert.equal((await serve(request)).status, 403)
  }
  assert.equal(calls, 1)
})

test('OS-encrypted vault round trips, rejects wrong server/corruption and never writes plaintext', async t => {
  const directory = await fixture(t)
  const crypto = encryption()
  const vault = new SessionVault(directory, 'https://server.test/mikka', crypto)
  await vault.save(stored)
  const ciphertext = await readFile(join(directory, 'desktop-session.bin'))
  assert.equal(ciphertext.includes(secret), false)
  assert.equal(ciphertext.includes(identity.user.email), false)
  assert.deepEqual(await vault.load(), stored)
  assert.equal((await stat(join(directory, 'desktop-session.bin'))).mode & 0o777, 0o600)
  assert.equal(await new SessionVault(directory, 'https://other.test/mikka', crypto).load(), null)
  await writeFile(join(directory, 'desktop-session.bin'), 'corrupted')
  assert.equal(await vault.load(), null)
  await vault.save(null)
  assert.equal(await vault.load(), null)
})

test('unavailable OS keychain fails closed instead of persisting a plaintext session', async t => {
  const directory = await fixture(t)
  let encryptCalled = false
  const vault = new SessionVault(directory, 'https://server.test/mikka', { available: async () => false, encrypt: async () => { encryptCalled = true; return Buffer.from(secret) }, decrypt: async () => secret })
  await assert.rejects(vault.save(stored), /Secure session storage unavailable/)
  assert.equal(encryptCalled, false)
  assert.equal(await vault.load(), null)
})

test('main bearer never appears in public session and only validated workspace selector persists', async t => {
  const directory = await fixture(t)
  const vault = new SessionVault(directory, 'https://server.test/mikka', encryption())
  await vault.save(stored)
  const workspace = '29cd2c26-64cc-4e04-9339-a29610234ffe'
  let calls = 0; let changes = 0
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault, openExternal: async () => {}, changed: () => { changes++ }, returned: () => {}, fetch: async (url, init) => {
    assert.equal(url, 'https://server.test/mikka/api/desktop/rpc')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), `Bearer ${secret}`)
    assert.equal(headers.get('cookie'), calls === 0 ? null : `mikka-workspace=${workspace}`)
    assert.equal(init?.redirect, 'error')
    calls++
    return calls === 3 ? new Response(null, { status: 401 }) : new Response('{}', { headers: { 'set-cookie': `session_token=never-retain; Path=/, mikka-workspace=${workspace}; Path=/` } })
  } })
  await auth.restore()
  assert.deepEqual(auth.session(), identity)
  assert.equal(JSON.stringify(auth.session()).includes(secret), false)
  await auth.request('/api/desktop/rpc', { headers: { cookie: 'evil=1', authorization: 'Bearer injected' } })
  await auth.request('/api/desktop/rpc')
  assert.equal((await vault.load())?.workspace, workspace)
  await auth.request('/api/desktop/rpc')
  assert.equal(auth.session(), null)
  assert.equal(await vault.load(), null)
  assert.equal(changes, 1)
})

test('loopback validates nonce/code exactly, ignores wrong attempts and accepts once on localhost', async t => {
  const state = randomBytes(32).toString('base64url')
  const code = randomBytes(32).toString('base64url')
  const received: string[] = []
  const listener = await startBundledLoopback(state, value => received.push(value))
  t.after(() => listener.close())
  assert.equal(new URL(listener.callback).hostname, '127.0.0.1')
  assert.equal((await fetch(`${listener.callback}?state=${'x'.repeat(state.length)}&code=${code}`)).status, 400)
  assert.equal((await fetch(`${listener.callback}?state=${encodeURIComponent('é'.repeat(state.length))}&code=${code}`)).status, 400)
  assert.equal((await fetch(`${listener.callback}?state=${state}&state=${state}&code=${code}`)).status, 400)
  const response = await fetch(`${listener.callback}?state=${state}&code=${code}`)
  assert.equal(response.status, 200)
  assert.equal((await response.text()).includes(code), false)
  assert.deepEqual(received, [code])
  await assert.rejects(fetch(`${listener.callback}?state=${state}&code=${code}`))
})

test('browser handoff creates/exchanges PKCE only in main and publishes only public identity', { timeout: 5000 }, async t => {
  const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
  let registration: { state: string; callback: string; challenge: string } | undefined
  let opened: URL | undefined
  let complete!: () => void
  const finished = new Promise<void>(resolve => { complete = resolve })
  const code = randomBytes(32).toString('base64url')
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault,
    openExternal: async url => { opened = new URL(url) }, changed: () => {}, returned: next => { assert.equal(next, '/en?issue=42'); complete() },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.equal(new Headers(init?.headers).get('authorization'), null)
      if (url.endsWith('/api/desktop/begin')) { registration = body; return new Response(null, { status: 204 }) }
      assert.ok(url.endsWith('/api/desktop/exchange'))
      assert.equal(body.client, 'bundled')
      assert.equal(body.code, code)
      assert.equal(body.state, registration?.state)
      assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), registration?.challenge)
      return Response.json({ ...identity, token: secret })
    },
  })
  t.after(() => auth.dispose())
  await auth.signIn({ provider: 'github', locale: 'en', next: '/en?issue=42' })
  assert.ok(registration)
  assert.equal(opened?.pathname, '/mikka/en/sign-in')
  assert.equal(opened?.searchParams.get('continue'), 'github')
  assert.equal(opened?.searchParams.has('verifier'), false)
  assert.equal(opened?.searchParams.has('code'), false)
  assert.equal(auth.session(), null)
  await fetch(`${registration.callback}?state=${registration.state}&code=${code}`)
  await finished
  assert.deepEqual(auth.session(), identity)
  assert.equal((await vault.load())?.token, secret)
  assert.equal(JSON.stringify(auth.session()).includes(secret), false)
})

test('password session rotation is accepted only for its RPC and refreshes public session id privately', async t => {
  const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
  await vault.save(stored)
  const replacement = 'rotated-main-secret-0123456789'
  let fresh = 0; let changed = 0
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault,
    openExternal: async () => {}, returned: () => {}, changed: () => { changed++ }, fetch: async (url, init) => {
      if (url.endsWith('/api/auth/get-session')) {
        fresh++
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${replacement}`)
        return Response.json({ ...identity, session: { id: 'new-public-session-id', token: replacement } })
      }
      return Response.json({}, { headers: { 'x-mikka-session-token': replacement } })
    },
  })
  await auth.restore()
  await auth.request('/api/desktop/rpc', { method: 'POST', body: JSON.stringify({ version: 1, action: 'desktop.bootstrap', args: [] }) })
  assert.equal((await vault.load())?.token, secret)
  assert.equal(fresh, 0)
  await auth.request('/api/desktop/rpc', { method: 'POST', body: new TextEncoder().encode(JSON.stringify({ version: 1, action: 'account.changePassword', args: [] })) })
  assert.equal((await vault.load())?.token, replacement)
  assert.equal(auth.session()?.session.id, 'new-public-session-id')
  assert.equal(JSON.stringify(auth.session()).includes(replacement), false)
  assert.equal(fresh, 1)
  assert.equal(changed, 1)
})

test('saved-account switching uses that account bearer, safely projects choices and fences stale responses', async t => {
  const vault = new SessionVault(await fixture(t), 'https://server.test/mikka', encryption())
  const second = { token: 'second-private-session-0123456789', identity: { user: { ...identity.user, id: '29cd2c26-64cc-4e04-9339-a29610234ffe', email: 'second@example.invalid' }, session: { id: 'second-public-session' } } }
  const workspace = '096db4ab-6bf3-4bcc-ad4b-dcfc521bb007'
  await vault.saveAccounts({ activeUserId: identity.user.id, accounts: [stored, second] })
  let finishStale!: (response: Response) => void
  const stale = new Promise<Response>(resolve => { finishStale = resolve })
  const revoked: string[] = []
  let changed = 0
  const auth = new BundledAuth({ serverUrl: 'https://server.test/mikka', version: '0.1.2', vault, openExternal: async () => {}, returned: () => {}, changed: () => { changed++ }, fetch: async (url, init) => {
    const token = new Headers(init?.headers).get('authorization')
    if (url.endsWith('/api/coordinator/messages')) return stale
    if (url.endsWith('/api/auth/sign-out')) { revoked.push(token ?? ''); return Response.json({ success: true }) }
    if (url.endsWith('/api/workspace/switcher')) {
      const owner = token === `Bearer ${second.token}` ? second.identity : identity
      return Response.json({ workspace: { id: workspace }, live: {}, accounts: [{ id: owner.user.id, email: owner.user.email, token: 'must-not-cross-projection', choices: [{ id: workspace, name: 'Owned workspace', kind: 'team', secret: 'must-not-cross-projection' }] }] })
    }
    assert.equal(token, `Bearer ${second.token}`)
    return Response.json({ version: 1, ok: true, result: { ok: true, data: { workspaceId: workspace } } }, { headers: { 'set-cookie': `mikka-workspace=${workspace}; Path=/` } })
  } })
  await auth.restore()
  const staleRequest = auth.request('/api/coordinator/messages')
  const response = await auth.request('/api/desktop/rpc', { method: 'POST', body: new TextEncoder().encode(JSON.stringify({ version: 1, action: 'workspace.switchWorkspace', args: [{ accountId: second.identity.user.id, workspaceId: workspace }] })).buffer })
  assert.equal(response.status, 200)
  assert.equal(auth.session()?.user.id, second.identity.user.id)
  finishStale(new Response(null, { status: 401 }))
  assert.equal((await staleRequest).status, 409)
  assert.equal(auth.session()?.user.id, second.identity.user.id)
  const switcher = await (await auth.request('/api/workspace/switcher')).json() as { accounts: { id: string }[] }
  assert.deepEqual(switcher.accounts.map(item => item.id), [second.identity.user.id, identity.user.id])
  assert.equal(JSON.stringify(switcher).includes('must-not-cross-projection'), false)
  assert.equal(JSON.stringify(switcher).includes(second.token), false)
  assert.equal((await vault.loadAccounts())?.accounts.length, 2)
  assert.equal((await vault.load())?.workspace, workspace)
  await auth.signOut()
  assert.equal(await vault.loadAccounts(), null)
  assert.equal(auth.session(), null)
  assert.deepEqual(revoked.sort(), [`Bearer ${secret}`, `Bearer ${second.token}`].sort())
  assert.equal(changed, 2)
})

test('live hands renderer only owner-bound handles and refuses cross-window use or arbitrary messages', async () => {
  const live = new BundledLive({ session: () => identity, request: async () => Response.json({ url: `wss://gateway.test/v1/live/${'a'.repeat(64)}/socket`, protocol: 'private-ticket', expiresAt: Date.now() + 60_000 }) }, () => {})
  const prepared = await live.prepare(1, identity.user.id)
  assert.ok(prepared)
  assert.deepEqual(Object.keys(prepared).sort(), ['expiresAt', 'id'])
  assert.equal(JSON.stringify(prepared).includes('private-ticket'), false)
  assert.throws(() => live.connect(2, prepared.id), /Untrusted live owner/)
  assert.throws(() => live.send(1, prepared.id, '{"command":"run"}'), /Invalid live message/)
  live.closeAll()
  assert.throws(() => live.connect(1, prepared.id), /Live handle expired/)
})

test('viewer grants permit only the backend E2B viewer gateways and bounded expiries', () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  assert.ok(validViewerGrant({ url: 'wss://6080-test.e2b.app/vnc?token=payload.signature', expiresAt }))
  assert.ok(validViewerGrant({ url: `wss://6082-test.foxtrot-2.e2b.dev/agents/${identity.user.id}/viewer?token=payload.signature`, expiresAt }))
  for (const url of ['ws://6080-test.e2b.app/vnc?token=a.b', 'wss://127.0.0.1/vnc?token=a.b', 'wss://6080-test.e2b.app.evil.test/vnc?token=a.b', 'wss://6080-test.e2b.app/other?token=a.b', 'wss://user@6080-test.e2b.app/vnc?token=a.b', 'wss://6080-test.e2b.app/vnc?token=a.b&redirect=https://evil.test']) assert.equal(validViewerGrant({ url, expiresAt }), null, url)
  assert.equal(validViewerGrant({ url: 'wss://6080-test.e2b.app/vnc?token=a.b', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }), null)
})

test('main binary viewer hides credentials, scopes ownership/workspace, and bounds send/receive data', async () => {
  let scope = 'session:workspace-one'
  const events: import('@mikka/protocol/bridge').BundledViewerEvent[] = []
  let closed = 0
  const socket = {
    binaryType: 'blob', readyState: 1, bufferedAmount: 0,
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send(data: Uint8Array) { assert.ok(data.byteLength <= 1024 * 1024) }, close() { closed++ },
  } as unknown as WebSocket
  const broker = new BundledViewer({ scope: () => scope, request: async (path, init) => {
    assert.equal(path, `/api/bots/${identity.user.id}/computer/viewer`)
    assert.equal(init?.body, '{"mode":"view"}')
    return Response.json({ url: 'wss://6080-test.e2b.app/vnc?token=private.signature', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  } }, (_owner, event) => events.push(event), url => { assert.match(url, /private\.signature/); return socket })
  const result = await broker.prepare(7, { botId: identity.user.id, mode: 'view' })
  assert.equal(result.status, 200)
  assert.equal(JSON.stringify(result).includes('private.signature'), false)
  assert.ok('url' in result.body)
  const id = new URL(result.body.url).pathname.slice(1)
  assert.equal(new URL(result.body.url).hostname, 'desktop-viewer.invalid')
  assert.throws(() => broker.connect(8, id), /Untrusted viewer owner/)
  broker.connect(7, id)
  socket.onopen?.call(socket, new Event('open'))
  socket.onmessage?.call(socket, new MessageEvent('message', { data: new Uint8Array([1, 2, 3]).buffer }))
  assert.deepEqual(events.at(-1)?.data, new Uint8Array([1, 2, 3]))
  broker.send(7, id, new Uint8Array([4, 5]))
  assert.throws(() => broker.send(7, id, new Uint8Array(1024 * 1024 + 1)), /Invalid viewer message/)
  assert.throws(() => broker.send(7, id, 'arbitrary text'), /Invalid viewer message/)
  scope = 'session:workspace-two'
  assert.throws(() => broker.send(7, id, new Uint8Array([6])), /Invalid viewer message/)
  assert.equal(closed, 1)
  assert.equal(events.at(-1)?.type, 'close')
  broker.closeAll()
})
