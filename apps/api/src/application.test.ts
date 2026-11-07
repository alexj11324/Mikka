import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import test from 'node:test'
import { NodeRequest } from 'srvx/node'
import { NextRequest as OriginalNextRequest } from 'next/server.js'
import { context as otelContext, propagation, trace } from '@opentelemetry/api'
import { AlwaysOnSampler, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { beginRequestTrace } from '../runtime/request-trace'
import { createApiHandler } from './application'
import { createRequestScope, currentRequestScope, requestCache, runRequestScope } from './context'
import { cookies, headers } from '../compat/headers'
import { after, NextRequest, NextResponse, NextURL } from '../compat/server'
import { getLocale, getTranslations } from '../compat/intl'
import { getPathname } from '../compat/localized-navigation'
import type { ApiRoute } from './routes'
import { createWebTransport } from '../../../lib/web-connection/transport'

const fixture = (path: string, module: Record<string, unknown>, methods = Object.keys(module)): ApiRoute => ({ path: `/mikka/api/${path}`, template: `/api/${path}`, source: 'fixture', methods, load: async () => module })
const request = (path = 'one', init?: RequestInit) => new Request(`https://example.test/mikka/api/${path}`, init)

test('official web bearer adaptation is installed before the API scope and strips handler cookies afterward', async () => {
  let calls = 0, revoked = false
  const origin = 'https://app.aspectlylabs.com', authorization = `Bearer ${'s'.repeat(40)}`
  const app = createApiHandler([fixture('write', { POST: async (input: Request) => {
    calls++
    assert.equal(input.headers.get('origin'), 'https://example.test')
    assert.equal((await headers()).get('authorization'), authorization)
    assert.equal((await headers()).has('cookie'), false)
    ;(await cookies()).set('must-not-cross', 'cookie')
    return Response.json({ body: await input.text() })
  } })], undefined, createWebTransport({ env: {}, authenticate: async incoming => {
    assert.deepEqual([...incoming], [['authorization', authorization]])
    return revoked ? null : { user: { id: 'owner' }, session: { id: 'session' } }
  }, scope: (_, work) => work() }))
  const read = () => app.fetch(request('write', { method: 'POST', body: 'selected-server', headers: { origin, authorization, cookie: 'cloud=private' } }))
  const accepted = await read()
  assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { body: 'selected-server' })
  assert.equal(accepted.headers.get('access-control-allow-origin'), origin)
  assert.equal(accepted.headers.has('set-cookie'), false)
  revoked = true
  const denied = await read()
  assert.equal(denied.status, 401); assert.equal(calls, 1)
})

test('request cookies match the installed SDK for duplicates and malformed encoding without rewriting auth headers', async () => {
  for (const cookie of [
    'NEXT_LOCALE=en; NEXT_LOCALE=zh-CN; mikka-workspace=old; mikka-workspace=new',
    'NEXT_LOCALE=en; NEXT_LOCALE=%E0%A4%A; bad=%; invalid=%FF; valid=%E4%B8%AD',
    'bad=%; bad=okay; empty=; flag; quoted="value"; plus=a+b; equals=a=b; encoded=%3D',
    'spaced =value;\tuntouched=name; %6Eame=literal; ; final=one; final=two',
  ]) {
    const input = request('one', { headers: { cookie } })
    const original = new OriginalNextRequest(input), adapted = new NextRequest(input)
    assert.deepEqual(adapted.cookies.getAll(), original.cookies.getAll())
    assert.equal(adapted.headers.get('cookie'), input.headers.get('cookie'))
    await runRequestScope(createRequestScope(input), async () => {
      assert.deepEqual((await cookies()).getAll(), original.cookies.getAll())
      assert.equal((await headers()).get('cookie'), input.headers.get('cookie'))
    })
  }
})

