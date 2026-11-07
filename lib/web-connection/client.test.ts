import assert from 'node:assert/strict'
import test from 'node:test'
import { WebServerDirectory } from './client'
import type { WebFetch } from './discovery'

class Storage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}
const discovery = { name: 'Acme', version: 'v1', edition: 'community', basePath: '/mikka', signIn: { email: true, google: false, github: false }, web: { enabled: true, protocol: { min: 1, max: 1 } } }
const session = (id: string, token = 't'.repeat(40)) => ({ token, user: { id, name: id, email: `${id}@example.test`, image: null, emailVerified: true }, session: { id: `session-${id}` } })
const code = 'c'.repeat(43)

function fixture(wrapFetch: (fetch: WebFetch) => WebFetch = fetch => fetch) {
  const storage = new Storage(), sessionStorage = new Storage(), calls: Request[] = []
  const users = new Map([['https://a.test', 'a'], ['https://b.test', 'b']])
  let hold: ((response: Response) => void) | undefined
  let holdExchange = false
  const fetch: WebFetch = async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init)
    calls.push(request)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/discovery')) return Response.json(discovery)
    if (url.pathname.endsWith('/begin')) return Response.json({ signInUrl: `${url.origin}/mikka/sign-in?web=1` })
    if (url.pathname.endsWith('/exchange')) return holdExchange ? new Promise(resolve => { hold = resolve }) : Response.json(session(users.get(url.origin)!))
    if (url.pathname.endsWith('/hold')) return new Promise(resolve => { hold = resolve })
    return Response.json({ ok: true })
  }
  const directory = new WebServerDirectory({ appUrl: 'https://app.aspectlylabs.com/mikka', fetch: wrapFetch(fetch), storage, sessionStorage })
  const signIn = async (host = 'a') => {
    const result = await directory.addServer(`https://${host}.test`)
    assert.equal(result.status, 'ok')
    const begin = await directory.beginSignIn(`https://${host}.test/mikka`)
    return directory.finishSignIn({ state: begin.state, code })
  }
  return { directory, storage, sessionStorage, calls, users, signIn, deferExchange: () => { holdExchange = true }, release: (response: Response) => hold!(response) }
}

test('credentials live only in browser session storage, public metadata never contains a token', async () => {
  const f = fixture()
  const account = await f.signIn()
  assert.equal(account.server, 'https://a.test/mikka')
  assert.equal('token' in account, false)
  assert.equal(JSON.stringify(f.directory.getServers()).includes('t'.repeat(40)), false)
  assert.equal(JSON.stringify([...f.storage.values]).includes('t'.repeat(40)), false)
  assert.equal(JSON.stringify([...f.sessionStorage.values]).includes('t'.repeat(40)), true)
  const begin = f.calls.find(request => request.url.endsWith('/begin'))!
  const body = await begin.json()
  assert.equal(body.callback, 'https://app.aspectlylabs.com/mikka/api/web/complete')
  assert.equal(body.challenge.length, 43); assert.equal('verifier' in body, false)
})

test('RPC, live ticket, upload and download route to the active account; bearer never follows redirects or foreign origins', async () => {
  const f = fixture(); await f.signIn()
  for (const path of ['/api/rpc', '/api/live/ticket?workspace=team', '/api/chat/attachments', '/api/artifacts/id/versions/1/download']) {
    await f.directory.fetch(`/mikka${path}`, { method: path === '/api/rpc' ? 'POST' : 'GET', headers: { 'x-deployment-id': 'cloud-build', cookie: 'cloud=cookie', authorization: 'Bearer cloud-token', 'x-mikka-session-cache': 'cloud-cache', 'x-mikka-rpc': '1' }, ...(path === '/api/rpc' ? { body: 'payload' } : {}) })
    const request = f.calls.at(-1)!
    assert.equal(new URL(request.url).origin, 'https://a.test')
    assert.equal(request.headers.get('authorization'), `Bearer ${'t'.repeat(40)}`)
    assert.equal(request.headers.has('cookie'), false); assert.equal(request.headers.has('x-deployment-id'), false); assert.equal(request.headers.has('x-mikka-session-cache'), false)
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error')
    if (path === '/api/rpc') { assert.ok(request.url.endsWith('/api/desktop/rpc')); assert.equal(await request.text(), 'payload') }
  }
  await f.directory.fetch('https://third-party.test/api/upload')
  assert.equal(f.calls.at(-1)!.headers.has('authorization'), false)
  await f.directory.fetch('https://app.aspectlylabs.com/mikka/api/auth/get-session')
  assert.equal(new URL(f.calls.at(-1)!.url).origin, 'https://app.aspectlylabs.com')
  assert.equal(f.calls.at(-1)!.headers.has('authorization'), false)
})

