import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { State } from 'swr'
import type { JSONContent } from '@tiptap/react'
import { Window } from 'happy-dom'
import { LIVE_KINDS } from '../lib/live/events'
import type { IssueView } from '../app/actions/issues'
import type { ActivityVersion } from '../lib/issue-activity'

// Mount the real TaskDetail, DocumentSync, ActivityFeed, SWR and live channel.
// Only server/transport boundaries and unrelated visual children are fixtures.
const issueId = '10000000-0000-4000-8000-000000000001'
const workspaceId = '20000000-0000-4000-8000-000000000001'
const owner = 'fixture-owner'
const at = (path: string) => new URL(`../${path}`, import.meta.url).href
const body = (text: string): JSONContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const bodyText = (content: JSONContent) => content.content?.[0]?.content?.[0]?.text ?? ''
const translators = new Map<string, ((key: string, values?: Record<string, unknown>) => string) & { has: () => boolean }>()
const format = { dateTime: () => '08:07', relativeTime: () => 'now' }
mock.module('next-intl', { namedExports: {
  useTranslations: (namespace = '') => {
    if (!translators.has(namespace)) translators.set(namespace, Object.assign((key: string, values?: Record<string, unknown>) => `${namespace}.${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`, { has: () => true }))
    return translators.get(namespace)!
  },
  useLocale: () => 'en', useFormatter: () => format, useNow: () => new Date('2026-11-05T08:08:00Z'),
} })

let stored: IssueView
let versions: ActivityVersion[]
let issueReads = 0, versionReads = 0
let readOverride: (() => Promise<IssueView>) | null = null
let documentHold: Promise<void> | null = null
let documentWaits = 0
let writes: Parameters<typeof import('../app/actions/issues')['saveIssue']>[0][]
mock.module(at('app/actions/issues.ts'), { namedExports: {
  getIssue: async (id: string) => { assert.equal(id, issueId); issueReads++; return { issue: readOverride ? await readOverride() : structuredClone(stored) } },
  listIssueVersions: async (id: string) => { assert.equal(id, issueId); versionReads++; return structuredClone(versions) },
  saveIssue: async (input: Parameters<typeof import('../app/actions/issues')['saveIssue']>[0]) => {
    writes.push(structuredClone(input))
    if (input.revision !== stored.revision) return { error: 'issueStale' }
    stored = { ...stored, title: input.title, status: input.status, priority: input.priority, revision: stored.revision + 1 }
    return { issue: structuredClone(stored) }
  },
} })
mock.module(at('app/actions/collaboration.ts'), { namedExports: {
  exchangeDocument: async (input: { id: string; seed: string; known?: string }) => {
    assert.equal(input.id, issueId)
    if (documentHold) { documentWaits++; await documentHold }
    return { ...(!input.known ? { update: input.seed } : {}), version: 'fixture-document', workspaceId }
  },
} })
mock.module(at('app/actions/issue-operations.ts'), { namedExports: {
  getDeletedIssue: async () => null, listIssueConnections: async () => [], setIssueDeleted: async () => { throw new Error('no deletion in this fixture') },
} })
const none = () => null
for (const [file, names] of [
  ['issue-detail-actions', ['IssueDetailActions']], ['issue-description-history', ['IssueDescriptionHistory']],
  ['issue-relations', ['IssueRelations']], ['issue-members', ['IssueMembers']], ['issue-thread-panel', ['IssueThreadPanel']],
  ['factory-acceptance', ['FactoryAcceptance', 'FactoryAcceptancePanel']],
] as const) mock.module(at(`components/workspace/${file}.tsx`), { namedExports: Object.fromEntries(names.map(name => [name, none])) })
const emptyThreads = { data: [] }
mock.module(at('components/workspace/issue-threads.tsx'), { namedExports: { IssueThreads: none, ThreadEventRow: none, useIssueThreads: () => emptyThreads } })
mock.module(at('components/workspace/issue-detail-header.tsx'), { namedExports: { IssueDetailHeader: () => <header>Task</header> } })
mock.module(at('components/workspace/issue-detail-properties.tsx'), { namedExports: { IssueDetailProperties: ({ status, priority, task }: { status: string; priority: string; task: IssueView }) =>
  <output data-properties="" data-revision={task.revision}>{status}:{priority}</output> } })
