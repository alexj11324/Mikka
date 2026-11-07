import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { State } from 'swr'
import { Window } from 'happy-dom'

// A thread that works on no task opens like any other, from its chat card and
// from the thread list (Bot 资料 › 线程): the whole card is one button.
const t = Object.assign((key: string) => key, { rich: (key: string) => key, has: () => true })
mock.module('next-intl', { namedExports: {
  useTranslations: () => t,
  useFormatter: () => ({ relativeTime: () => 'just now', dateTime: () => 'today' }),
  useNow: () => new Date('2026-11-01T12:00:00Z'),
} })

const browser = new Window({ url: 'https://mikka.example/en' })
const at = (path: string) => new URL(`../${path}`, import.meta.url).href
let lookup: { issueId: string | null } | null = { issueId: null }
let failure: unknown = null
let lookupHold: Promise<void> | null = null
let lookupReads = 0
mock.module(at('app/actions/agents.ts'), { namedExports: { findThreadIssue: async () => {
  lookupReads++
  if (lookupHold) await lookupHold
  if (failure) throw failure
  return lookup
} } })
mock.module(at('components/workspace/issue-thread-panel.tsx'), { namedExports: { IssueThreadPanel: () => <section data-conversation="">Existing conversation<textarea defaultValue="Unsent reply" /></section> } })
mock.module(at('components/nav/context-panel.tsx'), { namedExports: { PANEL_WIDTH: { storageKey: 'fixture:thread-width', min: 320, max: 'half', initial: 360, edge: 'start' } } })
const notices = new Map<string, { action?: { onClick: () => void } }>()
mock.module('sonner', { namedExports: { toast: {
  error: (_message: string, options: { id: string; action?: { onClick: () => void } }) => { notices.set(options.id, options) },
  dismiss: (id: string) => { notices.delete(id) },
} } })
let container: HTMLDivElement
let root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let ThreadCard: typeof import('../components/coordinator/thread-card')['ThreadCard']
let ThreadList: typeof import('../components/nav/thread-list')['ThreadList']
let ThreadColumn: typeof import('../components/workspace/thread-column')['ThreadColumn']
let swr: typeof import('swr')
let refreshLookup: () => Promise<unknown>
let cache: Map<string, State>
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, PopStateEvent: browser.PopStateEvent, ResizeObserver: class { observe() {} disconnect() {} }, getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: (id: number) => clearTimeout(id) })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ThreadCard } = await import('../components/coordinator/thread-card'))
  ;({ ThreadList } = await import('../components/nav/thread-list'))
  ;({ ThreadColumn } = await import('../components/workspace/thread-column'))
  swr = await import('swr')
})
beforeEach(() => { container = document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container); lookup = { issueId: null }; failure = null; lookupHold = null; lookupReads = 0; notices.clear(); cache = new Map(); browser.history.replaceState({}, '', '/en') })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())

const runId = '7d3d2f62-1d7c-4f2c-9a7e-3b1f0c0a5e11'

function ReadControl() {
  const { mutate } = swr.useSWRConfig()
  refreshLookup = () => mutate(['thread-issue', runId])
  return null
}
async function renderColumn(scope = 'owner:workspace', shown = true) {
  const { SWRConfig } = swr
  await act(async () => root.render(<SWRConfig key={scope} value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
    <ReadControl />{shown && <ThreadColumn runId={runId} />}
  </SWRConfig>))
}
async function revalidate(error: unknown) {
  failure = error
  await act(async () => { await refreshLookup().catch(() => {}) })
}

test('an initial thread lookup failure offers local Retry instead of a permanent skeleton', async () => {
  failure = new Error('network unavailable')
  await renderColumn()
  assert.equal(lookupReads, 1)
  assert.ok(container.querySelector('[role="status"]') === null, 'a failed read must leave its loading state')
  const retry = container.querySelector('[role="alert"] button') as HTMLButtonElement | null
  assert.ok(retry, 'the thread column offers its existing inline Retry control')
  failure = null
  await act(async () => { retry.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
  assert.equal(lookupReads, 2)
  assert.ok(container.querySelector('[data-conversation]'))
})

test('a background thread lookup failure keeps the mounted conversation and retries in place', async () => {
  await renderColumn()
  const conversation = container.querySelector('[data-conversation]')!
  const input = container.querySelector('textarea')!
  input.focus(); input.setSelectionRange(2, 6)
  await revalidate(new Error('network unavailable'))
  assert.ok(container.querySelector('[data-conversation]') === conversation)
  assert.ok(document.activeElement === input)
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 6])
  const retry = notices.get(`thread-issue-read-${runId}`)?.action
  assert.ok(retry)
  failure = null
  await act(async () => { retry.onClick(); await new Promise(resolve => setTimeout(resolve, 0)) })
  assert.ok(container.querySelector('[data-conversation]') === conversation)
  assert.equal(notices.size, 0)
})

