import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// Alex 2026-11-08: no drag on a message (swipe-to-quote and the swipe-left times are gone), and the left-edge swipe in a
// bot chat must go back to the bot list. The edge swipe is the native stack's; nothing on a chat screen may take it.
const root = new URL('..', import.meta.url).pathname
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const files = (dir: string): string[] => readdirSync(join(root, dir)).flatMap(name => {
  const path = join(dir, name)
  return statSync(join(root, path)).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : []
})

test('no pan gesture on chat messages or their lists', () => {
  for (const path of ['components/chat.tsx', 'features/chat/screens/chat-screen.tsx', 'app/groups/[id].tsx']) {
    const source = read(path)
    assert.doesNotMatch(source, /Gesture\.Pan\(/, `${path} has a pan gesture`)
    assert.doesNotMatch(source, /useTimeReveal|TimedRow/, `${path} still uses the swipe row`)
  }
})

test('a long press on a message selects its words; nothing else on the row moves it', () => {
  const source = read('components/chat.tsx')
  assert.match(source, /export function MessageRow/)
  assert.match(source, /Gesture\.LongPress\(\)/)
})

test('no screen turns the native swipe back off', () => {
  for (const path of [...files('app'), ...files('features/chat'), 'components/NavBar.tsx', 'components/nav-bar-options.ts', 'lib/sheet-options.ts']) {
    assert.doesNotMatch(read(path), /gestureEnabled:\s*false|fullScreenGestureEnabled:\s*false/, `${path} disables swipe back`)
  }
})
