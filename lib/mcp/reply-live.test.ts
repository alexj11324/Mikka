import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { SharedSubscription } from '../db/listen'

const app = { options: { connectionString: 'postgresql://localhost/mcp_app_e2e' } }
const workspace = { options: { connectionString: 'postgresql://localhost/mcp_workspace_e2e' } }
mock.module('../db', { namedExports: { pool: app } })
mock.module('../workspace-db', { namedExports: { workspacePool: workspace } })
const calls: { database: unknown; keys: readonly string[]; signal: AbortSignal; closes: number }[] = []
let mode: 'ready' | 'pending' | 'partial' = 'ready'
mock.module('../db/listen', { namedExports: {
  MCP_REPLY_CHANNEL: 'mikka_mcp_reply',
  subscribeShared: async (database: unknown, channel: string, keys: readonly string[], signal: AbortSignal) => {
    assert.equal(channel, 'mikka_mcp_reply')
    const row = { database, keys, signal, closes: 0 }; calls.push(row)
    if (mode === 'pending' || mode === 'partial' && database === workspace) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
      return null
    }
    const subscription: SharedSubscription = {
      reset() {}, lost: false, close() { row.closes++ },
      next(_milliseconds, abort) { return new Promise<void>(resolve => {
        if (abort?.aborted) resolve(); else abort?.addEventListener('abort', () => resolve(), { once: true })
      }) },
    }
    return subscription
  },
} })
const { subscribeToCoordinatorReplies } = await import('./reply-live')
const scope = { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace' }
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }

test('both target handshakes share one five-second setup budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); calls.length = 0; mode = 'pending'
  const controller = new AbortController()
  let settled = false
  const pending = subscribeToCoordinatorReplies(scope, 'fixture-bot', () => {}, controller.signal).then(value => { settled = true; return value })
  await flush()
  t.mock.timers.tick(4_999); await flush()
  assert.equal(settled, false)
  t.mock.timers.tick(1)
  const observer = await pending
  assert.equal(observer.lost, true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(row => row.keys), [['bot:fixture-bot'], ['member:fixture-workspace:fixture-owner']])
  assert.ok(calls.every(row => row.signal.aborted))
  observer.close()
})

test('the setup deadline is removed after both ready subscriptions and never expires a healthy wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); calls.length = 0; mode = 'ready'
  const observer = await subscribeToCoordinatorReplies(scope, 'fixture-bot', () => {}, new AbortController().signal)
  t.mock.timers.tick(90_000); await flush()
  assert.equal(observer.lost, false)
  assert.ok(calls.every(row => !row.signal.aborted && row.closes === 0))
  observer.close(); await flush()
  assert.ok(calls.every(row => row.closes === 1))
})

test('a partial setup falls back after five seconds and closes the successful subscription exactly once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); calls.length = 0; mode = 'partial'
  const pending = subscribeToCoordinatorReplies(scope, 'fixture-bot', () => {}, new AbortController().signal)
  await flush(); t.mock.timers.tick(5_000)
  const observer = await pending
  assert.equal(observer.lost, true)
  assert.equal(calls[0].closes, 0)
  observer.close(); observer.close(); await flush()
  assert.equal(calls[0].closes, 1)
  assert.equal(calls[1].closes, 0)
})

test('caller abort interrupts establishment before the five-second budget', async () => {
  calls.length = 0; mode = 'pending'
  const controller = new AbortController()
  const pending = subscribeToCoordinatorReplies(scope, 'fixture-bot', () => {}, controller.signal)
  controller.abort()
  const observer = await pending
  assert.equal(observer.lost, true)
  assert.ok(calls.every(row => row.signal.aborted))
  observer.close()
})
