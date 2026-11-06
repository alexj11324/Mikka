import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openBundledWebPage } from './bundled-web'

const token = 'SyntheticOneUseHandoffToken1234567'
const serverUrl = 'https://backend.test/mikka'

function fixture() {
  const requests: string[] = [], opened: string[] = []
  let scope: string | null = 'alice-session-workspace'
  let result = Response.json({ token })
  const options = {
    serverUrl,
    auth: { scope: () => scope, request: async (path: string) => { requests.push(path); return result } },
    openExternal: async (url: string) => { opened.push(url) },
  }
  return { requests, opened, options, setScope: (next: string | null) => { scope = next }, setResult: (next: Response) => { result = next } }
}

test('OAuth continuation mints in main and opens only existing account-confirmed handoff', async () => {
  const run = fixture()
  assert.equal(await openBundledWebPage(`${serverUrl}/en?settings=account`, run.options), true)
  assert.deepEqual(run.requests, ['/api/auth/one-time-token/generate'])
  assert.equal(run.opened.length, 1)
  const browser = new URL(run.opened[0]!)
  assert.equal(browser.origin, 'https://backend.test')
  assert.equal(browser.pathname, '/mikka/api/mobile/open')
  assert.equal(browser.searchParams.get('to'), '/en?settings=account')
  assert.equal(browser.searchParams.get('token'), token)
  assert.deepEqual([...browser.searchParams.keys()], ['to', 'token'])
})

test('no token is minted for an external origin, auth endpoint or unrecognized page', async () => {
  const run = fixture()
  for (const url of [
    'https://evil.test/mikka/?settings=account', 'https://user:pass@backend.test/mikka/?settings=account',
    `${serverUrl}/api/auth/get-session`, `${serverUrl}/api/integrations/github/connect?intent=ghi_token`,
    `${serverUrl}/?settings=account&next=//evil.test`, `${serverUrl}/?settings=account#details`,
    'https://backend.test/elsewhere?settings=account', `${serverUrl}/?section=coordinator`,
  ]) assert.equal(await openBundledWebPage(url, run.options), false, url)
  assert.deepEqual(run.requests, [])
  assert.deepEqual(run.opened, [])
})

test('missing, expired or changed native session cannot open a browser with another account', async () => {
  const run = fixture()
  run.setScope(null)
  await assert.rejects(() => openBundledWebPage(`${serverUrl}/?settings=account`, run.options), /desktop_session_expired/)
  assert.equal(run.requests.length, 0)
  run.setScope('alice')
  run.setResult(Response.json({ error: 'authRequired' }, { status: 401 }))
  await assert.rejects(() => openBundledWebPage(`${serverUrl}/?settings=account`, run.options), /desktop_rpc_request_rejected/)
  run.options.auth.request = async () => { run.setScope('bob'); return Response.json({ token }) }
  await assert.rejects(() => openBundledWebPage(`${serverUrl}/?settings=account`, run.options), /desktop_session_changed/)
  assert.deepEqual(run.opened, [])
})

test('malformed token response never reaches the browser or a caller', async () => {
  for (const token of [null, '', 'short', 'opaque\nheader', 'https://other.test/credential', 'x'.repeat(129)]) {
    const run = fixture()
    run.setResult(Response.json({ token }))
    await assert.rejects(() => openBundledWebPage(`${serverUrl}/settings?section=integrations`, run.options), /desktop_rpc_request_rejected/)
    assert.deepEqual(run.opened, [])
  }
})