test('an identical user id from another server or the cloud is rejected rather than merged', async () => {
  const f = fixture(); await f.signIn()
  f.users.set('https://b.test', 'a')
  await assert.rejects(f.signIn('b'), /web_connection_account_conflict/)
  assert.equal(f.directory.getActiveAccount()?.server, 'https://a.test/mikka')
  assert.equal(f.directory.getServers().find(server => server.url.includes('b.test'))!.accounts.length, 0)
  assert.ok(f.calls.at(-1)!.url.endsWith('/api/web/revoke'))
  const g = fixture(); await g.directory.rememberCloudAccounts(['a'])
  await assert.rejects(g.signIn(), /web_connection_account_conflict/)
  assert.equal(g.directory.getActiveAccount(), null)
})

test('switching aborts/fences old responses and disconnect clears only the selected server', async () => {
  const f = fixture(); await f.signIn(); await f.signIn('b')
  await f.directory.switchServer('https://a.test/mikka', 'a')
  const pending = f.directory.fetch('/mikka/api/hold')
  const oldRequest = f.calls.at(-1)!
  await f.directory.switchServer('https://b.test/mikka', 'b')
  assert.equal(oldRequest.signal.aborted, true)
  f.release(Response.json({ private: 'old account' }))
  await assert.rejects(pending, /web_connection_session_changed/)
  await f.directory.disconnectServer('https://a.test/mikka')
  assert.equal(f.directory.getActiveAccount()?.user.id, 'b')
  assert.equal(f.directory.getServers().length, 1)
  assert.ok(f.calls.at(-1)!.url.startsWith('https://a.test/'))
  await f.directory.signOut()
  assert.equal(f.directory.getActiveAccount(), null)
  assert.equal(f.sessionStorage.values.size, 0)
})

test('an unprobed stored address cannot start sign-in, and public input cannot provide a verifier or credential', async () => {
  const f = fixture()
  await assert.rejects(f.directory.beginSignIn('https://a.test/mikka'), /web_connection_probe_required/)
  await assert.rejects(f.directory.finishSignIn({ state: 'forged', code }), /web_connection_handoff_expired/)
  assert.equal(f.calls.length, 0)
})

test('a cloud read already in flight is also aborted and cannot populate the selected self-hosted account', async () => {
  const f = fixture()
  const pending = f.directory.fetch('/mikka/api/hold')
  const oldRequest = f.calls.at(-1)!
  await f.signIn()
  assert.equal(oldRequest.signal.aborted, true)
  assert.equal(oldRequest.headers.has('authorization'), false)
  f.release(Response.json({ private: 'cloud account' }))
  await assert.rejects(pending, /web_connection_session_changed/)
})

test('a late successful exchange cannot undo a later disconnect and its new session is revoked', async () => {
  const f = fixture(); await f.signIn()
  await f.directory.addServer('https://b.test')
  const begin = await f.directory.beginSignIn('https://b.test/mikka')
  f.deferExchange()
  const pending = f.directory.finishSignIn({ state: begin.state, code })
  await f.directory.disconnectServer('https://b.test/mikka')
  f.release(Response.json(session('b')))
  await assert.rejects(pending, /web_connection_session_changed/)
  assert.equal(f.directory.getActiveAccount()?.user.id, 'a')
  assert.equal(f.directory.getServers().some(item => item.url.includes('b.test')), false)
  assert.equal(f.calls.at(-1)?.url, 'https://b.test/mikka/api/web/revoke')
})

