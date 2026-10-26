import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { basePath } from './base-path-config.mjs'

// Runs with next.config's real basePath, as the browser bundle does. Every fetch
// below is a mock standing in for #310's route: these tests cover the client's
// handling of that contract, not the deployed endpoint.
process.env.MIKKA_BASE_PATH = basePath
// Imported after the env is set; BASE_PATH is read once at module load.
let site: typeof import('./site-search')
before(async () => { site = await import('./site-search') })

const WORKSPACE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const page = (source: string, items: unknown[] = [], nextCursor: string | null = null) => ({ source, items, nextCursor })
function mockFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    return next
  }) as typeof fetch
  return { fetcher, calls }
}

test('requests go to the basePath route, history without a workspace and the others with one', async () => {
  assert.equal(basePath, '/mikka')
  const history = new URL(site.siteSearchUrl('history', '周报 50%_', null), 'https://app.test')
  assert.equal(history.pathname, '/mikka/api/search')
  assert.deepEqual([...history.searchParams], [['source', 'history'], ['q', '周报 50%_']])
  const tasks = new URL(site.siteSearchUrl('tasks', 'deploy', WORKSPACE, 'abc_-'), 'https://app.test')
  assert.deepEqual([...tasks.searchParams], [['source', 'tasks'], ['q', 'deploy'], ['workspaceId', WORKSPACE], ['cursor', 'abc_-']])
  assert.throws(() => site.siteSearchUrl('groups', 'x', null), /needs a workspace/)
})

test('the query follows the server policy so half-typed input is never sent', async () => {
  assert.deepEqual(site.siteSearchQuery('   '), { kind: 'empty' })
  assert.deepEqual(site.siteSearchQuery(' a '), { kind: 'tooShort' })
  assert.deepEqual(site.siteSearchQuery('周'), { kind: 'ready', q: '周' })
  assert.deepEqual(site.siteSearchQuery(' ab '), { kind: 'ready', q: 'ab' })
  assert.deepEqual(site.siteSearchQuery('x'.repeat(200)), { kind: 'ready', q: 'x'.repeat(200) })
  assert.deepEqual(site.siteSearchQuery('x'.repeat(201)), { kind: 'tooLong' })
})

test('(mock fetch) a page is read without caching and with same-origin credentials', async () => {
  const body = page('history', [{ type: 'history', id: 'h1', title: 'Weekly', timestamp: '2026-10-01T00:00:00.000000Z', scope: 'owner' }], 'next')
  const { fetcher, calls } = mockFetch([Response.json(body)])
  assert.deepEqual(await site.fetchSiteSearchPage({ source: 'history', q: 'week', workspaceId: WORKSPACE }, fetcher), body)
  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0].url, 'https://app.test').searchParams.has('workspaceId'), false)
  assert.equal(calls[0].init?.cache, 'no-store')
  assert.equal(calls[0].init?.credentials, 'same-origin')
})

test('(mock fetch) a withheld 403 page is retried once for a fresh authorized page', async () => {
  const fresh = page('groups', [])
  const { fetcher, calls } = mockFetch([Response.json({ error: 'searchAccessDenied' }, { status: 403 }), Response.json(fresh)])
  assert.deepEqual(await site.fetchSiteSearchPage({ source: 'groups', q: 'ops', workspaceId: WORKSPACE, cursor: 'c1' }, fetcher), fresh)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, calls[0].url)
})

test('(mock fetch) a second 403 and other errors surface as codes', async () => {
  const cases: Array<[Response | Error, string, number]> = [
    [Response.json({ error: 'searchAccessDenied' }, { status: 403 }), 'searchAccessDenied', 403],
    [Response.json({ error: 'authRequired' }, { status: 401 }), 'authRequired', 401],
    [Response.json({ error: 'searchQueryTooShort' }, { status: 400 }), 'searchInvalidParam', 400],
    [Response.json({ error: 'searchFailed' }, { status: 500 }), 'searchFailed', 500],
    [new Response('<html>Not found</html>', { status: 404 }), 'searchUnavailable', 404],
    [Response.json({ error: 'something new' }, { status: 418 }), 'searchUnavailable', 418],
    [new TypeError('offline'), 'searchUnavailable', 0],
  ]
  for (const [response, code, status] of cases) {
    const responses = code === 'searchAccessDenied' ? [response, Response.json({ error: 'searchAccessDenied' }, { status: 403 })] : [response]
    const { fetcher } = mockFetch(responses)
    await assert.rejects(site.fetchSiteSearchPage({ source: 'tasks', q: 'deploy', workspaceId: WORKSPACE }, fetcher), (error: unknown) => {
      assert.ok(error instanceof site.SiteSearchRequestError)
      assert.equal(error.code, code)
      assert.equal(error.status, status)
      return true
    })
  }
})

test('(mock fetch) an aborted request rejects with the abort, not a search error', async () => {
  const controller = new AbortController()
  controller.abort()
  const { fetcher } = mockFetch([new DOMException('aborted', 'AbortError')])
  await assert.rejects(site.fetchSiteSearchPage({ source: 'history', q: 'week', workspaceId: null, signal: controller.signal }, fetcher), { name: 'AbortError' })
})

test('local rows come first and server rows add only what is missing', async () => {
  const local = [{ id: 'a', from: 'local' }, { id: 'b', from: 'local' }]
  const remote = [{ id: 'b', from: 'remote' }, { id: 'c', from: 'remote' }, { id: 'c', from: 'remote' }]
  assert.deepEqual(site.mergeById(local, remote), [{ id: 'a', from: 'local' }, { id: 'b', from: 'local' }, { id: 'c', from: 'remote' }])
})

test('client-side matching needs every word, ignoring case', async () => {
  assert.equal(site.matchesQuery('MIK-12 Fix Search Pill', 'search mik'), true)
  assert.equal(site.matchesQuery('MIK-12 Fix Search Pill', 'search board'), false)
  assert.equal(site.matchesQuery('新建任务 create issue', '新建'), true)
})
