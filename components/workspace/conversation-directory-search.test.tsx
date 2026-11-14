import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'
import type { listConversations } from '../../app/actions/task-runs'
type ConversationDirectoryPage = Awaited<ReturnType<typeof listConversations>>

const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
let renderedQuery: unknown
let data: ConversationDirectoryPage[] | undefined
const opened: string[] = []
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key, useFormatter: () => ({ dateTime: () => 'Today' }) } })
mock.module('swr', { defaultExport: () => ({}), namedExports: { useSWRConfig: () => ({}) } })
mock.module('swr/infinite', { defaultExport: (getKey: (index: number, previous: null) => unknown[], fetchPage: (key: unknown[]) => unknown) => {
  fetchPage(getKey(0, null))
  return { data }
}, namedExports: { unstable_serialize: () => 'directory' } })
const stub = (file: string, namedExports: Record<string, unknown>) => mock.module(new URL(file, import.meta.url).href, { namedExports })
stub('../../hooks/use-live-key.tsx', { useLiveKey: () => {} })
stub('../../app/actions/task-runs.ts', { listConversations: ({ search }: { search: string }) => { renderedQuery = search; return { items: [], cursor: null } } })
stub('./workspace-navigation.ts', { navigate: ({ group }: { group: string }) => opened.push('chat:' + group), openGroupConversation: (id: string) => opened.push('chat:' + id), openThread: (id: string) => opened.push('run:' + id), openTask: () => {} })
const { ConversationDirectory } = await import('./conversation-directory')
test('the active directory query follows the search input even before React can commit background work', async () => {
  const host = document.body
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ConversationDirectory ownerId="owner" workspaceId="workspace" />))
    assert.equal(renderedQuery, '')
    const input = host.querySelector('input[type="search"]')
    assert.ok(input instanceof browser.HTMLInputElement)
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set
    assert.ok(setter)
    await act(async () => {
      flushSync(() => {
        setter.call(input, '  another conversation  ')
        input.dispatchEvent(new browser.Event('input', { bubbles: true }))
      })
      assert.equal(renderedQuery, 'another conversation')
    })
  } finally { await act(async () => root.unmount()); await browser.happyDOM.abort() }
})

test('a chat and run with the same UUID retain their own directory rows and navigation', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const base = { id, unread: false, issueId: null, identifier: null, state: 'idle' as const, at: '2026-11-14T00:00:00Z', pinned: false }
  data = [{ items: [{ ...base, kind: 'run', title: 'Run entry' }, { ...base, kind: 'chat', title: 'Chat entry' }], cursor: null }]
  const root = createRoot(document.body)
  try {
    await act(async () => root.render(<ConversationDirectory ownerId="owner" workspaceId="workspace" />))
    const links = [...document.querySelectorAll('li button:first-child')]
    assert.equal(links.length, 2)
    for (const link of links) await act(async () => (link as HTMLButtonElement).click())
    assert.deepEqual(opened, ['run:' + id, 'chat:' + id])
  } finally {
    data = undefined
    opened.length = 0
    await act(async () => root.unmount())
    await browser.happyDOM.abort()
  }
})
