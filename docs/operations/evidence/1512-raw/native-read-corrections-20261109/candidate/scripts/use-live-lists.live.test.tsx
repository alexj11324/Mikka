import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { State } from 'swr'
import { Window } from 'happy-dom'
import { LIVE_KINDS } from '../lib/live/events'
import { liveKeyConnection } from '../lib/swr/live-focus'
import { PersistentReadCache } from '../lib/swr/persistent-cache'
import { CacheReadError } from '../lib/cache-read-error'
import type { PresenceProof } from '../lib/live/presence'
import type { ReadStorage, StoredRead } from '../lib/swr/indexed-db'

const home = '10000000-0000-4000-8000-000000000001'
const team = '20000000-0000-4000-8000-000000000001'
const otherTeam = '20000000-0000-4000-8000-000000000002'
const otherHome = '10000000-0000-4000-8000-000000000002'
type Kind = 'issues' | 'threads' | 'tasks' | 'bots' | 'groups' | 'roster'
type Read = { items: { id: string; title: string }[]; live: { ownerId: string; workspaceId: string | null; selectedWorkspaceId?: string; deadline?: { at: string; afterMs: number }; revisions?: Record<string, number>; presence?: PresenceProof | null }; version?: string; positions?: { id: string; version: string }[]; delta?: true; presenceFallback?: boolean }
const replies = new Map<Kind, () => Promise<Read>>()
let reads: Kind[]
let cursors: { kind: Kind; known?: string; positions?: unknown }[]
let scopeError: string | null = null
const read = (kind: Kind) => { reads.push(kind); return replies.get(kind)!() }
const sync = async (kind: Kind, known?: string, positions?: unknown) => {
  cursors.push({ kind, known, positions })
  return scopeError ? { error: scopeError } : { snapshot: await read(kind) }
}
mock.module(new URL('../app/actions/issues.ts', import.meta.url).href, { namedExports: { syncIssueList: (known?: string, positions?: unknown) => sync('issues', known, positions) } })
mock.module(new URL('../app/actions/task-runs.ts', import.meta.url).href, { namedExports: { syncThreadList: (known?: string, positions?: unknown) => sync('threads', known, positions), pollTaskRuns: () => read('tasks') } })
mock.module(new URL('../app/actions/coordinator.ts', import.meta.url).href, { namedExports: { pollBotChatSummaries: () => read('bots') } })
mock.module(new URL('../app/actions/bots.ts', import.meta.url).href, { namedExports: { pollBots: () => read('roster') } })

mock.module('next/navigation', { namedExports: { useSearchParams: () => ({ get: () => null }) } })
mock.module(new URL('../i18n/navigation.ts', import.meta.url).href, { namedExports: { useRouter: () => ({ refresh() {} }) } })

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let useSWR: typeof import('swr')['default']
let unstableSerialize: typeof import('swr')['unstable_serialize']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let useLiveKeys: typeof import('../hooks/use-live-key')['useLiveKeys']
let staleOnFocus: typeof import('../components/swr-defaults')['staleOnFocus']
let hooks: typeof import('../hooks/use-live-lists')
let useListExpiry: typeof import('../hooks/use-list-expiry')['useListExpiry']
let root: Root, container: HTMLDivElement, cache: Map<string, State>, tickets: string[]
let refresh: Partial<Record<Kind, () => Promise<unknown>>>
let replaceObserved: (value: Read) => Promise<unknown>
let automaticReadiness = true
let automaticOpen = true
const sockets: FakeSocket[] = []

/** Real React, SWR and LiveChannels; only authenticated read and WS boundaries
 * are replaced. No request can reach a real service. */
class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  readonly url: string
  readonly sent: { type: string; id: string; token?: string }[] = []
  // The channel asks the Worker for revisions; the fixture addresses the socket by its channel path.
  constructor(url: string) {
    assert.equal(new URL(url).searchParams.get('revisions'), '1')
    this.url = url.split('?')[0]
    sockets.push(this)
    queueMicrotask(() => { if (automaticOpen) this.open() })
  }
  open() {
    if (this.readyState !== 0) return
    this.readyState = 1; this.onopen?.()
    if (automaticReadiness) this.message({ type: 'live_ready', version: 1, kinds: LIVE_KINDS })
  }
  send(value: string) { if (value === 'ping') this.onmessage?.({ data: 'pong' }); else this.sent.push(JSON.parse(value)) }
  close() { this.readyState = 3; this.onclose?.() }
  message(value: unknown) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }) }
}

function Items({ kind, value }: { kind: Kind; value: { data?: unknown; error?: unknown; mutate: () => Promise<unknown> } }) {
  refresh[kind] = () => value.mutate()
  return <output data-kind={kind}>{value.data === undefined ? value.error ? 'unavailable' : 'loading' : JSON.stringify(value.data)}</output>
}
const Issues = ({ owner, workspace }: { owner: string; workspace: string }) => <Items kind="issues" value={hooks.useLiveIssueList(owner, workspace)} />
const Threads = ({ owner }: { owner: string }) => <Items kind="threads" value={hooks.useLiveThreadList(owner)} />
const Tasks = ({ owner }: { owner: string }) => <Items kind="tasks" value={hooks.useLiveTaskRunList(owner)} />
const Bots = ({ owner }: { owner: string }) => <Items kind="bots" value={hooks.useLiveBotChatList(owner)} />
const Groups = ({ owner, workspace }: { owner: string; workspace: string }) => <Items kind="groups" value={hooks.useLiveGroupList(owner, workspace)} />
const Roster = ({ owner, workspace }: { owner: string; workspace: string }) => <Items kind="roster" value={hooks.useLiveBotRoster(owner, workspace)} />

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig, default: useSWR, unstable_serialize: unstableSerialize } = await import('swr'))
  ;({ LiveProvider, useLiveKeys } = await import('../hooks/use-live-key'))
  ;({ staleOnFocus } = await import('../components/swr-defaults'))
  hooks = await import('../hooks/use-live-lists')
  ;({ useListExpiry } = await import('../hooks/use-list-expiry'))
})
beforeEach(() => {
  reads = []; cursors = []; scopeError = null; automaticReadiness = true; automaticOpen = true; tickets = []; sockets.length = 0; refresh = {}; cache = new Map(); replies.clear()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  for (const kind of ['issues', 'threads', 'tasks', 'bots', 'groups', 'roster'] as const) replies.set(kind, async () => snapshot(kind))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  globalThis.fetch = async (input, options) => {
    assert.ok(!options?.method || options.method === 'GET', 'no mutation/model request belongs in this fixture')
    const url = new URL(String(input), 'https://mikka.example')
    if (url.pathname.endsWith('/api/live/ticket')) {
      const workspace = url.searchParams.get('workspace'); assert.ok(workspace); tickets.push(workspace)
      return Response.json({ url: `wss://fixture.invalid/${workspace}`, protocol: 'fixture', expiresAt: Date.now() + 600_000 })
    }
    assert.ok(url.pathname.endsWith('/api/conversations'), `unexpected network boundary ${url.pathname}`)
    const value = await read('groups')
    return Response.json({ conversations: value.items, viewerId: value.live.ownerId, workspaceId: value.live.selectedWorkspaceId })
  }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch })
after(async () => { Object.assign(globalThis, { WebSocket: originalSocket }); mock.restoreAll(); await browser.close() })

function snapshot(kind: Kind, ownerId = 'owner', workspaceId: string | null = kind === 'roster' ? team : home): Read {
  return { items: [{ id: kind, title: `${ownerId}:${kind}` }], live: { ownerId, workspaceId, selectedWorkspaceId: team }, version: 'fixture-version' }
}
const wait = async (ms = 160) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
const count = (kind: Kind) => reads.filter(value => value === kind).length
const view = (kind: Kind) => container.querySelector(`[data-kind="${kind}"]`)?.textContent
async function render(kinds: Kind[], workspace = team, owner = 'owner') {
  await act(async () => root.render(<SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
    <LiveProvider ownerId={owner} workspaceId={workspace}>
      {kinds.includes('issues') && <Issues owner={owner} workspace={workspace} />}
      {kinds.includes('threads') && <Threads owner={owner} />}
      {kinds.includes('tasks') && <Tasks owner={owner} />}
      {kinds.includes('bots') && <Bots owner={owner} />}
      {kinds.includes('groups') && <Groups owner={owner} workspace={workspace} />}
      {kinds.includes('roster') && <Roster owner={owner} workspace={workspace} />}
    </LiveProvider>
  </SWRConfig>))
}
async function settled() { await wait(); await wait() }
function emit(scope: string, kind: string) { for (const socket of sockets) if (socket.url.endsWith(scope)) socket.message({ kind, id: scope }) }
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail }), resolve: (value: T) => resolve(value), reject: (error: unknown) => reject(error) } }

type ReadCompare = (a: Read | undefined, b: Read | undefined) => boolean
function ObservedReader({ enabled, scopes, owner, compare }: { enabled: boolean; scopes: string[]; owner: string; compare?: ReadCompare }) {
  const key = ['observed-live-reader', owner]
  const result = useSWR<Read>(enabled ? key : null, () => read('issues'), { revalidateOnFocus: false, revalidateOnReconnect: false, ...(compare ? { compare } : {}) })
  replaceObserved = value => result.mutate(value, { revalidate: false })
  const serialized = unstableSerialize(key)
  useLiveKeys(scopes.map(scope => ({ kind: 'issue_list', id: scope, workspaceId: scope,
    revisions: { [serialized]: result.data?.live.revisions?.[`issue_list:${scope}`] } })), [serialized])
  return <Items kind="issues" value={result} />
}
function ChannelAnchor() {
  useLiveKeys([{ kind: 'bot_list', id: team, workspaceId: team }], ['observed-live-anchor'])
  return null
}
async function renderObserved(enabled: boolean, scopes = [team], owner = 'owner', compare?: ReadCompare, onSuccess?: () => void, anchor = false) {
  await act(async () => root.render(<SWRConfig key={owner} value={{ provider: () => cache, use: [staleOnFocus], dedupingInterval: 0, shouldRetryOnError: false, ...(onSuccess ? { onSuccess } : {}) }}>
    <LiveProvider ownerId={owner} workspaceId={team}>{anchor && <ChannelAnchor />}<ObservedReader enabled={enabled} scopes={scopes} owner={owner} compare={compare} /></LiveProvider>
  </SWRConfig>))
}

