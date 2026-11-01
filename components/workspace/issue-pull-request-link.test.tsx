import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

const url = 'https://github.com/private/repo/pull/81'
let userId: string | null = 'viewer'
let pending = false
let data: { state: string; checkedAt: number } | { error: string } | undefined
let validating = false
let swrKey: unknown
let swrOptions: { refreshInterval: number; revalidateOnFocus?: boolean; revalidateOnMount: boolean; dedupingInterval: number }
let fetchStatus: (key: readonly string[]) => Promise<unknown>
mock.module(new URL('../../lib/auth-client.ts', import.meta.url).href, { namedExports: { authClient: { useSession: () => ({ data: userId ? { user: { id: userId } } : null, isPending: pending }) } } })
mock.module('swr', { defaultExport: (key: unknown, fetcher: typeof fetchStatus, options: typeof swrOptions) => {
  swrKey = key; fetchStatus = fetcher; swrOptions = options
  return { data, isValidating: validating }
} })
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string, args?: { state?: string }) => {
  if (namespace === 'Metadata.prState') return key
  if (key === 'manual') return `Manual: ${args?.state}`
  if (key === 'synced') return `GitHub: ${args?.state}`
  return key
} } })
let IssuePullRequestLink: typeof import('./issue-pull-request-link')['IssuePullRequestLink']
before(async () => { ({ IssuePullRequestLink } = await import('./issue-pull-request-link')) })
beforeEach(() => { userId = 'viewer'; pending = false; data = undefined; validating = false })
const render = (compact = false) => renderToStaticMarkup(<IssuePullRequestLink issueId="issue-1" pr={{ url, state: 'open' }} compact={compact} />)

test('requests are viewer scoped and refresh on mount and every minute, never on focus', () => {
  render()
  assert.deepEqual(swrKey, ['github-pr-status', 'viewer', 'issue-1', url])
  assert.equal(swrOptions.refreshInterval, 60_000)
  assert.notEqual(swrOptions.revalidateOnFocus, true)
  assert.equal(swrOptions.revalidateOnMount, true)
  assert.equal(swrOptions.dedupingInterval, 0)
  render(true)
  assert.equal(swrOptions.refreshInterval, 0)
  assert.notEqual(swrOptions.revalidateOnFocus, true)
})

test('detail and board show GitHub state separately from the shared manual value', () => {
  data = { state: 'merged', checkedAt: Number.POSITIVE_INFINITY }
  for (const compact of [false, true]) {
    const markup = render(compact)
    assert.ok(markup.includes('GitHub: merged'))
    assert.ok(markup.includes('Manual: open'))
    assert.ok(markup.includes('text-info-foreground'))
    assert.ok(markup.includes('target="_blank"'))
    if (!compact) assert.ok(markup.includes('>merged</span>'))
  }
})

test('refresh and lost authorization immediately suppress previously fetched GitHub state', () => {
  data = { state: 'merged', checkedAt: Number.POSITIVE_INFINITY }; validating = true
  let markup = render()
  assert.ok(markup.includes('loading'))
  assert.ok(!markup.includes('GitHub: merged'))
  assert.ok(!markup.includes('text-info-foreground'))
  validating = false; data = { error: 'githubRepositoryForbidden' }
  markup = render()
  assert.ok(markup.includes('unavailable'))
  assert.ok(markup.includes('Manual: open'))
  assert.ok(!markup.includes('text-success-foreground'))
})

test('signed out or changing sessions cannot display cached private state', () => {
  data = { state: 'merged', checkedAt: Number.POSITIVE_INFINITY }
  for (const loading of [false, true]) {
    userId = null; pending = loading
    const markup = render()
    assert.equal(swrKey, null)
    assert.ok(!markup.includes('GitHub: merged'))
    assert.ok(markup.includes(loading ? 'loading' : 'disconnected'))
  }
})

test('remount ignores prior successful cache even before SWR starts revalidation', () => {
  data = { state: 'merged', checkedAt: 0 }; validating = false
  const markup = render()
  assert.ok(markup.includes('loading'))
  assert.ok(!markup.includes('GitHub: merged'))
  assert.ok(!markup.includes('text-info-foreground'))
})

test('compact cards keep unavailable status accessible without adding long chip text', () => {
  data = { error: 'githubRepositoryForbidden' }
  const markup = render(true)
  assert.ok(markup.includes('aria-label="unavailable'))
  assert.ok(!markup.includes('>unavailable<'))
  assert.ok(!markup.includes('text-success-foreground'))
})

test('provider errors and network failures replace the successful response with unavailable state', async () => {
  render()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ error: 'githubRepositoryForbidden' }, { status: 403 })
    assert.deepEqual(await fetchStatus(['github-pr-status', 'viewer', 'issue-1', url]), { error: 'githubRepositoryForbidden' })
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.deepEqual(await fetchStatus(['github-pr-status', 'viewer', 'issue-1', url]), { error: 'githubUnavailable' })
  } finally { globalThis.fetch = originalFetch }
})

test('a cookie switch from A to B cannot write B state into the still-visible A cache key', async () => {
  userId = 'viewer-a'
  render()
  const key = swrKey as readonly string[]
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({ viewerId: 'viewer-a', state: 'open' })
    const initial = await fetchStatus(key) as { state: string; checkedAt: number }
    assert.equal(initial.state, 'open')
    data = { ...initial, checkedAt: Number.POSITIVE_INFINITY }
    assert.ok(render().includes('GitHub: open'))

    let respond!: (response: Response) => void
    globalThis.fetch = () => new Promise<Response>(resolve => { respond = resolve })
    const pendingRequest = fetchStatus(key)
    // Better Auth still exposes A while the server receives B's switched cookie.
    respond(Response.json({ viewerId: 'viewer-b', state: 'merged' }))
    const result = await pendingRequest
    assert.deepEqual(result, { error: 'authRequired' })
    data = result as { error: string }
    const markup = render()
    assert.ok(markup.includes('unavailable'))
    assert.ok(!markup.includes('GitHub: open'))
    assert.ok(!markup.includes('GitHub: merged'))
    assert.ok(!markup.includes('text-info-foreground'))
  } finally { globalThis.fetch = originalFetch }
})
