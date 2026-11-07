import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { GET } from '../../app/api/web/complete/route'
import { webAuthentication, authenticatedReturn } from '../../apps/frontend/src/web/auth-routing'
import { webAuthFlow, webAuthQuery, webAuthReturnPath } from './auth'
import { webAuthConfirmedNavigation, webAuthStateHash, webBearer } from './auth-server'
import { sha256Hex } from '../desktop-auth-server'

const flow = { state: 'abcdefghijklmnop', callback: 'https://app.aspectlylabs.com/mikka/api/web/complete' }
test('web handoff routing preserves confirmation and rejects ambiguous query values', () => {
  const query = webAuthQuery(flow)
  assert.deepEqual(webAuthFlow(query), flow)
  assert.equal(webAuthFlow({ ...query, web_state: [flow.state, flow.state] }), null)
  assert.equal(webAuthFlow({ ...query, web_callback: 'http://evil.example/api/web/complete' }), null)
  const location = new URL(`https://selfhost.example/sign-in?${new URLSearchParams(query)}`)
  assert.deepEqual(webAuthentication(location).webFlow, flow)
  assert.equal(authenticatedReturn(location), null)
  assert.match(webAuthReturnPath(flow), /\/api\/web\/return\?/)
  assert.notEqual(webAuthStateHash(flow.state), sha256Hex(flow.state))
})

test('binding requires same-origin confirmation; bearer parsing never accepts cookies', () => {
  const request = (headers: Record<string, string>) => new Request('https://selfhost.example/api/web/return', { headers })
  assert.equal(webAuthConfirmedNavigation(request({ 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(webAuthConfirmedNavigation(request({ 'sec-fetch-site': 'cross-site', referer: 'https://selfhost.example/sign-in' })), false)
  assert.equal(webAuthConfirmedNavigation(request({})), false)
  assert.equal(webBearer(request({ cookie: 'session=someone' })), null)
  assert.equal(webBearer(request({ authorization: 'Bearer token, Bearer other' })), null)
})

test('completion clears fragments before posting only code and state to its own origin and nonce channel', async () => {
  const response = await GET()
  const html = await response.text()
  const script = /<script>([\s\S]+)<\/script>/.exec(html)![1]
  const digest = createHash('sha256').update(script).digest('base64')
  assert.ok(response.headers.get('content-security-policy')?.includes(`'sha256-${digest}'`))
  assert.equal(response.headers.has('set-cookie'), false)
  assert.match(response.headers.get('cache-control')!, /no-store/)
  const calls: unknown[] = []
  const code = 'x'.repeat(43)
  runInNewContext(script, {
    location: { hash: `#state=${flow.state}&code=${code}&token=ignored`, pathname: '/mikka/api/web/complete', search: '', origin: 'https://app.aspectlylabs.com' },
    history: { replaceState: (...args: unknown[]) => calls.push(['clear', ...args]) },
    URLSearchParams,
    BroadcastChannel: class { constructor(name: string) { calls.push(['channel', name]) } postMessage(message: unknown) { calls.push(['broadcast', JSON.parse(JSON.stringify(message))]) } close() {} },
    window: { opener: { postMessage: (message: unknown, origin: string) => calls.push(['message', JSON.parse(JSON.stringify(message)), origin]) }, close: () => calls.push(['close']) },
  })
  assert.deepEqual(calls, [
    ['clear', null, '', '/mikka/api/web/complete'],
    ['message', { type: 'mikka.web.handoff', state: flow.state, code }, 'https://app.aspectlylabs.com'],
    ['channel', `mikka.web.handoff:${flow.state}`],
    ['broadcast', { type: 'mikka.web.handoff', state: flow.state, code }],
    ['close'],
  ])
})