test('a committed SWR read after connection readiness covers the pending live flush', async () => {
  replies.set('issues', async () => issueAt(5))
  await renderObserved(false)
  await renderObserved(true)
  assert.equal(count('issues'), 1)
  assert.ok(view('issues')?.includes('revision-5'), 'the real SWR cache has already committed the read')
  await settled()
  assert.equal(count('issues'), 1, 'finishing before the existing flush does not require the same read again')
  await act(async () => emit(team, 'issue_list')); await settled()
  assert.equal(count('issues'), 2, 'a later unversioned event cannot reuse the earlier commit')
})

test('a late live subscription shares the committed read from its continuously ready connection', async () => {
  replies.set('issues', async () => issueAt(5))
  await renderObserved(false, [], 'owner', undefined, undefined, true)
  await renderObserved(true, [], 'owner', undefined, undefined, true)
  assert.equal(count('issues'), 1)
  assert.ok(view('issues')?.includes('revision-5'))
  await renderObserved(true, [team], 'owner', undefined, undefined, true); await settled()
  assert.equal(sockets.length, 1, 'the unrelated existing subscriber keeps this exact connection alive')
  assert.equal(count('issues'), 1, 'subscribing itself is not a data change after the already committed read')
})

for (const revision of [undefined, 6]) test(`a ${revision ? 'higher-revision' : 'new unversioned'} push while unsubscribed invalidates the committed read before a late subscription`, async () => {
  replies.set('issues', async () => issueAt(5))
  await renderObserved(false, [], 'owner', undefined, undefined, true)
  await act(async () => sockets[0].message({ type: 'live_ready', version: 2, kinds: LIVE_KINDS, revisions: ['issue_list'] }))
  await renderObserved(true, [], 'owner', undefined, undefined, true)
  await act(async () => {
    sockets[0].message({ kind: 'issue_list', id: team, ...(revision ? { rev: revision } : {}) })
  })
  replies.set('issues', async () => issueAt(6))
  await renderObserved(true, [team], 'owner', undefined, undefined, true); await settled()
  assert.equal(count('issues'), 2)
  assert.ok(view('issues')?.includes('revision-6'))
})

for (const ready of [false, true]) test(`a late subscription cannot reuse a read from ${ready ? 'before' : 'without'} the capability acknowledgement`, async () => {
  automaticReadiness = false
  replies.set('issues', async () => issueAt(5))
  await renderObserved(false, [], 'owner', undefined, undefined, true)
  await renderObserved(true, [], 'owner', undefined, undefined, true)
  if (ready) await act(async () => sockets[0].message({ type: 'live_ready', version: 1, kinds: LIVE_KINDS }))
  replies.set('issues', async () => issueAt(6))
  await renderObserved(true, [team], 'owner', undefined, undefined, true); await settled()
  assert.equal(count('issues'), 2)
  assert.ok(view('issues')?.includes('revision-6'))
})

test('a committed read from an earlier connection generation cannot cover a late subscription', async () => {
  replies.set('issues', async () => issueAt(5))
  await renderObserved(false, [], 'owner', undefined, undefined, true)
  await renderObserved(true, [], 'owner', undefined, undefined, true)
  for (const visibility of ['hidden', 'visible']) await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility })
    document.dispatchEvent(new browser.Event('visibilitychange') as unknown as Event)
  })
  assert.equal(sockets.length, 2)
  replies.set('issues', async () => issueAt(6))
  await renderObserved(true, [team], 'owner', undefined, undefined, true); await settled()
  assert.equal(count('issues'), 2)
  assert.ok(view('issues')?.includes('revision-6'))
})

test('a replaced committed cache object cannot satisfy the pending live flush', async () => {
  replies.set('issues', async () => issueAt(5))
  await renderObserved(false); await renderObserved(true)
  await act(async () => { await replaceObserved(issueAt(9)) })
  replies.set('issues', async () => issueAt(10))
  await settled()
  assert.equal(count('issues'), 2, 'a different cache object needs one ordinary read, without a proof retry loop')
  assert.ok(view('issues')?.includes('revision-10'))
})

test('a newer failed SWR read cannot resurrect an earlier committed provenance', async () => {
  replies.set('issues', async () => issueAt(5))
  await renderObserved(false, [], 'owner', undefined, undefined, true)
  await renderObserved(true, [], 'owner', undefined, undefined, true)
  const error = new Error('fixture latest read failed')
  replies.set('issues', async () => { throw error })
  await act(async () => { await refresh.issues!() })
  assert.equal(cache.get(unstableSerialize(['observed-live-reader', 'owner']))?.error, error)
  replies.set('issues', async () => issueAt(6))
  await renderObserved(true, [team], 'owner', undefined, undefined, true); await settled()
  assert.equal(count('issues'), 3)
  assert.ok(view('issues')?.includes('revision-6'))
})

test('live catch-ups share an ordinary SWR read that starts after both scoped connections open', async () => {
  const held = deferred<Read>(), next = deferred<Read>()
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false, [team, home])
    assert.equal(sockets.filter(socket => socket.readyState === 1).length, 2)
    await renderObserved(true, [team, home])
    assert.equal(count('issues'), 1)
    await wait()
    assert.equal(count('issues'), 1, 'both catch-up obligations are covered by the same later in-flight read')
    await act(async () => held.resolve(snapshot('issues'))); await wait()
    assert.ok(view('issues')?.includes('owner:issues'))
    replies.set('issues', () => next.promise)
    await act(async () => { emit(team, 'issue_list'); emit(home, 'issue_list') }); await wait()
    assert.equal(count('issues'), 2, 'a later unversioned event needs a new read; completed results are not reused')
    await act(async () => next.resolve(issueAt(6))); await wait()
    assert.ok(view('issues')?.includes('revision-6'))
  } finally { await act(async () => { held.resolve(snapshot('issues')); next.resolve(issueAt(6)) }) }
})

test('a SWR read that starts before the live connection opens cannot consume its catch-up', async () => {
  const held = deferred<Read>()
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(true); await wait()
    assert.equal(count('issues'), 2, 'the connection gap still needs a later authoritative read')
    await act(async () => held.resolve(snapshot('issues'))); await wait()
    assert.ok(view('issues')?.includes('owner:issues'))
  } finally { await act(async () => held.resolve(snapshot('issues'))) }
})

function issueAt(revision: number): Read {
  const value = snapshot('issues')
  return { ...value, items: [{ id: 'issues', title: `revision-${revision}` }], live: { ...value.live, revisions: { [`issue_list:${team}`]: revision, [`issue_list:${home}`]: revision } } }
}

for (const revision of [undefined, 6]) test(`a ${revision ? 'higher-revision' : 'new unversioned'} push during a shared SWR read still gets its trailing read`, async () => {
  const held = deferred<Read>()
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false); await renderObserved(true); await wait()
    assert.equal(count('issues'), 1)
    await act(async () => {
      sockets[0].message({ type: 'live_ready', version: 2, kinds: LIVE_KINDS, revisions: ['issue_list'] })
      sockets[0].message({ kind: 'issue_list', id: team, ...(revision ? { rev: revision } : {}) })
    })
    await wait(); assert.equal(count('issues'), 1, 'the notification remains pending behind the active read')
    replies.set('issues', async () => issueAt(6))
    await act(async () => held.resolve(issueAt(5))); await settled()
    assert.equal(count('issues'), 2)
    assert.ok(view('issues')?.includes('revision-6'))
  } finally { await act(async () => held.resolve(issueAt(5))) }
})

test('a later-started SWR read must still prove every required revision before covering a live push', async () => {
  const held = deferred<Read>()
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false)
    await act(async () => {
      sockets[0].message({ type: 'live_ready', version: 2, kinds: LIVE_KINDS, revisions: ['issue_list'] })
      sockets[0].message({ kind: 'issue_list', id: team, rev: 6 })
    })
    await renderObserved(true); await wait()
    assert.equal(count('issues'), 1)
    replies.set('issues', async () => issueAt(6))
    await act(async () => held.resolve(issueAt(5))); await settled()
    assert.equal(count('issues'), 2, 'a successful HTTP read without the required revision cannot satisfy the push')
    assert.ok(view('issues')?.includes('revision-6'))
  } finally { await act(async () => held.resolve(issueAt(5))) }
})

test('a SWR response discarded by an optimistic mutation cannot consume the live catch-up', async () => {
  const held = deferred<Read>()
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false); await renderObserved(true); await wait()
    await act(async () => { await replaceObserved({ ...issueAt(5), items: [{ id: 'issues', title: 'optimistic-local-value' }] }) })
    replies.set('issues', async () => issueAt(6))
    await act(async () => held.resolve(issueAt(5))); await settled()
    assert.equal(count('issues'), 2, 'SWR ignored the HTTP result; the obligation still requires a committed read')
    assert.ok(view('issues')?.includes('revision-6'))
  } finally { await act(async () => held.resolve(issueAt(5))) }
})

test('a custom comparator retaining an older cache value cannot certify an unversioned live catch-up', async () => {
  const held = deferred<Read>(), first = issueAt(6)
  const compare: ReadCompare = (left, right) => Object.is(left, right) || left !== undefined && right === first
  cache.set(unstableSerialize(['observed-live-reader', 'owner']), { data: issueAt(5) })
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false, [team], 'owner', compare)
    await renderObserved(true, [team], 'owner', compare); await wait()
    assert.equal(count('issues'), 1)
    replies.set('issues', async () => issueAt(6))
    await act(async () => held.resolve(first)); await settled()
    assert.equal(count('issues'), 2, 'onSuccess and custom compare alone do not prove that the fresh result entered the cache')
    assert.ok(view('issues')?.includes('revision-6'))
  } finally { await act(async () => held.resolve(first)) }
})

