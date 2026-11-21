import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import { SWRConfig } from 'swr'
import type { Root } from 'react-dom/client'

type Page = { workspaceId: string; items: { id: string; updatedAt: string }[]; next: { id: string; updatedAt: string } | null; reset: boolean }
const calls: { view?: string; after: unknown }[] = []
let pages: Page[] = []
mock.module(new URL('../app/actions/issues.ts', import.meta.url).href, { namedExports: {
  listWorkspaceTaskPage: async (input: { view?: string; after: unknown }) => { calls.push({ view: input.view, after: input.after }); return pages.shift() },
} })
mock.module(new URL('./use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey() {}, useLiveKeys() {}, useLiveScope: () => null } })

const browser = new Window()
let createRoot: typeof import('react-dom/client')['createRoot']
let useTaskViewPage: typeof import('./use-task-view-page')['useTaskViewPage']
before(async () => {
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useTaskViewPage } = await import('./use-task-view-page'))
})
after(() => browser.happyDOM.close())

const rows = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ id: `task-${from + index}`, updatedAt: '2026-11-20T00:00:00.000Z' }))
const page = (items: Page['items'], next: Page['next'] = null, reset = false): Page => ({ workspaceId: 'ws', items, next, reset })
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })

async function mount(view: 'assigned' | 'all') {
  let state!: ReturnType<typeof useTaskViewPage>
  function Probe() { state = useTaskViewPage('me', 'ws', view); return null }
  const host = browser.document.createElement('div') as unknown as HTMLDivElement
  const root: Root = createRoot(host)
  await act(async () => { root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Probe /></SWRConfig>) })
  await settle()
  return { get: () => state, unmount: () => act(async () => root.unmount()) }
}

// S1-C review: a tab's board must hold every task its count names, not silently stop at the first page.
test('a task list tab pages past its first 100 tasks with the cursor the server returns', async () => {
  calls.length = 0
  const cursor = { id: 'task-99', updatedAt: '2026-11-20T00:00:00.000Z' }
  pages = [page(rows(0, 100), cursor), page(rows(100, 50))]
  const view = await mount('assigned')
  assert.equal(view.get().active, true)
  assert.equal(view.get().items.length, 100)
  assert.equal(view.get().hasMore, true)
  await act(async () => { await view.get().loadMore() })
  await settle()
  assert.equal(view.get().items.length, 150)
  assert.equal(view.get().hasMore, false)
  assert.deepEqual(calls, [{ view: 'assigned', after: null }, { view: 'assigned', after: cursor }])
  await view.unmount()
})

test('All reads nothing here; an anchor that left the view reads the first page again', async () => {
  calls.length = 0
  pages = []
  const all = await mount('all')
  assert.equal(all.get().active, false)
  assert.equal(calls.length, 0)
  await all.unmount()

  const cursor = { id: 'task-99', updatedAt: '2026-11-20T00:00:00.000Z' }
  pages = [page(rows(0, 100), cursor), page([], null, true), page(rows(0, 100), cursor)]
  const view = await mount('assigned')
  await act(async () => { await view.get().loadMore() })
  await settle()
  assert.equal(view.get().failed, true, 'the stale continuation is reported, not merged')
  assert.equal(view.get().items.length, 100)
  assert.deepEqual(calls.map(call => call.after), [null, cursor, null])
  await view.unmount()
})
