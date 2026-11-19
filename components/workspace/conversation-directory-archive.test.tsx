import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { act, useEffect } from 'react'
import { Window } from 'happy-dom'
import { SWRConfig, useSWRConfig } from 'swr'

const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
let days = 30
let canSave = true
const writes: number[] = []
let reads = 0
let pendingRead: Promise<{ archiveIdleAfterDays: number }> | null = null
const subscriptions = new Map<string, () => Promise<unknown>>()

mock.module('@/lib/intl/i18n-client', { namedExports: { useTranslations: () => (key: string) => key, useFormatter: () => ({ dateTime: () => '' }) } })
const stub = (file: string, namedExports: Record<string, unknown>) => mock.module(new URL(file, import.meta.url).href, { namedExports })
function readPreferences() { reads++; return pendingRead ?? { archiveIdleAfterDays: days } }
stub('../../lib/settings-read.ts', { settingsRead: readPreferences })
stub('../../app/actions/preferences.ts', { getPreferences: readPreferences, updatePreferences: async ({ archiveIdleAfterDays }: { archiveIdleAfterDays: number }) => {
  writes.push(archiveIdleAfterDays)
  if (!canSave) return { error: 'unknown' }
  days = archiveIdleAfterDays
  return { archiveIdleAfterDays }
} })
stub('../../app/actions/task-runs.ts', { listConversations: async () => ({ items: [], cursor: null }) })
stub('./workspace-navigation.ts', { openGroupConversation() {}, openThread() {}, openTask() {} })
stub('./pull-requests-badge.tsx', { pullRequestRef: () => ({}), PullRequestsBadge: () => null })
stub('../../hooks/use-live-key.tsx', { useLiveKey(kind: string, id: string | null, keys: readonly string[], scope: string | null) {
  const { mutate } = useSWRConfig()
  useEffect(() => {
    if (!id || !scope) return
    const channel = [kind, id, scope].join('/')
    subscriptions.set(channel, () => Promise.all(keys.map(key => mutate(key))))
    return () => { subscriptions.delete(channel) }
  }, [kind, id, scope, JSON.stringify(keys), mutate])
} })
const router = { refresh() {} }
mock.module('@/lib/client-runtime/navigation', { namedExports: { useSearchParams: () => new URLSearchParams() } })
stub('../../i18n/navigation.ts', { useRouter: () => router })
const { AuthenticatedReadCache } = await import('../authenticated-read-cache')
const { ConversationDirectory } = await import('./conversation-directory')

async function mount() {
  const root = createRoot(document.body)
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
    <ConversationDirectory ownerId="owner" workspaceId="workspace" botId={null} />
  </SWRConfig>))
  const select = document.querySelector('label select')
  assert.ok(select instanceof browser.HTMLSelectElement)
  return { root, select }
}

test('retry writes the refused archive interval again and clears the visible error after persistence', async () => {
  days = 30
  canSave = false
  writes.length = 0
  const { root, select } = await mount()
  try {
    assert.equal(select.value, '30')
    await act(async () => { select.value = '0'; select.dispatchEvent(new browser.Event('change', { bubbles: true })) })
    assert.deepEqual(writes, [0])
    assert.equal(select.value, '30')
    const retry = document.querySelector('[role=alert] button')
    assert.ok(retry instanceof browser.HTMLButtonElement)
    assert.match(retry.parentElement?.textContent ?? '', /archiveSaveError/)
    canSave = true
    await act(async () => retry.click())
    assert.deepEqual(writes, [0, 0])
    assert.equal(days, 0)
    assert.equal(select.value, '0')
    assert.equal(document.querySelector('[role=alert]'), null)
  } finally { await act(async () => root.unmount()); await browser.happyDOM.abort() }
})

test('the existing scoped live invalidation refreshes the displayed personal interval from another session', async () => {
  days = 7
  const { root, select } = await mount()
  try {
    assert.equal(select.value, '7')
    const before = reads
    days = 90
    const receive = subscriptions.get('group_list/workspace/workspace')
    assert.ok(receive)
    await act(async () => { await receive() })
    assert.equal(select.value, '90')
    assert.ok(reads > before)
  } finally { await act(async () => root.unmount()); await browser.happyDOM.abort() }
})

test('switching signed-in accounts removes the previous archive choice and its retry intent while the next read is pending', async () => {
  const root = createRoot(document.body)
  const view = (ownerId: string, role: 'admin' | 'member') => <AuthenticatedReadCache ownerId={ownerId} workspace={{ workspaceId: 'workspace', role }} build="qa">
    <ConversationDirectory ownerId={ownerId} workspaceId="workspace" botId={null} />
  </AuthenticatedReadCache>
  const select = () => {
    const field = document.querySelector('label select')
    assert.ok(field instanceof browser.HTMLSelectElement)
    return field
  }
  try {
    canSave = false
    days = 3
    writes.length = 0
    await act(async () => root.render(view('owner', 'admin')))
    assert.equal(select().value, '3')
    await act(async () => { select().value = '14'; select().dispatchEvent(new browser.Event('change', { bubbles: true })) })
    assert.ok(document.querySelector('[role=alert] button'))
    let complete!: (value: { archiveIdleAfterDays: number }) => void
    pendingRead = new Promise(resolve => { complete = resolve })
    await act(async () => root.render(view('member', 'member')))
    assert.equal(select().disabled, true)
    assert.notEqual(select().value, '3')
    assert.equal(document.querySelector('[role=alert]'), null)
    await act(async () => { complete({ archiveIdleAfterDays: 90 }); await pendingRead })
    assert.equal(select().value, '90')
    assert.deepEqual(writes, [14])
  } finally {
    pendingRead = null
    canSave = true
    await act(async () => root.unmount())
    await browser.happyDOM.abort()
  }
})
