import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useEffect, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { State } from 'swr'
import type { JSONContent } from '@tiptap/react'
import { Window } from 'happy-dom'
import { LIVE_KINDS } from '../lib/live/events'
import type { IssueView } from '../app/actions/issues'
import type { ActivityVersion } from '../lib/issue-activity'
import { ISSUE_STATUS_CODES } from '../lib/issue-meta'
import { taskPresentation } from '../lib/task-presentation'
import { PersistentReadCache } from '../lib/swr/persistent-cache'
import { ReadResponseError } from '../lib/swr/retry'
import type { ReadStorage, StoredRead } from '../lib/swr/indexed-db'

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
const notices = new Map<string, { action?: { onClick: (event: Event) => void } }>()
mock.module('sonner', { namedExports: { toast: {
  error: (_message: string, options: { id: string; action?: { onClick: (event: Event) => void } }) => { notices.set(options.id, options) },
  dismiss: (id: string) => { notices.delete(id) }, success: () => {},
} } })
mock.module('next-intl', { namedExports: {
  useTranslations: (namespace = '') => {
    if (!translators.has(namespace)) translators.set(namespace, Object.assign((key: string, values?: Record<string, unknown>) => `${namespace}.${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`, { has: () => true }))
    return translators.get(namespace)!
  },
  useLocale: () => 'en', useFormatter: () => format, useNow: () => new Date('2026-11-05T08:08:00Z'),
} })

