import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import React, { act } from 'react'
import { Window } from 'happy-dom'
import { useSiteSearch } from './use-site-search'

const browser = new Window({ url: 'https://fixture.example' })
Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
after(() => browser.happyDOM.close())

test('search continuations serialize by source, deduplicate UUIDs and discard results when the session ends', async t => {
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.body)
  const responses = new Map<string, Array<(response: Response) => void>>()
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const params = new URL(url, 'https://fixture.example').searchParams
    const key = [params.get('q'), params.get('source'), params.get('cursor') ?? 'first'].join('/')
    calls.push(key)
    return new Promise<Response>(resolve => {
      responses.set(key, [...(responses.get(key) ?? []), resolve])
    })
  })
  function reply(key: string, status: number, body: object) {
    const resolve = responses.get(key)?.shift()
    assert.ok(resolve, 'expected pending request ' + key)
    resolve(Response.json(body, { status }))
  }
  function groupPage(ids: string[], nextCursor: string | null) {
    return { source: 'groups', nextCursor, items: ids.map(id => ({ type: 'group', id, title: id, workspaceId: 'space' })) }
  }
  let search!: ReturnType<typeof useSiteSearch>
  function Screen({ query }: { query: string }) {
    search = useSiteSearch(query, 'space')
    return null
  }
  const ids = () => search.state.groups.items.map(item => item.id)
  const more = () => act(async () => { search.more('groups'); search.more('groups') })
  try {
    await act(async () => root.render(<Screen query="shared" />))
    await act(async () => { await delay(230) })
    await act(async () => {
      reply('shared/groups/first', 200, groupPage(['alpha'], 'next'))
      reply('shared/history/first', 200, { source: 'history', items: [{ type: 'history', id: 'session', title: 'old' }], nextCursor: null })
    })
    await more()
    assert.equal(calls.filter(key => key === 'shared/groups/next').length, 1)
    await act(async () => reply('shared/groups/next', 503, { error: 'searchFailed' }))
    assert.deepEqual(ids(), ['alpha'])
    assert.equal(search.state.groups.nextCursor, 'next')
    await act(async () => { search.retry('groups'); search.retry('groups') })
    assert.equal(calls.filter(key => key === 'shared/groups/next').length, 2)
    await act(async () => reply('shared/groups/next', 200, groupPage(['alpha', 'beta'], 'last')))
    assert.deepEqual(ids(), ['alpha', 'beta'])
    await more()
    await act(async () => reply('shared/groups/last', 401, { error: 'authRequired' }))
    assert.equal(search.state.groups.error, 'authRequired')
    assert.equal(search.state.groups.nextCursor, null)
    assert.deepEqual(ids(), [])
    assert.deepEqual(search.state.history.items, [])
    await act(async () => reply('shared/tasks/first', 200, { source: 'tasks', items: [{ type: 'task', id: 'late' }], nextCursor: 'after' }))
    assert.deepEqual(search.state.tasks.items, [])
    await act(async () => root.render(<Screen query="another" />))
    await act(async () => { await delay(230) })
    await act(async () => reply('another/groups/first', 403, { error: 'searchAccessDenied' }))
    await act(async () => reply('another/groups/first', 403, { error: 'searchAccessDenied' }))
    assert.equal(search.state.groups.error, 'searchAccessDenied')
    assert.deepEqual(search.state.groups.items, [])
  } finally { await act(async () => root.unmount()) }
})
