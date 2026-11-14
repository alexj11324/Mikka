import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'

const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
let renderedQuery: unknown
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key, useFormatter: () => ({}) } })
mock.module('swr', { defaultExport: () => ({}), namedExports: { useSWRConfig: () => ({}) } })
mock.module('swr/infinite', { defaultExport: (getKey: (index: number, previous: null) => unknown[]) => {
  renderedQuery = getKey(0, null)[4]
  return {}
}, namedExports: { unstable_serialize: () => 'directory' } })
const stub = (file: string, namedExports: Record<string, unknown>) => mock.module(new URL(file, import.meta.url).href, { namedExports })
stub('../../hooks/use-live-key.tsx', { useLiveKey: () => {} })
stub('../../app/actions/preferences.ts', { getPreferences: () => ({}), updatePreferences: () => ({}) })
stub('../../app/actions/task-runs.ts', { listConversations: () => ({ items: [], cursor: null }) })
stub('./workspace-navigation.ts', { openGroupConversation: () => {}, openThread: () => {}, openTask: () => {} })
stub('./pull-requests-badge.tsx', { pullRequestRef: () => ({}), PullRequestsBadge: () => null })
const { ConversationDirectory } = await import('./conversation-directory')
test('the active directory query follows the search input even before React can commit background work', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ConversationDirectory ownerId="owner" workspaceId="workspace" botId={null} />))
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
  } finally { await act(async () => root.unmount()); host.remove(); await browser.happyDOM.abort() }
})
