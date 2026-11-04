import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { unstable_serialize } from 'swr'
import type { ComputerEvent, ComputerState, ViewerGrant } from '../lib/computer/types'

type Config = { refreshInterval?: number | ((grant?: ViewerGrant) => number); revalidateOnFocus?: boolean; revalidateOnReconnect?: boolean; shouldRetryOnError?: boolean }
let state: ComputerState & { requestedAt?: number } = { machine: 'sleeping', control: 'idle' }
let listener: ((event: ComputerEvent) => void) | undefined
let subscriptions = 0, cleanups = 0
const calls: { key: unknown; fetcher: (...args: unknown[]) => unknown; config: Config }[] = []
const live: unknown[][] = []
const reads: string[] = []
const mutate = async (update?: (current: ComputerState) => ComputerState | undefined) => {
  if (update) state = update(state)!
  return state
}
mock.module('swr', {
  defaultExport: (key: unknown, fetcher: (...args: unknown[]) => unknown, config: Config) => {
    calls.push({ key, fetcher, config }); return { data: state, mutate }
  },
  namedExports: { unstable_serialize },
})
mock.module(new URL('../hooks/use-live-key.tsx', import.meta.url).href, {
  namedExports: { useLiveKey: (...args: unknown[]) => { live.push(args) } },
})
mock.module(new URL('../lib/computer/client.ts', import.meta.url).href, { namedExports: {
  isMockedComputer: (id: string) => id.startsWith('demo-'),
  computerApi: {
    state: async (id: string) => { reads.push(id); return state },
    viewer: async (id: string, mode: string) => ({ url: `wss://fixture.invalid/${id}/${mode}`, expiresAt: new Date(Date.now() + 90_000).toISOString() }),
  },
  subscribeComputerEvents: (receive: (event: ComputerEvent) => void, enabled: boolean) => {
    if (!enabled) return () => {}
    subscriptions++; listener = receive
    return () => { cleanups++; if (listener === receive) listener = undefined }
  },
} })
let useComputer: typeof import('../hooks/use-computer')['useComputer']
let useViewerGrant: typeof import('../hooks/use-computer')['useViewerGrant']
function Probe({ botId }: { botId?: string | null }) { useComputer(botId); return null }
function Viewer({ enabled = true }: { enabled?: boolean }) { useViewerGrant('fixture-bot', 'control', enabled); return null }

const browser = new Window()
let createRoot: typeof import('react-dom/client')['createRoot']
let root: Root, host: HTMLDivElement
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useComputer, useViewerGrant } = await import('../hooks/use-computer'))
})
beforeEach(() => {
  state = { machine: 'sleeping', control: 'idle' }; listener = undefined; subscriptions = 0; cleanups = 0
  calls.length = 0; live.length = 0; reads.length = 0
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
after(async () => { await browser.close(); mock.restoreAll() })

test('real computer uses its serialized SWR key, server deadline, and no periodic polling', async () => {
  const botId = '10000000-0000-4000-8000-000000000001'
  const deadline = { at: '2030-01-01T00:00:00.000Z', afterMs: 5_000 }
  state = { machine: 'running', control: 'agent', requestedAt: performance.now(), live: { workspaceId: '20000000-0000-4000-8000-000000000001', deadline } }
  await act(async () => root.render(<Probe botId={botId} />))
  assert.deepEqual(calls[0].config, { refreshInterval: 0, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false })
  assert.deepEqual(live[0].slice(0, 4), ['computer_state', botId, [unstable_serialize(['computer', botId])], state.live!.workspaceId])
  const options = live[0][4] as { minIntervalMs: number; deadline: { at: string; afterMs: number } }
  assert.equal(options.minIntervalMs, 500)
  assert.equal(options.deadline.at, deadline.at)
  assert.ok(options.deadline.afterMs > 0 && options.deadline.afterMs <= deadline.afterMs)
  assert.equal(subscriptions, 0, 'real computers do not open the unrelated subagent SSE endpoint')
  await calls[0].fetcher(['computer', botId]); assert.deepEqual(reads, [botId])
})

test('a hidden panel with no selected Bot registers neither a key nor a live entity', async () => {
  await act(async () => root.render(<Probe botId={null} />))
  assert.equal(calls[0].key, null)
  assert.equal(live[0][1], null)
  assert.deepEqual(live[0][2], [])
  assert.equal(live[0][3], null, 'no authenticated response means no guessed channel')
  assert.equal(subscriptions, 0)
})

test('only an authenticated state response selects the channel and a changed response changes the scope', async () => {
  const botId = '10000000-0000-4000-8000-000000000001'
  await act(async () => root.render(<Probe botId={botId} />))
  assert.equal(live.at(-1)![3], null, 'legacy or unresolved responses use slow fallback, not the active workspace guess')
  const first = '20000000-0000-4000-8000-000000000001'
  const second = '20000000-0000-4000-8000-000000000002'
  state = { ...state, live: { workspaceId: first } }
  await act(async () => root.render(<Probe botId={botId} />))
  assert.equal(live.at(-1)![3], first)
  state = { ...state, live: { workspaceId: second } }
  await act(async () => root.render(<Probe botId={botId} />))
  assert.equal(live.at(-1)![3], second)
})

test('mock pushes keep their existing patches and release the previous Bot listener', async () => {
  await act(async () => root.render(<Probe botId="demo-a" />))
  assert.equal(calls[0].config.refreshInterval, 0)
  assert.equal(live[0][1], null)
  assert.equal(subscriptions, 1)
  listener!({ type: 'computer.machine', state: 'running' })
  listener!({ type: 'computer.control', botId: 'demo-other', control: 'user', controlledBy: { userId: 'other' } })
  assert.equal(state.control, 'idle')
  listener!({ type: 'computer.control', botId: 'demo-a', control: 'user', controlledBy: { userId: 'owner' } })
  listener!({ type: 'computer.action', botId: 'demo-a', lastAction: { tool: 'click', x: 5, y: 9, at: '2030-01-01T00:00:00.000Z' } })
  assert.equal(state.machine, 'running'); assert.equal(state.control, 'user'); assert.equal(state.lastAction?.x, 5)
  listener!({ type: 'computer.approval', botId: 'demo-a', approval: null })
  assert.equal(state.pendingApproval, undefined)
  await act(async () => root.render(<Probe botId="demo-b" />))
  assert.equal(cleanups, 1); assert.equal(subscriptions, 2)
  await act(async () => root.render(<Probe botId={null} />))
  assert.equal(cleanups, 2); assert.equal(listener, undefined)
})

test('short-lived viewer grants keep their original renewal deadline and disabled behavior', async () => {
  await act(async () => root.render(<Viewer />))
  const config = calls[0].config
  assert.equal(config.revalidateOnFocus, false)
  assert.equal(typeof config.refreshInterval, 'function')
  const interval = config.refreshInterval as (grant?: ViewerGrant) => number
  const now = Date.now(), nowMock = mock.method(Date, 'now', () => now)
  try {
    assert.equal(interval(), 0)
    assert.equal(interval({ url: 'wss://fixture.invalid', expiresAt: new Date(now + 90_000).toISOString() }), 60_000)
    assert.equal(interval({ url: 'wss://fixture.invalid', expiresAt: new Date(now + 10_000).toISOString() }), 5_000)
  } finally { nowMock.mock.restore() }
  await act(async () => root.render(<Viewer enabled={false} />))
  assert.equal(calls.at(-1)!.key, null)
})
