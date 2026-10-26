import assert from 'node:assert/strict'
import test from 'node:test'
import { createFirecrawlProvider } from './firecrawl'
import { createSearchService, SearchProviderError, type SearchProvider } from './index'

const ctx = { userId: 'u1', caller: 'coordinator' as const }

test('Firecrawl 结果映射成通用格式，并丢掉非 http 链接', async () => {
  const provider = createFirecrawlProvider(async () => Response.json({ success: true, data: { web: [
    { url: 'https://neon.com/docs', title: 'Neon', description: '分支' }, { url: 'javascript:alert(1)', title: 'x' },
  ] } }))
  assert.deepEqual(await provider.search('neon'), [{ url: 'https://neon.com/docs', title: 'Neon', snippet: '分支' }])
})

test('429 和 5xx 分别归类', async () => {
  for (const [status, outcome] of [[429, 'rate_limited'], [503, 'upstream_error']] as const) {
    const provider = createFirecrawlProvider(async () => new Response('', { status }))
    await assert.rejects(provider.search('q'), (error: unknown) => error instanceof SearchProviderError && error.outcome === outcome)
  }
})

test('失败时降级成 searchUnavailable，不抛错', async () => {
  const provider: SearchProvider = { name: 'fake', search: async () => { throw new SearchProviderError('rate_limited', '429') } }
  assert.deepEqual(await createSearchService({ provider })('q', ctx), { ok: false, error: 'searchUnavailable', outcome: 'rate_limited' })
})

test('同一查询命中缓存，只请求一次', async () => {
  let calls = 0
  const provider: SearchProvider = { name: 'fake', search: async () => { calls++; return [] } }
  const search = createSearchService({ provider })
  await search('neon  branching', ctx)
  const second = await search('neon branching', ctx)
  assert.equal(calls, 1)
  assert.equal(second.ok && second.cached, true)
})

test('每个用户每分钟最多 10 次', async () => {
  const provider: SearchProvider = { name: 'fake', search: async () => [] }
  const search = createSearchService({ provider })
  for (let i = 0; i < 10; i++) assert.equal((await search(`q${i}`, ctx)).ok, true)
  assert.deepEqual(await search('q10', ctx), { ok: false, error: 'searchUnavailable', outcome: 'rate_limited' })
})

test('权限钩子拒绝时不调用提供方', async () => {
  let calls = 0
  const provider: SearchProvider = { name: 'fake', search: async () => { calls++; return [] } }
  const result = await createSearchService({ provider, authorize: () => false })('q', ctx)
  assert.equal(result.ok, false)
  assert.equal(calls, 0)
})