test('exact routes, decoded parameters, HEAD and OPTIONS preserve method contracts', async () => {
  let writes = 0
  const app = createApiHandler([
    fixture('items/static', { GET: () => Response.json({ static: true }) }),
    fixture('items/[id]', { GET: async (_: Request, { params }: { params: Promise<{ id: string }> }) => Response.json(await params), POST: () => { writes++; return new Response('written') } }),
  ])
  assert.deepEqual(await (await app.fetch(request('items/static'))).json(), { static: true })
  assert.deepEqual(await (await app.fetch(request('items/a%20b'))).json(), { id: 'a b' })
  const head = await app.fetch(request('items/x', { method: 'HEAD' }))
  assert.equal(head.status, 200); assert.equal(await head.text(), '')
  const options = await app.fetch(request('items/x', { method: 'OPTIONS' }))
  assert.equal(options.status, 204); assert.equal(options.headers.get('allow'), 'GET, HEAD, OPTIONS, POST')
  assert.equal((await app.fetch(request('items/x', { method: 'PATCH' }))).status, 405)
  assert.equal((await app.fetch(request('items/x/nested'))).status, 404)
  assert.equal((await app.fetch(request('items/%E0%A4%A'))).status, 400)
  assert.equal(writes, 0)
})

test('API slash redirects preserve POST replay and never execute a handler or decode an encoded route', async () => {
  let called = 0
  const app = createApiHandler([fixture('write', { POST: async (input: Request) => {
    called++
    return Response.json({ method: input.method, body: await input.text(), query: new URL(input.url).search })
  } })])
  const input = request('write/?x=a%2Fb&x=c+d', { method: 'POST', body: 'original payload', headers: { authorization: 'Bearer fixture' } })
  const response = await app.fetch(input)
  assert.equal(response.status, 308); assert.equal(called, 0); assert.equal(input.bodyUsed, false)
  const replay = new Request(response.headers.get('location')!, input)
  assert.deepEqual(await (await app.fetch(replay)).json(), { method: 'POST', body: 'original payload', query: '?x=a%2Fb&x=c+d' })
  assert.equal(called, 1)
  for (const path of ['missing/', '../%61pi/write/', '../api%2Fwrite/']) {
    const redirected = await app.fetch(request(path))
    assert.equal(redirected.status, 308)
    const missing = await app.fetch(new Request(redirected.headers.get('location')!))
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('content-type')?.includes('text/html'), false)
  }
  assert.equal((await app.fetch(request('write%2F', { method: 'POST', body: 'opaque' }))).status, 404)
  assert.equal(called, 1)
})

test('parallel requests retain their own cookie, locale, React cache and all after ALS', async () => {
  const rendezvous = Promise.withResolvers<void>(), ready: string[] = [], observations: unknown[] = []
  const other = new AsyncLocalStorage<string>()
  let reads = 0
  const memo = requestCache(async () => { reads++; return (await headers()).get('cookie') })
  const app = createApiHandler([fixture('one', { GET: async () => {
    const identity = (await headers()).get('cookie')!
    ready.push(identity); if (ready.length === 2) rendezvous.resolve()
    await rendezvous.promise
    assert.equal(await memo(), identity); assert.equal(await memo(), identity)
    const locale = await getLocale()
    other.run(identity, () => after(() => { observations.push([currentRequestScope()?.headers.get('cookie'), other.getStore(), locale]) }))
    return Response.json({ identity, locale })
  } })])
  const pending: Promise<unknown>[] = []
  const a = Object.assign(request('one', { headers: { cookie: 'owner=a', 'x-mikka-locale': 'en' } }), { waitUntil: (work: Promise<unknown>) => pending.push(work) })
  const b = Object.assign(request('one', { headers: { cookie: 'owner=b', 'x-mikka-locale': 'zh-CN' } }), { waitUntil: (work: Promise<unknown>) => pending.push(work) })
  const responses = await Promise.all([app.fetch(a), app.fetch(b)])
  assert.deepEqual(await Promise.all(responses.map(value => value.json())), [{ identity: 'owner=a', locale: 'en' }, { identity: 'owner=b', locale: 'zh-CN' }])
  await Promise.all(pending)
  assert.equal(reads, 2)
  assert.deepEqual(observations.sort(), [['owner=a', 'owner=a', 'en'], ['owner=b', 'owner=b', 'zh-CN']])
  assert.equal(currentRequestScope(), undefined)
})

test('multiple raw Set-Cookie fields retain Expires, chunks and deletion attributes', async () => {
  const existing = 'proof.0=first; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly; Secure; SameSite=None'
  const app = createApiHandler([fixture('one', { GET: async () => {
    const jar = await cookies()
    jar.set('proof.1', 'second', { httpOnly: true, secure: true, sameSite: 'none', path: '/mikka' })
    jar.delete({ name: 'old', path: '/mikka' })
    const response = new NextResponse('okay')
    response.headers.append('set-cookie', existing)
    response.cookies.set('selector', 'new', { maxAge: 10, path: '/mikka' })
    return response
  } })])
  const response = await app.fetch(request())
  assert.deepEqual(response.headers.getSetCookie(), [existing, 'selector=new; Max-Age=10; Path=/mikka', 'proof.1=second; Path=/mikka; HttpOnly; Secure; SameSite=None', 'old=; Path=/mikka; Expires=Thu, 01 Jan 1970 00:00:00 GMT'])
  await response.text()
})

