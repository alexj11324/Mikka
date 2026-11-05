import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { State } from 'swr'
import { Window } from 'happy-dom'
import { LIVE_KINDS } from '../lib/live/events'

const home = '10000000-0000-4000-8000-000000000001'
const team = '20000000-0000-4000-8000-000000000001'
const otherTeam = '20000000-0000-4000-8000-000000000002'
const otherHome = '10000000-0000-4000-8000-000000000002'
type Kind = 'issues' | 'threads' | 'tasks' | 'bots' | 'groups' | 'roster'
type Read = { items: { id: string; title: string }[]; live: { ownerId: string; workspaceId: string | null; selectedWorkspaceId?: string; deadline?: { at: string; afterMs: number } }; version?: string; presenceFallback?: boolean }
const replies = new Map<Kind, () => Promise<Read>>()
let reads: Kind[]
const read = (kind: Kind) => { reads.push(kind); return replies.get(kind)!() }
mock.module(new URL('../app/actions/issues.ts', import.meta.url).href, { namedExports: { pollIssues: () => read('issues') } })
mock.module(new URL('../app/actions/task-runs.ts', import.meta.url).href, { namedExports: { pollThreads: () => read('threads'), pollTaskRuns: () => read('tasks') } })
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
  reads = []; tickets = []; sockets.length = 0; refresh = {}; cache = new Map(); replies.clear()
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
