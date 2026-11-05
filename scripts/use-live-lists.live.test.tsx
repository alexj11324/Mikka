import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { State } from 'swr'
import { Window } from 'happy-dom'
import { LIVE_KINDS } from '../lib/live/events'
import { liveKeyConnection } from '../lib/swr/live-focus'

const home = '10000000-0000-4000-8000-000000000001'
const team = '20000000-0000-4000-8000-000000000001'
const otherTeam = '20000000-0000-4000-8000-000000000002'
const otherHome = '10000000-0000-4000-8000-000000000002'
type Kind = 'issues' | 'threads' | 'tasks' | 'bots' | 'groups' | 'roster'
type Read = { items: { id: string; title: string }[]; live: { ownerId: string; workspaceId: string | null; selectedWorkspaceId?: string; deadline?: { at: string; afterMs: number }; revisions?: Record<string, number> }; version?: string; positions?: { id: string; version: string }[]; delta?: true; presenceFallback?: boolean }
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

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let unstableSerialize: typeof import('swr')['unstable_serialize']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let hooks: typeof import('../hooks/use-live-lists')
let useListExpiry: typeof import('../hooks/use-list-expiry')['useListExpiry']
let root: Root, container: HTMLDivElement, cache: Map<string, State>, tickets: string[]
let refresh: Partial<Record<Kind, () => Promise<unknown>>>
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
  // The channel asks the Worker for revisions; the fixture addresses the socket by its channel path.
  constructor(url: string) {
    assert.equal(new URL(url).searchParams.get('revisions'), '1')
    this.url = url.split('?')[0]
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1; this.onopen?.()
      this.message({ type: 'live_ready', version: 1, kinds: LIVE_KINDS })
    })
  }
  send(value: string) { if (value === 'ping') this.onmessage?.({ data: 'pong' }) }
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
  ;({ SWRConfig, unstable_serialize: unstableSerialize } = await import('swr'))
  ;({ LiveProvider } = await import('../hooks/use-live-key'))
  hooks = await import('../hooks/use-live-lists')
  ;({ useListExpiry } = await import('../hooks/use-list-expiry'))
})
beforeEach(() => {
  reads = []; cursors = []; scopeError = null; tickets = []; sockets.length = 0; refresh = {}; cache = new Map(); replies.clear()
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
const deferred = <T,>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) } }

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
