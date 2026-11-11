import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserModule } from './test-module.mjs'

test('web RPC keeps the shared codec but uses only normal same-origin cookie transport', async () => {
  const beforeWindow = globalThis.window
  const beforeFetch = globalThis.fetch
  const requests = []
  globalThis.window = { location: new URL('https://app.example/mikka/en') }
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return Response.json({ version: 1, ok: true, result: { accepted: true } }) }
  try {
    const api = await browserModule('export { callAction } from "./apps/frontend/src/web/rpc.ts"')
    assert.deepEqual(await api.callAction('preferences.getPreferences', []), { accepted: true })
    assert.equal(requests[0].url, '/mikka/api/rpc')
    assert.equal(requests[0].options.credentials, 'same-origin')
    assert.deepEqual(requests[0].options.headers, { 'content-type': 'application/json', 'x-mikka-rpc': '1', 'x-mikka-locale': 'en' })
    assert.deepEqual(JSON.parse(requests[0].options.body), { version: 1, action: 'preferences.getPreferences', args: [] })
    globalThis.fetch = async () => Response.json({ version: 1, ok: false, error: { code: 'workspaceAccessDenied' } }, { status: 403 })
    await assert.rejects(api.callAction('workspace.switchWorkspace', ['invalid']), error => error.code === 'workspaceAccessDenied' && error.status === 403)
  } finally { globalThis.window = beforeWindow; globalThis.fetch = beforeFetch }
})

async function ownerTransport(callback) {
  const beforeWindow = globalThis.window
  const beforeFetch = globalThis.fetch
  globalThis.window = { location: new URL('https://app.example/mikka/en'), dispatchEvent() {} }
  const api = await browserModule(`
    export { callAction } from "./apps/frontend/src/web/rpc.ts"
    export { watchSessionOwner } from "./apps/frontend/src/web/session-owner.ts"
    export { getTransportState } from "./apps/desktop/src/renderer/transport-state.ts"
  `)
  let listener
  const value = id => ({ data: { user: { id }, session: { id: `${id}-session` } }, isPending: false })
  const stop = api.watchSessionOwner({ subscribe(fn) { listener = fn; fn(value('A')); return () => {} } }, () => {})
  try { await callback(api, id => listener(value(id))) }
  finally { stop(); globalThis.window = beforeWindow; globalThis.fetch = beforeFetch }
}

test('an old web owner delayed 401 cannot clear the newly authenticated owner', () => ownerTransport(async (api, owner) => {
  const started = Promise.withResolvers()
  const delayed = Promise.withResolvers()
  let requests = 0
  globalThis.fetch = () => {
    if (++requests === 1) { started.resolve(); return delayed.promise }
    return Promise.resolve(Response.json({ version: 1, ok: true, result: { user: { id: 'B' }, session: { id: 'B-session' } } }))
  }
  const old = api.callAction('preferences.getPreferences', [])
  await started.promise
  owner('B')
  const current = await api.callAction('desktop.bootstrap', [])
  assert.equal(current.user.id, 'B')
  assert.equal(api.getTransportState(), 'ready')
  delayed.resolve(new Response('', { status: 401 }))
  await assert.rejects(old, error => error.code === 'desktop_session_changed' && error.status === 409)
  assert.equal(api.getTransportState(), 'ready')
  // The current owner's real expiry still fails closed through the same path.
  globalThis.fetch = async () => new Response('', { status: 401 })
  await assert.rejects(api.callAction('desktop.bootstrap', []), error => error.code === 'desktop_session_expired' && error.status === 401)
  assert.equal(api.getTransportState(), 'unauthenticated')
}))

test('an old web owner network rejection does not overwrite the new owner transport', () => ownerTransport(async (api, owner) => {
  const started = Promise.withResolvers()
  const delayed = Promise.withResolvers()
  const cause = new TypeError('fixture transport interruption')
  globalThis.fetch = () => { started.resolve(); return delayed.promise }
  const old = api.callAction('preferences.getPreferences', [])
  await started.promise
  owner('B')
  delayed.reject(cause)
  await assert.rejects(old, error => error.code === 'desktop_session_changed' && error.status === 409 && error.cause === cause)
  assert.equal(api.getTransportState(), 'ready')
}))

