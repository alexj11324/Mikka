import assert from 'node:assert/strict'
import test from 'node:test'
import { createFirecrawlProvider } from './firecrawl'
import { SearchProviderError } from './types'
import { createWebService } from './index'

const publicHost = async () => [{ address: '8.8.8.8' }]
const url = 'https://www.iana.org/help/example-domains'
const validPage = () => ({ success: true, data: { markdown: '# Example domains', metadata: { statusCode: 200, sourceURL: url, url } } })
const ctx = { userId: 'synthetic-provider', caller: 'bot' as const }
// Keep the event loop alive while exercising AbortSignal.timeout's unref timer.
async function timed(work: () => Promise<unknown>) { const timer = setInterval(() => {}, 1000); try { return await work() } finally { clearInterval(timer) } }

test('Fixed endpoint, optional key, no credentials or redirects and markdown-only scrape options', async () => {
  const prior = process.env.FIRECRAWL_API_KEY
  try {
    for (const key of [undefined, 'synthetic-test-key']) {
      if (key) process.env.FIRECRAWL_API_KEY = key
      else delete process.env.FIRECRAWL_API_KEY
      const provider = createFirecrawlProvider(async (target, init) => {
        assert.equal(target, 'https://api.firecrawl.dev/v2/scrape')
        assert.equal(init?.redirect, 'error')
        assert.equal(init?.credentials, 'omit')
        assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, key ? `Bearer ${key}` : undefined)
        const body = JSON.parse(init?.body as string)
        assert.deepEqual(body.formats, ['markdown'])
        assert.equal(body.maxAge, 0)
        assert.equal(body.storeInCache, false)
        assert.equal(body.skipTlsVerification, false)
        assert.equal(body.headers, undefined)
        assert.equal(body.profile, undefined)
        return Response.json(validPage())
      }, { resolve: publicHost })
      assert.deepEqual(await provider.scrape!(url), { url, markdown: '# Example domains' })
    }
  } finally {
    if (prior === undefined) delete process.env.FIRECRAWL_API_KEY
    else process.env.FIRECRAWL_API_KEY = prior
  }
})

test('Invalid/non-public and mixed DNS targets send no scrape POST', async () => {
  let posts = 0
  for (const addresses of [[], [{ address: '127.0.0.1' }], [{ address: '8.8.8.8' }, { address: '10.0.0.1' }], [{ address: '::ffff:127.0.0.1' }]]) {
    const provider = createFirecrawlProvider(async () => { posts++; return Response.json(validPage()) }, { resolve: async () => addresses })
    await assert.rejects(provider.scrape!(url))
  }
  assert.equal(posts, 0)
})

test('Malformed, false-success, redirects, changed targets and target failures fail closed', async () => {
  const bodies: unknown[] = [null, {}, { success: false }, { success: true, data: { markdown: 'error' } },
    { ...validPage(), success: false },
    { success: true, data: { markdown: '', metadata: { statusCode: 200, sourceURL: url } } },
    ...[302, 404, 500].map(statusCode => ({ success: true, data: { markdown: 'error', metadata: { statusCode, sourceURL: url } } })),
    ...['https://localhost/', 'https://127.0.0.1/', 'https://www.example.org/', 'http://www.iana.org/'].map(target => ({ success: true, data: { markdown: 'wrong target', metadata: { statusCode: 200, sourceURL: url, url: target } } })),
  ]
  for (const body of bodies) await assert.rejects(createFirecrawlProvider(async () => Response.json(body), { resolve: publicHost }).scrape!(url))
  for (const body of [null, { success: false, data: { web: [] } }, { success: true, data: {} }, { success: true, data: { web: [{ url: url, title: 2 }] } }]) {
    await assert.rejects(createFirecrawlProvider(async () => Response.json(body)).search('public query'))
  }
  const provider = createFirecrawlProvider(async () => new Response('not json'))
  await assert.rejects(provider.search('public query'))
})

test('Bound response size and do not treat missing/oversized bodies as evidence', async () => {
  for (const response of [new Response(null), new Response('x'.repeat(512_001))]) {
    await assert.rejects(createFirecrawlProvider(async () => response).search('public query'))
  }
})

