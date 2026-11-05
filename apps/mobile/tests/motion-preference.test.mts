import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

type Store = { subscribe: (listener: () => void) => () => void; snapshot: () => boolean }
let store: Store
const platform = { OS: 'ios' }
const nativeListeners = new Set<(value: boolean) => void>()
const reads: Array<(value: boolean) => void> = []

mock.module('react', { namedExports: {
  useSyncExternalStore: (subscribe: Store['subscribe'], snapshot: Store['snapshot']) => {
    store = { subscribe, snapshot }
    return snapshot()
  },
} })
mock.module('react-native', { namedExports: {
  Platform: platform,
  AccessibilityInfo: {
    isReduceMotionEnabled: () => new Promise<boolean>(resolve => { reads.push(resolve) }),
    addEventListener: (name: string, listener: (value: boolean) => void) => {
      assert.equal(name, 'reduceMotionChanged')
      nativeListeners.add(listener)
      return { remove: () => nativeListeners.delete(listener) }
    },
  },
} })

const { useReducedMotionPreference } = await import('../lib/reduced-motion.ts')

test('mounted consumers share the native subscription and a new preference beats an older async read', async () => {
  assert.equal(useReducedMotionPreference(), true, 'motion stays off while native preferences are unknown')
  let updates = 0
  const unsubscribeFirst = store.subscribe(() => { updates++ })
  const unsubscribeSecond = store.subscribe(() => { updates++ })
  assert.equal(nativeListeners.size, 1)
  assert.equal(reads.length, 1)
  nativeListeners.forEach(listener => listener(false))
  assert.equal(store.snapshot(), false)
  assert.equal(updates, 2)
  reads[0](true)
  await Promise.resolve()
  assert.equal(store.snapshot(), false, 'a delayed startup read must not undo an in-session preference change')
  nativeListeners.forEach(listener => listener(true))
  assert.equal(store.snapshot(), true)
  unsubscribeFirst()
  assert.equal(nativeListeners.size, 1)
  unsubscribeSecond()
  assert.equal(nativeListeners.size, 0)
})

test('the mounted web app follows media preference changes and detaches on unmount', () => {
  platform.OS = 'web'
  let changed: ((event: { matches: boolean }) => void) | undefined
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const media = {
    matches: false,
    addEventListener: (name: string, listener: typeof changed) => { assert.equal(name, 'change'); changed = listener },
    removeEventListener: (name: string, listener: typeof changed) => { assert.equal(name, 'change'); assert.equal(listener, changed); changed = undefined },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: (query: string) => {
    assert.equal(query, '(prefers-reduced-motion: reduce)')
    return media
  } } })
  try {
    useReducedMotionPreference()
    let updates = 0
    const unsubscribe = store.subscribe(() => { updates++ })
    assert.equal(store.snapshot(), false)
    changed?.({ matches: true })
    assert.equal(store.snapshot(), true)
    assert.equal(updates, 2)
    unsubscribe()
    assert.equal(changed, undefined)
    assert.equal(nativeListeners.size, 0)
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
