import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

class FakeSource {
  static CLOSED = 2
  static opened: FakeSource[] = []
  readyState = 1
  listeners = new Map<string, Set<(event: Event) => void>>()
  onerror: (() => void) | null = null
  constructor(readonly url: string) { FakeSource.opened.push(this) }
  addEventListener(type: string, handler: (event: Event) => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(handler) }
  removeEventListener(type: string, handler: (event: Event) => void) { this.listeners.get(type)?.delete(handler) }
  close() { this.readyState = FakeSource.CLOSED }
  emit(type: string, data: string, lastEventId: string) { for (const handler of this.listeners.get(type) ?? []) handler({ data, lastEventId } as unknown as Event) }
}
let visibility: 'visible' | 'hidden' = 'visible'
const visibilityListeners = new Set<() => void>()
Object.assign(globalThis, {
  EventSource: FakeSource,
  document: {
    get visibilityState() { return visibility },
    addEventListener: (_: string, listener: () => void) => visibilityListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => visibilityListeners.delete(listener),
  },
})
const setVisibility = (next: typeof visibility) => { visibility = next; for (const listener of visibilityListeners) listener() }
let listenComputerStream: typeof import('./event-stream')['listenComputerStream']
before(async () => { ({ listenComputerStream } = await import('./event-stream')) })

afterEach(() => { FakeSource.opened.length = 0; visibility = 'visible' })

test('a hidden tab closes the stream and a visible one resumes after the last event', () => {
  const received: string[] = []
  const stop = listenComputerStream('data-subagent', data => { received.push(data) })
  assert.equal(FakeSource.opened.length, 1)
  assert.match(FakeSource.opened[0].url, /\/api\/computer\/events$/)
  FakeSource.opened[0].emit('data-subagent', 'first', '41')

  setVisibility('hidden')
  assert.equal(FakeSource.opened[0].readyState, FakeSource.CLOSED, 'no stream, and so no polling query, while hidden')

  setVisibility('visible')
  assert.equal(FakeSource.opened.length, 2)
  assert.match(FakeSource.opened[1].url, /\/api\/computer\/events\?after=41$/)
  FakeSource.opened[1].emit('data-subagent', 'second', '42')
  assert.deepEqual(received, ['first', 'second'], 'subscribers carry over to the reopened stream')

  stop()
  assert.equal(FakeSource.opened[1].readyState, FakeSource.CLOSED)
  assert.equal(visibilityListeners.size, 0)
})

test('subscribing while hidden opens nothing until the tab is shown', () => {
  visibility = 'hidden'
  const stop = listenComputerStream('data-subagent', () => {})
  assert.equal(FakeSource.opened.length, 0)
  setVisibility('visible')
  assert.equal(FakeSource.opened.length, 1)
  const second = listenComputerStream('computer', () => {})
  assert.equal(FakeSource.opened.length, 1, 'one stream per tab')
  second()
  stop()
})

test('a required update closes the EventSource and visibility cannot reconnect it', async () => {
  const stop = listenComputerStream('data-subagent', () => {})
  assert.equal(FakeSource.opened.length, 1)
  const { markPageNeedsRefresh } = await import('../app-build')
  markPageNeedsRefresh()
  assert.equal(FakeSource.opened[0].readyState, FakeSource.CLOSED)
  setVisibility('hidden'); setVisibility('visible')
  const stopAgain = listenComputerStream('data-subagent', () => {})
  assert.equal(FakeSource.opened.length, 1)
  stopAgain(); stop()
  assert.equal(visibilityListeners.size, 0)
})
