import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { ComputerState } from '../lib/computer/types'

const botA = '10000000-0000-4000-8000-000000000001'
const botB = '10000000-0000-4000-8000-000000000002'
const selectedWorkspace = '20000000-0000-4000-8000-000000000001'
const actualWorkspace = '20000000-0000-4000-8000-000000000002'
const browser = new Window({ url: 'https://mikka.example/mikka/en' })
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
const originalMock = process.env.NEXT_PUBLIC_COMPUTER_MOCK
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let useComputer: typeof import('../hooks/use-computer')['useComputer']
let root: Root, container: HTMLDivElement
let states: Map<string, ComputerState>, reads: string[], tickets: string[]
let held: { botId: string; promise: Promise<void> } | null
let stateForRead: ((botId: string) => ComputerState) | null
const sockets: FakeSocket[] = []

/** Only the network boundary is replaced. SWR keys, the provider, hook,
 * capability handshake and event scheduling are the production modules. */
class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  readySent = false
  constructor(readonly url: string, readonly protocol: string) {
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== 0) return
      this.readyState = 1
      this.onopen?.()
      this.message({ type: 'live_ready', version: 1, kinds: ['computer_state'] })
      this.readySent = true
    })
  }
  send(value: string) { if (value === 'ping') this.onmessage?.({ data: 'pong' }) }
  close() { this.readyState = 3; this.onclose?.() }
  message(value: unknown) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(value) }) }
}

function Probe({ botId }: { botId: string }) {
  const { data, error } = useComputer(botId)
  return <output data-bot={botId}>{error ? 'error' : data ? `${data.machine}:${data.control}` : 'loading'}</output>
}

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket })
  process.env.NEXT_PUBLIC_COMPUTER_MOCK = '0'
  // Import SWR after installing the browser, so its actual client polling and
  // revalidation lifecycle runs; importing it in server mode would hide a bug.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig } = await import('swr'))
  ;({ LiveProvider } = await import('../hooks/use-live-key'))
  ;({ useComputer } = await import('../hooks/use-computer'))
})

