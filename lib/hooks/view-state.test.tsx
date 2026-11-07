import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { act, StrictMode, useCallback, type Dispatch, type SetStateAction } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { ViewStateProvider, useViewScroll, useViewState } from './view-state'

const browser = new Window({ url: 'https://mikka.example/en' })
let root: Root
let container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let update: Dispatch<SetStateAction<string>>

before(async () => {
  for (const key of ['window', 'document', 'HTMLElement', 'MutationObserver', 'ResizeObserver'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => { browser.sessionStorage.clear(); container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

function Reader({ id, initial = '' }: { id: string; initial?: string }) {
  const [value, setValue] = useViewState(`draft:${id}`, initial)
  update = setValue
  return <p>{value}</p>
}
const renderReader = (scope = 'person:workspace', id = 'thread-a') => act(async () => root.render(<ViewStateProvider scope={scope}><Reader id={id} /></ViewStateProvider>))

test('switching threads reads each draft immediately and an old callback only updates its own thread', async () => {
  await renderReader()
  await act(async () => update('draft A'))
  const finishA = update
  await renderReader('person:workspace', 'thread-b')
  assert.equal(container.textContent, '')
  await act(async () => update('draft B'))
  await act(async () => finishA(current => current === 'draft A' ? '' : current))
  assert.equal(container.textContent, 'draft B')
  await renderReader()
  assert.equal(container.textContent, '')
  await renderReader('person:workspace', 'thread-b')
  assert.equal(container.textContent, 'draft B')
})

test('account and workspace scopes keep their state separate', async () => {
  await renderReader()
  await act(async () => update('private draft'))
  await renderReader('person:other-workspace')
  assert.equal(container.textContent, '')
  await renderReader('other-person:workspace')
  assert.equal(container.textContent, '')
  await renderReader()
  assert.equal(container.textContent, 'private draft')
})

test('a retired account or workspace cannot write late results back into window storage', async () => {
  await renderReader()
  await act(async () => update('private draft'))
  const finishPreviousScope = update
  await renderReader('other-person:other-workspace')
  browser.sessionStorage.removeItem('mikka:view:v1:person:workspace:draft:thread-a')
  await act(async () => finishPreviousScope('late response from the previous scope'))
  assert.equal(container.textContent, '')
  assert.equal(browser.sessionStorage.getItem('mikka:view:v1:person:workspace:draft:thread-a'), null)
  await renderReader()
  assert.equal(container.textContent, '')
})

test('a result arriving after sign-out cannot restore erased drafts', async () => {
  await renderReader()
  await act(async () => update('private draft'))
  const finishAfterSignOut = update
  await act(async () => root.render(null))
  browser.sessionStorage.clear()
  await act(async () => finishAfterSignOut('late failed submission'))
  assert.equal(browser.sessionStorage.length, 0)
  await renderReader()
  assert.equal(container.textContent, '')
})

test('StrictMode effect replay leaves the current scope writable and preserves offscreen completions', async () => {
  const render = (shown: boolean) => act(async () => root.render(<StrictMode><ViewStateProvider scope="person:workspace">{shown ? <Reader id="thread-a" /> : <span />}</ViewStateProvider></StrictMode>))
  await render(true)
  await act(async () => update('unsent'))
  const finishWhileAway = update
  await render(false)
  await act(async () => finishWhileAway('failed while another page was open'))
  await render(true)
  assert.equal(container.textContent, 'failed while another page was open')
  await act(async () => update('edited after returning'))
  assert.equal(container.textContent, 'edited after returning')
})

test('a new object uses its own initial choice rather than the previous object default', async () => {
  await act(async () => root.render(<ViewStateProvider scope="person:workspace"><Reader id="all-tasks" initial="all" /></ViewStateProvider>))
  assert.equal(container.textContent, 'all')
  await act(async () => root.render(<ViewStateProvider scope="person:workspace"><Reader id="my-tasks" initial="mine" /></ViewStateProvider>))
  assert.equal(container.textContent, 'mine')
  await act(async () => update('favorites'))
  await act(async () => root.render(<ViewStateProvider scope="person:workspace"><Reader id="my-tasks" initial="mine" /></ViewStateProvider>))
  assert.equal(container.textContent, 'favorites')
})

test('a fresh provider restores the window session and an empty draft stays cleared', async () => {
  await renderReader()
  await act(async () => update('unsent'))
  await act(async () => root.render(null))
  await renderReader()
  assert.equal(container.textContent, 'unsent')
  await act(async () => update(''))
  await act(async () => root.render(null))
  await renderReader()
  assert.equal(container.textContent, '')
})

test('blocked storage still preserves state through component unmounts', async () => {
  const storage = Object.getOwnPropertyDescriptor(browser, 'sessionStorage')
  Object.defineProperty(browser, 'sessionStorage', { configurable: true, get() { throw new Error('blocked') } })
  try {
    await renderReader()
    await act(async () => update('in memory'))
    await act(async () => root.render(<ViewStateProvider scope="person:workspace"><span /></ViewStateProvider>))
    await renderReader()
    assert.equal(container.textContent, 'in memory')
  } finally {
    if (storage) Object.defineProperty(browser, 'sessionStorage', storage)
    else delete (browser as unknown as { sessionStorage?: unknown }).sessionStorage
  }
})

test('malformed saved JSON falls back without breaking the screen', async () => {
  browser.sessionStorage.setItem('mikka:view:v1:person:workspace:draft:thread-a', '{bad')
  await renderReader()
  assert.equal(container.textContent, '')
  await act(async () => update('recovered'))
  assert.equal(container.textContent, 'recovered')
})

function ScrollReader({ id = 'list', rows = 15, ready = true }: { id?: string; rows?: number; ready?: boolean }) {
  const scroll = useViewScroll<HTMLDivElement>(id, ready)
  const attach = useCallback((node: HTMLDivElement | null) => {
    scroll.current = node
    if (!node) return
    let top = 0
    Object.defineProperties(node, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => node.childElementCount * 100 },
      scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, node.scrollHeight - node.clientHeight)) } },
    })
  }, [scroll])
  return <div ref={attach}>{Array.from({ length: rows }, (_, i) => <p key={i}>row {i}</p>)}</div>
}
const renderScroll = (props: Parameters<typeof ScrollReader>[0] = {}) => act(async () => root.render(<StrictMode><ViewStateProvider scope="person:workspace"><ScrollReader {...props} /></ViewStateProvider></StrictMode>))
const scrollNode = () => container.firstElementChild as HTMLElement
async function move(top: number) {
  scrollNode().scrollTop = top
  await act(async () => scrollNode().dispatchEvent(new browser.Event('scroll') as unknown as Event))
}
const savedScroll = (top: number) => browser.sessionStorage.setItem('mikka:view:v1:person:workspace:scroll:list', JSON.stringify({ top, left: 0 }))

