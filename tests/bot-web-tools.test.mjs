import assert from 'node:assert/strict'
import test from 'node:test'
import { createBotWebTools } from '../lib/bot-web-tools.ts'
import { createWebService as meteredWebService } from '../lib/search/index.ts'
import { createFirecrawlProvider } from '../lib/search/firecrawl.ts'
const createWebService = options => meteredWebService({ ...options, consumeRate: async () => true })
const context = { toolCallId: 'synthetic', messages: [], context: {} }
const url = 'https://www.iana.org/help/example-domains'

test('Bot tools execute only supplied durable steps and preserve original source timestamps', async () => {
  const calls = []
  const tools = createBotWebTools({
    search: async input => { calls.push(input); return { ok: true, results: [{ url, title: 'IANA', snippet: 'Public evidence' }], cached: true, fetchedAt: '2026-10-25T20:00:00Z', cacheAgeMs: 3540000 } },
    scrape: async input => { calls.push(input); return { ok: true, page: { url, markdown: '# Example domains' } } },
  })
  const search = await tools.web_search.execute({ query: 'IANA example domains' }, context)
  assert.equal(search.ok && 'retrievedAt' in search && search.retrievedAt, '2026-10-25T20:00:00Z')
  assert.equal(search.ok && 'cached' in search && search.cached, true)
  assert.equal(search.ok && 'cacheAgeMs' in search && search.cacheAgeMs, 3540000)
  const page = await tools.read_webpage.execute({ url }, context)
  assert.equal(page.ok && 'page' in page && page.page.markdown, '# Example domains')
  assert.deepEqual(calls, [{ query: 'IANA example domains' }, { url }])
})

test('Bot search and scrape return explicit rate-limit degradation without fabricating evidence', async () => {
  const unavailable = async () => ({ ok: false, error: 'searchUnavailable', outcome: 'rate_limited' })
  const tools = createBotWebTools({ search: unavailable, scrape: unavailable })
  for (const result of [await tools.web_search.execute({ query: 'public query' }, context), await tools.read_webpage.execute({ url }, context)]) {
    assert.equal(result.ok, false)
    assert.equal('notice' in result && result.notice, 'search_degraded')
    assert.match('message' in result ? result.message : '', /429.*do not retry/)
    assert.equal('results' in result || 'page' in result, false)
  }
})

test('Actual Bot tool factory → service → Firecrawl adapter protocol, with fixture transport only', async () => {
  const provider = createFirecrawlProvider(async target => target.toString().endsWith('/search')
    ? Response.json({ success: true, data: { web: [{ url, title: 'IANA', description: 'Public domains' }] } })
    : Response.json({ success: true, data: { markdown: '# Example Domains', metadata: { statusCode: 200, sourceURL: url } } }),
  { resolve: async () => [{ address: '8.8.8.8' }] })
  const service = createWebService({ provider })
  const caller = { userId: 'synthetic-bot-user', caller: 'coordinator' }
  const tools = createBotWebTools({ search: input => service.search(input.query, caller, input), scrape: input => service.scrape(input.url, caller) })
  assert.equal((await tools.web_search.execute({ query: 'IANA example domains' }, context)).ok, true)
  assert.equal((await tools.read_webpage.execute({ url }, context)).ok, true)
})


test('Fresh Bot tool registries retain the original provider timestamp across a 59-minute cache hit', async () => {
  let clock = Date.parse('2026-10-25T20:00:00Z')
  let calls = 0
  const caller = { userId: 'synthetic-cached-bot', caller: 'coordinator' }
  const service = createWebService({ now: () => clock, provider: { name: 'original-array-provider', search: async () => { calls++; return [{ url, title: 'IANA', snippet: 'public evidence' }] } } })
  const turn = () => createBotWebTools({ search: input => service.search(input.query, caller), scrape: async () => ({ ok: true, page: { url, markdown: 'unused' } }) })
  const first = await turn().web_search.execute({ query: 'IANA documentation' }, context)
  clock += 59 * 60000
  const second = await turn().web_search.execute({ query: 'IANA documentation' }, context)
  assert.equal(calls, 1)
  assert.equal(first.retrievedAt, '2026-10-25T20:00:00.000Z')
  assert.equal(second.retrievedAt, first.retrievedAt)
  assert.equal(second.cached, true)
  assert.equal(second.cacheAgeMs, 3540000)
  clock += 2 * 60000
  const refreshed = await turn().web_search.execute({ query: 'IANA documentation' }, context)
  assert.equal(calls, 2)
  assert.equal(refreshed.cached, false)
  assert.equal(refreshed.retrievedAt, '2026-10-25T21:01:00.000Z')
})
