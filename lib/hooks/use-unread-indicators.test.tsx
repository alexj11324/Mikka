import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { act, useRef } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { useUnreadIndicators } from './use-unread-indicators'
import type { ConversationRead, ConversationReadSource } from '../conversation-reads'

const browser = new Window({ url: 'https://mikka.example/en' })
let root: Root
let container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let mounted = false

// Deterministic observers and animation frames: the hook must create one ResizeObserver
// for the transcript content and its viewport, and coalesce every notification into one frame.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly targets: Element[] = []
  disconnected = false
  private readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) { this.callback = callback; FakeResizeObserver.instances.push(this) }
  observe(target: Element) { this.targets.push(target) }
  unobserve() {}
  disconnect() { this.disconnected = true }
  notify() { this.callback([], this as unknown as ResizeObserver) }
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  constructor() { FakeIntersectionObserver.instances.push(this) }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
}

let frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let canceledFrames: number[] = []

function runFrame() {
  const pending = [...frames]
  frames.clear()
  for (const [, callback] of pending) callback(0)
}

async function flushFrames() {
  for (let pass = 0; pass < 10; pass++) {
    if (frames.size === 0) return
    await act(async () => { runFrame() })
  }
}

const read: ConversationRead = { lastReadMessageId: null, lastReadPosition: null, unreadCount: 0 }
const source: ConversationReadSource = {
  async get() { return read },
  async mark() { return read },
  beacon() {},
}

type FixtureItem = { position: number; own: boolean; messageId: string; reportable: boolean }
const items: FixtureItem[] = [{ position: 1, own: false, messageId: 'message-1', reportable: true }]

let contentHeight = 100
let viewportHeight = 200
let measured = 0

const viewportNode = () => container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')
const contentNode = () => container.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')

function Fixture({ items }: { items: FixtureItem[] }) {
  const rootRef = useRef<HTMLElement>(null)
  useUnreadIndicators({ conversationId: 'conversation', items, rootRef, source })
  return (
    <section ref={rootRef}>
      <div data-slot="message-scroller-viewport">
        <div data-slot="message-scroller-content">
          {items.map(item => <div key={item.position} data-message-position={item.position} />)}
        </div>
      </div>
    </section>
  )
}

before(async () => {
  for (const key of ['window', 'document', 'sessionStorage', 'HTMLElement', 'MutationObserver'] as const) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? browser : browser[key] })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: FakeResizeObserver })
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: FakeIntersectionObserver })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => { const id = nextFrameId++; frames.set(id, callback); return id } })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => { frames.delete(id); canceledFrames.push(id) } })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
})

beforeEach(() => {
  FakeResizeObserver.instances = []
  FakeIntersectionObserver.instances = []
  frames = new Map()
  nextFrameId = 1
  canceledFrames = []
  contentHeight = 100
  viewportHeight = 200
  measured = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})

async function unmount() {
  if (!mounted) return
  mounted = false
  await act(async () => { root.unmount() })
}

afterEach(async () => { await unmount(); container.remove() })
after(() => browser.close())

/**
 * Mounts the fixture, gives real geometry to the two scroller nodes, and settles the open-time
 * placement frames. The baseline notification records the current heights, so the assertions
 * below observe only the changes each test makes.
 */
async function settle() {
  // The read source resolves on a microtask; its render and the open-time placement frames
  // must finish before the tests start counting measurements.
  for (let round = 0; round < 3; round++) {
    await act(async () => { await Promise.resolve() })
    await flushFrames()
  }
}

async function mount() {
  mounted = true
  await act(async () => { root.render(<Fixture items={items} />) })
  await settle()
  const viewport = viewportNode()
  const content = contentNode()
  assert.ok(viewport)
  assert.ok(content)
  Object.defineProperties(viewport, {
    getBoundingClientRect: { configurable: true, value: () => { measured += 1; return { top: 0, bottom: viewportHeight } as DOMRect } },
    clientHeight: { configurable: true, get: () => viewportHeight },
    scrollHeight: { configurable: true, get: () => contentHeight },
    scrollTop: { configurable: true, get: () => 0 },
  })
  Object.defineProperties(content, { scrollHeight: { configurable: true, get: () => contentHeight } })
  const observer = FakeResizeObserver.instances[0]
  assert.ok(observer, 'the hook must observe the transcript')
  observer.notify()
  await flushFrames()
  measured = 0
  return observer
}

test('the transcript is watched by one ResizeObserver on the content and viewport, never per row', async () => {
  await mount()
  assert.equal(FakeResizeObserver.instances.length, 1)
  const observer = FakeResizeObserver.instances[0]
  assert.equal(observer.targets.length, 2, 'content and viewport, no per-row targets')
  assert.equal(observer.targets[0], contentNode())
  assert.equal(observer.targets[1], viewportNode())
  assert.equal(FakeIntersectionObserver.instances.length, 0, 'intersection observers are what pinned the CPU')
})

test('a content height change coalesces into one measurement per frame', async () => {
  const observer = await mount()
  contentHeight = 150
  observer.notify()
  observer.notify()
  assert.equal(measured, 0, 'the observer only schedules a frame')
  await flushFrames()
  assert.equal(measured, 1, 'two notifications in one frame measure once')
  observer.notify()
  await flushFrames()
  assert.equal(measured, 1, 'an unchanged height does not remeasure')
  contentHeight = 150.5
  observer.notify()
  await flushFrames()
  assert.equal(measured, 1, 'a subpixel change is not a new height')
  contentHeight = 151
  observer.notify()
  await flushFrames()
  assert.equal(measured, 2)
})

test('a viewport resize remeasures even when the transcript height is unchanged', async () => {
  const observer = await mount()
  viewportHeight = 400
  observer.notify()
  await flushFrames()
  assert.equal(measured, 1, 'a taller window changes which rows are visible')
  observer.notify()
  await flushFrames()
  assert.equal(measured, 1, 'an unchanged viewport does not remeasure')
})

test('unmount disconnects the observer and cancels a pending frame', async () => {
  const observer = await mount()
  contentHeight = 150
  observer.notify()
  assert.equal(frames.size, 1)
  const pendingFrame = [...frames.keys()][0]!
  await unmount()
  assert.equal(observer.disconnected, true)
  assert.ok(canceledFrames.includes(pendingFrame), 'the pending measurement frame is canceled')
  assert.equal(frames.size, 0)
  await flushFrames()
  assert.equal(measured, 0, 'a canceled frame cannot measure after unmount')
})