test('a shared read cannot replace the revision held when the live obligation began with a lower revision', async () => {
  const held = deferred<Read>()
  cache.set(unstableSerialize(['observed-live-reader', 'owner']), { data: issueAt(9) })
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false); await renderObserved(true); await wait()
    assert.equal(count('issues'), 1)
    replies.set('issues', async () => issueAt(10))
    await act(async () => held.resolve(issueAt(5))); await settled()
    assert.equal(count('issues'), 2, 'post-commit revision 5 cannot erase the earlier revision 9 requirement')
    assert.ok(view('issues')?.includes('revision-10'))
  } finally { await act(async () => held.resolve(issueAt(5))) }
})

test('a completed read cannot erase the higher revision still held by the active live subscription', async () => {
  replies.set('issues', async () => issueAt(9))
  await renderObserved(false); await renderObserved(true); await settled()
  assert.equal(count('issues'), 1)
  await act(async () => emit(team, 'issue_list'))
  replies.set('issues', async () => issueAt(5))
  await act(async () => { await refresh.issues!() })
  assert.equal(count('issues'), 2)
  assert.ok(view('issues')?.includes('revision-5'), 'the actual SWR commit precedes the pending live flush')
  replies.set('issues', async () => issueAt(10))
  await settled()
  assert.equal(count('issues'), 3, 'the subscription still requires revision 9 after cache commit 5')
  assert.ok(view('issues')?.includes('revision-10'))
})

test('an original onSuccess exception remains a SWR error without a shared-read retry', async () => {
  const held = deferred<Read>(), error = new Error('fixture success callback failed')
  let callbacks = 0
  const onSuccess = () => { callbacks++; throw error }
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false, [team], 'owner', undefined, onSuccess)
    await renderObserved(true, [team], 'owner', undefined, onSuccess); await wait()
    await act(async () => held.resolve(issueAt(6))); await settled()
    assert.equal(count('issues'), 1, 'the observer must not retry an original SWR callback failure')
    assert.equal(callbacks, 1)
    assert.equal(cache.get(unstableSerialize(['observed-live-reader', 'owner']))?.error, error)
  } finally { await act(async () => held.resolve(issueAt(6))) }
})

test('a discarded shared read cannot start another request after the page becomes hidden', async () => {
  const held = deferred<Read>()
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false); await renderObserved(true); await wait()
    await act(async () => {
      await replaceObserved(issueAt(5))
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new browser.Event('visibilitychange') as unknown as Event)
    })
    replies.set('issues', async () => issueAt(6))
    await act(async () => held.resolve(issueAt(5))); await settled()
    assert.equal(count('issues'), 1, 'the retired visible interval cannot initiate a new HTTP read')
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new browser.Event('visibilitychange') as unknown as Event)
    }); await settled()
    assert.equal(count('issues'), 2, 'the existing visibility catch-up still performs the necessary fresh read')
    assert.ok(view('issues')?.includes('revision-6'))
  } finally { await act(async () => held.resolve(issueAt(5))) }
})

test('a newer SWR read replaces a shared observation without applying or re-reading the discarded result', async () => {
  const first = deferred<Read>(), second = deferred<Read>()
  replies.set('issues', () => first.promise)
  let replacement: Promise<unknown> | undefined
  try {
    await renderObserved(false); await renderObserved(true); await wait()
    replies.set('issues', () => second.promise)
    await act(async () => { replacement = refresh.issues!() })
    assert.equal(count('issues'), 2)
    await act(async () => first.resolve(issueAt(5))); await wait()
    assert.equal(view('issues'), 'loading', 'SWR discards the superseded result')
    assert.equal(count('issues'), 2, 'the newer in-flight read itself covers the obligation')
    await act(async () => { second.resolve(issueAt(6)); await replacement }); await wait()
    assert.ok(view('issues')?.includes('revision-6'))
    assert.equal(count('issues'), 2)
  } finally { await act(async () => { first.resolve(issueAt(5)); second.resolve(issueAt(6)); await replacement }) }
})

test('an old cache error cannot be attributed to a superseded read or consume the replacement revision requirement', async () => {
  const first = deferred<Read>(), second = deferred<Read>()
  cache.set(unstableSerialize(['observed-live-reader', 'owner']), { data: issueAt(9), error: new Error('earlier read failed') })
  replies.set('issues', () => first.promise)
  let replacement: Promise<unknown> | undefined
  try {
    await renderObserved(false); await renderObserved(true); await wait()
    replies.set('issues', () => second.promise)
    await act(async () => { replacement = refresh.issues!() })
    await act(async () => first.resolve(issueAt(5))); await wait()
    assert.equal(count('issues'), 2)
    replies.set('issues', async () => issueAt(10))
    await act(async () => { second.resolve(issueAt(5)); await replacement }); await settled()
    assert.equal(count('issues'), 3, 'the replacement must still cover revision 9; an unrelated old error is not its outcome')
    assert.ok(view('issues')?.includes('revision-10'))
  } finally { await act(async () => { first.resolve(issueAt(5)); second.resolve(issueAt(5)); await replacement }) }
})

test('a shared permission failure keeps SWR error handling and does not start another request', async () => {
  const held = deferred<Read>(), error = new CacheReadError('workspaceAccessDenied')
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false); await renderObserved(true); await wait()
    assert.equal(count('issues'), 1)
    await act(async () => held.reject(error)); await settled()
    assert.equal(count('issues'), 1)
    assert.equal(view('issues'), 'unavailable')
    assert.equal(cache.get(unstableSerialize(['observed-live-reader', 'owner']))?.error, error)
  } finally { await act(async () => held.resolve(snapshot('issues'))) }
})

test('retiring the owner cache while a shared read is pending neither adopts it nor revalidates the departed scope', async () => {
  const held = deferred<Read>(), oldCache = cache
  replies.set('issues', () => held.promise)
  try {
    await renderObserved(false); await renderObserved(true); await wait()
    // Force the old SWR result to be discarded before its provider departs.
    await act(async () => { await replaceObserved(issueAt(5)) })
    cache = new Map()
    replies.set('issues', async () => snapshot('issues', 'next-owner', otherHome))
    await renderObserved(true, [otherTeam], 'next-owner'); await settled()
    const before = count('issues')
    await act(async () => held.resolve(snapshot('issues'))); await settled()
    assert.equal(count('issues'), before, 'the retired obligation cannot initiate a new request')
    assert.ok(view('issues')?.includes('next-owner:issues'))
    assert.equal(cache.has(unstableSerialize(['observed-live-reader', 'owner'])), false)
    assert.equal(cache.get(unstableSerialize(['observed-live-reader', 'next-owner']))?.data.live.ownerId, 'next-owner')
    assert.notEqual(cache, oldCache)
  } finally { await act(async () => held.resolve(snapshot('issues'))) }
})

for (const ownedHome of [home, team]) test(`resolving the issue home ${ownedHome === team ? 'equal to' : 'different from'} the selected workspace preserves its live subscription`, async () => {
  const held = deferred<Read>()
  const value = snapshot('issues', 'owner', ownedHome)
  replies.set('issues', () => held.promise)
  try {
    await render(['issues']); await settled()
    const selected = sockets.find(socket => socket.url.endsWith(team))!
    assert.ok(selected)
    assert.equal(selected.readyState, 1)
    const before = count('issues')
    replies.set('issues', async () => value)
    await act(async () => held.resolve(value)); await settled()
    assert.equal(selected.readyState, 1, 'discovering the home must not close the selected workspace channel')
    assert.deepEqual(tickets, ownedHome === team ? [team] : [team, home])
    assert.equal(count('issues'), before + Number(ownedHome !== team), 'only a newly discovered distinct home needs its initial catch-up')
    assert.ok(view('issues')?.includes('owner:issues'))
  } finally { held.resolve(value) }
})

test('an unresolved issue home retains disconnected fallback even when its selected workspace channel is healthy', async () => {
  replies.set('issues', async () => snapshot('issues', 'owner', null))
  await render(['issues']); await settled()
  assert.deepEqual(tickets, [team], 'an unresolved home must never guess another ticket scope')
  assert.equal(sockets[0].readyState, 1)
  assert.equal(liveKeyConnection(cache, unstableSerialize(['issues', 'owner', team])), false, 'selected-workspace coverage alone cannot suppress the unresolved owner-wide fallback')
  assert.ok(view('issues')?.includes('owner:issues'))
})

test('real thread hooks require a current presence acknowledgement, update its proof and unregister on exit', async () => {
  let presence: PresenceProof = { token: `initial.${'a'.repeat(64)}`, expiresAt: Date.now() + 300_000 }
  replies.set('threads', async () => { const value = snapshot('threads'); return { ...value, presenceFallback: true, live: { ...value.live, presence } } })
  await render(['threads', 'bots']); await settled()
  const key = unstableSerialize(['threads', 'owner']), socket = sockets.find(value => value.url.endsWith(home))!
  assert.equal(liveKeyConnection(cache, key), false)
  const before = { reads: count('threads'), tickets: tickets.length, sockets: sockets.length }
  await act(async () => socket.message({ type: 'presence_ready', version: 1 }))
  assert.equal(socket.sent.length, 1)
  assert.equal(liveKeyConnection(cache, key), false, 'support does not acknowledge this subscription')
  const previous = socket.sent[0].id
  await act(async () => socket.message({ type: 'presence_ack', id: previous, expiresAt: presence.expiresAt }))
  assert.equal(liveKeyConnection(cache, key), true)
  presence = { token: `updated.${'b'.repeat(64)}`, expiresAt: Date.now() + 300_000 }
  await act(async () => { await refresh.threads!() })
  assert.deepEqual(socket.sent.map(value => value.type), ['presence_watch', 'presence_unwatch', 'presence_watch'])
  assert.equal(liveKeyConnection(cache, key), false)
  await act(async () => socket.message({ type: 'presence_ack', id: previous, expiresAt: presence.expiresAt }))
  assert.equal(liveKeyConnection(cache, key), false, 'the prior proof cannot acknowledge the current read')
  await act(async () => socket.message({ type: 'presence_ack', id: socket.sent.at(-1)!.id, expiresAt: presence.expiresAt }))
  assert.equal(liveKeyConnection(cache, key), true)
  assert.equal(count('threads'), before.reads + 1, 'only the explicit read ran; watch control does not read')
  assert.equal(tickets.length, before.tickets); assert.equal(sockets.length, before.sockets)
  await render(['bots']); await wait()
  assert.equal(socket.sent.at(-1)!.type, 'presence_unwatch')
  assert.equal(socket.readyState, 1, 'the other list still owns this home socket')
})

