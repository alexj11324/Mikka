import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, Fragment, type ReactNode } from 'react'
import { Window } from 'happy-dom'
import type { ConversationDirectoryPage } from '../../../lib/conversation-directory-input'
import { mobileMessages } from '../lib/messages.ts'

type Item = ConversationDirectoryPage['items'][number]
const runId = '10000000-0000-4000-8000-000000000001'
const chatId = '20000000-0000-4000-8000-000000000002'
const items = [{ id: runId, kind: 'run', title: 'Run conversation' }, { id: chatId, kind: 'chat', title: 'Independent chat' }]
  .map(row => ({ ...row, state: 'idle', at: '2026-11-14T00:00:00Z', unread: false }))
const writes: unknown[] = []
const none = () => null
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('expo-router', { namedExports: { useRouter: () => ({}), useLocalSearchParams: () => ({}) } })
mock.module('react-native', { namedExports: {
  StyleSheet: { create: (styles: unknown) => styles }, View: 'div', RefreshControl: none,
  FlatList: ({ data, renderItem, ListHeaderComponent }: { data: Item[]; renderItem: (props: { item: Item }) => ReactNode; ListHeaderComponent: ReactNode }) =>
    createElement(Fragment, null, ListHeaderComponent, ...data.map(item => createElement('section', { key: item.id, 'aria-label': item.title }, renderItem({ item })))),
} })
stub('components/settings.tsx', { Row: ({ label, value }: { label: string; value?: string }) => createElement('span', null, label, value) })
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
stub('lib/useApi.ts', { useRefresh: () => ({}), useLiveApi: () => ({ data: { items, workspaceId: 'workspace' }, reload: none }) })
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