beforeEach(() => {
  reads = []; tickets = []; sockets.length = 0; held = null; stateForRead = null
  states = new Map<string, ComputerState>()
  for (const id of [botA, botB]) states.set(id, { machine: 'running', control: 'agent', live: { workspaceId: actualWorkspace } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  globalThis.fetch = async (input, options) => {
    assert.ok(!options?.method || options.method === 'GET', 'this fixture must never mutate a computer')
    const url = new URL(String(input), 'https://mikka.example')
    if (url.pathname.endsWith('/api/live/ticket')) {
      const workspace = url.searchParams.get('workspace')
      assert.ok(workspace)
      tickets.push(workspace)
      return Response.json({ url: `wss://fixture.invalid/live/${workspace}`, protocol: 'fixture-only', expiresAt: Date.now() + 600_000 })
    }
    const match = url.pathname.match(/\/api\/bots\/([^/]+)\/computer$/)
    assert.ok(match, `unexpected network path ${url.pathname}`)
    const botId = decodeURIComponent(match[1])
    assert.ok(states.has(botId), 'only the two disposable fixture Bots may be read')
    reads.push(botId)
    if (held?.botId === botId) await held.promise
    return Response.json(stateForRead ? stateForRead(botId) : states.get(botId))
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  globalThis.fetch = originalFetch
})
after(async () => {
  Object.assign(globalThis, { WebSocket: originalSocket })
  if (originalMock === undefined) delete process.env.NEXT_PUBLIC_COMPUTER_MOCK
  else process.env.NEXT_PUBLIC_COMPUTER_MOCK = originalMock
  await browser.close()
})

const wait = async (milliseconds = 180) => { await act(async () => { await new Promise(resolve => setTimeout(resolve, milliseconds)) }) }
const readCount = (botId: string) => reads.filter(id => id === botId).length
const view = (botId: string) => container.querySelector(`[data-bot="${botId}"]`)?.textContent
async function render(ids: string[] = [botA]) {
  await act(async () => root.render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <LiveProvider ownerId="fixture-owner" workspaceId={selectedWorkspace}>
        {ids.map(botId => <Probe key={botId} botId={botId} />)}
      </LiveProvider>
    </SWRConfig>,
  ))
}
async function settled() {
  await wait(); await wait()
  assert.equal(sockets.filter(socket => socket.readyState === 1 && socket.readySent).length, 1)
}

test('real SWR stays quiet beyond the former two-second interval after computer capability is ready', { timeout: 10_000 }, async () => {
  await render(); await settled()
  assert.equal(view(botA), 'running:agent')
  assert.ok(readCount(botA) > 0)
  const before = { reads: reads.length, tickets: tickets.length }
  await wait(2_350)
  assert.deepEqual({ reads: reads.length, tickets: tickets.length }, before)
})

test('a real computer key event refreshes only its Bot through the shared SWR cache', { timeout: 10_000 }, async () => {
  await render([botA, botB]); await settled()
  const beforeA = readCount(botA), beforeB = readCount(botB)
  states.set(botA, { machine: 'running', control: 'user', live: { workspaceId: actualWorkspace } })
  states.set(botB, { machine: 'sleeping', control: 'idle', live: { workspaceId: actualWorkspace } })
  await act(async () => sockets[0].message({ kind: 'computer_state', id: botA }))
  await wait(650)
  assert.equal(readCount(botA), beforeA + 1)
  assert.equal(readCount(botB), beforeB)
  assert.equal(view(botA), 'running:user')
  assert.equal(view(botB), 'running:agent', 'an unrelated Bot is not re-read or patched')
})

test('an unresolved state never guesses the Provider workspace; its authorized response chooses the actual channel', { timeout: 10_000 }, async () => {
  let release!: () => void
  held = { botId: botA, promise: new Promise<void>(resolve => { release = resolve }) }
  try {
    await render(); await wait()
    assert.equal(view(botA), 'loading')
    assert.equal(readCount(botA), 1)
    assert.deepEqual(tickets, [], 'no ticket is requested for the unrelated selected workspace')
    assert.equal(sockets.length, 0)
    held = null
    await act(async () => release())
    await settled()
    assert.deepEqual(tickets, [actualWorkspace])
    assert.equal(sockets[0].url, `wss://fixture.invalid/live/${actualWorkspace}`)
    assert.equal(view(botA), 'running:agent')
  } finally { held = null; release() }
})

test('an observed computer expiry reads once without reopening the shared channel or restarting the expired deadline', { timeout: 10_000 }, async () => {
  const expiresAt = new Date(Date.now() + 2_500).toISOString()
  states.set(botA, { machine: 'running', control: 'agent', live: {
    workspaceId: actualWorkspace, deadline: { at: expiresAt, afterMs: 2_500 },
  } })
  await render(); await settled()
  assert.equal(view(botA), 'running:agent')
  const before = { reads: readCount(botA), tickets: tickets.length, sockets: sockets.length }
  // Only the next authorized HTTP response changes machine state. The timer
  // invalidates that read; it cannot manufacture a local sleeping result.
  states.set(botA, { machine: 'sleeping', control: 'idle', live: { workspaceId: actualWorkspace } })
  assert.equal(view(botA), 'running:agent')
  await wait(2_700)
  assert.equal(readCount(botA), before.reads + 1)
  assert.equal(view(botA), 'sleeping:idle')
  assert.equal(tickets.length, before.tickets)
  assert.equal(sockets.length, before.sockets)
  assert.equal(sockets[0].readyState, 1)
  await wait(600)
  assert.equal(readCount(botA), before.reads + 1, 'a consumed deadline never starts a refresh loop')
  assert.equal(tickets.length, before.tickets)
  assert.equal(sockets.length, before.sockets)
})

test('a new authorized observation re-arms an early deadline read for the same future expiry', { timeout: 15_000 }, async () => {
  const expires = Date.now() + 3_400, at = new Date(expires).toISOString()
  const observations: { at?: string; afterMs?: number; machine: string }[] = []
  stateForRead = botId => {
    assert.equal(botId, botA)
    const afterMs = Math.max(0, expires - Date.now())
    const state: ComputerState = afterMs > 0
      ? { machine: 'running', control: 'agent', live: { workspaceId: actualWorkspace, deadline: { at, afterMs } } }
      : { machine: 'sleeping', control: 'idle', live: { workspaceId: actualWorkspace } }
    observations.push({ at: state.live?.deadline?.at, afterMs: state.live?.deadline?.afterMs, machine: state.machine })
    return state
  }
  let release!: () => void
  held = { botId: botA, promise: new Promise<void>(resolve => { release = resolve }) }
  try {
    await render(); await wait(1_000)
    assert.equal(view(botA), 'loading')
    held = null
    await act(async () => release())
    await settled()
    assert.equal(view(botA), 'running:agent')
    const before = { reads: readCount(botA), tickets: tickets.length, sockets: sockets.length }
    // The first request was slow. Its conservative request-start deadline
    // fires early; a faster authorized read still observes the same future
    // server expiry. This is a new observation, not a cached re-render.
    await wait(1_300)
    assert.equal(readCount(botA), before.reads + 1)
    assert.equal(view(botA), 'running:agent')
    assert.equal(observations.at(-1)?.at, at)
    assert.ok((observations.at(-1)?.afterMs ?? 0) > 0)
    await wait(1_200)
    assert.equal(readCount(botA), before.reads + 2, 'a consumed early timer must not suppress the actual expiry read')
    assert.equal(view(botA), 'sleeping:idle')
    assert.equal(tickets.length, before.tickets)
    assert.equal(sockets.length, before.sockets)
    await wait(350)
    assert.equal(readCount(botA), before.reads + 2)
    assert.equal(tickets.length, before.tickets)
    assert.equal(sockets.length, before.sockets)
  } finally { held = null; release() }
})