test('an older server presence fallback flag remains uncovered on a healthy new live transport', async () => {
  replies.set('threads', async () => ({ ...snapshot('threads'), presenceFallback: true }))
  await render(['threads']); await settled()
  const socket = sockets.find(value => value.url.endsWith(home))!, key = unstableSerialize(['threads', 'owner'])
  await act(async () => socket.message({ type: 'presence_ready', version: 1 }))
  assert.equal(liveKeyConnection(cache, key), false)
  assert.deepEqual(socket.sent, [])
})

test('three acknowledged presence tabs still share one authorized read for the same device-state push', { timeout: 10_000 }, async () => {
  const scoped = [0, 1, 2].map(() => new PersistentReadCache({ userId: 'owner', workspaceId: team, build: 'presence-fixture', role: 'member' }))
  await Promise.all(scoped.map(value => value.hydrate(async () => undefined)))
  const presence = { token: `shared.${'c'.repeat(64)}`, expiresAt: Date.now() + 300_000 }
  replies.set('threads', async () => { const value = snapshot('threads'); return { ...value, presenceFallback: true, live: { ...value.live, presence } } })
  await act(async () => root.render(<>{scoped.map((provider, index) => <SWRConfig key={index} value={{ provider: () => provider, dedupingInterval: 0 }}>
    <LiveProvider ownerId="owner" workspaceId={team}><Threads owner="owner" /></LiveProvider>
  </SWRConfig>)}</>))
  await settled(); await wait(2_100)
  await act(async () => {
    for (const socket of sockets) {
      socket.message({ type: 'presence_ready', version: 1 })
      socket.message({ type: 'presence_ack', id: socket.sent.at(-1)!.id, expiresAt: presence.expiresAt })
    }
  })
  const before = count('threads'), key = unstableSerialize(['threads', 'owner'])
  assert.ok(scoped.every(provider => liveKeyConnection(provider, key) === true))
  await act(async () => emit(home, 'thread_list')); await settled()
  assert.equal(count('threads'), before + 1)
  assert.ok(scoped.every(provider => liveKeyConnection(provider, key) === true))
  assert.ok(sockets.every(socket => socket.sent.length === 1), 'the shared unchanged proof does not re-register')
})

for (const kind of ['issues', 'threads'] as const) test(`a restored ${kind} snapshot sends its existing row proofs and removes rows absent from the authorized delta`, async () => {
  const kept = '30000000-0000-4000-8000-000000000001', removed = '30000000-0000-4000-8000-000000000002'
  const positions = [{ id: kept, version: 'a'.repeat(32) }, { id: removed, version: 'b'.repeat(32) }]
  const previous = { ...snapshot(kind), version: 'c'.repeat(32), positions, items: [{ id: kept, title: 'cached row' }, { id: removed, title: 'deleted row' }] }
  const key = kind === 'issues' ? ['issues', 'owner', team] : ['threads', 'owner']
  cache.set(unstableSerialize(key), { data: previous })
  replies.set(kind, async () => ({ ...snapshot(kind), version: 'd'.repeat(32), delta: true, positions: [positions[0]], items: [] }))
  await render([kind]); await settled()
  assert.deepEqual(cursors[0], { kind, known: previous.version, positions })
  assert.ok(view(kind)?.includes('cached row'))
  assert.ok(!view(kind)?.includes('deleted row'))
  const restored = cache.get(unstableSerialize(key))?.data as Read | undefined
  assert.ok(restored)
  assert.deepEqual(restored.positions, [positions[0]])
})

for (const proof of ['partial', 'missing'] as const) test(`a restored list with ${proof} proofs cannot receive unchanged while rows are missing`, async () => {
  const kept = '30000000-0000-4000-8000-000000000001', missing = '30000000-0000-4000-8000-000000000002'
  const positions = [{ id: kept, version: 'a'.repeat(32) }, { id: missing, version: 'b'.repeat(32) }]
  const previous = { ...snapshot('issues'), version: 'c'.repeat(32), ...(proof === 'partial' ? { positions } : {}), items: [{ id: kept, title: 'held row' }] }
  cache.set(unstableSerialize(['issues', 'owner', team]), { data: previous })
  replies.set('issues', async () => ({ ...snapshot('issues'), version: 'c'.repeat(32), positions, ...(proof === 'partial' ? { delta: true as const } : {}),
    items: [...(proof === 'partial' ? [] : previous.items), { id: missing, title: 'recovered missing row' }] }))
  await render(['issues']); await settled()
  assert.equal(cursors[0].known, undefined)
  assert.deepEqual(cursors[0].positions, proof === 'partial' ? [positions[0]] : undefined)
  assert.ok(view('issues')?.includes('held row'))
  assert.ok(view('issues')?.includes('recovered missing row'))
})

test('an explicit revoked access response hides a previously visible cached issue list', async () => {
  await render(['issues']); await settled()
  assert.ok(view('issues')?.includes('owner:issues'))
  scopeError = 'workspaceAccessDenied'
  await act(async () => { await refresh.issues!().catch(() => undefined) })
  assert.equal(view('issues'), 'unavailable')
  const deniedReads = cursors.length
  await act(async () => { emit(home, 'issue_list'); emit(team, 'issue_list') }); await wait(350)
  assert.equal(cursors.length, deniedReads, 'terminal access failure retires live invalidation and its disconnected fallback')
})

test('real list hooks update held revisions after an asynchronous read without losing scoped focus coverage', { timeout: 10_000 }, async () => {
  let revision = 5
  for (const kind of ['issues', 'threads'] as const) replies.set(kind, async () => {
    const value = snapshot(kind), liveKind = kind === 'issues' ? 'issue_list' : 'thread_list'
    return { ...value, live: { ...value.live, revisions: {
      [`${liveKind}:${home}`]: revision, ...(kind === 'issues' ? { [`${liveKind}:${team}`]: revision } : {}),
    } } }
  })
  await render(['issues', 'threads']); await settled(); await wait(2_100)
  for (const socket of sockets) socket.message({ type: 'live_ready', version: 2, kinds: LIVE_KINDS, revisions: ['issue_list', 'thread_list'] })
  const issueKey = unstableSerialize(['issues', 'owner', team]), threadKey = unstableSerialize(['threads', 'owner'])
  assert.equal(liveKeyConnection(cache, issueKey), true)
  assert.equal(liveKeyConnection(cache, threadKey), true)
  assert.equal(liveKeyConnection(new Map(), issueKey), undefined, 'another provider cannot borrow this live connection')
  const before = { issues: count('issues'), threads: count('threads'), tickets: tickets.length, sockets: sockets.length }
  const push = () => {
    for (const socket of sockets) {
      const scope = socket.url.endsWith(home) ? home : team
      socket.message({ kind: 'issue_list', id: scope, rev: revision })
      if (scope === home) socket.message({ kind: 'thread_list', id: home, rev: revision })
    }
  }
  await act(async () => push()); await wait(200)
  assert.equal(count('issues'), before.issues)
  assert.equal(count('threads'), before.threads)
  revision = 6
  await act(async () => push()); await settled()
  assert.equal(count('issues'), before.issues + 1, 'home and selected-workspace pushes share one incremental read')
  assert.equal(count('threads'), before.threads + 1)
  await act(async () => push()); await wait(2_100)
  assert.equal(count('issues'), before.issues + 1, 'the completed read updates the existing subscription before its echo')
  assert.equal(count('threads'), before.threads + 1)
  assert.equal(tickets.length, before.tickets)
  assert.equal(sockets.length, before.sockets)
  assert.equal(liveKeyConnection(cache, issueKey), true)
})

test('real shared live hooks reject an older in-flight snapshot and still coalesce matching pushes', { timeout: 15_000 }, async () => {
  const scoped = [0, 1, 2].map(() => new PersistentReadCache({ userId: 'owner', workspaceId: team, build: 'fixture', role: 'member' }))
  await Promise.all(scoped.map(value => value.hydrate(async () => undefined)))
  const snapshotAt = (revision: number): Read => {
    const value = snapshot('bots')
    return { ...value, items: [{ id: 'bots', title: `revision-${revision}` }], live: { ...value.live, revisions: { [`bot_chat_list:${home}`]: revision } } }
  }
  replies.set('bots', async () => snapshotAt(5))
  await act(async () => root.render(<>{scoped.map((provider, index) => <SWRConfig key={index} value={{ provider: () => provider, dedupingInterval: 0 }}>
    <LiveProvider ownerId="owner" workspaceId={team}><div data-tab={index}><Bots owner="owner" /></div></LiveProvider>
  </SWRConfig>)}</>))
  await settled(); await wait(2_100)
  assert.equal(sockets.length, 3)
  for (const socket of sockets) socket.message({ type: 'live_ready', version: 2, kinds: LIVE_KINDS, revisions: ['bot_chat_list'] })
  const held = deferred<Read>()
  const before = count('bots')
  replies.set('bots', () => held.promise)
  try {
    await act(async () => sockets[0].message({ kind: 'bot_chat_list', id: home })); await wait()
    assert.equal(count('bots'), before + 1, 'the first tab is reading a snapshot captured before revision 6')
    replies.set('bots', async () => snapshotAt(6))
    await act(async () => { for (const socket of sockets) socket.message({ kind: 'bot_chat_list', id: home, rev: 6 }) }); await wait()
    assert.equal(count('bots'), before + 1, 'the other tabs join the outstanding claim')
    await act(async () => held.resolve(snapshotAt(5))); await settled(); await wait(2_100)
    for (const index of [0, 1, 2]) assert.ok(container.querySelector(`[data-tab="${index}"]`)?.textContent?.includes('revision-6'), 'the newer push must reach every tab without another push or reconnect')
    assert.equal(count('bots'), before + 2, 'old read + one fresh read, including the paced leader trailing read')

    await wait(2_100)
    replies.set('bots', async () => snapshotAt(7))
    const fresh = count('bots')
    await act(async () => { for (const socket of sockets) socket.message({ kind: 'bot_chat_list', id: home, rev: 7 }) }); await settled()
    assert.equal(count('bots'), fresh + 1, 'matching pushes still coalesce across real providers')
    for (const index of [0, 1, 2]) assert.ok(container.querySelector(`[data-tab="${index}"]`)?.textContent?.includes('revision-7'))
  } finally { held.resolve(snapshotAt(5)) }
})

