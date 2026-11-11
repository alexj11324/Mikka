import assert from 'node:assert/strict'
import test from 'node:test'
import { eveProxyPath, eveServiceOrigin, proxyEveRequest } from './eve-service-proxy'

test('the app mount forwards only eve protocol paths to an operator-configured origin', () => {
  assert.equal(eveProxyPath(new Request('https://app.test/mikka/api/agents/eve/v1/session/wrun_a/stream?startIndex=9')), '/eve/v1/session/wrun_a/stream')
  for (const path of ['/api/other', '/mikka/api/agents/https://evil.test', '/mikka/api/agents/eve/v1/session/a%2fb']) {
    assert.throws(() => eveProxyPath(new Request(`https://app.test${path}`)))
  }
  for (const value of ['https://user:password@eve.test', 'https://eve.test/path', 'file:///tmp/eve', 'https://eve.test?x=1']) {
    assert.throws(() => eveServiceOrigin({ MIKKA_EVE_ORIGIN: value }))
  }
})

test('forwarding retains auth, bot scope, cursors, streaming body and cancellation', async () => {
  const controller = new AbortController()
  const request = new Request('https://app.test/mikka/api/agents/eve/v1/session/wrun_a?botId=bot-a&startIndex=8', {
    method: 'POST', body: '{"message":"Hello"}', headers: { cookie: 'session=fixture', authorization: 'Bearer fixture', connection: 'x-private-hop', 'x-private-hop': 'remove' }, signal: controller.signal,
  })
  let upstreamRequest: Request | undefined
  const source = new TransformStream<Uint8Array, Uint8Array>()
  const response = await proxyEveRequest(request, undefined, { fetch: async (input, init) => {
    upstreamRequest = new Request(input, init)
    return new Response(source.readable, { headers: { 'content-type': 'application/x-ndjson' } })
  } })
  assert.equal(upstreamRequest!.url, 'http://127.0.0.1:3002/eve/v1/session/wrun_a?botId=bot-a&startIndex=8')
  assert.equal(upstreamRequest!.headers.get('cookie'), 'session=fixture')
  assert.equal(upstreamRequest!.headers.get('authorization'), 'Bearer fixture')
  assert.equal(upstreamRequest!.headers.get('x-forwarded-host'), 'app.test')
  assert.equal(upstreamRequest!.headers.has('x-private-hop'), false)
  assert.equal(await upstreamRequest!.text(), '{"message":"Hello"}')
  const reader = response.body!.getReader(), writer = source.writable.getWriter()
  const read = reader.read()
  await writer.write(new TextEncoder().encode('{"progress":{}}\n'))
  assert.equal(new TextDecoder().decode((await read).value), '{"progress":{}}\n')
  controller.abort()
  assert.equal(upstreamRequest!.signal.aborted, true)
  await reader.cancel()
})

test('the Slack compatibility route keeps the exact signed body and does not follow redirects', async () => {
  const request = new Request('https://app.test/mikka/api/webhooks/slack', { method: 'POST', body: ' { "event": "signed" } ', headers: { 'x-slack-signature': 'v0=fixture' } })
  const response = await proxyEveRequest(request, '/eve/v1/slack', { fetch: async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:3002/eve/v1/slack')
    assert.equal(init!.redirect, 'manual')
    assert.equal(await new Response(init!.body).text(), ' { "event": "signed" } ')
    assert.equal(new Headers(init!.headers).get('x-slack-signature'), 'v0=fixture')
    return new Response(null, { status: 307, headers: { location: 'https://other.test' } })
  } })
  assert.equal(response.status, 307)
})

test('cookie session mutations require the configured application origin before any upstream call', async () => {
  let calls = 0
  const options = { env: { BETTER_AUTH_URL: 'https://app.test' }, fetch: async () => { calls++; return new Response('{}') } }
  for (const origin of [undefined, 'https://evil.test', 'https://app.test.evil.test']) {
    const headers = new Headers({ cookie: 'session=fixture', 'content-type': 'text/plain', 'x-forwarded-host': 'evil.test' })
    if (origin) headers.set('origin', origin)
    const response = await proxyEveRequest(new Request('https://app.test/mikka/api/agents/eve/v1/session', { method: 'POST', body: '{"message":"paid turn"}', headers }), undefined, options)
    assert.equal(response.status, 403)
  }
  assert.equal(calls, 0)
  const request = new Request('https://app.test/mikka/api/agents/eve/v1/session/wrun_a/cancel', {
    method: 'POST', body: '{}', headers: { cookie: 'session=fixture', origin: 'https://app.test' },
  })
  assert.equal((await proxyEveRequest(request, undefined, options)).status, 200)
  assert.equal(calls, 1)
})