test('web owner changes fence both asynchronous response bodies and pre-request encoding', () => ownerTransport(async (api, owner) => {
  const reading = Promise.withResolvers()
  let body
  globalThis.fetch = async () => {
    const response = new Response(new ReadableStream({ start(controller) { body = controller } }), { status: 200 })
    const json = response.json.bind(response)
    response.json = () => { reading.resolve(); return json() }
    return response
  }
  const old = api.callAction('desktop.bootstrap', [])
  await reading.promise
  owner('B')
  body.enqueue(new TextEncoder().encode(JSON.stringify({ version: 1, ok: true, result: { user: { id: 'A' } } })))
  body.close()
  await assert.rejects(old, error => error.code === 'desktop_session_changed' && error.status === 409)
  assert.equal(api.getTransportState(), 'ready')
  let requests = 0
  globalThis.fetch = async () => { requests++; return Response.json({ version: 1, ok: true, result: null }) }
  const notSent = api.callAction('workspace.switchWorkspace', [{ accountId: 'B' }])
  owner('C')
  await assert.rejects(notSent, error => error.code === 'desktop_session_changed' && error.status === 409)
  assert.equal(requests, 0)
}))

test('web auth routing preserves real PKCE, refused handoff, account addition and signed OAuth return behavior', async () => {
  const { webAuthentication, authenticatedReturn } = await browserModule('export { webAuthentication, authenticatedReturn } from "./apps/frontend/src/web/auth-routing.ts"')
  const location = new URL('https://app.example/mikka/en/sign-in')
  location.search = new URLSearchParams({ desktop: '1', desktop_state: 'abcdefghijklmnop', desktop_callback: 'http://localhost:4567/auth/callback', desktop_next: '/settings?section=devices' })
  const auth = webAuthentication(location)
  assert.deepEqual(auth.desktopFlow, { state: 'abcdefghijklmnop', callback: 'http://127.0.0.1:4567/auth/callback', next: '/settings?section=devices' })
  // A signed-in browser stays on the page and shows the account before the app gets it.
  assert.equal(authenticatedReturn(location), null)
  location.searchParams.set('oauth', 'failed')
  assert.equal(authenticatedReturn(location), null)
  location.searchParams.delete('oauth')
  location.searchParams.set('addAccount', '1')
  assert.equal(authenticatedReturn(location), null)
  location.searchParams.delete('addAccount')
  location.searchParams.append('desktop_state', 'duplicate-refused')
  assert.equal(webAuthentication(location).desktopFlow, null)
  assert.equal(authenticatedReturn(new URL('https://app.example/mikka/en/sign-in?next=https://foreign.example')), '/mikka/en/')
  // A refused company SSO sign-in brings its own notice (auth-sso slot); other errors keep the OAuth one.
  assert.equal(webAuthentication(new URL('https://app.example/mikka/en/sign-in?sso=failed&error=ENTERPRISE_DIRECTORY_INACTIVE')).oauthFailed, false)
  assert.equal(webAuthentication(new URL('https://app.example/mikka/en/sign-in?error=access_denied')).oauthFailed, true)
  assert.equal(webAuthentication(new URL('https://app.example/mikka/en/sign-in?oauth=failed&sso=failed')).oauthFailed, true)
  const oauth = new URL('https://app.example/mikka/sign-in?sig=signed&client_id=client&scope=a&scope=b&ba_context=hidden&exp=123&prompt=login')
  const continuation = new URL(authenticatedReturn(oauth), oauth)
  assert.equal(continuation.pathname, '/mikka/api/auth/oauth2/authorize')
  assert.deepEqual(continuation.searchParams.getAll('scope'), ['a', 'b'])
  for (const excluded of ['sig', 'ba_context', 'exp', 'prompt']) assert.equal(continuation.searchParams.has(excluded), false)
})