for (const outcome of ['complete', 'cancel', 'error'] as const) test(`real Web stream ${outcome} schedules after once and retains waitUntil`, async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>, ran = 0, traceFinished = 0
  const afterDone = Promise.withResolvers<void>(), lifetimes: Promise<unknown>[] = []
  const app = createApiHandler([fixture('one', { GET: () => {
    after(async () => { ran++; await afterDone.promise })
    return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(new Uint8Array([65])) } }))
  } })], () => ({ run: work => work(), finish: () => { traceFinished++ } }))
  const input = Object.assign(request(), { waitUntil: (work: Promise<unknown>) => lifetimes.push(work) })
  const response = await app.fetch(input)
  assert.equal(ran, 0); assert.equal(traceFinished, 0)
  const reader = response.body!.getReader()
  assert.deepEqual((await reader.read()).value, new Uint8Array([65]))
  if (outcome === 'complete') { controller.close(); assert.equal((await reader.read()).done, true) }
  else if (outcome === 'cancel') await reader.cancel()
  else { controller.error(new Error('fixture')); await assert.rejects(reader.read(), /fixture/) }
  afterDone.resolve()
  await Promise.all(lifetimes)
  assert.equal(ran, 1); assert.equal(traceFinished, 1)
})

test('native Request facade retains URL, query, clone, body and cancellation without global patch', async () => {
  const controller = new AbortController()
  const original = new Request('https://example.test/mikka/api/check?q=1', { method: 'POST', body: 'payload', signal: controller.signal, headers: { cookie: 'a=1' } })
  const adapted = new NextRequest(original)
  assert.equal(adapted.method, 'POST'); assert.equal(await adapted.clone().text(), 'payload')
  assert.equal(adapted.nextUrl.pathname, '/api/check'); assert.equal(adapted.nextUrl.basePath, '/mikka')
  assert.equal(adapted.nextUrl.clone().href, original.url)
  adapted.cookies.set('b', '2'); assert.equal(adapted.headers.get('cookie'), 'a=1; b=2')
  controller.abort(); assert.equal(adapted.signal.aborted, true)
  const url = new NextURL('https://example.test/mikka?x=1'); url.pathname = '/settings'
  assert.equal(url.href, 'https://example.test/mikka/settings?x=1')
})

test('actual srvx NodeRequest backing preserves POST and rejects stale canonical authority', async () => {
  const socket = new Socket(), incoming = new IncomingMessage(socket)
  incoming.method = 'POST'; incoming.url = '/mikka/api/check?q=1'; incoming.headers = { host: 'example.test', 'content-type': 'text/plain' }
  incoming.rawHeaders = ['Host', 'example.test', 'Content-Type', 'text/plain']
  incoming.push(Buffer.from('body')); incoming.push(null)
  const response = new ServerResponse(incoming)
  const original = new NodeRequest({ req: incoming, res: response, trustProxy: false })
  original._url = new URL('https://example.test/mikka/api/check?q=1')
  const adapted = new NextRequest(original)
  assert.equal(adapted.url, original.url); assert.equal(adapted.method, 'POST'); assert.equal(await adapted.text(), 'body')
  assert.equal(original.runtime?.node?.req, incoming)
  original._url = new URL('https://other.test/mikka/api/check?q=1')
  assert.throws(() => new NextRequest(original), /API_REQUEST_BODY_USED|API_REQUEST_URL_MISMATCH/)
  socket.destroy()
})