test('healthy real list hooks stay quiet beyond the old sixty-second interval, and an owner-home event refreshes only its list', { timeout: 80_000 }, async () => {
  await render(['threads', 'tasks', 'bots']); await settled()
  assert.deepEqual(new Set(tickets), new Set([home]), 'the selected team is not the owner-wide transport')
  const before = [...reads]; await wait(61_100); assert.deepEqual(reads, before)
  replies.set('tasks', async () => ({ ...snapshot('tasks'), items: [{ id: 'tasks', title: 'committed task result' }] }))
  await act(async () => emit(team, 'task_run_list')); await wait(); assert.deepEqual(reads, before)
  await act(async () => emit(home, 'task_run_list')); await wait(350)
  assert.equal(count('tasks'), before.filter(value => value === 'tasks').length + 1)
  assert.equal(count('threads'), before.filter(value => value === 'threads').length)
  assert.equal(count('bots'), before.filter(value => value === 'bots').length)
  assert.ok(view('tasks')?.includes('committed task result'))
})

for (const kind of ['tasks', 'bots'] as const) test(`a late ${kind} response after the cookie changes cannot populate the old owner's real SWR cache`, async () => {
  await render([kind]); await settled()
  assert.ok(view(kind)?.includes(`owner:${kind}`))
  const held = deferred<Read>(); replies.set(kind, () => held.promise)
  let pending!: Promise<unknown>
  await act(async () => { pending = refresh[kind]!().catch(() => undefined) })
  try {
    await act(async () => { held.resolve(snapshot(kind, 'foreign-owner', otherHome)); await pending })
    assert.equal(view(kind), 'unavailable')
    const key = unstableSerialize([kind === 'tasks' ? 'task-runs' : 'bot-chats', 'owner'])
    assert.ok(!JSON.stringify(cache.get(key)).includes('foreign-owner'), 'foreign items never enter the prior owner key')
    assert.ok(!tickets.includes(otherHome), 'the foreign response cannot select a new transport')
  } finally { held.resolve(snapshot(kind)); await pending }
})

test('a late issue response cannot replace the selected workspace, and an unresolved read has no adopted SSR rows', async () => {
  const held = deferred<Read>(); replies.set('issues', () => held.promise)
  await render(['issues']); await wait()
  assert.equal(view('issues'), 'loading')
  const next = { ...snapshot('issues'), items: [{ id: 'other', title: 'new workspace issue' }], live: { ...snapshot('issues').live, selectedWorkspaceId: otherTeam } }
  replies.set('issues', async () => next)
  await render(['issues'], otherTeam); await settled()
  assert.ok(view('issues')?.includes('new workspace issue'))
  await act(async () => held.resolve(snapshot('issues'))); await settled()
  assert.ok(view('issues')?.includes('new workspace issue'))
  assert.ok(!view('issues')?.includes('owner:issues'))
})

test('a server-selected replacement workspace is refused under the former issue-list key', async () => {
  replies.set('issues', async () => ({ ...snapshot('issues'), live: { ...snapshot('issues').live, selectedWorkspaceId: otherTeam } }))
  await render(['issues']); await settled()
  assert.equal(view('issues'), 'unavailable')
  assert.ok(!JSON.stringify(cache.get(unstableSerialize(['issues', 'owner', team]))).includes('owner:issues'))
})

test('group list GET results are bound to both the authenticated owner and the requested workspace before caching', async () => {
  await render(['groups']); await settled()
  const held = deferred<Read>(); replies.set('groups', () => held.promise)
  let pending!: Promise<unknown>
  await act(async () => { pending = refresh.groups!().catch(() => undefined) })
  await act(async () => { held.resolve(snapshot('groups', 'foreign-owner', otherHome)); await pending })
  assert.equal(view('groups'), 'unavailable')
  assert.ok(!JSON.stringify(cache.get(unstableSerialize(['bot-list-groups', 'owner', team]))).includes('foreign-owner'))
})

for (const moved of ['owner', 'workspace'] as const) test(`a delayed Bot roster cannot populate another ${moved}'s list key`, async () => {
  await render(['roster']); await settled()
  const held = deferred<Read>(); replies.set('roster', () => held.promise)
  let pending!: Promise<unknown>
  await act(async () => { pending = refresh.roster!().catch(() => undefined) })
  const reply = moved === 'owner' ? snapshot('roster', 'foreign-owner', team) : snapshot('roster', 'owner', otherTeam)
  reply.items = [{ id: 'other', title: 'wrong roster' }]
  await act(async () => { held.resolve(reply); await pending })
  assert.equal(view('roster'), 'unavailable')
  assert.ok(!JSON.stringify(cache.get(unstableSerialize(['bots', 'owner', team]))).includes('wrong roster'))
})

test('leaving Settings catches up a roster event that arrived while its read was paused', async () => {
  function PausedRoster({ paused }: { paused: boolean }) { return <Items kind="roster" value={hooks.useLiveBotRoster('owner', team, paused)} /> }
  const renderPaused = async (paused: boolean) => {
    await act(async () => root.render(<SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
      <LiveProvider ownerId="owner" workspaceId={team}><PausedRoster paused={paused} /></LiveProvider>
    </SWRConfig>))
  }
  await renderPaused(false); await settled()
  const before = count('roster')
  await renderPaused(true)
  replies.set('roster', async () => ({ ...snapshot('roster'), items: [{ id: 'roster', title: 'created in Settings' }] }))
  await act(async () => emit(team, 'bot_list')); await wait(2_100)
  assert.equal(count('roster'), before)
  await renderPaused(false); await settled()
  assert.equal(count('roster'), before + 1)
  assert.ok(view('roster')?.includes('created in Settings'))
})

test('hidden list views retain a dirty event and catch up once when visible', { timeout: 10_000 }, async () => {
  await render(['tasks']); await settled(); await wait(2_100)
  const before = count('tasks')
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new browser.Event('visibilitychange') as unknown as Event)
    emit(home, 'task_run_list')
  })
  await wait(300); assert.equal(count('tasks'), before)
  replies.set('tasks', async () => ({ ...snapshot('tasks'), items: [{ id: 'tasks', title: 'while hidden' }] }))
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new browser.Event('visibilitychange') as unknown as Event)
  })
  await wait(350)
  assert.equal(count('tasks'), before + 1)
  assert.ok(view('tasks')?.includes('while hidden'))
})

test('without an active owned home, the owner-wide list never guesses the Provider workspace', async () => {
  replies.set('tasks', async () => snapshot('tasks', 'owner', null))
  await render(['tasks']); await settled()
  assert.ok(view('tasks')?.includes('owner:tasks'))
  assert.deepEqual(tickets, [])
  assert.equal(sockets.length, 0)
})

test('a server-derived chat lease expiry performs one read without recreating the transport', { timeout: 8_000 }, async () => {
  const expiresAt = Date.now() + 1_500
  replies.set('bots', async () => {
    const remaining = expiresAt - Date.now(), value = snapshot('bots')
    return { ...value, items: [{ id: 'bots', title: remaining > 0 ? 'working' : 'idle' }], live: { ...value.live, ...(remaining > 0 ? { deadline: { at: new Date(expiresAt).toISOString(), afterMs: remaining } } : {}) } }
  })
  await render(['bots']); await settled()
  assert.ok(view('bots')?.includes('working'))
  const before = { reads: count('bots'), tickets: tickets.length, sockets: sockets.length }
  await wait(1_650)
  assert.ok(view('bots')?.includes('idle'))
  assert.deepEqual({ reads: count('bots'), tickets: tickets.length, sockets: sockets.length }, { ...before, reads: before.reads + 1 })
  await wait(300); assert.equal(count('bots'), before.reads + 1)
})

test('a completed-list age boundary repaints once without a data read, and a hidden boundary catches up on visibility', async () => {
  let renders = 0
  let deadlines = [Date.now() + 500]
  function AgeFilter() {
    useListExpiry(deadlines); renders++
    return <output data-kind="age">{Date.now() <= deadlines[0] ? 'visible' : 'expired'}</output>
  }
  await act(async () => root.render(<AgeFilter />))
  assert.equal(container.textContent, 'visible')
  await wait(650); assert.equal(container.textContent, 'expired')
  const afterExpiry = renders
  await wait(200); assert.equal(renders, afterExpiry)
  assert.deepEqual(reads, [])
  deadlines = [Date.now() + 350]
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new browser.Event('visibilitychange') as unknown as Event)
    root.render(<AgeFilter />)
  })
  const hiddenRenders = renders
  await wait(500); assert.equal(renders, hiddenRenders)
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new browser.Event('visibilitychange') as unknown as Event)
  })
  assert.equal(container.textContent, 'expired')
  assert.deepEqual(reads, [])
})

test('a bot-list push re-reads the bot list only, never a mounted whole Coordinator chat', { timeout: 20_000 }, async () => {
  const { default: useSWR } = await import('swr')
  let chatReads = 0
  // A screen that still keeps the Coordinator's whole chat under its shared key (as the bot list once did).
  const Chat = () => { useSWR('coordinator-chat', async () => { chatReads++; return { items: [] } }, { revalidateOnFocus: false }); return null }
  await act(async () => root.render(<SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
    <LiveProvider ownerId="owner" workspaceId={team}><Bots owner="owner" /><Chat /></LiveProvider>
  </SWRConfig>))
  await settled()
  const bots = count('bots'), chats = chatReads
  await act(async () => emit(home, 'bot_chat_list')); await wait(2_300)
  assert.equal(count('bots'), bots + 1, 'the list itself re-reads')
  assert.equal(chatReads, chats, 'a list push is not a reason to read 200 chat messages again (#1414)')
})