test('identity-only bootstrap is limited to a validated PKCE sign-in without other OAuth continuations', async () => {
  const { isDesktopHandoffPage } = await browserModule('export { isDesktopHandoffPage } from "./apps/frontend/src/web/auth-routing.ts"')
  const url = new URL('https://app.example/mikka/en/sign-in')
  url.search = new URLSearchParams({ desktop: '1', desktop_state: 'abcdefghijklmnop', desktop_callback: 'http://localhost:4567/auth/callback', desktop_next: '/' })
  assert.equal(isDesktopHandoffPage(url), true)
  for (const [name, value] of [['oauth', 'failed'], ['addAccount', '1']]) {
    const next = new URL(url); next.searchParams.set(name, value)
    assert.equal(isDesktopHandoffPage(next), true)
  }
  for (const path of ['/mikka/en/sign-up', '/mikka/en/', '/mikka/en/device']) {
    const next = new URL(url); next.pathname = path
    assert.equal(isDesktopHandoffPage(next), false)
  }
  for (const name of ['desktop', 'desktop_state', 'desktop_callback']) {
    const next = new URL(url); next.searchParams.append(name, next.searchParams.get(name))
    assert.equal(isDesktopHandoffPage(next), false)
  }
  const foreign = new URL(url); foreign.searchParams.set('desktop_callback', 'https://foreign.example/auth/callback')
  assert.equal(isDesktopHandoffPage(foreign), false)
  const oauth = new URL(url)
  for (const [key, value] of new URLSearchParams('sig=signed&client_id=client&scope=a&ba_context=hidden&exp=123')) oauth.searchParams.set(key, value)
  assert.equal(isDesktopHandoffPage(oauth), false)
  const composio = new URL(url); composio.searchParams.set('next', '/api/integrations/composio/callback')
  assert.equal(isDesktopHandoffPage(composio), false)
})

test('web session owner watches the actual SDK atom without mutating it or treating an error as logout', async () => {
  const { watchSessionOwner } = await browserModule('export { watchSessionOwner } from "./apps/frontend/src/web/session-owner.ts"')
  let listener
  let changed = 0
  let stopped = false
  const atom = Object.freeze({ subscribe(fn) { listener = fn; fn({ data: null, isPending: true }); return () => { stopped = true } } })
  const stop = watchSessionOwner(atom, () => { changed++ })
  const first = { data: { user: { id: 'one' }, session: { id: 'first' } }, isPending: false }
  listener(first)
  listener({ ...first, isRefetching: true })
  listener({ data: null, isPending: false, error: { status: 503 } })
  listener(first)
  assert.equal(changed, 0)
  listener({ data: { user: { id: 'two' }, session: { id: 'second' } }, isPending: false })
  listener({ data: { user: { id: 'two' }, session: { id: 'second' } }, isPending: false })
  assert.equal(changed, 1)
  listener({ data: null, isPending: false })
  assert.equal(changed, 2)
  stop()
  assert.equal(stopped, true)
})

test('deployment fetch pins actual API Requests while preserving method, body, headers and abort signal', async () => {
  const { installDeploymentFetch } = await browserModule('export { installDeploymentFetch } from "./apps/frontend/src/web/deployment-fetch.ts"')
  const calls = []
  const target = { location: new URL('https://app.example/mikka'), fetch: async (input, init) => { calls.push({ input, init }); return new Response('ok') } }
  installDeploymentFetch(target, 'release-1')
  const fetch = target.fetch
  installDeploymentFetch(target, 'release-1')
  assert.equal(target.fetch, fetch)
  const signal = new AbortController().signal
  const request = new Request('https://app.example/mikka/api/rpc', { method: 'POST', body: 'payload', headers: { 'x-mikka-rpc': '1' }, signal })
  await target.fetch(request)
  assert.equal(calls[0].input, request)
  assert.equal(calls[0].init.headers.get('x-deployment-id'), 'release-1')
  assert.equal(calls[0].init.headers.get('x-mikka-rpc'), '1')
  assert.equal(await calls[0].input.text(), 'payload')
  assert.equal(calls[0].input.signal.aborted, false)
  await target.fetch('/mikka/api/auth/get-session', { headers: { accept: 'application/json' } })
  assert.equal(calls[1].init.headers.get('x-deployment-id'), 'release-1')
  await target.fetch('/mikka/api/version', { cache: 'no-store' })
  await target.fetch('https://foreign.example/api', { method: 'GET' })
  assert.deepEqual(calls[2].init, { cache: 'no-store' })
  assert.deepEqual(calls[3].init, { method: 'GET' })
})