test('locale and translations use actual ICU formatter; localized URL keeps query/hash', async () => {
  await runRequestScope(createRequestScope(request('one', { headers: { 'x-mikka-locale': 'en' } })), async () => {
    assert.equal(await getLocale(), 'en')
    const t = await getTranslations('Auth')
    assert.equal(t('signIn'), 'Sign in')
    const readonlyHeaders = await headers()
    assert.throws(() => readonlyHeaders.set('x', 'x'), /API_REQUEST_HEADERS_READONLY/)
  })
  assert.equal(getPathname({ locale: 'en', href: { pathname: '/settings', query: { tab: 'a b' }, hash: 'details' } }), '/en/settings?tab=a+b#details')
  assert.equal(getPathname({ locale: 'zh-CN', href: '/settings?tab=x#details' }), '/settings?tab=x#details')
  assert.equal(NextResponse.redirect('https://example.test/a', { status: 303, headers: { 'cache-control': 'no-store' } }).status, 303)
})

for (const outcome of ['accepted', 'expired', 'unavailable', 'disabled', 'preflight'] as const) test(`web transport ${outcome} belongs to the original request trace before any business scope`, async () => {
  const memory = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(memory)] })
  provider.register()
  try {
    const origin = 'https://app.aspectlylabs.com', authorization = `Bearer ${'s'.repeat(40)}`
    const lifetimes: Promise<unknown>[] = [], finished = Promise.withResolvers<void>()
    const sources: Request[] = [], scopes: boolean[] = [], parents: Array<string | undefined> = []
    let authenticationReads = 0, handlers = 0, afterRuns = 0, finishes = 0, finishStatus: number | undefined
    const input = Object.assign(request('write', { method: outcome === 'preflight' ? 'OPTIONS' : 'POST',
      ...(outcome === 'preflight' ? {} : { body: 'private-body-canary' }),
      headers: { origin, authorization, cookie: 'cloud=private-cookie-canary',
        ...(outcome === 'preflight' ? { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } : {}) },
    }), { waitUntil: (work: Promise<unknown>) => lifetimes.push(work) })
    const prepare = createWebTransport({ env: outcome === 'disabled' ? { MIKKA_OFFICIAL_WEB_ENABLED: '0' } : {},
      authenticate: async () => {
        authenticationReads++
        scopes.push(currentRequestScope() !== undefined)
        parents.push(trace.getActiveSpan()?.spanContext().spanId)
        // Only a numeric child span: this verifies the active-parent boundary
        // required by pg instrumentation without a database or auth SDK call.
        const lookup = trace.getTracer('application-test').startSpan('auth.lookup')
        await Promise.resolve()
        lookup.end()
        if (outcome === 'unavailable') throw new Error('authentication_fixture_failed')
        return outcome === 'expired' ? null : { user: { id: 'owner' }, session: { id: 'session' } }
      }, scope: (_identity, work) => work(),
    })
    const app = createApiHandler([fixture('write', { POST: async (adapted: Request) => {
      handlers++
      assert.equal(adapted.headers.get('origin'), 'https://example.test')
      assert.equal((await headers()).has('cookie'), false)
      assert.equal(await adapted.text(), 'private-body-canary')
      ;(await cookies()).set('must-not-cross', 'private-response-canary')
      after(() => { afterRuns++; assert.equal(finishes, 1) })
      return new Response('accepted')
    } })], (original, route) => {
      sources.push(original)
      const active = beginRequestTrace(original, route)
      return { run: work => active.run(work), finish(status, error) { finishes++; finishStatus = status; active.finish(status, error); finished.resolve() } }
    }, (original, route) => {
      scopes.push(currentRequestScope() !== undefined)
      parents.push(trace.getActiveSpan()?.spanContext().spanId)
      return prepare(original, route)
    })
    const response = await app.fetch(input)
    const expectedStatus = { accepted: 200, expired: 401, unavailable: 503, disabled: 403, preflight: 204 }[outcome]
    assert.equal(response.status, expectedStatus)
    assert.equal(response.headers.get('access-control-allow-origin'), origin)
    assert.equal(response.headers.has('access-control-allow-credentials'), false)
    assert.equal(response.headers.has('set-cookie'), false)
    assert.equal(sources.length, 1, 'even a transport early response owns a request trace')
    assert.equal(sources[0], input, 'tracing receives the untouched outer request')
    await response.text()
    await finished.promise
    await Promise.all(lifetimes)
    await provider.forceFlush()
    const spans = memory.getFinishedSpans(), root = spans.find(span => span.name.endsWith(' /api/write'))!
    assert.ok(root)
    assert.ok(parents.every(parent => parent === root.spanContext().spanId), 'transport preparation and fresh authentication run under the request parent')
    assert.ok(scopes.every(value => value === false), 'business scope is created only from the adapted request')
    const expectedReads = ['accepted', 'expired', 'unavailable'].includes(outcome) ? 1 : 0
    assert.equal(authenticationReads, expectedReads)
    const lookups = spans.filter(span => span.name === 'auth.lookup')
    assert.equal(lookups.length, expectedReads)
    for (const lookup of lookups) {
      assert.equal(lookup.parentSpanContext?.spanId, root.spanContext().spanId)
      assert.equal(lookup.spanContext().traceId, root.spanContext().traceId)
    }
    assert.equal(root.attributes['http.response.status_code'], expectedStatus)
    assert.equal(root.status.code, outcome === 'unavailable' ? 2 : 0)
    assert.equal(finishes, 1); assert.equal(finishStatus, expectedStatus)
    assert.equal(handlers, outcome === 'accepted' ? 1 : 0)
    assert.equal(afterRuns, handlers)
    assert.equal(input.headers.get('origin'), origin)
    assert.equal(currentRequestScope(), undefined)
    const exported = JSON.stringify(spans.map(span => ({ name: span.name, attributes: span.attributes, events: span.events })))
    for (const canary of ['private-body-canary', 'private-cookie-canary', 'private-response-canary', authorization]) assert.equal(exported.includes(canary), false)
  } finally {
    await provider.shutdown()
    trace.disable(); otelContext.disable(); propagation.disable()
  }
})