mock.module(at('components/workspace/issue-editor.tsx'), { namedExports: {
  // An empty valid Yjs seed keeps the real DocumentSync lifecycle in this test.
  createDocumentSeed: () => new Uint8Array([0, 0]),
  IssueEditor: ({ content, onChange, activity, afterDescription }: { content: JSONContent; onChange: (value: JSONContent) => void; activity: ReactNode; afterDescription: ReactNode }) =>
    <><textarea data-description="" value={bodyText(content)} onChange={event => onChange(body(event.currentTarget.value))} />{afterDescription}<section data-activity="">{activity}</section></>,
} })

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
const sockets: FakeSocket[] = []
class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor(readonly url: string) {
    sockets.push(this)
    queueMicrotask(() => { if (this.readyState !== 0) return; this.readyState = 1; this.onopen?.(); this.message({ type: 'live_ready', version: 1, kinds: LIVE_KINDS }) })
  }
  send(value: string) { if (value === 'ping') this.onmessage?.({ data: 'pong' }) }
  close() { this.readyState = 3; this.onclose?.() }
  message(value: unknown) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }) }
}

let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let TaskDetail: typeof import('../components/workspace/task-detail')['TaskDetail']
let root: Root, container: HTMLDivElement, cache: Map<string, State>
let flush: (() => Promise<boolean>) | null = null
const registerFlush = (value: typeof flush) => { flush = value }
const noop = () => {}
before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Element', 'getComputedStyle', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'ResizeObserver', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'CompositionEvent', 'FocusEvent', 'Event', 'CSS'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig } = await import('swr'))
  ;({ LiveProvider } = await import('../hooks/use-live-key'))
  ;({ TaskDetail } = await import('../components/workspace/task-detail'))
})
function version(issue: IssueView): ActivityVersion {
  return { ...issue, id: `version-${issue.revision}`, createdAt: `2026-11-05T08:0${issue.revision}:00Z` }
}
beforeEach(() => {
  stored = { id: issueId, userId: owner, title: 'Accepted report', content: body('Original description'), status: 'review', priority: 'normal', revision: 1,
    identifier: 'ALEX-60', metadata: {}, createdAt: new Date('2026-11-05T08:00:00Z'), updatedAt: new Date('2026-11-05T08:00:00Z') } as IssueView
  versions = [version(stored)]; writes = []; issueReads = 0; versionReads = 0; readOverride = null; documentHold = null; documentWaits = 0; flush = null; cache = new Map(); sockets.length = 0
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  globalThis.fetch = async (input, options) => {
    assert.ok(!options?.method || options.method === 'GET')
    const url = new URL(String(input), 'https://mikka.example')
    assert.ok(url.pathname.endsWith('/api/live/ticket'), `unexpected network boundary ${url.pathname}`)
    assert.equal(url.searchParams.get('workspace'), workspaceId)
    return Response.json({ url: `wss://fixture.invalid/${workspaceId}`, protocol: 'fixture', expiresAt: Date.now() + 600_000 })
  }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch })
