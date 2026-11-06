import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import test from 'node:test'
import { NodeRequest } from 'srvx/node'
import { createApiHandler } from './application'
import { createRequestScope, currentRequestScope, requestCache, runRequestScope } from './context'
import { cookies, headers } from '../compat/headers'
import { after, NextRequest, NextResponse, NextURL } from '../compat/server'
import { getLocale, getTranslations } from '../compat/intl'
import { getPathname } from '../compat/localized-navigation'
import type { ApiRoute } from './routes'

const fixture = (path: string, module: Record<string, unknown>, methods = Object.keys(module)): ApiRoute => ({ path: `/mikka/api/${path}`, template: `/api/${path}`, source: 'fixture', methods, load: async () => module })
const request = (path = 'one', init?: RequestInit) => new Request(`https://example.test/mikka/api/${path}`, init)

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