test('scroll survives remounts and a different list starts at its own position', async () => {
  await renderScroll()
  await move(840)
  await act(async () => root.render(null))
  await renderScroll()
  assert.equal(scrollNode().scrollTop, 840)
  await renderScroll({ id: 'other-list' })
  assert.equal(scrollNode().scrollTop, 0)
  await move(150)
  await renderScroll()
  assert.equal(scrollNode().scrollTop, 840)
})

test('loading placeholders do not overwrite a saved scroll position', async () => {
  savedScroll(840)
  await renderScroll({ rows: 1, ready: false })
  await renderScroll()
  assert.equal(scrollNode().scrollTop, 840)
})

test('scroll waits for asynchronous rows, including a resolved group opening after mount', async () => {
  savedScroll(840)
  await renderScroll({ rows: 2 })
  assert.equal(scrollNode().scrollTop, 0)
  await renderScroll()
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  assert.equal(scrollNode().scrollTop, 840)
})

test('user scrolling cancels a pending restore instead of pulling the list back later', async () => {
  savedScroll(840)
  await renderScroll({ rows: 4 })
  scrollNode().dispatchEvent(new browser.Event('wheel') as unknown as Event)
  await move(100)
  await renderScroll()
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  assert.equal(scrollNode().scrollTop, 100)
})