after(async () => { Object.assign(globalThis, { WebSocket: originalSocket }); mock.restoreAll(); await browser.close() })
async function wait(ms = 25) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
async function until(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 160 && !predicate(); attempt++) await wait()
  assert.ok(predicate(), label)
}
const properties = () => container.querySelector('[data-properties]')!
const title = () => container.querySelector<HTMLTextAreaElement>('#task-title')!
const description = () => container.querySelector<HTMLTextAreaElement>('[data-description]')!
const activity = () => container.querySelector('[data-activity]')?.textContent ?? ''
async function mount() {
  await act(async () => root.render(<SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
    <LiveProvider ownerId={owner} workspaceId={workspaceId}><TaskDetail id={issueId} thread={null} origin="Tasks"
      user={{ id: owner, name: 'Owner', email: 'owner@example.invalid' }} navigation={{ index: -1, total: 0, onOpen: noop }}
      onOpen={noop} onSaved={noop} onDirty={noop} onClose={noop} onDeleted={noop} onRegisterFlush={registerFlush} /></LiveProvider>
  </SWRConfig>))
  await until(() => !!description() && sockets.some(socket => socket.readyState === 1) && activity().includes('createdTask'), 'task, activity and live channel mounted')
  await wait(100)
}
async function emit(id = issueId) { await act(async () => { for (const socket of sockets) socket.message({ kind: 'issue_document', id }) }) }
async function input(element: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function accepted() {
  stored = { ...stored, status: 'done', revision: 2 }
  versions.push(version(stored))
}

test('a committed acceptance event refreshes the mounted task status and activity without reload', { timeout: 10_000 }, async () => {
  await mount()
  assert.equal(properties().textContent, 'review:normal')
  const before = { issueReads, versionReads }
  accepted()
  await emit('10000000-0000-4000-8000-000000000002'); await wait(100)
  assert.deepEqual({ issueReads, versionReads }, before, 'another issue cannot refresh this task')
  await emit()
  await until(() => properties().textContent === 'done:normal' && activity().includes('changedStatus Issue.status.done'), 'accepted status and human activity refresh together')
  assert.equal(properties().getAttribute('data-revision'), '2')
  assert.ok(issueReads > before.issueReads && versionReads > before.versionReads)
  assert.equal(writes.length, 0, 'a committed live read performs no save')
})

test('a live acceptance keeps unsaved title and description, then saves them against the new revision without reopening the task', { timeout: 15_000 }, async () => {
  await mount()
  const original = structuredClone(stored)
  const titleElement = title(), bodyElement = description()
  await act(async () => { titleElement.focus(); titleElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await input(titleElement, 'Unsent title while composing')
  await input(bodyElement, 'Unsent description')
  titleElement.setSelectionRange(4, 12)
  accepted(); await emit()
  await until(() => properties().textContent === 'done:normal', 'external status is adopted while text is dirty')
  assert.equal(title(), titleElement, 'the task is not remounted')
  assert.equal(description(), bodyElement)
  assert.equal(title().value, 'Unsent title while composing')
  assert.equal(description().value, 'Unsent description')
  assert.equal(document.activeElement, titleElement)
  assert.deepEqual([titleElement.selectionStart, titleElement.selectionEnd], [4, 12])
  assert.equal(writes.length, 0, 'composition does not autosave or get interrupted by acceptance')
  assert.match(activity(), /changedStatus Issue\.status\.done/)
  await act(async () => { titleElement.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); assert.equal(await flush!(), true) })
  assert.equal(writes.length, 1)
  assert.deepEqual({ revision: writes[0].revision, title: writes[0].title, status: writes[0].status, description: bodyText(writes[0].content) },
    { revision: 2, title: 'Unsent title while composing', status: 'done', description: 'Unsent description' })
  readOverride = async () => original
  const before = issueReads
  await emit(); await until(() => issueReads > before, 'a late older snapshot has been read')
  await wait(100)
  assert.equal(properties().getAttribute('data-revision'), '3', 'an older read cannot replace the acknowledged save')
  assert.equal(properties().textContent, 'done:normal')
  assert.equal(title().value, 'Unsent title while composing')
})

test('acceptance during a pending document flush cannot pair the newer revision with an older Review snapshot', { timeout: 15_000 }, async () => {
  await mount()
  await act(async () => { title().focus(); title().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await input(title(), 'Keep the pending title')
  await input(description(), 'Keep the pending description')
  let release!: () => void
  documentHold = new Promise<void>(resolve => { release = resolve })
  let pending!: Promise<boolean>
  try {
    await act(async () => { title().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); pending = flush!() })
    await until(() => documentWaits > 0, 'the real DocumentSync flush waits on its server response')
    assert.equal(writes.length, 0)
    accepted(); await emit()
    await until(() => properties().textContent === 'done:normal' && properties().getAttribute('data-revision') === '2', 'acceptance arrives while the older save snapshot is waiting')
    documentHold = null
    await act(async () => { release(); assert.equal(await pending, true) })
    assert.equal(writes.length, 1)
    assert.deepEqual({ revision: writes[0].revision, status: writes[0].status, title: writes[0].title, description: bodyText(writes[0].content) },
      { revision: 2, status: 'done', title: 'Keep the pending title', description: 'Keep the pending description' })
    assert.equal(stored.status, 'done', 'an unrelated text save must not reopen accepted work')
  } finally {
    documentHold = null
    release()
    await act(async () => { await pending?.catch(() => false) })
  }
})