/** Direct snapshot readers use the real Native queue, JSON codec and fetch
 * boundary. Only authenticated HTTP responses and socket events are fixtures.
 * MessageChannel is the runtime implementation, not a timer/mock scheduler. */
for (const { kind, action, liveKind } of [
  { kind: 'tasks', action: 'task-runs.pollTaskRuns', liveKind: 'task_run_list' },
  { kind: 'bots', action: 'coordinator.pollBotChatSummaries', liveKind: 'bot_chat_list' },
  { kind: 'roster', action: 'bots.pollBots', liveKind: 'bot_list' },
] as const) for (const grouped of [false, true]) for (const beforeReady of [false, true]) {
  test(`native dispatch proof: ${kind} ${grouped ? 'batch' : 'single'} HTTP ${beforeReady ? 'before' : 'after'} readiness`, async t => {
    const { callAction } = await import('../apps/desktop/src/renderer/rpc')
    const { resetReadBatchScope } = await import('../apps/desktop/src/renderer/read-batch')
    const { encode, decode } = await import('../lib/desktop-rpc/wire')
    const phases: string[] = []
    const dispatched = deferred<void>()
    let listCalls = 0, physicalCalls = 0, revision = 5
    const originalMessage = FakeSocket.prototype.message
    FakeSocket.prototype.message = function (value: unknown) {
      originalMessage.call(this, value)
      if ((value as { type?: unknown })?.type === 'live_ready') phases.push('live_ready')
    }
    automaticOpen = !beforeReady
    resetReadBatchScope()
    replies.set(kind, () => {
      phases.push('list_fetcher')
      const pending = callAction<Read>(action, [])
      phases.push('native_enqueued')
      return pending
    })
    const ticketFetch = globalThis.fetch
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input), 'https://mikka.example')
      if (url.pathname.endsWith('/api/live/ticket')) return ticketFetch(input, options)
      assert.ok(url.pathname.endsWith('/api/desktop/rpc'))
      assert.equal(options?.method, 'POST')
      assert.equal(options?.cache, 'no-store')
      const envelope = JSON.parse(String(options?.body)) as { version: number; action: string; args: unknown }
      assert.equal(envelope.version, 1)
      const args = decode(envelope.args) as unknown[]
      const batch = envelope.action === 'desktop.readBatch'
      const calls = batch ? args[0] as { action: string; args: unknown[] }[] : [{ action: envelope.action, args }]
      assert.ok(calls.length >= 1 && calls.length <= 2)
      phases.push('fetch_dispatch')
      physicalCalls++
      const results = calls.map(call => {
        assert.deepEqual(call.args, [])
        if (call.action === action) {
          listCalls++
          const result = snapshot(kind, 'owner', home)
          result.live.revisions = { [`${liveKind}:${home}`]: revision }
          return { ok: true as const, result }
        }
        assert.equal(call.action, 'projects.listProjects')
        return { ok: true as const, result: [] }
      })
      dispatched.resolve()
      return Response.json({ version: 1, ok: true, result: encode(batch ? results : results[0].result) })
    }
    function HomeAnchor() {
      useLiveKeys([{ kind: 'bot_list', id: home, workspaceId: home }], ['native-dispatch-anchor'])
      return null
    }
    function Projects() {
      useSWR('native-dispatch-projects', () => callAction('projects.listProjects', []), { revalidateOnFocus: false, revalidateOnReconnect: false })
      return null
    }
    try {
      await act(async () => root.render(<SWRConfig value={{ provider: () => cache, use: [staleOnFocus], dedupingInterval: 0, shouldRetryOnError: false }}>
        <LiveProvider ownerId="owner" workspaceId={home}>
          <HomeAnchor />
          {kind === 'tasks' && <Tasks owner="owner" />}
          {kind === 'bots' && <Bots owner="owner" />}
          {kind === 'roster' && <Roster owner="owner" workspace={home} />}
          {grouped && <Projects />}
        </LiveProvider>
      </SWRConfig>))
      await dispatched.promise
      if (beforeReady) {
        revision = 6
        await act(async () => { sockets.find(socket => socket.url.endsWith(home))!.open() })
      }
      await settled()
      const firstSend = phases.indexOf('fetch_dispatch'), ready = phases.indexOf('live_ready')
      assert.ok(firstSend >= 0 && ready >= 0)
      assert.ok(phases.indexOf('native_enqueued') < firstSend)
      assert.equal(firstSend < ready, beforeReady, 'the actual RPC fetch boundary establishes the tested order')
      assert.equal(JSON.parse(view(kind)!).live.revisions[`${liveKind}:${home}`], beforeReady ? 6 : 5)
      t.diagnostic(JSON.stringify({ kind: 'native_dispatch_order', action, grouped, beforeReady, phases, listCalls, physicalCalls }))
      assert.equal(listCalls, beforeReady ? 2 : 1, 'only a read actually dispatched after coverage may satisfy the late subscription')
      assert.equal(physicalCalls, beforeReady ? 2 : 1)
    } finally {
      FakeSocket.prototype.message = originalMessage
      resetReadBatchScope()
    }
  })
}


/** Startup composes the production persistent provider, hydration middleware,
 * owner list hooks and Native MessageChannel queue. Only storage/HTTP/socket
 * boundaries are controlled; no timer or live scheduling code is replaced. */
for (const scenario of [
  'provider-unresolved', 'provider-hint', 'warm-committed',
  'warm-pending-after-ready', 'warm-pending-before-ready', 'warm-new-home',
] as const) test('native hydration order: ' + scenario, { timeout: 8_000 }, async t => {
  const { HydrateReadCache } = await import('../components/authenticated-read-cache')
  const { callAction } = await import('../apps/desktop/src/renderer/rpc')
  const { resetReadBatchScope } = await import('../apps/desktop/src/renderer/read-batch')
  const { encode, decode } = await import('../lib/desktop-rpc/wire')
  const { setLiveTelemetrySink } = await import('../lib/live/telemetry')
  const phases: { event: string; at: number; kind?: string; call?: number }[] = []
  const record = (event: string, kind?: string, call?: number) => phases.push({ event, at: performance.now(), ...(kind ? { kind } : {}), ...(call ? { call } : {}) })
  const warm = scenario.startsWith('warm-')
  const pending = scenario.includes('pending')
  const beforeReady = scenario === 'warm-pending-before-ready'
  const changedHome = scenario === 'warm-new-home'
  const activation = deferred<StoredRead[]>(), response = deferred<void>(), dispatched = deferred<void>()
  const rawKey = ['bot-chats', 'owner'], key = unstableSerialize(rawKey)
  const warmRead = snapshot('bots', 'owner', home)
  warmRead.live.revisions = { ['bot_chat_list:' + home]: 4 }
  const storage: ReadStorage = {
    async activate() { record('storage_activate'); return activation.promise },
    async write() {},
    async remove() {},
    async clear() {},
  }
  class ObservedCache extends PersistentReadCache {
    override set(id: string, state: State & { _k?: unknown }) {
      const oldData = this.get(id)?.data
      const result = super.set(id, state)
      if (state.data !== undefined && state.data !== oldData) {
        record(this.isHydrated ? 'commit' : 'restore', id === key ? 'bots' : 'other')
      }
      return result
    }
    override resumeHydrationReads() { record('hydration_resume'); return super.resumeHydrationReads() }
  }
  const persistent = new ObservedCache({ userId: 'owner', workspaceId: team, role: 'admin', build: 'fixture-native-startup' }, storage)
  cache = persistent
  let listCalls = 0, rosterCalls = 0, physicalCalls = 0
  const originalOpen = FakeSocket.prototype.open, originalMessage = FakeSocket.prototype.message
  FakeSocket.prototype.open = function () { if (!this.readyState) record('socket_open', this.url.endsWith(home) ? 'home' : 'other'); return originalOpen.call(this) }
  FakeSocket.prototype.message = function (value: unknown) {
    originalMessage.call(this, value)
    if ((value as { type?: unknown })?.type === 'live_ready') record('ready', this.url.endsWith(home) ? 'home' : 'other')
  }
  setLiveTelemetrySink((event, properties) => { if (event === 'mikka_live_read') record('flush', String(properties.read_key)) })
  automaticOpen = !warm
  resetReadBatchScope()
  const openHome = () => sockets.find(socket => socket.url.endsWith(home))?.open()
  replies.set('bots', () => {
    record('fetcher', 'bots')
    const result = callAction<Read>('coordinator.pollBotChatSummaries', [])
    record('enqueue', 'bots')
    if (warm && !beforeReady) queueMicrotask(openHome)
    return result
  })
  replies.set('roster', () => {
    record('fetcher', 'roster')
    const result = callAction<Read>('bots.pollBots', [])
    record('enqueue', 'roster')
    if (warm && !beforeReady) queueMicrotask(openHome)
    return result
  })
  const ticketFetch = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input), 'https://mikka.example')
    if (url.pathname.endsWith('/api/live/ticket')) return ticketFetch(input, options)
    assert.ok(url.pathname.endsWith('/api/desktop/rpc'))
    assert.equal(options?.method, 'POST')
    assert.equal(options?.cache, 'no-store')
    const envelope = JSON.parse(String(options?.body))
    assert.equal(envelope.version, 1)
    const args = decode(envelope.args) as unknown[]
    const batch = envelope.action === 'desktop.readBatch'
    const calls = batch ? args[0] as { action: string; args: unknown[] }[] : [{ action: envelope.action, args }]
    const physicalCall = ++physicalCalls
    record('dispatch', undefined, physicalCall)
    const first = physicalCall === 1
    const results = calls.map(call => {
      assert.deepEqual(call.args, [])
      if (call.action === 'coordinator.pollBotChatSummaries') {
        listCalls++
        const nextHome = changedHome ? otherHome : home
        const result = snapshot('bots', 'owner', nextHome)
        result.live.revisions = { ['bot_chat_list:' + nextHome]: listCalls + 4 }
        return { ok: true, result }
      }
      assert.equal(call.action, 'bots.pollBots')
      rosterCalls++
      return { ok: true, result: snapshot('roster', 'owner', home) }
    })
    if (first) {
      dispatched.resolve()
      if (beforeReady) queueMicrotask(openHome)
      if (pending) await response.promise
    }
    record('response', undefined, physicalCall)
    return Response.json({ version: 1, ok: true, result: encode(batch ? results : results[0].result) })
  }
  try {
    await act(async () => root.render(<SWRConfig value={{ provider: () => persistent, use: [staleOnFocus], dedupingInterval: 0, shouldRetryOnError: false }}>
      <HydrateReadCache />
      <LiveProvider ownerId="owner" workspaceId={scenario === 'provider-unresolved' ? undefined : home}>
        <Bots owner="owner" />
        {warm && <Roster owner="owner" workspace={home} />}
      </LiveProvider>
    </SWRConfig>))
    assert.equal(listCalls, 0, 'paused reads cannot dispatch before hydration')
    await act(async () => activation.resolve(warm ? [{ key, rawKey, data: warmRead, savedAt: 1 }] : []))
    await dispatched.promise
    if (pending) {
      await wait()
      if (beforeReady) assert.equal(listCalls, 2, 'the pending older read cannot block the required catch-up')
      record('response_release')
      await act(async () => response.resolve())
    }
    if (changedHome) {
      await wait(10)
      await act(async () => sockets.find(socket => socket.url.endsWith(otherHome))?.open())
    }
    await settled()
    const first = (event: string, kind?: string) => phases.findIndex(phase => phase.event === event && (!kind || phase.kind === kind))
    assert.ok(first('hydration_resume') >= 0)
    assert.ok(first('fetcher', 'bots') >= 0)
    assert.ok(first('enqueue', 'bots') < first('dispatch'))
    if (!warm) {
      assert.ok(first('commit', 'bots') < first('socket_open'))
      assert.equal(listCalls, 2, 'Provider scope alone never guesses the unresolved owner home; its later watch gap still needs a read')
    } else {
      assert.ok(first('restore', 'bots') >= 0)
      assert.ok(first('fetcher') < first('ready'), 'the fetcher enters before the controlled acknowledgement')
      assert.equal(first('dispatch') < first('ready'), beforeReady, 'the real MessageChannel dispatch establishes the controlled order')
      if (pending) assert.ok(first('flush') < first('response_release'), 'the actual live timer flushes while the first response is held')
      if (changedHome) {
        assert.ok(tickets.includes(otherHome), 'the returned authenticated home replaces the disk hint')
        assert.equal(listCalls, 2, 'a genuinely different home starts a new coverage generation')
      } else {
        assert.equal(listCalls, beforeReady ? 2 : 1, 'only an actual dispatch after readiness may satisfy the flush')
        assert.equal(rosterCalls, beforeReady ? 2 : 1)
      }
    }
    assert.equal(persistent.isHydrated, true)
    assert.equal(persistent.isEnabled, true)
  } finally {
    response.resolve()
    activation.resolve([])
    t.diagnostic(JSON.stringify({ kind: 'native_hydration_order', scenario, listCalls, rosterCalls, physicalCalls, phases }))
    FakeSocket.prototype.open = originalOpen
    FakeSocket.prototype.message = originalMessage
    setLiveTelemetrySink(undefined)
    resetReadBatchScope()
    await persistent.flushed()
  }
})


