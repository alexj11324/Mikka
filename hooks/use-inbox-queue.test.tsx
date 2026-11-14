import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React, { act } from 'react'
import { Window } from 'happy-dom'
import type { InboxPage } from '../lib/inbox/contract'

const params = new URLSearchParams()
mock.module('next/navigation', { namedExports: { useSearchParams: () => params } })

test('returning from a detail revalidates the visible Inbox and retires unusable rows until Retry', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const { SWRConfig } = await import('swr')
  const { useInboxQueue } = await import('./use-inbox-queue')
  const root = createRoot(browser.document.createElement('div') as unknown as HTMLDivElement)
  const cache = new Map()
  const row = (id: string): InboxPage['items'][number] => ({
    id, type: 'task', title: id, source: 'task', issueId: id, ownerId: 'peer', pending: true, reason: 'review',
    occurredAt: '2026-11-14T00:00:00.000Z', snoozedUntil: null, rejectedAt: null, status: 'pending', actions: ['open', 'dismiss'],
  })
  const page = (ids: string[]) => Response.json({ historySince: '2026-11-14T00:00:00.000Z', items: ids.map(row), nextCursor: null })
  const originalFetch = globalThis.fetch
  let finish: (res: Response) => void = () => assert.fail('missing queue read')
  let reads = 0
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/api\/inbox\?workspaceId=workspace&tab=pending$/)
    assert.notEqual(options?.method, 'POST')
    if (++reads === 1) return page(['shared', 'mine'])
    return new Promise<Response>(resolve => { finish = resolve })
  }
  let queue!: ReturnType<typeof useInboxQueue>
  function List() {
    queue = useInboxQueue('reader', 'workspace', 'pending')
    return <output>{queue.items.map(item => item.id).join(',')}</output>
  }
  const render = (mounted = true) => act(async () => {
    root.render(<SWRConfig value={{ provider: () => cache }}>{mounted && <List />}</SWRConfig>)
  })
  try {
    await render()
    assert.deepEqual(queue.items.map(item => item.id), ['shared', 'mine'])
    params.set('thread', 'my-thread')
    await render()
    assert.equal(reads, 1, 'opening the adjacent panel leaves the list mounted')
    params.delete('thread')
    await render()
    assert.equal(reads, 2, 'returning starts a fresh read despite a warm cache')
    assert.equal(queue.items.length, 0, 'previous actions are unavailable while return is being checked')
    await act(async () => finish(Response.json({ error: 'actionFailed' }, { status: 500 })))
    assert.ok(queue.error)
    assert.equal(queue.items.length, 0)
    await assert.rejects(queue.command(row('shared'), 'dismiss'), /decisionUnavailable/)
    let retry: Promise<unknown> | undefined
    await act(async () => { retry = queue.reload() })
    await act(async () => { finish(page(['mine'])); await retry })
    assert.deepEqual(queue.items.map(item => item.id), ['mine'])
    assert.equal(reads, 3)
    await render(false)
    await render()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)) })
    assert.equal(reads, 4, 'a full-page Task return remounts and revalidates the list')
    await act(async () => finish(page([])))
    assert.equal(queue.items.length, 0)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await browser.happyDOM.close()
  }
})