test('a rejected transport preparation keeps the original H3 error response and finishes its trace once', async () => {
  const error = new Error('transport_fixture_failed'), finished = Promise.withResolvers<void>()
  const observed: Array<{ status: number; error?: unknown }> = []
  let traced = 0, handlers = 0
  const app = createApiHandler([fixture('one', { GET: () => { handlers++; return new Response('unreachable') } })], () => {
    traced++
    return { run: work => work(), finish(status, cause) { observed.push({ status, error: cause }); finished.resolve() } }
  }, async () => { throw error })
  app.config.silent = true
  const response = await app.fetch(request())
  assert.equal(response.status, 500)
  assert.equal(traced, 1)
  await response.text(); await finished.promise
  assert.equal(handlers, 0)
  assert.deepEqual(observed, [{ status: 500, error }])
  assert.equal(currentRequestScope(), undefined)
})

for (const outcome of ['complete', 'cancel', 'error'] as const) test(`adapted Web stream ${outcome} retains tracing and after disposal`, async () => {
  const active = new AsyncLocalStorage<string>()
  const afterDone = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>(), lifetimes: Promise<unknown>[] = []
  let controller!: ReadableStreamDefaultController<Uint8Array>, afterRuns = 0, finishes = 0, authenticationReads = 0
  const seen: Array<string | undefined> = []
  const app = createApiHandler([fixture('one', { GET: () => {
    seen.push(active.getStore())
    after(async () => { afterRuns++; seen.push(active.getStore()); assert.equal(finishes, 1); await afterDone.promise })
    return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(new Uint8Array([65])) } }))
  } })], () => ({ run: work => active.run('request', work), finish(status) { assert.equal(status, 200); finishes++; finished.resolve() } }),
  createWebTransport({ env: {}, authenticate: async () => {
    authenticationReads++; seen.push(active.getStore())
    return { user: { id: 'owner' }, session: { id: 'session' } }
  }, scope: (_identity, work) => work() }))
  const input = Object.assign(request('one', { headers: { origin: 'https://app.aspectlylabs.com', authorization: `Bearer ${'s'.repeat(40)}` } }), { waitUntil: (work: Promise<unknown>) => lifetimes.push(work) })
  const response = await app.fetch(input)
  assert.equal(afterRuns, 0); assert.equal(finishes, 0)
  const reader = response.body!.getReader()
  assert.deepEqual((await reader.read()).value, new Uint8Array([65]))
  if (outcome === 'complete') { controller.close(); assert.equal((await reader.read()).done, true) }
  else if (outcome === 'cancel') await reader.cancel()
  else { controller.error(new Error('stream_fixture_failed')); await assert.rejects(reader.read(), /stream_fixture_failed/) }
  await finished.promise
  afterDone.resolve(); await Promise.all(lifetimes)
  assert.equal(authenticationReads, 1); assert.equal(afterRuns, 1); assert.equal(finishes, 1)
  assert.deepEqual(seen, ['request', 'request', 'request'])
  assert.equal(currentRequestScope(), undefined)
})
