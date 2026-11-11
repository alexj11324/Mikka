import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import type { Root } from 'react-dom/client'

const calls: string[][] = []
mock.module(new URL('../app/actions/task-domain.ts', import.meta.url).href, { namedExports: {
  getTaskPresentations: async ({ workspaceId, issueIds, includeReview }: { workspaceId: string; issueIds: string[]; includeReview?: true }) => {
    assert.equal(includeReview, true)
    calls.push(issueIds)
    return { version: 1, workspaceId, items: Object.fromEntries(issueIds.map(id => [id, { state: 'waiting' }])) }
  },
} })
mock.module(new URL('./use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKeys() {} } })
const browser = new Window()
let createRoot: typeof import('react-dom/client')['createRoot']
let TaskCardDataProvider: typeof import('./use-task-cards')['TaskCardDataProvider'], useTaskCards: typeof import('./use-task-cards')['useTaskCards']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TaskCardDataProvider, useTaskCards } = await import('./use-task-cards'))
})
after(() => browser.happyDOM.close())

function Row({ id }: { id: string }) {
  const cards = useTaskCards([id])
  return <span>{cards[id]?.state}</span>
}
test('mounted review/citation cards batch and deduplicate IDs including a task outside the first list page', async () => {
  for (const count of [1, 16, 201]) {
    const host = browser.document.createElement('div') as unknown as HTMLDivElement
    const root: Root = createRoot(host)
    calls.length = 0
    const ids = Array.from({ length: count }, (_, index) => `historical-${index}`)
    try {
      await act(async () => {
        root.render(<TaskCardDataProvider ownerId="viewer" workspaceId={`ws-${count}`}>
          {ids.map(id => <Row key={id} id={id} />)}<Row id={ids[0]} />
        </TaskCardDataProvider>)
      })
      assert.deepEqual(calls.map(batch => batch.length), count > 200 ? [200, 1] : [count])
      assert.deepEqual(new Set(calls.flat()), new Set(ids))
      assert.equal(host.textContent, 'waiting'.repeat(count + 1))
    } finally { await act(async () => root.unmount()) }
  }
})

test('continuations are user-driven, deduplicate overlaps and cannot restore another workspace page', async () => {
  const { useTaskContinuation } = await import('../lib/hooks/use-task-continuation')
  const host = browser.document.createElement('div') as unknown as HTMLDivElement, root = createRoot(host)
  const cursor = { id: 'legacy-anchor', updatedAt: '2026-11-11T00:00:00.000Z' }
  let release!: () => void, reads = 0, load!: () => Promise<void>
  const read = async () => {
    reads++
    await new Promise<void>(resolve => { release = resolve })
    return { items: [{ id: 'a-first' }, {id: 'a-second'}], next: null }
  }
  function Probe({ owner }: { owner: string }) {
    const paging = useTaskContinuation([{ id: owner+'-first' }], owner, cursor, read)
    load = paging.loadMore
    return <span>{paging.items.map(row => row.id).join(',')}</span>
  }
  try {
    await act(async () => { root.render(<Probe owner="a" />) })
    assert.equal(reads, 0)
    let first!: Promise<void>
    await act(async () => { first = load(); void load() })
    assert.equal(reads, 1)
    await act(async () => { release(); await first })
    assert.equal(host.textContent, 'a-first,a-second')
    await act(async () => { root.render(<Probe owner="b" />) })
    assert.equal(host.textContent, 'b-first')
    await act(async () => { first = load() })
    await act(async () => { root.render(<Probe owner="c" />) })
    await act(async () => { release(); await first })
    assert.equal(host.textContent, 'c-first')
  } finally { await act(async () => root.unmount()) }
})