test('Search only returns safe public HTTPS links and never automatically scrapes them', async () => {
  const provider = createFirecrawlProvider(async (_target, init) => {
    const body = JSON.parse(init?.body as string)
    assert.equal(body.scrapeOptions, undefined)
    assert.deepEqual(body.sources, ['web'])
    return Response.json({ success: true, data: { web: [
      ...['https://127.0.0.1/', 'http://site.org/', 'https://host.internal/', 'https://x:y@site.org/'].map(url => ({ url })),
      { url, title: 'title'.repeat(200), description: 'x'.repeat(8000) },
    ] } })
  })
  const results = await provider.search('public query')
  assert.equal(results.length, 1)
  assert.equal(results[0].title.length, 300)
  assert.equal(results[0].snippet.length, 7000)
})

test('Timeout bounds stalled DNS, transport and body reads; caller cancellation remains cancellation', async () => {
  const hangs = () => new Promise<never>(() => {})
  const providers = [
    createFirecrawlProvider(async () => Response.json(validPage()), { resolve: hangs, timeoutMs: 20 }),
    createFirecrawlProvider(hangs, { resolve: publicHost, timeoutMs: 20 }),
    createFirecrawlProvider(async () => new Response(new ReadableStream({ start() {} })), { resolve: publicHost, timeoutMs: 20 }),
  ]
  await timed(async () => {
    for (const provider of providers) await assert.rejects(provider.scrape!(url), (error: unknown) => error instanceof SearchProviderError && error.outcome === 'timeout')
    const controller = new AbortController()
    const promise = providers[1].scrape!(url, { signal: controller.signal })
    controller.abort()
    await assert.rejects(promise, { name: 'AbortError' })
  })
})

test('Shared service bounds hanging permissions/providers and ignores aborted cache hits', async () => {
  await timed(async () => {
    const provider = { name: 'fixture', search: async () => new Promise<never>(() => {}) }
    for (const options of [{ provider }, { provider, authorize: async () => new Promise<boolean>(() => {}) }]) {
      const web = createWebService({ ...options, timeoutMs: 20 })
      assert.deepEqual(await web.search('public query', ctx), { ok: false, error: 'searchUnavailable', outcome: 'timeout' })
    }
  })
  let calls = 0
  const web = createWebService({ provider: { name: 'fixture', search: async () => { calls++; return [] } } })
  await web.search('public query', ctx)
  const signal = AbortSignal.abort()
  await assert.rejects(web.search('public query', ctx, { signal }), { name: 'AbortError' })
  assert.equal(calls, 1)
})

test('Cache is scoped by owner/workspace, immutable, case preserving; scrape shares search quota', async () => {
  let calls = 0
  const provider = { name: 'fixture', search: async () => { calls++; return [{ title: 'ok', url, snippet: 'evidence' }] }, scrape: async () => ({ url, markdown: 'ok' }) }
  const web = createWebService({ provider })
  const first = await web.search('Public  query', ctx)
  if (first.ok) first.results[0].snippet = 'corrupted'
  const hit = await web.search('Public query', ctx)
  assert.equal(hit.ok && hit.results[0].snippet, 'evidence')
  await web.search('public query', ctx)
  await web.search('Public query', { ...ctx, userId: 'other-user' })
  await web.search('Public query', { ...ctx, workspaceId: 'other-workspace' })
  assert.equal(calls, 4)
  for (let i = 0; i < 7; i++) assert.equal((await web.scrape(url, ctx)).ok, true)
  assert.equal((await web.search('fresh query', ctx)).ok, false)
})


test('Unchanged scrape metadata reuses the preflight DNS check within the same bounded call', async () => {
  let resolutions = 0
  const provider = createFirecrawlProvider(async () => Response.json(validPage()), { resolve: async () => { resolutions++; return publicHost() } })
  await provider.scrape!(url)
  assert.equal(resolutions, 1)
})

test('Authorization is rechecked before serving cached results', async () => {
  let allowed = true
  let calls = 0
  const web = createWebService({ authorize: () => allowed, provider: { name: 'fixture', search: async () => { calls++; return [] } } })
  assert.equal((await web.search('public query', ctx)).ok, true)
  allowed = false
  assert.equal((await web.search('public query', ctx)).ok, false)
  assert.equal(calls, 1)
})
