import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { unstable_serialize } from 'swr'

// A Stripe webhook's commit pushes hosted_billing (#1212): the wait listens on it, never on a timer, and reads
// once more at its timeout as the backstop.
const live: unknown[][] = []
mock.module(new URL('../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey: (...args: unknown[]) => { live.push(args) } } })

type Read = { status: string }
const WORKSPACE = '20000000-0000-4000-8000-000000000001'
let useLiveWait: typeof import('../hooks/use-live-wait')['useLiveWait']
let wait: () => Promise<Read | undefined>
let reads = 0
let swr: { data: Read | undefined; mutate: () => Promise<Read | undefined> }
const done = (value: Read) => value.status === 'verified'
function Probe() { wait = useLiveWait(swr, 'hosted_billing', WORKSPACE, ['card-verification', WORKSPACE], done, 1_000); return null }

const browser = new Window()
let createRoot: typeof import('react-dom/client')['createRoot']
let root: Root, host: HTMLDivElement
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useLiveWait } = await import('../hooks/use-live-wait'))
})
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] })
  live.length = 0; reads = 0
  swr = { data: { status: 'pending' }, mutate: async () => { reads++; return swr.data } }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); mock.timers.reset() })
after(async () => { await browser.close(); mock.restoreAll() })

test('idle, it registers no key and reads nothing', async () => {
  await act(async () => root.render(<Probe />))
  assert.deepEqual(live.at(-1)!.slice(0, 3), ['hosted_billing', null, []])
  mock.timers.tick(60_000)
  assert.equal(reads, 0)
})

test('waiting, it listens on the workspace key and ends with the pushed read, with no read of its own', async () => {
  await act(async () => root.render(<Probe />))
  let result: Read | undefined
  await act(async () => { void wait().then(value => { result = value }) })
  assert.deepEqual(live.at(-1)!.slice(0, 4), ['hosted_billing', WORKSPACE, [unstable_serialize(['card-verification', WORKSPACE])], WORKSPACE])
  // The push re-reads the SWR key; its new data ends the wait.
  swr = { ...swr, data: { status: 'verified' } }
  await act(async () => root.render(<Probe />))
  assert.deepEqual(result, { status: 'verified' })
  assert.equal(reads, 0)
  assert.equal(live.at(-1)![1], null, 'done: the key is dropped')
  mock.timers.tick(5_000)
  assert.equal(reads, 0, 'no backstop read after it ended')
})

test('with no push, one backstop read at the timeout, and the last data either way', async () => {
  await act(async () => root.render(<Probe />))
  let result: Read | undefined
  await act(async () => { void wait().then(value => { result = value }) })
  await act(async () => { mock.timers.tick(999) })
  assert.equal(reads, 0)
  await act(async () => { mock.timers.tick(1) })
  await act(async () => { await Promise.resolve() })
  assert.equal(reads, 1)
  assert.deepEqual(result, { status: 'pending' })
})
