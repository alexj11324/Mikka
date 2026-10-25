import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { agentWebInstructions, createAgentWebTools, isPublicWebAddress, webUrlSchema } from '../lib/agent-web-tools.ts'
import { createWebService } from '../lib/search/index.ts'
import { createFirecrawlProvider } from '../lib/search/firecrawl.ts'

const signal = new AbortController().signal
const context = { toolCallId: 'test', messages: [], abortSignal: signal }
const user = { userId: 'synthetic-agent', caller: 'agent-panel' }
const failure = outcome => ({ ok: false, error: 'searchUnavailable', outcome })
const toolsFor = options => createAgentWebTools({ signal, context: user, ...options })

test('Agent uses the shared Firecrawl service with authenticated user context and bounded tool steps', async () => {
  assert.deepEqual(Object.keys(toolsFor()), ['web_search', 'read_webpage'])
  const source = await readFile(new URL('../app/api/agent/route.ts', import.meta.url), 'utf8')
  assert.match(source, /opencode\('deepseek-v4\.1-flash'\)/)
  assert.match(source, /auth\.api\.getSession/)
  assert.match(source, /createAgentWebTools\(\{ signal: request.signal, context: \{ userId: session.user.id, caller: 'agent-panel' \}/)
  assert.match(source, /agentSearchStatusStream\(\)/)
  assert.match(source, /stopWhen: isStepCount\(3\)/)
  assert.match(source, /stepNumber >= 2/)
  const instructions = agentWebInstructions(new Date('2026-10-21T00:00:00Z'))
  assert.match(instructions, /2026-10-21/)
  assert.match(instructions, /时区/)
  assert.match(instructions, /不可信数据/)
  const implementation = await readFile(new URL('../lib/agent-web-tools.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(implementation, /perplexity|browserbase|generateText|billing_required/i)
})

test('Reject non-HTTPS, credentials, private names, IP literals and custom ports', () => {
  for (const url of ['http://example.org', 'https://user:pass@example.org', 'https://127.0.0.1', 'https://[::1]', 'https://2130706433', 'https://0x7f000001', 'https://localhost', 'https://host.internal', 'https://site.local', 'https://site.local.', 'https://example.org:8080']) {
    assert.equal(webUrlSchema.safeParse(url).success, false, url)
  }
  assert.equal(webUrlSchema.safeParse('https://www.weather.gov/').success, true)
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '172.16.0.2', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '3fff::1', '2002:7f00:1::']) assert.equal(isPublicWebAddress(address), false, address)
  assert.equal(isPublicWebAddress('8.8.8.8'), true)
  assert.equal(isPublicWebAddress('2606:4700:4700::1111'), true)
})

test('Actual Agent → shared service → Firecrawl adapter preserves search evidence and markdown', async () => {
  const seen = []
  const provider = createFirecrawlProvider(async (url, init) => {
    seen.push({ url, input: JSON.parse(init.body) })
    return url.endsWith('/search')
      ? Response.json({ success: true, data: { web: [{ url: 'https://www.weather.gov/', title: 'Weather', description: 'Public weather' }] } })
      : Response.json({ success: true, data: { markdown: '# Weather\nPublic weather', metadata: { sourceURL: 'https://www.weather.gov/', url: 'https://www.weather.gov/', statusCode: 200 } } })
  }, { resolve: async () => [{ address: '8.8.8.8' }] })
  const web = createWebService({ provider })
  const tools = toolsFor({ search: web.search, scrape: web.scrape })
  const found = await tools.web_search.execute({ query: 'public weather' }, context)
  assert.equal(found.ok, true)
  assert.equal(found.results[0].url, 'https://www.weather.gov/')
  assert.equal(found.untrustedContent, true)
  assert.ok(Date.parse(found.retrievedAt))
  const page = await tools.read_webpage.execute({ url: found.results[0].url }, context)
  assert.equal(page.content, '# Weather\nPublic weather')
  assert.equal(page.url, found.results[0].url)
  assert.equal(page.untrustedContent, true)
  assert.deepEqual(seen.map(x => x.url), ['https://api.firecrawl.dev/v2/search', 'https://api.firecrawl.dev/v2/scrape'])
  assert.deepEqual(Object.keys(seen[0].input).sort(), ['limit', 'query', 'sources'])
})

test('429 emits the reserved degradation notice and suppresses both tools for the rest of the turn', async () => {
  let calls = 0
  const tools = toolsFor({ search: async (_q, ctx) => { assert.deepEqual(ctx, user); calls++; return failure('rate_limited') }, scrape: async () => { calls++; return failure('error') } })
  for (const tool of [() => tools.web_search.execute({ query: 'public weather' }, context), () => tools.read_webpage.execute({ url: 'https://www.weather.gov/' }, context)]) {
    const result = await tool()
    assert.equal(result.ok, false)
    assert.equal(result.notice, 'search_degraded')
    assert.equal(result.outcome, 'rate_limited')
    assert.match(result.error, /429/)
  }
  assert.equal(calls, 1)
})

test('Timeout and upstream errors degrade explicitly, cap turn calls, and propagate cancellation', async () => {
  let calls = 0
  const tools = toolsFor({ search: async () => { calls++; return failure('timeout') } })
  for (let i = 0; i < 4; i++) {
    const result = await tools.web_search.execute({ query: 'public weather' }, context)
    assert.equal(result.ok, false)
    assert.equal(result.notice, 'search_degraded')
  }
  assert.equal(calls, 2)
  const controller = new AbortController()
  controller.abort()
  const cancelled = toolsFor({ signal: controller.signal, search: async () => { throw new Error('must not run') } })
  await assert.rejects(cancelled.web_search.execute({ query: 'public weather' }, context), { name: 'AbortError' })
})


test('A new Agent turn after 59 minutes preserves provider retrieval time and exposes cache age', async () => {
  const base = Date.parse('2026-10-25T20:00:00.000Z')
  let now = base
  let calls = 0
  // The original #64 provider contract still only returns result arrays.
  const web = createWebService({ now: () => now, provider: { name: 'legacy-array-provider', search: async () => {
    calls++
    return [{ title: 'Public weather', url: 'https://www.weather.gov/', snippet: 'Time-sensitive evidence' }]
  } } })
  const first = await toolsFor({ search: web.search }).web_search.execute({ query: 'current weather' }, context)
  assert.equal(first.retrievedAt, '2026-10-25T20:00:00.000Z')
  assert.equal(first.cached, false)
  assert.equal(first.cacheAgeMs, 0)
  now += 59 * 60_000
  const cached = await toolsFor({ search: web.search }).web_search.execute({ query: 'current weather' }, context)
  assert.equal(calls, 1)
  assert.equal(cached.retrievedAt, first.retrievedAt)
  assert.equal(cached.cached, true)
  assert.equal(cached.cacheAgeMs, 59 * 60_000)
  now += 2 * 60_000
  const refreshed = await toolsFor({ search: web.search }).web_search.execute({ query: 'current weather' }, context)
  assert.equal(calls, 2)
  assert.equal(refreshed.retrievedAt, '2026-10-25T21:01:00.000Z')
  assert.equal(refreshed.cached, false)
  assert.equal(refreshed.cacheAgeMs, 0)
})

test('Legacy service responses with no fetchedAt never fabricate a current retrieval timestamp', async () => {
  const tools = toolsFor({ search: async () => ({ ok: true, cached: true, results: [] }) })
  const output = await tools.web_search.execute({ query: 'public query' }, context)
  assert.equal(output.retrievedAt, null)
  assert.equal(output.cached, true)
  assert.equal(output.cacheAgeMs, null)
})
