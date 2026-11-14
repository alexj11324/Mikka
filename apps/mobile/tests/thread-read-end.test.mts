import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act, createElement, useEffect } from 'react'
import { Window } from 'happy-dom'
import type { Root } from 'react-dom/client'
import type { ThreadDetail } from '../lib/types.ts'

const app = { currentState: 'active' }
const requests: { action: string; runId: string; revision: number; through: string }[] = []
let foreground: () => void = () => {}
let focus: () => () => void = () => () => {}
let blur = () => {}
let failWrite = false
let frame = () => {}
const originalScroll = mock.fn()
mock.module('react-native', { namedExports: { AppState: app } })
mock.module('expo-router', { namedExports: {
  useFocusEffect: (effect: () => () => void) => useEffect(() => {
    focus = effect
    blur = effect()
    return () => blur()
  }, [effect]),
} })
mock.module(new URL('../lib/api.ts', import.meta.url).href, { namedExports: {
  api: async (_path: string, { body }: { body: typeof requests[number] }) => {
    requests.push(body)
    if (failWrite) throw Error('test write failed')
  },
} })
mock.module(new URL('../lib/useApi.ts', import.meta.url).href, { namedExports: {
  onAppForeground: (fn: () => void) => { foreground = fn; return () => { foreground = () => {} } },
} })

const dom = new Window({ url: 'https://fixture.invalid/' })
let root: Root
let hook: typeof import('../features/chat/model/use-thread-read-end.ts')['useThreadReadEnd']
let callbacks: ReturnType<typeof hook>
function Probe({ rows }: { rows: ThreadDetail['readReceipts'] }) {
  callbacks = hook(rows?.[0]?.id ?? '', rows, originalScroll)
  return null
}
before(async () => {
  Object.assign(globalThis, { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: () => void) => { frame = fn; return 1 }, cancelAnimationFrame: () => {},
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  const { createRoot } = await import('react-dom/client')
  root = createRoot(dom.document.body as unknown as HTMLBodyElement)
  ;({ useThreadReadEnd: hook } = await import('../features/chat/model/use-thread-read-end.ts'))
})
after(async () => { await act(async () => root.unmount()); await dom.happyDOM.close() })
type Row = NonNullable<ThreadDetail['readReceipts']>[number]
const render = async (rows: Row[]) => {
  await act(async () => root.render(createElement(Probe, { rows })))
  frame()
}
const rows = (through: string, revision: number): Row[] => [{ id: 'earlier', through, revision, unread: true }]
const scroll = (offset: number) => callbacks.onScroll({ nativeEvent: {
  contentOffset: { x: 0, y: offset }, contentSize: { width: 390, height: 1200 }, layoutMeasurement: { width: 390, height: 800 },
} } as Parameters<typeof callbacks.onScroll>[0])

test('a mounted Native transcript sends its seen revision only while focused, foreground, and at its actual end', async () => {
  await render(rows('2026-11-14T16:00:00.000Z', 3))
  scroll(10)
  assert.deepEqual(requests, [])
  app.currentState = 'background'
  scroll(400)
  assert.deepEqual(requests, [])
  app.currentState = 'active'
  blur()
  foreground()
  scroll(400)
  assert.deepEqual(requests, [])
  blur = focus()
  assert.deepEqual(requests, [{ action: 'read', runId: 'earlier', through: '2026-11-14T16:00:00.000Z', revision: 3 }])
  foreground()
  scroll(400)
  assert.equal(requests.length, 1)
  assert.equal(originalScroll.mock.callCount(), 4)
  failWrite = true
  await render(rows('2026-11-14T17:00:00.000Z', 4))
  assert.equal(requests.length, 2)
  await Promise.resolve()
  failWrite = false
  foreground()
  assert.equal(requests.length, 3)
  assert.equal(requests[2].revision, 4)
  assert.equal(requests[2].through, '2026-11-14T17:00:00.000Z')
  foreground()
  assert.equal(requests.length, 3)
})

test('changing the displayed conversation waits for its own Native layout before a visible read can be accepted', async () => {
  await render([{ id: 'earlier', through: '2026-11-14T18:00:00.000Z', revision: 5, unread: true }])
  scroll(400)
  const before = requests.length
  const oldView = callbacks
  const next = { id: 'different-chat', through: '2026-11-14T19:00:00.000Z', revision: 2, unread: true }
  await render([next])
  assert.equal(requests.length, before, 'the bottom position from the previous conversation cannot count as viewing the new one')
  oldView.onContentSizeChange(390, 800)
  assert.equal(requests.length, before)
  scroll(0)
  assert.equal(requests.length, before)
  scroll(400)
  assert.deepEqual(requests.at(-1), { action: 'read', runId: next.id, through: next.through, revision: 2 })
})