for (const scenario of ['unproven-result', 'repeated-dispatch', 'multiple-captures', 'superseded-read', 'failed-read'] as const) {
  test('pending dispatch observation: ' + scenario, { timeout: 2_000 }, async () => {
    const { observeSWRRead, acceptSWRRead, capturePendingReadDispatch, readBoundary, readFresh } = await import('../lib/swr/read-observer')
    const observationCache = new Map<string, { data?: unknown; error?: unknown }>()
    const held = deferred<object>()
    let notify: (() => void) | undefined
    const original = observeSWRRead(observationCache, 'pending', withDispatch => withDispatch(() => {
      notify = capturePendingReadDispatch()
      if (scenario === 'multiple-captures') assert.equal(capturePendingReadDispatch(), undefined)
      return held.promise
    }))
    void original.then(value => {
      acceptSWRRead(observationCache, 'pending', value)
      observationCache.set('pending', { data: value })
    }, () => undefined)
    assert.equal(capturePendingReadDispatch(), undefined, 'the synchronous token cannot escape into unrelated work')
    const after = readBoundary()
    assert.ok(notify)
    notify()
    let revalidations = 0
    const expected = { fresh: true }
    const catchup = readFresh(observationCache, 'pending', after, async () => { revalidations++; return expected }, () => true, () => true)
    const failure = new CacheReadError('workspaceAccessDenied')
    try {
      await Promise.resolve()
      if (scenario === 'multiple-captures') {
        assert.equal(await catchup, expected)
        assert.equal(revalidations, 1, 'an ambiguous capture never lets the hung original hold up catch-up')
      } else if (scenario === 'repeated-dispatch') {
        assert.equal(revalidations, 0)
        notify()
        assert.equal(await catchup, expected)
        assert.equal(revalidations, 1, 'revoking an already-used pending hint wakes the catch-up without the old response')
      } else if (scenario === 'superseded-read') {
        assert.equal(revalidations, 0)
        const nextValue = { replacement: true }
        const next = observeSWRRead(observationCache, 'pending', () => nextValue)
        void next.then(value => {
          acceptSWRRead(observationCache, 'pending', value)
          observationCache.set('pending', { data: value })
        })
        assert.equal(await catchup, nextValue, 'a newer actual read supersedes the hung pending hint')
        assert.equal(revalidations, 0)
      } else if (scenario === 'failed-read') {
        held.reject(failure)
        await assert.rejects(catchup, error => error === failure)
        assert.equal(revalidations, 0, 'the original failure is not silently retried')
      } else {
        assert.equal(revalidations, 0)
        held.resolve({ unproven: true })
        assert.equal(await catchup, expected)
        assert.equal(revalidations, 1, 'a pending hint alone never becomes completed dispatch proof')
      }
    } finally {
      held.resolve({ released: true })
      await original.catch(() => undefined)
    }
  })
}



/** These two workspace settings readers return complete arrays. Exercise the
 * production SWR middleware, live coverage and Native queue without adding
 * revision fields to their existing unversioned response contract. */
