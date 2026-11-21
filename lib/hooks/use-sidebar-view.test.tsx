import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { ViewStateProvider } from './view-state'
import { useSidebarView, type SidebarView, type SidebarViewControls } from './use-sidebar-view'

const browser = new Window({ url: 'https://mikka.example/en' })
let root: Root
let container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let view!: SidebarView & SidebarViewControls

before(async () => {
  for (const key of ['window', 'document', 'sessionStorage', 'HTMLElement'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => { browser.sessionStorage.clear(); container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

/** The frame's reader: whatever the section menus change, this is what the list is drawn from. */
function Reader() {
  view = useSidebarView()
  return <p>{`${view.density}/${view.sort}/${view.group}/${view.filters.join('+')}/${view.search}`}</p>
}
const render = (scope = 'person:workspace') => act(async () => root.render(<ViewStateProvider scope={scope}><Reader /></ViewStateProvider>))
/** What the cells saved for this window, so a fresh store can be checked for reading it back. */
const saved = (key: string) => browser.sessionStorage.getItem(`mikka:view:v1:person:workspace:${key}`)

test('the sidebar opens 详细 and 置顶优先, ungrouped and unfiltered', async () => {
  await render()
  assert.deepEqual([view.density, view.sort, view.group, view.filters, view.searchOpen], ['detailed', 'pinned', 'none', [], false])
})

test('密度 and 排序 are the same window-session cells the frame already used, and they persist', async () => {
  await render()
  await act(async () => { view.setDensity('compact'); view.setSort('name') })
  assert.deepEqual([view.density, view.sort], ['compact', 'name'])
  assert.equal(saved('sidebar-density'), '"compact"')
  assert.equal(saved('sidebar-sort'), '"name"')
  // A new window session's store reads the saved choice back, so 紧凑 survives a reload of the frame.
  await act(async () => root.unmount())
  root = createRoot(container)
  await render()
  assert.deepEqual([view.density, view.sort], ['compact', 'name'])
})

test('筛选 turns one dimension on and off again', async () => {
  await render()
  await act(async () => view.toggleFilter('unread'))
  assert.deepEqual(view.filters, ['unread'])
  await act(async () => view.toggleFilter('working'))
  assert.deepEqual(view.filters, ['unread', 'working'])
  await act(async () => view.toggleFilter('unread'))
  assert.deepEqual(view.filters, ['working'])
  await act(async () => view.clearFilters())
  assert.deepEqual(view.filters, [])
})

test('a closed 搜索线程 box drops its text, so no hidden query keeps rows out of the list', async () => {
  await render()
  await act(async () => { view.openSearch('bot'); view.setSearch('infisical') })
  assert.deepEqual([view.searchOpen, view.search, view.searchIn], [true, 'infisical', 'bot'])
  await act(async () => view.closeSearch())
  assert.deepEqual([view.searchOpen, view.search], [false, ''])
  // Saved too: reopening the section's menu returns the same view, not a query nobody can see.
  await act(async () => { view.openSearch('bot'); view.setSearch('infisical'); view.closeSearch() })
  assert.equal(saved('sidebar-search'), '""')
})

test('搜索线程 belongs to the section whose menu opened it, so the other section keeps its rows', async () => {
  await render()
  await act(async () => view.openSearch('group'))
  assert.deepEqual([view.searchOpen, view.searchIn], [true, 'group'])
  assert.equal(saved('sidebar-search-in'), '"group"')
})

test('分组 is a window-session choice like the rest', async () => {
  await render()
  await act(async () => view.setGroup('waiting'))
  assert.equal(view.group, 'waiting')
  assert.equal(saved('sidebar-group'), '"waiting"')
})