for (const [label, refusal] of [
  ['401', { status: 401 }], ['403', { status: 403 }], ['404', { status: 404 }],
  ['owner scope', { kind: 'owner' }], ['workspace scope', { kind: 'workspace' }],
  ['changed transport session', { status: 409, code: 'desktop_session_changed' }],
] as const) test(`a ${label} thread lookup refusal cannot revive old content after a later network failure`, async () => {
  await renderColumn()
  assert.ok(container.querySelector('[data-conversation]'))
  await revalidate(refusal)
  assert.ok(container.querySelector('[data-conversation]') === null)
  await revalidate(new Error('network unavailable'))
  assert.ok(container.querySelector('[data-conversation]') === null)
  await revalidate(null)
  assert.ok(container.querySelector('[data-conversation]'))
})

test('a definitive null lookup removes the thread address and never restores the previous conversation', async () => {
  browser.history.replaceState({}, '', `/en?thread=${runId}`)
  await renderColumn()
  lookup = null
  await revalidate(null)
  assert.ok(container.querySelector('[data-conversation]') === null)
  assert.equal(new URL(browser.location.href).searchParams.get('thread'), null)
  await revalidate(new Error('network unavailable'))
  assert.ok(container.querySelector('[data-conversation]') === null)
})

test('changing thread scope cannot reuse the previous scope lookup during an initial failure', async () => {
  await renderColumn()
  cache = new Map()
  failure = new Error('new scope network unavailable')
  await renderColumn('other-owner:other-workspace')
  assert.ok(container.querySelector('[data-conversation]') === null)
  assert.ok(container.querySelector('[role="alert"]'))
})

test('a retry started before the column remounts restores its new conversation from the shared read', async () => {
  await renderColumn()
  await revalidate({ status: 403 })
  failure = null
  let release!: () => void
  lookupHold = new Promise<void>(resolve => { release = resolve })
  let retry!: Promise<unknown>
  await act(async () => { retry = refreshLookup() })
  await renderColumn('owner:workspace', false)
  await renderColumn()
  assert.ok(container.querySelector('[data-conversation]') === null)
  await act(async () => { release(); await retry })
  assert.ok(container.querySelector('[data-conversation]'), 'the shared success restores the remounted column')
})

test('a chat thread card with no task is a live button that opens the thread', () => {
  const opened: unknown[] = []
  const run = { kind: 'run', id: runId, name: 'Draft the release notes', status: 'succeeded', outcome: null, issue: null } as unknown as Parameters<typeof ThreadCard>[0]['run']
  act(() => root.render(<ThreadCard run={run} onOpen={thread => opened.push(thread)} />))
  const button = container.querySelector('[data-slot="thread-card"] button') as unknown as HTMLButtonElement
  assert.ok(button)
  assert.equal(button.disabled, false)
  act(() => button.click())
  assert.deepEqual(opened, [{ issueId: null, runId }])
})

test('the thread list shows each thread as a card, and one with no task opens like the rest', () => {
  const opened: unknown[] = []
  const thread = { id: runId, issueId: null, prompt: 'Draft the release notes\nfor 2.4', status: 'succeeded', outcome: 'resolved', createdAt: new Date('2026-11-01T11:00:00Z'), finishedAt: new Date('2026-11-01T11:30:00Z'), lastReply: 'Notes are in the doc.', harness: 'codex' } as unknown as Parameters<typeof ThreadList>[0]['threads'][number]
  act(() => root.render(<ThreadList threads={[thread]} issues={[]} all onOpenThread={value => opened.push(value)} />))
  const cards = container.querySelectorAll('li[data-slot="thread-card"]')
  assert.equal(cards.length, 1, 'one card per thread')
  // 已解决 starts collapsed; open it, then the card.
  const resolved = container.querySelector('[role="group"] button') as unknown as HTMLButtonElement | null
  const card = cards[0].querySelector('button') as unknown as HTMLButtonElement | null
  assert.ok(card ?? resolved)
  if (!card) act(() => resolved!.click())
  const button = container.querySelector('li[data-slot="thread-card"] button') as unknown as HTMLButtonElement
  assert.equal(button.getAttribute('aria-label'), 'Draft the release notes')
  act(() => button.click())
  assert.deepEqual(opened, [{ issueId: null, runId }])
})
