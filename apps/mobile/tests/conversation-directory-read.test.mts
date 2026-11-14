import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, Fragment, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import type { ConversationDirectoryPage } from '../../../lib/conversation-directory-input'
import { mobileMessages } from '../lib/messages.ts'

type Item = ConversationDirectoryPage['items'][number]
const runId = '10000000-0000-4000-8000-000000000001'
const chatId = '20000000-0000-4000-8000-000000000002'
const items: Item[] = [{ id: runId, kind: 'run', title: 'Run conversation' }, { id: chatId, kind: 'chat', title: 'Independent chat' }]
  .map(row => ({ ...row, kind: row.kind as Item['kind'], pulls: [], identifier: null, issueId: null, taskTitle: null, pinned: false, state: 'idle', at: '2026-11-14T00:00:00Z', unread: false }))
const navigation: string[] = []
const requested: string[] = []
let view: string | undefined
const writes: unknown[] = []
const none = () => null
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('expo-router', { namedExports: { useRouter: () => ({ push: (path: string) => navigation.push(path) }), useLocalSearchParams: () => ({ view }) } })
mock.module('react-native', { namedExports: {
  StyleSheet: { create: (styles: unknown) => styles }, View: 'div', RefreshControl: none, Linking: { openURL: (url: string) => navigation.push(url) },
  FlatList: ({ data, renderItem, ListHeaderComponent }: { data: { key: string; conversation?: Item; pull?: { title: string } }[]; renderItem: (props: { item: unknown }) => ReactNode; ListHeaderComponent: ReactNode }) =>
    createElement(Fragment, null, ListHeaderComponent, ...data.map(item => createElement('section', { key: item.key, 'aria-label': item.conversation?.title ?? item.pull?.title }, renderItem({ item })))),
} })
stub('components/settings.tsx', { Row: ({ label, value, detail, onPress }: { label: string; value?: string; detail?: string; onPress?: () => void }) =>
  createElement('a', { onClick: onPress }, label, value, detail) })
stub('components/GlassButton.tsx', { GlassButton: ({ label, onPress }: { label: string; onPress: () => void }) => createElement('button', { onClick: onPress }, label) })
stub('components/NavBar.tsx', { NavBar: none, underBar: {} })
stub('components/ReadNotice.tsx', { ReadNotice: none })
stub('components/Segmented.tsx', { Segmented: none })
stub('components/Text.tsx', { Text: 'span' })
stub('lib/api.ts', { ApiError: Error, api: async (path: string, input: unknown) => { writes.push({ path, input }) } })
stub('lib/api-cache.ts', { apiCache: {} })
stub('lib/home.tsx', { useHome: () => ({ data: { workspace: { id: 'workspace' } } }) })
stub('lib/live.ts', { listRef: none })
stub('lib/theme.ts', { colors: {}, LIST_INSET: 0 })
stub('lib/useApi.ts', { useRefresh: () => ({}), useLiveApi: (path: string) => { requested.push(path); return { data: { items, workspaceId: 'workspace' }, reload: none } } })
stub('../../lib/hooks/use-task-continuation.ts', { useTaskContinuation: (items: Item[]) => ({ items, hasMore: false }) })
const { default: Conversations } = await import('../app/conversations.tsx')

test('the native directory marks each conversation kind and all rows using their own write receipts', async () => {
  const labels = mobileMessages.ConversationDirectory
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(Conversations)))
    for (const [selector, label, body] of [
      ['section[aria-label="Independent chat"] button', labels.markUnread, { action: 'unread', chatId }],
      ['section[aria-label="Run conversation"] button', labels.markUnread, { action: 'unread', runId }],
      ['button', labels.readAll, { action: 'readAll' }],
    ] as const) {
      const button = Array.from(host.querySelectorAll<HTMLButtonElement>(selector)).find(node => node.textContent === label)
      assert.ok(button, selector)
      await act(async () => button.click())
      assert.deepEqual(writes.pop(), { path: '/api/conversations/read-state', input: { method: 'POST', body } })
    }
    items[1]!.unread = true
    await act(async () => root.render(createElement(Conversations)))
    const chat = host.querySelector('section[aria-label="Independent chat"]')!
    assert.ok(chat.textContent?.includes(labels.unread))
    assert.equal(chat.querySelector('button'), null)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    await browser.happyDOM.close()
  }
})

test('native PR view loads archived and active rows and links one publication to both conversations and its task', async () => {
  const pull = { url: 'https://github.com/example/one/pull/2', title: 'A saved pull', state: 'merged' as const, additions: 8, deletions: 2 }
  const issueId = '30000000-0000-4000-8000-000000000003'
  items[0]!.pulls = [pull]
  items[0]!.issueId = issueId
  items[0]!.identifier = 'PROJ-4'
  items[1]!.pulls = [{ ...pull, url: pull.url.replace('example', 'EXAMPLE') }]
  view = 'pulls'
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(Conversations)))
    const params = new URL(requested.at(-1)!, 'http://localhost').searchParams
    assert.equal(params.get('archived'), 'any')
    assert.equal(params.get('pullState'), 'linked')
    assert.equal(host.querySelectorAll('section').length, 1)
    const links = [...host.querySelectorAll('section a')]
    assert.match(links[0]!.textContent ?? '', /\+8 −2/)
    for (const link of links) await act(async () => link.click())
    assert.deepEqual(navigation, [pull.url, '/thread/' + runId, '/groups/' + chatId, '/task/' + issueId])
  } finally {
    await act(async () => root.unmount())
    view = undefined
    items.forEach(item => { item.pulls = []; item.issueId = null; item.identifier = null })
    navigation.length = 0
    await browser.happyDOM.close()
  }
})
