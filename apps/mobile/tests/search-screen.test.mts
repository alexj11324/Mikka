import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { act, createElement as h, Fragment, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import { mobileMessages } from '../lib/messages.ts'

const browser = new Window({ url: 'https://fixture.example' })
Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
after(() => browser.happyDOM.close())

const none = () => null
const stub = (path: string, namedExports: Record<string, unknown>) =>
  mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
const paths: string[] = []
const pageReads: string[] = []
const chats = { rows: [], loading: false, error: null as Error | null, reload: mock.fn() }
const first = { workspaceId: 'workspace', tasks: [], next: { id: 'cursor', updatedAt: '2026-01-01T00:00:00Z' } }
const taskRead = { loading: false, data: first, error: null as Error | null, reload: mock.fn() }
let typeQuery: (query: string) => void
let rejectNextPage = true
type NativeList = {
  sections: { data: unknown[] }[]
  renderItem: (row: { item: unknown }) => ReactNode
  ListHeaderComponent?: ReactNode
  ListEmptyComponent?: ReactNode
  ListFooterComponent?: ReactNode
}
mock.module('expo-router', { namedExports: { useRouter: () => ({ push: (path: string) => paths.push(path) }) } })
mock.module('react-native', { namedExports: {
  StyleSheet: { create: (styles: unknown) => styles }, View: 'div', FlatList: none, RefreshControl: none,
  Pressable: ({ children, onPress, disabled }: { children: ReactNode; onPress: () => void; disabled?: boolean }) =>
    h('button', { onClick: onPress, disabled }, children),
  SectionList: (list: NativeList) => h(Fragment, null, list.ListHeaderComponent,
    list.sections.length ? list.sections.flatMap(section => section.data.map((item, i) =>
      h(Fragment, { key: i }, list.renderItem({ item })))) : list.ListEmptyComponent, list.ListFooterComponent),
} })
mock.module('react-native-safe-area-context', { namedExports: { useSafeAreaInsets: () => ({ bottom: 0 }) } })
mock.module('lucide-react-native', { namedExports: { ChevronDown: none, ChevronRight: none } })
stub('components/NavBar.tsx', { underBar: {}, NavBar: ({ search }: { search: { onChange: typeof typeQuery } }) => { typeQuery = search.onChange; return null } })
stub('components/ChatList.tsx', { useChatRows: () => chats, ChatRowView: none, rowKey: none })
stub('components/Text.tsx', { Text: ({ children }: { children: ReactNode }) => h('span', null, children) })
stub('components/icons.tsx', { Spinner: () => h('span', { role: 'status' }, 'loading') })
stub('components/ReadNotice.tsx', { ReadNotice: ({ error, label, onRetry }: { error: unknown; label: string; onRetry: () => void }) =>
  error ? h('button', { onClick: onRetry }, label) : null })
stub('shared/components/list-section.tsx', { ListSectionHeader: none })
stub('features/tasks/components/task-icons.tsx', { BOARD_LABEL: {}, GROUP_LABEL: {}, STATE_LABEL: {}, TaskGroupIcon: none, TaskStateIcon: none })
stub('lib/api.ts', { ApiError: Error })
stub('lib/haptics.ts', { tap: none })
stub('lib/theme.ts', { colors: {}, LIST_INSET: 0, ROW_SURFACE_INSET: 0, SPACE: {} })
stub('lib/home.tsx', { useHome: () => ({ data: { workspace: { id: 'workspace' } } }) })
stub('lib/useApi.ts', { useRefresh: none, useLiveApi: () => taskRead })
stub('features/tasks/model/task-presentation-read.ts', { readPresentedTasks: async (path: string) => {
  pageReads.push(path)
  if (rejectNextPage) throw new Error('offline')
  return { workspaceId: 'workspace', tasks: [{ id: 'task-two', title: 'Second page', group: 'todo', state: 'todo', status: 'todo' }], next: null }
} })

const { createRoot } = await import('react-dom/client')
const { SearchScreen } = await import('../features/search/screens/search-screen.tsx')

test('Search distinguishes incomplete and failed reads, retries the same cursor and opens the matched Task by ID', async () => {
  const root = createRoot(document.body)
  const render = () => act(async () => root.render(h(SearchScreen)))
  const contains = (value: string) => document.body.textContent!.includes(value)
  function button(label: string) {
    const item = Array.from(document.querySelectorAll('button')).find(node => node.textContent === label)
    assert.ok(item, label)
    return item
  }
  try {
    await render()
    chats.loading = true
    await act(async () => typeQuery('second'))
    assert.ok(contains('loading'))
    assert.ok(!contains(mobileMessages.Shell.searchEmpty))
    chats.loading = false
    chats.error = new Error('offline')
    taskRead.error = new Error('unavailable')
    await render()
    await act(async () => {
      button(mobileMessages.MobileCore.chatList).click()
      button(mobileMessages.Nav.tasks).click()
    })
    assert.equal(chats.reload.mock.callCount(), 1)
    assert.equal(taskRead.reload.mock.callCount(), 1)
    assert.ok(!contains(mobileMessages.Shell.searchEmpty))
    taskRead.error = null
    await render()
    await act(async () => button(mobileMessages.HostedTasks.loadMore).click())
    assert.ok(!contains(mobileMessages.Shell.searchEmpty))
    rejectNextPage = false
    await act(async () => button(mobileMessages.Common.retry).click())
    assert.equal(pageReads.length, 2)
    assert.equal(pageReads[0], pageReads[1])
    assert.equal(new URL(pageReads[0], 'https://fixture.example').searchParams.get('after'), 'cursor')
    assert.ok(contains(mobileMessages.MobileCore.chatList), 'a failed chat source remains visible alongside successful task hits')
    await act(async () => button('Second page').click())
    assert.deepEqual(paths, ['/task/task-two'])
    chats.error = null
    await act(async () => typeQuery('absent'))
    assert.ok(contains(mobileMessages.Shell.searchEmpty))
    await act(async () => typeQuery(''))
    assert.ok(!contains(mobileMessages.Shell.searchEmpty))
  } finally { await act(async () => root.unmount()) }
})
