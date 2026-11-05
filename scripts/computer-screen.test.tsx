import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ComponentProps } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { ComputerState } from '@/lib/computer/types'
import { ComputerRequestError } from '@/lib/computer/client'

let state: ComputerState = { machine: 'sleeping', control: 'idle' }
let requests = 0
let stateReads = 0
let refreshController = new AbortController()
let viewer: { url: string } | undefined
class FakeRFB extends EventTarget {
  static instances: FakeRFB[] = []
  viewOnly = false; scaleViewport = false; resizeSession = false; background = ''; disconnects = 0
  constructor(_host: HTMLElement, _url: string) { super(); FakeRFB.instances.push(this) }
  disconnect() { this.disconnects++; this.dispatchEvent(new Event('disconnect')) }
  focus() {}
}
mock.module('@novnc/novnc/lib/rfb.js', { defaultExport: FakeRFB })
mock.module(new URL('../lib/app-build.ts', import.meta.url).href, { namedExports: { pageRefreshSignal: () => refreshController.signal } })
let finishWake: (value: null) => void
let failWake: (error: Error) => void
const failures: string[] = []
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
mock.module('sonner', { namedExports: { toast: { error: (message: string) => failures.push(message) } } })
mock.module(new URL('../hooks/use-computer.ts', import.meta.url).href, { namedExports: {
  useComputer: () => ({ data: state, mutate: async () => { stateReads++; return state } }),
  useViewerGrant: () => ({ data: viewer }),
} })
mock.module(new URL('../lib/computer/client.ts', import.meta.url).href, { namedExports: { ComputerRequestError, computerApi: {
  wake: () => { requests++; return new Promise<null>((resolve, reject) => { finishWake = resolve; failWake = reject }) },
} } })
mock.module(new URL('../components/ui/button.tsx', import.meta.url).href, { namedExports: { Button: ({ size: _size, variant: _variant, ...props }: ComponentProps<'button'> & { size?: string; variant?: string }) => <button {...props} /> } })
mock.module(new URL('../components/ui/progress.tsx', import.meta.url).href, { namedExports: { Progress: (props: { 'aria-label': string }) => <div role="progressbar" aria-label={props['aria-label']} /> } })

const browser = new Window()
let root: Root
let container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let ComputerScreen: typeof import('../components/computer/computer-screen')['ComputerScreen']
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ComputerScreen } = await import('../components/computer/computer-screen'))
})
beforeEach(() => {
  state = { machine: 'sleeping', control: 'idle' }; requests = 0; stateReads = 0; failures.length = 0
  refreshController = new AbortController(); viewer = undefined; FakeRFB.instances.length = 0
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())
const render = async () => { await act(async () => root.render(<ComputerScreen botId="fixture-bot" name="Fixture" />)) }

test('rapid wake clicks send one request and show progress while a sleeping poll is stale', async () => {
  await render()
  const button = container.querySelector('button')!
  await act(async () => { button.click(); button.click() })
  assert.equal(requests, 1)
  assert.ok(container.querySelector('[role="progressbar"][aria-label="waking"]'))
  assert.equal(container.querySelector('button'), null)
  state = { machine: 'waking', control: 'idle' }
  await act(async () => finishWake(null))
  assert.deepEqual(failures, [])
  assert.ok(container.querySelector('[aria-label="waking"]'))
})

test('a real wake failure is visible and releases the button for an explicit retry', async () => {
  await render()
  await act(async () => container.querySelector('button')!.click())
  await act(async () => failWake(new Error('provider unavailable')))
  assert.deepEqual(failures, ['wakeFailed'])
  assert.equal(container.querySelector('button')?.textContent, 'wake')
  await act(async () => container.querySelector('button')!.click())
  assert.equal(requests, 2)
  state = { machine: 'waking', control: 'idle' }
  await act(async () => finishWake(null))
})


const showRunning = () => { state = { machine: 'running', control: 'idle' }; viewer = { url: 'wss://viewer.example/fixture' } }
const settleViewer = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }) }

test('a required refresh disconnects the active viewer once and removes its listener on unmount', async () => {
  showRunning()
  await render()
  for (let n = 0; n < 100 && FakeRFB.instances.length === 0; n++) await settleViewer()
  assert.equal(FakeRFB.instances.length, 1)
  assert.equal(getEventListeners(refreshController.signal, 'abort').length, 1)
  const client = FakeRFB.instances[0]
  refreshController.abort()
  assert.equal(client.disconnects, 1)
  await act(async () => root.render(null))
  assert.equal(client.disconnects, 1)
  assert.equal(getEventListeners(refreshController.signal, 'abort').length, 0)
  assert.equal(requests, 0, 'disconnecting the viewer performs no device operation')
})

test('a page already requiring refresh never creates the viewer connection', async () => {
  showRunning()
  refreshController.abort()
  await render()
  await settleViewer()
  assert.equal(FakeRFB.instances.length, 0)
})

test('refresh while the viewer module loads prevents its eventual connection', async () => {
  showRunning()
  act(() => root.render(<ComputerScreen botId="fixture-bot" name="Fixture" />))
  refreshController.abort()
  await settleViewer()
  assert.equal(FakeRFB.instances.length, 0)
})

test('normal viewer unmount removes the update listener and does not stop the device', async () => {
  showRunning()
  await render()
  for (let n = 0; n < 100 && FakeRFB.instances.length === 0; n++) await settleViewer()
  const client = FakeRFB.instances[0]
  assert.ok(client)
  await act(async () => root.render(null))
  assert.equal(client.disconnects, 1)
  assert.equal(getEventListeners(refreshController.signal, 'abort').length, 0)
  refreshController.abort()
  assert.equal(client.disconnects, 1)
  assert.equal(requests, 0)
})

test('a remote viewer disconnect requests one authoritative state read; normal disposal does not', async () => {
  showRunning()
  await render()
  for (let n = 0; n < 100 && FakeRFB.instances.length === 0; n++) await settleViewer()
  const client = FakeRFB.instances[0]
  assert.ok(client)
  await act(async () => { client.dispatchEvent(new Event('disconnect')); client.dispatchEvent(new Event('disconnect')) })
  assert.equal(stateReads, 1)
  assert.equal(state.machine, 'running', 'a disconnect does not fabricate a sleeping or error state')
  await act(async () => root.render(null))
  assert.equal(stateReads, 1)
})

test('remote disconnect while hidden waits for the shared visibility catch-up', async () => {
  showRunning()
  await render()
  for (let n = 0; n < 100 && FakeRFB.instances.length === 0; n++) await settleViewer()
  const previous = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  try {
    await act(async () => FakeRFB.instances[0].dispatchEvent(new Event('disconnect')))
    assert.equal(stateReads, 0)
  } finally {
    if (previous) Object.defineProperty(document, 'visibilityState', previous)
    else delete (document as unknown as { visibilityState?: string }).visibilityState
  }
})
