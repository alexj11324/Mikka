import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { createRequire } from 'node:module'
import * as nativeReact from 'react'
import { act, createElement, Fragment, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import type { ConversationDirectoryPage } from '../../../lib/conversation-directory-input'
import { mobileMessages } from '../lib/messages.ts'

type Item = ConversationDirectoryPage['items'][number]
const runId = '10000000-0000-4000-8000-000000000001'
const chatId = runId
const items = ([{ id: runId, kind: 'run', title: 'Run conversation' }, { id: chatId, kind: 'chat', title: 'Independent chat' }] as const)
  .map((row): Item => ({ ...row, identifier: null, issueId: null, pinned: false, state: 'idle', at: '2026-11-14T00:00:00Z', unread: false }))
type TestPage = ConversationDirectoryPage & { workspaceId: string }
let firstPage: TestPage | undefined
let nextPage: TestPage | undefined
const requested: string[] = []
const writes: unknown[] = []
const none = () => null
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('expo-router', { namedExports: { useRouter: () => ({}), useLocalSearchParams: () => ({}) } })
mock.module('react-native', { namedExports: {
  StyleSheet: { create: (styles: unknown) => styles }, View: 'div', RefreshControl: none,
  FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent }: { data: Item[]; keyExtractor: (item: Item) => string; ListFooterComponent?: ReactNode; renderItem: (props: { item: Item }) => ReactNode; ListHeaderComponent: ReactNode }) =>
    createElement(Fragment, null, ListHeaderComponent, ...data.map(item => createElement('section', { key: keyExtractor(item), 'aria-label': item.title }, renderItem({ item }))), ListFooterComponent),
} })
stub('components/settings.tsx', { Row: ({ label, value }: { label: string; value?: string }) => createElement('span', null, label, value) })
stub('components/GlassButton.tsx', { GlassButton: ({ label, onPress }: { label: string; onPress: () => void }) => createElement('button', { onClick: onPress }, label) })
stub('components/NavBar.tsx', { NavBar: none, underBar: {} })
stub('components/ReadNotice.tsx', { ReadNotice: none })
stub('components/Segmented.tsx', { Segmented: none })
stub('components/Text.tsx', { Text: 'span' })
stub('lib/api.ts', { ApiError: Error, api: async (path: string, input: unknown) => { if (nextPage && path.startsWith('/api/mobile/conversations?')) { requested.push(path); return nextPage }
  writes.push({ path, input }) } })
stub('lib/api-cache.ts', { apiCache: { context: () => ({}), revision: () => 0 } })
stub('lib/home.tsx', { useHome: () => ({ data: { workspace: { id: 'workspace' } } }) })
stub('lib/live.ts', { listRef: none })
stub('lib/theme.ts', { colors: {}, LIST_INSET: 0 })
stub('lib/useApi.ts', { useRefresh: () => ({}), useLiveApi: () => ({ data: firstPage ?? { items, workspaceId: 'workspace' }, reload: none }) })
// Node resolves a shared hook relative to lib/. Match Metro's native React resolution.
const sharedRequire = createRequire(new URL('../../../lib/hooks/use-task-continuation.ts', import.meta.url))
if (sharedRequire.resolve('react') !== createRequire(import.meta.url).resolve('react')) {
  mock.module(sharedRequire.resolve('react'), { namedExports: { useRef: nativeReact.useRef, useState: nativeReact.useState }, defaultExport: nativeReact.default })
}
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

test('a native continuation keeps run and chat with the same UUID and sends the typed cursor', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.body)
  firstPage = { workspaceId: 'workspace', items: [items[0]!], cursor: { id: runId, at: '2026-11-14T00:00:00.000000Z', pinned: false, kind: 'run' } }
  nextPage = { workspaceId: 'workspace', items: [items[1]!], cursor: null }
  try {
    await act(async () => root.render(createElement(Conversations)))
    const more = [...document.querySelectorAll('button')].find(button => button.textContent === mobileMessages.ConversationDirectory.more)
    assert.ok(more)
    await act(async () => more.click())
    const continuation = requested.find(path => new URL(path, 'http://localhost').searchParams.has('after'))
    assert.ok(continuation)
    assert.equal(new URL(continuation, 'http://localhost').searchParams.get('afterKind'), 'run')
    assert.deepEqual([...document.querySelectorAll('section')].map(row => row.getAttribute('aria-label')), ['Run conversation', 'Independent chat'])
  } finally {
    await act(async () => root.unmount())
    firstPage = undefined
    nextPage = undefined
    requested.length = 0
    await browser.happyDOM.abort()
  }
})
