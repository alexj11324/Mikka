import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, createElement, Fragment, useEffect, type ReactNode } from 'react'
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
let linked: { workspaceId?: string; botId?: string } = {}
let botChildren: { botId: string; workspaceId: string; items: Item[]; more: boolean } | null = null
const writes: unknown[] = []
let archiveDays: number | undefined = 30
let archivePending = false
let settingReads = 0
const reloadSettings = () => { settingReads++ }
const none = () => null
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL('../' + path, import.meta.url).href, { namedExports })
mock.module('expo-router', { namedExports: { useRouter: () => ({ push: (path: string) => navigation.push(path) }), useLocalSearchParams: () => ({ view, ...linked }), useFocusEffect: (read: () => void) => useEffect(read, [read]) } })
mock.module('react-native', { namedExports: {
  StyleSheet: { create: (styles: unknown) => styles }, View: 'div', RefreshControl: none, Linking: { openURL: (url: string) => navigation.push(url) },
  FlatList: ({ data, renderItem, ListHeaderComponent }: { data: { key: string; conversation?: Item; pull?: { title: string } }[]; renderItem: (props: { item: unknown }) => ReactNode; ListHeaderComponent: ReactNode }) =>
    createElement(Fragment, null, ListHeaderComponent, ...data.map(item => createElement('section', { key: item.key, 'aria-label': item.conversation?.title ?? item.pull?.title }, renderItem({ item })))),
} })
stub('components/settings.tsx', {
  SettingsPage: ({ children }: { children: ReactNode }) => children,
  ChoiceRow: ({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) =>
    createElement('button', { 'aria-pressed': selected, disabled, onClick: onPress }, label),
  Row: ({ label, value, detail, onPress }: { label: string; value?: string; detail?: string; onPress?: () => void }) =>
  createElement('a', { onClick: onPress }, label, value, detail) })
stub('components/ui.tsx', { Group: ({ children }: { children: ReactNode }) => children })
stub('components/PreferenceSaveNotice.tsx', { PreferenceSaveNotice: none })
stub('lib/settings.tsx', { useSettings: () => ({
  data: { preferences: { archiveIdleAfterDays: archiveDays } }, reload: reloadSettings,
  preferenceSave: { status: archivePending ? 'saving' : 'idle', intent: archivePending ? { archiveIdleAfterDays: 0 } : {} },
  savePreferences: (patch: unknown) => writes.push(patch),
}) })
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
stub('lib/useApi.ts', { useRefresh: () => ({}), useLiveApi: (path: string) => { requested.push(path); return { data: path?.includes('view=botChildren') ? botChildren : { items, workspaceId: 'workspace' }, reload: none } } })
stub('../../lib/hooks/use-task-continuation.ts', { useTaskContinuation: (items: Item[]) => ({ items, hasMore: false }) })
const { default: ArchivePreferences } = await import('../app/(tabs)/settings/conversations.tsx')
const { default: Conversations } = await import('../app/conversations.tsx')

test('the mounted Bot detail opens its ranked eight conversations and carries the Bot and workspace into View all', async () => {
  const { BotConversations } = await import('../features/chat/components/bot-conversations.tsx')
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  const root = createRoot(host)
  const props = { botId: '30000000-0000-4000-8000-000000000003', workspaceId: 'workspace' }
  const ranked = Array.from({ length: 8 }, (_, i) => ({ ...items[i % 2]!, id: `${i}`, title: `Rank ${i + 1}`, unread: i === 0 }))
  const links = () => [...host.querySelectorAll('a')]
  try {
    botChildren = { ...props, items: ranked, more: true }
    await act(async () => root.render(createElement(BotConversations, props)))
    assert.equal(new URL(requested.at(-1)!, 'http://localhost').searchParams.get('view'), 'botChildren')
    assert.equal(links().length, 9)
    for (const [i, item] of ranked.entries()) assert.ok(links()[i]!.textContent?.includes(item.title))
    assert.ok(links()[0]!.textContent?.includes(mobileMessages.ConversationDirectory.unread))
    for (const index of [0, 1, 8]) await act(async () => links()[index]!.click())
    assert.deepEqual(navigation.splice(0), ['/thread/0', '/groups/1', { pathname: '/conversations', params: props }])
    linked = props
    await act(async () => root.render(createElement(Conversations)))
    const query = new URL(requested.at(-1)!, 'http://localhost').searchParams
    assert.equal(query.get('botId'), props.botId)
    assert.equal(query.get('workspaceId'), props.workspaceId)
    linked = { ...props, workspaceId: 'another-workspace' }
    await act(async () => root.render(createElement(Conversations)))
    assert.equal(new URL(requested.at(-1)!, 'http://localhost').searchParams.get('workspaceId'), linked.workspaceId)
    assert.equal(host.querySelectorAll('section').length, 0, 'never display another workspace’s cached rows on this link')
    botChildren = { ...props, items: ranked.slice(0, 1), more: false }
    await act(async () => root.render(createElement(BotConversations, props)))
    assert.equal(links().length, 1)
    await act(async () => root.render(createElement(BotConversations, { ...props, botId: 'other' })))
    assert.equal(links().length, 0, 'a previous Bot’s cached rows disappear on a scope change')
  } finally {
    await act(async () => root.unmount())
    linked = {}; botChildren = null; navigation.length = 0
    await browser.happyDOM.close()
  }
})

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

test('the directory opens the personal archive interval and only the confirmed value is selected', async () => {
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(createElement(Conversations)))
    const link = [...host.querySelectorAll('a')].find(row => row.textContent === mobileMessages.ConversationDirectory.archiveIdle)
    assert.ok(link)
    await act(async () => link.click())
    assert.equal(navigation.pop(), '/settings/conversations')
    await act(async () => root.render(createElement(ArchivePreferences)))
    const rows = () => [...host.querySelectorAll('button')]
    assert.equal(settingReads, 1)
    assert.equal(rows().length, 6)
    assert.equal(rows()[4]!.getAttribute('aria-pressed'), 'true')
    await act(async () => rows()[0]!.click())
    assert.deepEqual(writes.pop(), { archiveIdleAfterDays: 0 })
    archivePending = true
    await act(async () => root.render(createElement(ArchivePreferences)))
    assert.ok(rows().every(row => row.disabled))
    assert.equal(rows()[4]!.getAttribute('aria-pressed'), 'true')
    archiveDays = 0
    archivePending = false
    await act(async () => root.render(createElement(ArchivePreferences)))
    assert.equal(rows()[0]!.getAttribute('aria-pressed'), 'true')
    assert.equal(rows()[0]!.textContent, mobileMessages.ConversationDirectory.archiveOff)
    archiveDays = undefined
    await act(async () => root.render(createElement(ArchivePreferences)))
    assert.equal(rows().length, 0)
    assert.match(host.textContent ?? '', new RegExp(mobileMessages.ConversationDirectory.archiveUnavailable))
  } finally {
    archiveDays = 30
    archivePending = false
    await act(async () => root.unmount())
    await browser.happyDOM.close()
  }
})