for (const scenario of [
  'committed-after-ready', 'pending-after-ready', 'late-subscription',
  'dispatch-before-ready', 'newer-push', 'workspace-change', 'identity-change',
] as const) test('native workspace snapshot: ' + scenario, { timeout: 8_000 }, async t => {
  const { callAction } = await import('../apps/desktop/src/renderer/rpc')
  const { resetReadBatchScope } = await import('../apps/desktop/src/renderer/read-batch')
  const { snapshotReadFetcher } = await import('../lib/swr/read-observer')
  const { encode, decode } = await import('../lib/desktop-rpc/wire')
  const actions = ['teams.listTeams', 'team-relations.listProjectTeams'] as const
  type Action = typeof actions[number]
  type Rows = { id: string; name: string; observation: number; owner: string }[]
  const counts = new Map<Action, number>(actions.map(action => [action, 0]))
  const phases: string[] = []
  const rejected: { action: Action; code?: string; status?: number }[] = []
  const dispatched = deferred<void>(), firstResponse = deferred<void>()
  const beforeReady = scenario === 'dispatch-before-ready'
  const held = ['pending-after-ready', 'newer-push', 'workspace-change', 'identity-change'].includes(scenario)
  let physicalCalls = 0, enqueued = 0, observation = 1
  let owner = 'owner', workspace = home
  const initialCache = cache
  const originalURL = window.location.href
  const originalMessage = FakeSocket.prototype.message
  FakeSocket.prototype.message = function (value: unknown) {
    originalMessage.call(this, value)
    if ((value as { type?: unknown })?.type === 'live_ready') phases.push('ready:' + this.url)
  }
  automaticOpen = false
  resetReadBatchScope()
  const fetcher = (action: Action) => snapshotReadFetcher(() => {
    phases.push('fetcher:' + action)
    const pending = callAction<Rows>(action, [])
    phases.push('enqueue:' + action)
    // Both real SWR fetchers enter before the capability acknowledgement. The
    // real MessageChannel, not a replaced scheduler, dispatches their batch.
    if (++enqueued % actions.length === 0 && !beforeReady) queueMicrotask(() => {
      sockets.find(socket => socket.url.endsWith(workspace) && socket.readyState === 0)?.open()
    })
    return pending.catch((error: { code?: string; status?: number }) => {
      rejected.push({ action, code: error.code, status: error.status })
      throw error
    })
  })
  const teamsFetcher = fetcher(actions[0]), projectTeamsFetcher = fetcher(actions[1])
  function Anchor({ scope }: { scope: string }) {
    useLiveKeys([{ kind: 'bot_list', id: scope, workspaceId: scope }], ['workspace-array-anchor'])
    return null
  }
  function WorkspaceArrays({ enabled, watch, scope }: { enabled: boolean; watch: boolean; scope: string }) {
    const teams = useSWR<Rows>(enabled ? 'teams' : null, teamsFetcher, { revalidateOnFocus: false, revalidateOnReconnect: false })
    const relations = useSWR<Rows>(enabled ? 'project-teams' : null, projectTeamsFetcher, { revalidateOnFocus: false, revalidateOnReconnect: false })
    useLiveKeys(watch ? [{ kind: 'workspace_settings', id: scope, workspaceId: scope }] : [], watch ? ['teams', 'project-teams'] : [])
    return <><output data-workspace-snapshot="teams">{JSON.stringify(teams.data)}</output><output data-workspace-snapshot="project-teams">{JSON.stringify(relations.data)}</output></>
  }
  const renderArrays = async (enabled: boolean, watch: boolean) => {
    await act(async () => root.render(<SWRConfig key={owner + ':' + workspace} value={{ provider: () => cache, use: [staleOnFocus], dedupingInterval: 0, shouldRetryOnError: false }}>
      <LiveProvider ownerId={owner} workspaceId={workspace}>
        <Anchor scope={workspace} /><WorkspaceArrays enabled={enabled} watch={watch} scope={workspace} />
      </LiveProvider>
    </SWRConfig>))
  }
  const ticketFetch = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input), 'https://mikka.example')
    if (url.pathname.endsWith('/api/live/ticket')) return ticketFetch(input, options)
    assert.ok(url.pathname.endsWith('/api/desktop/rpc'))
    assert.equal(options?.method, 'POST')
    assert.equal(options?.cache, 'no-store')
    const envelope = JSON.parse(String(options?.body))
    assert.equal(envelope.version, 1)
    assert.equal(envelope.action, 'desktop.readBatch')
    const calls = (decode(envelope.args) as [{ action: Action; args: unknown[] }[]])[0]
    assert.deepEqual(calls.map(call => call.action).sort(), [...actions].sort())
    const request = ++physicalCalls
    const requestOwner = owner, requestObservation = observation
    phases.push('dispatch:' + request)
    const results = calls.map(call => {
      assert.deepEqual(call.args, [])
      counts.set(call.action, counts.get(call.action)! + 1)
      return { ok: true, result: [{ id: call.action, name: call.action, observation: requestObservation, owner: requestOwner }] satisfies Rows }
    })
    if (request === 1) {
      dispatched.resolve()
      if (held) await firstResponse.promise
    }
    phases.push('response:' + request)
    return Response.json({ version: 1, ok: true, result: encode(results) })
  }
  const verifyRows = (expectedObservation: number, expectedOwner = owner) => {
    for (const [index, key] of ['teams', 'project-teams'].entries()) {
      const value = cache.get(key)?.data
      assert.ok(Array.isArray(value), 'the existing full-array contract stays intact')
      assert.deepEqual(value, [{ id: actions[index], name: actions[index], observation: expectedObservation, owner: expectedOwner }])
      assert.equal(Object.hasOwn(value, 'live'), false, 'an unversioned workspace settings response gains no invented revision')
      assert.equal(container.querySelector('[data-workspace-snapshot="' + key + '"]')?.textContent, JSON.stringify(value))
    }
  }
  try {
    await renderArrays(false, false)
    assert.equal(sockets.length, 1)
    await renderArrays(true, scenario !== 'late-subscription')
    await dispatched.promise
    if (beforeReady) {
      observation = 2
      await act(async () => sockets[0].open())
    }
    const ready = phases.findIndex(phase => phase.startsWith('ready:'))
    const sent = phases.indexOf('dispatch:1')
    assert.ok(ready >= 0 && sent >= 0)
    assert.equal(sent < ready, beforeReady, 'actual dispatch, not fetcher entry, defines coverage')
    for (const action of actions) assert.ok(phases.indexOf('fetcher:' + action) < ready)
    if (scenario === 'pending-after-ready') {
      await wait()
      assert.equal(physicalCalls, 1, 'the live flush joins both pending post-ready responses')
      await act(async () => firstResponse.resolve())
    } else if (scenario === 'newer-push') {
      observation = 2
      await act(async () => emit(home, 'workspace_settings'))
      await settled()
      assert.equal(physicalCalls, 2, 'a newer unversioned push still needs an authoritative read')
      verifyRows(2)
      await act(async () => firstResponse.resolve())
    } else if (scenario === 'workspace-change' || scenario === 'identity-change') {
      observation = 2
      if (scenario === 'workspace-change') {
        workspace = otherHome
        window.history.replaceState(null, '', '/mikka/en?workspace=' + workspace)
      } else {
        owner = 'next-owner'
        resetReadBatchScope()
      }
      cache = new Map()
      await renderArrays(false, false)
      await renderArrays(true, true)
      await settled()
      verifyRows(2)
      await act(async () => firstResponse.resolve())
      await settled()
      assert.equal(physicalCalls, 2, 'the current scope reads once while the retired result is refused')
      assert.equal(initialCache.get('teams')?.data, undefined)
      assert.equal(initialCache.get('project-teams')?.data, undefined)
      assert.deepEqual(rejected.map(value => [value.action, value.code, value.status]).sort(),
        actions.map(action => [action, 'desktop_session_changed', 409]).sort())
    } else {
      await settled()
      if (scenario === 'late-subscription') {
        verifyRows(1)
        await renderArrays(true, true)
      }
    }
    await settled()
    const expected = beforeReady || scenario === 'newer-push' || scenario === 'workspace-change' || scenario === 'identity-change' ? 2 : 1
    assert.equal(physicalCalls, expected)
    assert.deepEqual([...counts.values()], [expected, expected])
    verifyRows(expected)
  } finally {
    firstResponse.resolve()
    resetReadBatchScope()
    FakeSocket.prototype.message = originalMessage
    window.history.replaceState(null, '', originalURL)
    t.diagnostic(JSON.stringify({ kind: 'native_workspace_snapshot_dispatch', scenario, physicalCalls, counts: Object.fromEntries(counts), phases, rejected }))
  }
})

/** Keep this last: a 404 capability response disables batching for this real
 * document, and resetReadBatchScope deliberately does not restore capability. */
test('native pending dispatch: real 404 capability fallback revokes an already awaited hint', { timeout: 8_000 }, async t => {
  const { HydrateReadCache } = await import('../components/authenticated-read-cache')
  const { callAction } = await import('../apps/desktop/src/renderer/rpc')
  const { resetReadBatchScope } = await import('../apps/desktop/src/renderer/read-batch')
  const { encode, decode } = await import('../lib/desktop-rpc/wire')
  const { setLiveTelemetrySink } = await import('../lib/live/telemetry')
  const activation = deferred<StoredRead[]>(), batchRefusal = deferred<void>(), fallback = deferred<void>(), batchDispatched = deferred<void>()
  const phases: string[] = []
  const rawKey = ['bot-chats', 'owner'], key = unstableSerialize(rawKey)
  const storage: ReadStorage = { async activate() { return activation.promise }, async write() {}, async remove() {}, async clear() {} }
  const persistent = new PersistentReadCache({ userId: 'owner', workspaceId: team, role: 'admin', build: 'fixture-capability-fallback' }, storage)
  cache = persistent
  let physical = 0
  const logical = { bots: 0, roster: 0 }
  const originalMessage = FakeSocket.prototype.message
  FakeSocket.prototype.message = function (value: unknown) {
    originalMessage.call(this, value)
    if ((value as { type?: unknown })?.type === 'live_ready') phases.push('ready')
  }
  setLiveTelemetrySink((event, properties) => { if (event === 'mikka_live_read') phases.push('flush:' + properties.read_key) })
  automaticOpen = false
  resetReadBatchScope()
  for (const kind of ['bots', 'roster'] as const) replies.set(kind, () => {
    const action = kind === 'bots' ? 'coordinator.pollBotChatSummaries' : 'bots.pollBots'
    phases.push('enqueue:' + kind)
    const promise = callAction<Read>(action, [])
    queueMicrotask(() => sockets.find(socket => socket.url.endsWith(home))?.open())
    return promise
  })
  const ticketFetch = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input), 'https://mikka.example')
    if (url.pathname.endsWith('/api/live/ticket')) return ticketFetch(input, options)
    assert.ok(url.pathname.endsWith('/api/desktop/rpc'))
    const envelope = JSON.parse(String(options?.body))
    const id = ++physical
    phases.push('dispatch:' + id + ':' + envelope.action)
    if (id === 1) {
      assert.equal(envelope.action, 'desktop.readBatch')
      const args = decode(envelope.args) as { action: string }[][]
      assert.deepEqual(args[0].map(call => call.action).sort(), ['bots.pollBots', 'coordinator.pollBotChatSummaries'])
      batchDispatched.resolve()
      await batchRefusal.promise
      phases.push('batch_404')
      return Response.json({ version: 1, ok: false, error: { code: 'desktop_rpc_action_unknown' } }, { status: 404 })
    }
    assert.notEqual(envelope.action, 'desktop.readBatch', 'only the explicit capability refusal permits single fallback')
    const kind = envelope.action === 'coordinator.pollBotChatSummaries' ? 'bots' : 'roster'
    assert.ok(['coordinator.pollBotChatSummaries', 'bots.pollBots'].includes(envelope.action))
    const count = ++logical[kind]
    if (count === 1) {
      phases.push('fallback_held:' + kind)
      await fallback.promise
    } else phases.push('catchup:' + kind)
    const value = snapshot(kind, 'owner', home)
    value.items[0].title = count === 1 ? 'late-fallback' : 'fresh-catchup'
    phases.push('response:' + id)
    return Response.json({ version: 1, ok: true, result: encode(value) })
  }
  try {
    await act(async () => root.render(<SWRConfig value={{ provider: () => persistent, use: [staleOnFocus], dedupingInterval: 0, shouldRetryOnError: false }}>
      <HydrateReadCache />
      <LiveProvider ownerId="owner" workspaceId={home}><Bots owner="owner" /><Roster owner="owner" workspace={home} /></LiveProvider>
    </SWRConfig>))
    await act(async () => activation.resolve([{ key, rawKey, data: snapshot('bots'), savedAt: 1 }]))
    await batchDispatched.promise
    await wait()
    assert.ok(phases.indexOf('ready') < phases.findIndex(value => value.startsWith('dispatch:1:')))
    assert.ok(phases.includes('flush:bot-chats') && phases.includes('flush:bots'))
    assert.equal(physical, 1, 'both catch-ups are already waiting on the post-ready pending batch')
    await act(async () => batchRefusal.resolve())
    await settled()
    assert.deepEqual(logical, { bots: 2, roster: 2 }, 'duplicate dispatch notification wakes both catch-ups while fallback responses remain held')
    assert.equal(physical, 5)
    assert.ok(view('bots')?.includes('fresh-catchup'))
    assert.ok(view('roster')?.includes('fresh-catchup'))
    phases.push('release_fallback')
    await act(async () => fallback.resolve())
    await settled()
    assert.equal(physical, 5, 'releasing obsolete fallback responses creates no further request')
    assert.ok(view('bots')?.includes('fresh-catchup'))
    assert.ok(view('roster')?.includes('fresh-catchup'))
  } finally {
    batchRefusal.resolve(); fallback.resolve(); activation.resolve([])
    t.diagnostic(JSON.stringify({ kind: 'native_real_capability_fallback', physical, logical, phases }))
    FakeSocket.prototype.message = originalMessage
    setLiveTelemetrySink(undefined)
    resetReadBatchScope()
    await persistent.flushed()
  }
})
