import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

const events: string[] = []
let answer: { error?: { code: string } } = {}
let release: (() => void) | undefined
mock.module('better-auth/react', { namedExports: { createAuthClient: () => ({ signOut: async () => { events.push('signed-out'); return answer } }) } })
mock.module(new URL('../chat-drafts.ts', import.meta.url).href, { namedExports: { clearChatDrafts: () => { events.push('drafts-cleared') } } })
mock.module(new URL('./persistent-cache.ts', import.meta.url).href, { namedExports: {
  clearPersistentReadCaches: async () => { events.push('cache-clear-start'); await new Promise<void>(resolve => { release = resolve }); events.push('cache-clear-finished') },
} })
let endSession: typeof import('../auth-client')['endSession']
before(async () => { ({ endSession } = await import('../auth-client')) })
beforeEach(() => { events.length = 0; answer = {}; release = undefined })

test('successful logout waits for persistent data to be erased before navigation can proceed', async () => {
  let settled = false
  const pending = endSession().then(result => { settled = true; return result })
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(events, ['signed-out', 'drafts-cleared', 'cache-clear-start'])
  assert.equal(settled, false)
  release!()
  assert.deepEqual(await pending, {})
  assert.equal(events.at(-1), 'cache-clear-finished')
})

test('failed logout does not claim that the still-authenticated session was cleared', async () => {
  answer = { error: { code: 'serviceUnavailable' } }
  assert.deepEqual(await endSession(), answer)
  assert.deepEqual(events, ['signed-out'])
})