test('account switching invalidates pending login proofs before any exchange request', async () => {
  const f = fixture(); await f.signIn()
  const begin = await f.directory.beginSignIn('https://a.test/mikka')
  await f.directory.switchServer(null)
  const count = f.calls.length
  await assert.rejects(f.directory.finishSignIn({ state: begin.state, code }), /web_connection_handoff_expired/)
  assert.equal(f.calls.length, count)
})

test('official renderer version checks stay anonymous and cloud-bound when a self-hosted backend is active', async () => {
  const f = fixture(); await f.signIn()
  await f.directory.fetch('/mikka/api/version', { headers: { authorization: 'Bearer must-not-cross', 'x-deployment-id': 'pinned' } })
  const request = f.calls.at(-1)!
  assert.equal(request.url, 'https://app.aspectlylabs.com/mikka/api/version')
  assert.equal(request.headers.has('authorization'), false)
  assert.equal(request.headers.has('x-deployment-id'), false)
  assert.equal(request.credentials, 'omit')
})

// Mirrors PostHog's host check and three header writes without loading its SDK
// or making network calls. The real directory runs inside/outside this layer.
const cloudCorrelationHeaders = {
  'x-posthog-session-id': 'synthetic-cloud-session',
  'x-posthog-window-id': 'synthetic-cloud-window',
  'x-posthog-distinct-id': 'synthetic-cloud-person',
}
function cloudTracing(fetch: WebFetch): WebFetch {
  return (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === 'app.aspectlylabs.com') {
      for (const [name, value] of Object.entries(cloudCorrelationHeaders)) request.headers.set(name, value)
    }
    return fetch(request)
  }
}

for (const order of ['before', 'after'] as const) {
  test(`official correlation stays cloud-bound when tracing is installed ${order} the directory`, async () => {
    const f = fixture(order === 'before' ? cloudTracing : undefined)
    await f.signIn()
    const fetch = order === 'after' ? cloudTracing(f.directory.fetch) : f.directory.fetch
    const controller = new AbortController()
    await fetch('https://app.aspectlylabs.com/mikka/api/rpc', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-mikka-locale': 'en', 'x-mikka-stream-key': 'synthetic-stream' },
      body: '{"synthetic":true}',
    })
    const remote = f.calls.at(-1)!
    assert.equal(remote.url, 'https://a.test/mikka/api/desktop/rpc')
    for (const name of Object.keys(cloudCorrelationHeaders)) assert.equal(remote.headers.get(name), null, name)
    assert.equal(remote.headers.get('authorization'), `Bearer ${'t'.repeat(40)}`)
    assert.equal(remote.headers.get('x-mikka-desktop-protocol'), '1')
    assert.equal(remote.headers.get('content-type'), 'application/json')
    assert.equal(remote.headers.get('x-mikka-locale'), 'en')
    assert.equal(remote.headers.get('x-mikka-stream-key'), 'synthetic-stream')
    assert.equal(remote.method, 'POST')
    assert.equal(await remote.text(), '{"synthetic":true}')
    controller.abort()
    assert.equal(remote.signal.aborted, true)

    await f.directory.switchServer(null)
    await fetch('https://app.aspectlylabs.com/mikka/api/rpc', { method: 'POST', body: '{}' })
    const cloud = f.calls.at(-1)!
    assert.equal(cloud.url, 'https://app.aspectlylabs.com/mikka/api/rpc')
    for (const [name, value] of Object.entries(cloudCorrelationHeaders)) assert.equal(cloud.headers.get(name), value, name)
    assert.equal(cloud.headers.has('authorization'), false)
  })
}
