import assert from 'node:assert/strict'
import test from 'node:test'
import { serverPageResponse } from './server-page'
import { serverDocumentKind, serverPageKind } from '../../../lib/server-pages'

const html = '<!doctype html><html lang="zh-CN"><body><div id="root"></div><script src="/mikka/assets/app.js"></script></body></html>'
const request = (path: string, init?: RequestInit) => new Request(`https://self.example${path}`, init)
const view = { kind: 'mikka-server', address: 'https://self.example/mikka' }
const info = async (input: Request) => new Response(input.method === 'HEAD' ? null : JSON.stringify(view), {
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
})

test('the retired option cannot select an alternate workbench; cloud serves its application', async () => {
  for (const [env, cloud] of [[{}, false], [{ MIKKA_COMMUNITY_UI: '1' }, false],
    [{ MIKKA_EDITION: 'cloud' }, true]] as const) {
    for (const path of ['/mikka', '/mikka/en', '/mikka/settings', '/mikka/en/settings/members']) {
      const response = await serverPageResponse(request(path), html, info, env)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('cache-control')!, /no-store/)
      const body = await response.text()
      if (cloud) { assert.match(body, /<html\b/); assert.doesNotMatch(body, /data-mikka-server-page/) }
      else assert.deepEqual(JSON.parse(body), view)
    }
  }
})

test('authentication documents keep their flows and server marker in both locales', async () => {
  for (const locale of ['', '/en']) for (const path of ['/sign-in?web=1&web_state=opaque', '/sign-up', '/device?user_code=TEST',
    '/forgot-password', '/reset-password?token=opaque', '/verify-email?token=opaque', '/oauth/consent', '/workspaces/new', `/invite/${'a'.repeat(64)}`, `/organization-invite/${'b'.repeat(64)}`]) {
    const response = await serverPageResponse(request(`/mikka${locale}${path}`), html, async () => { throw new Error('AUTH_MUST_RETAIN_EXISTING_FORM') }, {})
    assert.equal(response.status, 200)
    assert.match(await response.text(), /data-mikka-server-page="authentication"/)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  }
})

test('GitHub linking stays on its existing narrow surface before and after URL cleanup', async () => {
  for (const query of ['section=plugins&app=github', `section=plugins&app=github&intent=ghi_${'a'.repeat(43)}`,
    'section=plugins&app=github&github=link-failed&reason=account']) {
    const response = await serverPageResponse(request(`/mikka/?${query}`), html, info, {})
    assert.equal(response.status, 308)
    const canonical = new URL(response.headers.get('location')!)
    const document = await serverPageResponse(new Request(canonical), html, info, {})
    assert.match(await document.text(), /data-mikka-server-page="github"/)
    assert.equal(serverPageKind(canonical), 'github')
  }
  for (const query of ['section=plugins&app=gmail', 'section=plugins&app=github&intent=invalid',
    'section=plugins&app=github&app=github', 'section=plugins&app=github&next=https://evil.test']) {
    assert.equal(serverPageKind(new URL(`https://self.example/mikka?${query}`)), null)
  }
})

test('server pages preserve HEAD, refuse writes and never absorb machine endpoints', async () => {
  const head = await serverPageResponse(request('/mikka', { method: 'HEAD' }), html, info, {})
  assert.equal(head.status, 200); assert.equal(await head.text(), '')
  assert.equal((await serverPageResponse(request('/mikka', { method: 'POST', body: '{}' }), html, info, {})).status, 405)
  for (const path of ['/mikka/api/version', '/mikka/v1/live/socket', '/.well-known/workflow/v1/flow', '/mikka/%61pi/desktop/discovery']) {
    assert.equal((await serverPageResponse(request(path), html, info, {})).status, 404)
  }
  assert.equal(serverDocumentKind(), null, 'no document marker means no renderer restriction')
})

test('a browser gets the public status and client links from one read; machine clients keep JSON', async () => {
  const shell = '<html lang="zh-CN"><head></head><body><div id="root"></div></body></html>'
  const publicView = { ...view, name: 'A < B & C', version: 'fixture' }
  let reads = 0
  const unavailable = async (req: Request) => {
    reads++
    return new Response(req.method === 'HEAD' ? null : JSON.stringify(publicView), { status: 503, headers: { 'content-type': 'application/json' } })
  }
  const headers = { accept: 'text/html,application/xhtml+xml', 'accept-language': 'en' }
  const page = await serverPageResponse(request('/mikka/en', { headers }), shell, unavailable, {})
  assert.equal(page.status, 503)
  assert.match(page.headers.get('vary') ?? '', /Accept/i)
  const text = await page.text()
  assert.match(text, /data-mikka-server-page="status"/)
  assert.doesNotMatch(text, /A < B/)
  const data = /id="mikka-server-info">([^<]+)<\/script>/.exec(text)
  assert.ok(data)
  assert.deepEqual(JSON.parse(data[1]), publicView)
  assert.equal(reads, 1)
  const head = await serverPageResponse(request('/mikka/en', { method: 'HEAD', headers }), shell, unavailable, {})
  assert.equal(head.status, 503)
  assert.equal(await head.text(), '')
  const json = await serverPageResponse(request('/mikka/en', { headers: { accept: 'application/json' } }), shell, unavailable, {})
  assert.deepEqual(await json.json(), publicView)
})