let stored: IssueView
let versions: ActivityVersion[]
let issueReads = 0, versionReads = 0, fullVersionReads = 0, documentReads = 0
let readOverride: (() => Promise<IssueView>) | null = null
let deletedTask: { id: string; title: string; deletedAt: string; canRestore?: boolean } | null = null
let restoreOverride: (() => Promise<{ error: string }>) | null = null
let readFailure: string | null = null
let readViewerId = owner
let knownVersions: (string | undefined)[]
let documentHold: Promise<void> | null = null
let documentWaits = 0
let latestDocumentUpdate: string | undefined
let projectionReads = 0
mock.module(at('app/actions/task-domain.ts'), { namedExports: {
  getTaskPresentations: async ({ workspaceId, issueIds }: { workspaceId: string; issueIds: string[] }) => {
    projectionReads++
    const status = ISSUE_STATUS_CODES.find(code => code === stored.status)
    assert.ok(status)
    const view = taskPresentation({ status, metadata: { pullRequests: [] } },
      { runId: 'active-run', status: 'running', outcome: null }, null, () => false)
    return { version: 1, workspaceId, items: Object.fromEntries(issueIds.map(id => [id, view])) }
  },
} })
let writes: Parameters<typeof import('../app/actions/issues')['saveIssue']>[0][]
mock.module(at('app/actions/issues.ts'), { namedExports: {
  pollIssue: async (id: string, known?: string) => {
    assert.equal(id, issueId); issueReads++; knownVersions.push(known)
    const issue = readOverride ? await readOverride() : structuredClone(stored)
    if (readFailure) return { error: readFailure }
    const version = String(issue.revision).padStart(32, '0')
    return known === version ? { viewerId: readViewerId, version, unchanged: true } : { viewerId: readViewerId, issue, version }
  },
  pollIssueVersionSummaries: async (id: string) => {
    assert.equal(id, issueId); versionReads++
    return { viewerId: readViewerId, snapshot: { version: String(versions.length).padStart(32, '0'), items: structuredClone(versions) } }
  },
  listIssueVersions: async (id: string) => { assert.equal(id, issueId); fullVersionReads++; return structuredClone(versions) },
  saveIssue: async (input: Parameters<typeof import('../app/actions/issues')['saveIssue']>[0]) => {
    writes.push(structuredClone(input))
    if (input.revision !== stored.revision) return { error: 'issueStale' }
    stored = { ...stored, title: input.title, status: input.status, priority: input.priority, revision: stored.revision + 1 }
    return { issue: structuredClone(stored) }
  },
} })
mock.module(at('app/actions/collaboration.ts'), { namedExports: {
  exchangeDocument: async (input: { id: string; seed: string; known?: string; update?: string }) => {
    assert.equal(input.id, issueId)
    documentReads++
    if (input.update) latestDocumentUpdate = input.update
    if (documentHold) { documentWaits++; await documentHold }
    return { ...(!input.known ? { update: input.seed } : {}), version: 'fixture-document', workspaceId }
  },
} })
mock.module(at('app/actions/issue-operations.ts'), { namedExports: {
  getDeletedIssue: async () => deletedTask,
  listIssueConnections: async () => [],
  setIssueDeleted: async (input: { id: string; restore: boolean }) => {
    if (!restoreOverride) throw new Error('no deletion in this fixture')
    assert.deepEqual(input, { id: issueId, restore: true })
    return restoreOverride()
  },
} })
const none = () => null
for (const [file, names] of [
  ['issue-relations', ['IssueRelations']], ['issue-members', ['IssueMembers']], ['issue-thread-panel', ['IssueThreadPanel']],
  ['factory-acceptance', ['FactoryAcceptance', 'FactoryAcceptancePanel']],
] as const) mock.module(at(`components/workspace/${file}.tsx`), { namedExports: Object.fromEntries(names.map(name => [name, none])) })
mock.module(at('components/workspace/issue-description-history.tsx'), { namedExports: {
  IssueDescriptionHistory: ({ open, onRestore }: import('react').ComponentProps<typeof import('../components/workspace/issue-description-history').IssueDescriptionHistory>) =>
    open ? <output data-restore-available={String(Boolean(onRestore))} /> : null,
} })
const emptyThreads = { data: [] }
mock.module(at('components/workspace/issue-threads.tsx'), { namedExports: { IssueThreads: none, ThreadEventRow: none, useIssueThreads: () => emptyThreads, useAgentActivity: () => ({ rows: [], error: null }) } })
// The controller is mounted with a minimal renderer for the official frame contract.
const { IssueActivityFeed } = await import('../components/workspace/issue-activity-feed')
mock.module(at('components/workspace/task-detail-frame.tsx'), { namedExports: {
  FramedTask: (props: import('../components/workspace/task-detail-frame').FramedTaskProps) => {
    const { rootRef, onKeyDown, preview, status, priority, titleField, onHistory, task } = props
    return <div ref={rootRef} onKeyDown={onKeyDown} role="region" aria-busy={preview}>
      <textarea id="task-title" value={titleField.value} readOnly={titleField.readOnly}
        onChange={event => titleField.onChange(event.currentTarget.value)} onBlur={titleField.onBlur}
        onCompositionStart={titleField.onCompositionStart} onCompositionEnd={titleField.onCompositionEnd} onKeyDown={titleField.onKeyDown} />
      <button data-history="" disabled={preview} onClick={onHistory}>History</button>
      <button data-complete="" onClick={() => props.onStatus('done')}>Done</button>
      <button data-reopen="" onClick={() => props.onStatus('todo')}>Reopen</button>
      <button data-priority="" onClick={() => props.onPriority('high')}>High</button>
      <output data-properties="" data-revision={task.revision}>{status}:{priority}</output>
      {props.editor(null, () => null)}
      <section data-activity="">{!preview && <IssueActivityFeed versions={props.versions} children={[]} agents={props.agentActivity.rows} />}</section>
      {props.panel}{props.dialogs}
    </div>
  },
} })
mock.module(at('components/workspace/issue-editor.tsx'), { namedExports: {
  // An empty valid Yjs seed keeps the real DocumentSync lifecycle in this test.
  createDocumentSeed: () => new Uint8Array([0, 0]),
  IssueEditor: ({ content, sharedDoc, disabled, onChange, activity, afterDescription }: { sharedDoc?: import('yjs').Doc; content: JSONContent; disabled: boolean; onChange: (value: JSONContent) => void; activity: ReactNode; afterDescription: ReactNode }) =>
    <><button data-discussion-write="" disabled={disabled} onClick={() => sharedDoc?.getMap('threads').set('fixture-comment', 'Only a discussion changed')}>Comment</button><textarea data-description="" readOnly={disabled} value={bodyText(content)} onChange={event => onChange(body(event.currentTarget.value))} />{afterDescription}{activity}</>,
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
let useSWRConfig: typeof import('swr')['useSWRConfig']
let swrDefaults: typeof import('../components/swr-defaults')['swrDefaults']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let TaskDetail: typeof import('../components/workspace/task-detail')['TaskDetail']
let root: Root, container: HTMLDivElement, cache: Map<string, State>
let flush: (() => Promise<boolean>) | null = null
const registerFlush = (value: typeof flush) => { flush = value }
let dirty = false
const recordDirty = (value: boolean) => { dirty = value }
const noop = () => {}
before(async () => {
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Element', 'getComputedStyle', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'ResizeObserver', 'KeyboardEvent', 'MouseEvent', 'InputEvent', 'CompositionEvent', 'FocusEvent', 'Event', 'CSS'] as const) {
    const value = key === 'window' ? browser : (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: typeof value === 'function' && !/^[A-Z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, useSWRConfig } = await import('swr'))
  ;({ swrDefaults } = await import('../components/swr-defaults'))
  ;({ LiveProvider } = await import('../hooks/use-live-key'))
  ;({ TaskDetail } = await import('../components/workspace/task-detail'))
})
function version(issue: IssueView): ActivityVersion {
  return { ...issue, id: `version-${issue.revision}`, createdAt: `2026-11-05T08:0${issue.revision}:00Z` }
}
beforeEach(() => {
  notices.clear(); dirty = false
  stored = { id: issueId, userId: owner, title: 'Accepted report', content: body('Original description'), status: 'review', priority: 'normal', revision: 1,
    identifier: 'ALEX-60', metadata: {}, createdAt: new Date('2026-11-05T08:00:00Z'), updatedAt: new Date('2026-11-05T08:00:00Z') } as IssueView
  deletedTask = null
  restoreOverride = null
  versions = [version(stored)]; writes = []; issueReads = 0; versionReads = 0; fullVersionReads = 0; documentReads = 0; knownVersions = []; readFailure = null; readViewerId = owner; readOverride = null; documentHold = null; documentWaits = 0; latestDocumentUpdate = undefined; flush = null; cache = new Map(); sockets.length = 0
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
function HydrateFixtureCache() {
  const { cache, mutate } = useSWRConfig()
  useEffect(() => {
    if (cache instanceof PersistentReadCache) void cache.hydrate((key, data) => mutate(key, data, { revalidate: false }))
  }, [cache, mutate])
  return null
}
async function renderDetail(visible: boolean, origin = 'Tasks', siblings?: ReactNode, live = true) {
  // Keep the provider mounted when a task closes: SWR retains both completed
  // and pending reads across a quick reopen, with its default dedupe interval.
  const detail = <>{siblings}{visible && <TaskDetail id={issueId} thread={null} origin={origin}
    user={{ id: owner, name: 'Owner', email: 'owner@example.invalid' }} navigation={{ index: -1, total: 0, onOpen: noop }}
    onOpen={noop} onSaved={noop} onDirty={recordDirty} onClose={noop} onDeleted={noop} onRegisterFlush={registerFlush} />}</>
  await act(async () => root.render(<SWRConfig value={{ ...(cache instanceof PersistentReadCache ? swrDefaults : {}), provider: () => cache, shouldRetryOnError: false }}>
    {cache instanceof PersistentReadCache && <HydrateFixtureCache />}
    {live ? <LiveProvider ownerId={owner} workspaceId={workspaceId}>{detail}</LiveProvider> : detail}
  </SWRConfig>))
}
async function mount(ready = true) {
  await renderDetail(true)
  if (!ready) return
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

test('a recovered task appears before its conditional read, without creating a writable document until access is revalidated', { timeout: 10_000 }, async () => {
  const { unstable_serialize } = await import('swr')
  const readVersion = String(stored.revision).padStart(32, '0')
  cache.set(unstable_serialize(['issue', issueId]), { data: { ...structuredClone(stored), readVersion } })
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  readOverride = async () => { await waiting; return structuredClone(stored) }
  try {
    await mount(false); await until(() => !!description(), 'cached task preview appears')
    assert.equal(description().value, 'Original description')
    assert.equal(container.querySelector('[role="region"]')?.getAttribute('aria-busy'), 'true')
    assert.equal(title().readOnly, true)
    assert.deepEqual(knownVersions, [readVersion])
    assert.equal(documentReads, 0, 'no stale seed is exchanged before authorization')
    assert.equal(versionReads, 0, 'activity is deferred until the task read succeeds')
    assert.equal(writes.length, 0)
    await act(async () => release())
    await until(() => documentReads > 0 && activity().includes('createdTask'), 'verified document and activity mount')
    assert.equal(title().readOnly, false)
    assert.equal(fullVersionReads, 0, 'the activity feed reads summaries, not fifty full historical documents')
    await act(async () => { (container.querySelector('[data-history]') as HTMLButtonElement).click() })
    await until(() => fullVersionReads === 1, 'opening history fetches the version bodies on demand')
  } finally { release() }
})

test('a failed cached-task authorization removes its preview without exchanging the stored document', { timeout: 10_000 }, async () => {
  const { unstable_serialize } = await import('swr')
  cache.set(unstable_serialize(['issue', issueId]), { data: { ...structuredClone(stored), readVersion: '1'.padStart(32, '0') } })
  readFailure = 'workspaceAccessDenied'
  await mount(false)
  await until(() => container.textContent?.includes('unavailableTitle') === true, 'revoked task is unavailable')
  assert.equal(description(), null)
  assert.equal(documentReads, 0)
  assert.equal(writes.length, 0)
})

test('a shared-task response after an account cookie change cannot validate the old viewer\'s document', { timeout: 10_000 }, async () => {
  const { unstable_serialize } = await import('swr')
  cache.set(unstable_serialize(['issue', issueId]), { data: { ...structuredClone(stored), readVersion: '1'.padStart(32, '0') } })
  readViewerId = 'other-viewer'
  await mount(false)
  await until(() => container.textContent?.includes('unavailableTitle') === true, 'foreign viewer response is refused')
  assert.equal(description(), null)
  assert.equal(documentReads, 0)
  assert.equal(writes.length, 0)
})

test('a quick reopen revalidates a completed SWR read before unlocking the cached task', { timeout: 10_000 }, async () => {
  await mount()
  const before = { issueReads, documentReads, versionReads }
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  readOverride = async () => { await waiting; return structuredClone(stored) }
  try {
    await renderDetail(false)
    assert.equal(flush, null, 'closing unregisters the previous form')
    await mount(false)
    await until(() => !!description(), 'the same task reopens from the retained SWR cache')
    assert.equal(title().readOnly, true)
    assert.equal(description().readOnly, true)
    assert.equal(container.querySelector('[role="region"]')?.getAttribute('aria-busy'), 'true')
    assert.equal((container.querySelector('[data-history]') as HTMLButtonElement).disabled, true)
    assert.equal(documentReads, before.documentReads, 'the reopened snapshot cannot create a writable document')
    assert.equal(versionReads, before.versionReads, 'the reopened snapshot cannot fetch its activity before authorization')
    await act(async () => { assert.equal(await flush!(), true, 'an untouched preview must not block navigation') })
    assert.equal(writes.length, 0)
    await until(() => issueReads > before.issueReads, 'the reopened task checks current access despite SWR retaining the previous request')
    await act(async () => release())
    await until(() => !!title() && !title().readOnly && documentReads > before.documentReads && activity().includes('createdTask'), 'the reopened form unlocks after its current authorized read')
    assert.equal(description().readOnly, false)
    await act(async () => { assert.equal(await flush!(), true) })
    assert.equal(writes.length, 0)
  } finally { release() }
})

test('closing and reopening during the first conditional read unlocks the new form only after authorization', { timeout: 10_000 }, async () => {
  const { unstable_serialize } = await import('swr')
  cache.set(unstable_serialize(['issue', issueId]), { data: { ...structuredClone(stored), readVersion: '1'.padStart(32, '0') } })
  let releaseOld!: () => void, releaseCurrent!: () => void
  const oldRead = new Promise<void>(resolve => { releaseOld = resolve })
  const currentRead = new Promise<void>(resolve => { releaseCurrent = resolve })
  let started = 0
  readOverride = async () => { await (++started === 1 ? oldRead : currentRead); return structuredClone(stored) }
  try {
    await mount(false)
    await until(() => !!description() && issueReads > 0, 'the first cached preview waits on authorization')
    assert.equal(title().readOnly, true)
    assert.equal(description().readOnly, true)
    await act(async () => { assert.equal(await flush!(), true, 'the pending read must not trap the user in a preview') })
    await renderDetail(false)
    assert.equal(flush, null)
    await mount(false)
    await until(() => !!description() && issueReads >= 2, 'the new form starts its own read while the original read is still pending')
    assert.equal(issueReads, 2)
    assert.equal(title().readOnly, true)
    assert.equal(description().readOnly, true)
    assert.equal(documentReads, 0)
    assert.equal(versionReads, 0)
    assert.equal(writes.length, 0)
    await act(async () => releaseOld())
    assert.equal(container.querySelector('[role="region"]')?.getAttribute('aria-busy'), 'true')
    assert.equal(title().readOnly, true, 'the old request cannot authorize the newly mounted form')
    assert.equal(description().readOnly, true)
    assert.equal(documentReads, 0)
    assert.equal(versionReads, 0)
    assert.equal(writes.length, 0)
    await act(async () => releaseCurrent())
    await until(() => !!title() && !title().readOnly && documentReads > 0 && activity().includes('createdTask'), 'only the current authorization unlocks the reopened form')
    assert.equal(description().readOnly, false)
    await act(async () => { assert.equal(await flush!(), true) })
    assert.equal(writes.length, 0)
  } finally { releaseOld(); releaseCurrent() }
})

test('a task reopened before persistent hydration starts its authorized read after the SWR pause ends', { timeout: 10_000 }, async () => {
  const { unstable_serialize } = await import('swr')
  const rawKey = ['issue', issueId], key = unstable_serialize(rawKey)
  const readVersion = String(stored.revision).padStart(32, '0')
  let releaseDisk!: (rows: StoredRead[]) => void
  let releaseRead!: () => void
  const disk = new Promise<StoredRead[]>(resolve => { releaseDisk = resolve })
  const network = new Promise<void>(resolve => { releaseRead = resolve })
  const storage: ReadStorage = {
    activate: () => disk,
    write: async () => undefined, remove: async () => undefined, clear: async () => undefined,
  }
  const persistent = new PersistentReadCache({ userId: owner, workspaceId, build: 'fixture-build', role: 'admin' }, storage)
  cache = persistent
  readOverride = async () => { await network; return structuredClone(stored) }
  try {
    await mount(false)
    assert.equal(persistent.isHydrated, false)
    assert.equal(issueReads, 0, 'SWR remains paused while storage activation is pending')
    assert.equal(documentReads, 0)
    await renderDetail(false)
    await mount(false)
    assert.equal(persistent.isHydrated, false)
    assert.equal(issueReads, 0, 'remounting must not start a read before the disk cursor is available')
    assert.equal(documentReads, 0)
    assert.equal(versionReads, 0)
    await act(async () => {
      releaseDisk([{ key, rawKey, data: { ...structuredClone(stored), readVersion }, savedAt: Date.now() }])
      await persistent.hydrated
    })
    await until(() => !!description() && issueReads > 0, 'the current mount explicitly authorizes its restored preview after hydration')
    assert.equal(issueReads, 1, 'the unmounted instance must not launch another read when hydration resolves')
    assert.deepEqual(knownVersions, [readVersion])
    assert.equal(title().readOnly, true)
    assert.equal(description().readOnly, true)
    assert.equal(documentReads, 0)
    assert.equal(versionReads, 0)
    await act(async () => { assert.equal(await flush!(), true) })
    await act(async () => releaseRead())
    await until(() => !!title() && !title().readOnly && documentReads > 0 && activity().includes('createdTask'), 'the post-hydration authorization unlocks the current form')
    assert.equal(description().readOnly, false)
    assert.equal(writes.length, 0)
    await act(async () => { assert.equal(await flush!(), true) })
  } finally {
    await renderDetail(false)
    await act(async () => { releaseDisk([]); releaseRead(); await persistent.hydrated; await persistent.flushed() })
  }
})

for (const refusal of ['workspaceAccessDenied', 'foreign-viewer'] as const) test(`a quick reopen stays read-only when current authorization returns ${refusal}`, { timeout: 10_000 }, async () => {
  await mount()
  const before = { documentReads, versionReads }
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  readOverride = async () => { await waiting; return structuredClone(stored) }
  if (refusal === 'foreign-viewer') readViewerId = 'other-viewer'
  else readFailure = refusal
  try {
    await renderDetail(false)
    await mount(false)
    await until(() => !!description(), 'the previously authorized task reopens as a preview')
    assert.equal(title().readOnly, true)
    assert.equal(description().readOnly, true)
    assert.equal(documentReads, before.documentReads)
    assert.equal(versionReads, before.versionReads)
    await act(async () => { assert.equal(await flush!(), true) })
    await act(async () => release())
    await until(() => container.textContent?.includes('unavailableTitle') === true, 'the current authorization refusal removes the old preview')
    assert.equal(title(), null)
    assert.equal(description(), null)
    assert.equal(flush, null, 'the unavailable task retains no writable form')
    assert.equal(documentReads, before.documentReads, 'revoked access never creates a new document exchange')
    assert.equal(versionReads, before.versionReads)
    assert.equal(writes.length, 0)
  } finally { release() }
})

test('a comment-only Yjs change flushes without a title or body edit', async () => {
  await mount()
  await act(async () => document.querySelector<HTMLButtonElement>('[data-discussion-write]')!.click())
  await until(() => Boolean(latestDocumentUpdate && Buffer.from(latestDocumentUpdate, 'base64').includes(Buffer.from('Only a discussion changed'))), 'the discussion reached the document writer')
  assert.equal(writes.length, 0, 'saving a discussion cannot create a task revision')
})

test('a confirmed read-only grant shows activity without enabling title, body or document writes', async () => {
  stored = { ...stored, workspaceId, canSteer: false, readOnlyDiscussions: [] }
  await mount()
  assert.equal(title().readOnly, true)
  assert.equal(description().readOnly, true)
  assert.equal(documentReads, 0)
  await input(title(), 'Must not save')
  await act(async () => { assert.equal(await flush!(), true) })
  assert.equal(writes.length, 0)
  assert.equal(title().value, stored.title)
  accepted()
  await emit()
  await until(() => properties().textContent === 'done:normal', 'a read grant continues to observe the task')
  assert.equal(documentReads, 0)
})

test('a confirmed read grant opens description history without a restore command or document exchange', async () => {
  stored = { ...stored, workspaceId, canSteer: false, readOnlyDiscussions: [] }
  await mount()
  const history = container.querySelector<HTMLButtonElement>('[data-history]')!
  await act(async () => history.click())
  await until(() => fullVersionReads === 1, 'a reader can fetch historical bodies')
  assert.equal(container.querySelector('[data-restore-available]')?.getAttribute('data-restore-available'), 'false')
  assert.equal(documentReads, 0)
  assert.deepEqual(writes, [])
})

test('a confirmed status write refreshes only this viewer’s Task projections without a live event', async () => {
  const { useWorkspaceTaskPresentations } = await import('../hooks/use-task-collection')
  const { useSelectedTaskPresentation } = await import('../hooks/use-selected-task-presentation')
  const { TaskCardDataProvider, useTaskCards } = await import('../hooks/use-task-cards')
  stored = { ...stored, workspaceId, status: 'todo' }
  projectionReads = 0
  function Card() {
    const cards = useTaskCards([issueId])
    return <output data-card="">{cards[issueId]?.state}</output>
  }
  function Projections() {
    const collection = useWorkspaceTaskPresentations(owner, workspaceId, null, [{ id: issueId, workspaceId }], true)
    const detail = useSelectedTaskPresentation(owner, workspaceId, issueId)
    const otherViewer = useSelectedTaskPresentation('another-viewer', workspaceId, issueId)
    const otherWorkspace = useSelectedTaskPresentation(owner, 'other-workspace', issueId)
    const otherTask = useSelectedTaskPresentation(owner, workspaceId, 'other-task')
    return <><output data-projections="">{[collection.items[issueId]?.state, detail.data?.state].join('/')}</output>
      <output data-unrelated="">{[otherViewer, otherWorkspace, otherTask].map(read => read.data?.state).join('/')}</output>
      <TaskCardDataProvider ownerId={owner} workspaceId={workspaceId}><Card /></TaskCardDataProvider></>
  }
  await renderDetail(true, 'Tasks', <Projections />, false)
  const state = (attribute: string) => container.querySelector(`[data-${attribute}]`)?.textContent
  await until(() => state('card') === 'running' && state('unrelated') === 'running/running/running' && !!description(), 'six scoped reads mounted')
  const initialReads = projectionReads
  for (const [control, status, projected] of [['complete', 'done', 'done'], ['reopen', 'todo', 'running']]) {
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-${control}]`)!.click())
    await until(() => stored.status === status && state('card') === projected && state('projections') === [projected, projected].join('/'), 'the authorized state catches up without push')
    assert.equal(state('unrelated'), 'running/running/running')
  }
  await act(async () => container.querySelector<HTMLButtonElement>('[data-priority]')!.click())
  await until(() => stored.priority === 'high', 'priority save committed')
  assert.equal(projectionReads - initialReads, 6, 'only the three matching keys revalidated after each status change')
})

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

test('every Task entry revalidates the shared saved value and withholds its editor on denial', { timeout: 40_000 }, async () => {
  await mount()
  await input(title(), 'Shared title from Tasks')
  await act(async () => { assert.equal(await flush!(), true) })
  for (const origin of ['Board', 'Project', 'Team', 'Search', 'Notifications', 'Inbox', 'Coordinator']) {
    await renderDetail(false)
    let allowRead!: () => void
    const pending = new Promise<void>(resolve => { allowRead = resolve })
    readOverride = async () => { await pending; return structuredClone(stored) }
    try {
      await renderDetail(true, origin)
      await until(() => title()?.value === 'Shared title from Tasks', origin + ' sees the saved Task')
      assert.ok(title().readOnly, origin + ' cannot write through cached data')
    } finally { allowRead() }
    await until(() => title()?.readOnly === false, origin + ' rechecks the current grant')
    assert.equal(writes.length, 1, origin + ' opening an entry never replays the edit')
  }
  readFailure = 'workspaceAccessDenied'
  await emit()
  await until(() => container.textContent?.includes('unavailableTitle') === true, 'a revoked grant removes the refreshed editor')
  assert.equal(flush, null)
  for (const origin of ['Notifications', 'Project', 'Search']) {
    await renderDetail(false)
    await renderDetail(true, origin)
    await until(() => container.textContent?.includes('unavailableTitle') === true, origin + ' cannot restore a denied edit')
    assert.equal(title(), null)
    assert.equal(flush, null)
  }
  assert.equal(writes.length, 1)
})

test('a background transport failure keeps the authorized editor, unsaved text and selection through retry', { timeout: 10_000 }, async () => {
  await mount()
  const titleElement = title(), bodyElement = description()
  await act(async () => { titleElement.focus(); titleElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await input(titleElement, 'Keep this unsaved title')
  await input(bodyElement, 'Keep this unsaved description')
  titleElement.setSelectionRange(5, 9)
  const before = issueReads
  readOverride = async () => { throw new TypeError('fixture offline') }
  await emit(); await until(() => issueReads > before, 'the live detail read fails')
  await wait()
  assert.ok(title() === titleElement, 'a background failure must not remount the editor')
  assert.ok(description() === bodyElement)
  assert.equal(title().value, 'Keep this unsaved title')
  assert.equal(description().value, 'Keep this unsaved description')
  assert.ok(document.activeElement === titleElement)
  assert.deepEqual([titleElement.selectionStart, titleElement.selectionEnd], [5, 9])
  assert.equal(writes.length, 0)
  assert.ok(flush, 'the mounted draft keeps its flush registration')
  assert.equal(dirty, true, 'a temporary read failure must retain the unsaved-change guard')
  const notice = notices.get(`issue-detail-read-${issueId}`)
  assert.ok(notice?.action, 'the retained editor offers an explicit read retry')
  readOverride = null
  const failedReads = issueReads
  await act(async () => notice.action!.onClick(new Event('click', { cancelable: true })))
  await until(() => issueReads > failedReads && !notices.has(`issue-detail-read-${issueId}`), 'retry succeeds and clears the read failure')
  assert.ok(title() === titleElement)
  assert.ok(description() === bodyElement)
  assert.equal(title().value, 'Keep this unsaved title')
  assert.equal(description().value, 'Keep this unsaved description')
  assert.equal(writes.length, 0, 'retrying a read does not submit the draft')
})

for (const refusal of ['authRequired', 'workspaceAccessDenied', 'issueNotFound', 'foreign-viewer', 401, 403, 404] as const) test(`an authorized task discards its editor after ${refusal} and a later network failure cannot restore it`, { timeout: 10_000 }, async () => {
  await mount()
  await act(async () => { title().focus(); title().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
  await input(title(), 'A draft whose access is about to be revoked')
  assert.equal(dirty, true)
  if (typeof refusal === 'number') readOverride = async () => { throw new ReadResponseError(refusal) }
  else if (refusal === 'foreign-viewer') readViewerId = 'another-owner'
  else readFailure = refusal
  await emit()
  await until(() => container.textContent?.includes('unavailableTitle') === true, 'the authorization refusal clears the task')
  assert.equal(title(), null)
  assert.equal(description(), null)
  assert.equal(flush, null)
  assert.equal(dirty, false, 'the discarded editor must not leave a dirty guard that traps navigation')
  assert.equal(notices.size, 0)
  readFailure = null; readViewerId = owner
  readOverride = async () => { throw new TypeError('fixture offline after refusal') }
  const before = issueReads
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'IssueDetail.reload')!.click())
  await until(() => issueReads > before, 'the explicit retry fails with an ordinary network error')
  await wait()
  assert.ok(title() === null, 'previously refused content stays hidden until a successful authorized read')
  assert.equal(description(), null)
  assert.equal(flush, null)
  assert.equal(writes.length, 0)
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
  await until(() => properties().textContent === 'done:normal' && activity().includes('changedStatus Issue.status.done'), 'external status and activity are adopted while text is dirty')
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

test('discussion draft ACK clears only its submitted edit, keeps the original operation for retry, and respects Task changes', async () => {
  const { useActivityDrafts } = await import('../components/workspace/issue-activity')
  const { ViewStateProvider } = await import('../lib/hooks/view-state')
  const acknowledgements: (() => void)[] = []
  const commands: { task: string; body: string; id: string }[] = []
  let retries = 0
  let draft: ReturnType<typeof useActivityDrafts>
  function Composer({ task, reader = false }: { task: string; reader?: boolean }) {
    draft = useActivityDrafts(task, () => false, (_thread, body, id) => {
      if (reader) return false
      commands.push({ task, body, id })
    }, { afterAcknowledged: ack => acknowledgements.push(ack), retry: () => { retries++ } })
    return null
  }
  const open = (task: string, reader = false) => act(async () => {
    root.render(<ViewStateProvider scope="discussion-test"><Composer key={task + reader} task={task} reader={reader} /></ViewStateProvider>)
  })
  await open('first')
  await act(async () => { draft.setReplyTo('thread'); draft.setReply('original') })
  await act(async () => { draft.sendReply('thread'); draft.sendReply('thread') })
  assert.equal(commands.length, 1)
  assert.equal(retries, 1)
  assert.equal(draft!.reply, 'original')
  await act(async () => { draft.setReply('later edit') })
  await act(async () => { acknowledgements.shift()!() })
  assert.equal(draft!.reply, 'later edit')
  await act(async () => { draft.sendReply('thread') })
  assert.notEqual(commands[0].id, commands[1].id)
  await open('second')
  await act(async () => { draft.setReplyTo('other-thread'); draft.setReply('other Task') })
  await act(async () => { acknowledgements.shift()!() })
  assert.equal(draft!.reply, 'other Task')
  await open('first', true)
  await act(async () => { draft.sendReply('thread') })
  assert.equal(commands.length, 2)
  await open('first')
  assert.equal(draft!.reply, 'later edit')
  await act(async () => { draft.sendReply('thread') })
  assert.equal(commands[1].id, commands[2].id, 'a reopened draft reuses its Yjs operation identity')
  await act(async () => { acknowledgements.shift()!() })
  assert.equal(draft!.reply, '')
})

test('expired deleted Task explains its restore window without offering an impossible action', async () => {
  readFailure = 'issueNotFound'
  deletedTask = { id: issueId, title: 'Old task', deletedAt: '2020-01-01T00:00:00.000Z' }
  await mount(false)
  await until(() => container.textContent?.includes('deletedTitle') === true, 'owner sees the deleted Task')
  assert.match(container.textContent ?? '', /Errors\.issueRestoreWindow/)
  assert.doesNotMatch(container.textContent ?? '', /IssueDetail\.(restoreTask|deletedDescription)/)
})

test('a recoverable deleted Task withdraws Restore when its open page passes the deadline', async () => {
  readFailure = 'issueNotFound'
  const deadline = Date.now() + 1500
  deletedTask = { id: issueId, title: 'Recent task', deletedAt: new Date(deadline - 30 * 86_400_000).toISOString(), canRestore: true }
  await mount(false)
  await until(() => container.textContent?.includes('restoreTask') === true, 'recoverable Task offers Restore')
  await until(() => container.textContent?.includes('Errors.issueRestoreWindow') === true, 'an open page crosses the deadline')
  assert.doesNotMatch(container.textContent ?? '', /IssueDetail\.(restoreTask|deletedDescription)/)
})

test('the server restore decision wins even when the client clock says a Task is still recoverable', async () => {
  readFailure = 'issueNotFound'
  deletedTask = { id: issueId, title: 'Clock-skewed task', deletedAt: new Date().toISOString(), canRestore: true }
  let writes = 0
  restoreOverride = async () => { writes++; return { error: 'issueRestoreWindow' } }
  await mount(false)
  const restoreButton = () => [...container.querySelectorAll('button')].find(button => button.textContent === 'IssueDetail.restoreTask')
  await until(() => !!restoreButton(), 'the initial owner read allowed Restore')
  await act(async () => restoreButton()!.click())
  await until(() => container.textContent?.includes('Errors.issueRestoreWindow') === true, 'writer returned the authoritative expiry')
  assert.equal(writes, 1)
  assert.equal(restoreButton(), undefined)
  assert.doesNotMatch(container.textContent ?? '', /IssueDetail\.deletedDescription/)
})
