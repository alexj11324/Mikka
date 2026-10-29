import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { installAccountOriginFence } from '../../tests/e2e/test-account-network.ts'

// Protocol event interleavings only. Actual Chromium and reachable loopback
// sinks remain covered by test-account-origin-fence.spec.ts in Browser CI.
async function fixture({ failAbort = false } = {}) {
  let blocked = 0, failures = 0, closed = false, routeHandler
  const consoleSnapshots = []
  const session = new EventEmitter()
  session.send = async method => {
    if (method !== 'Fetch.failRequest') return
    if (failAbort) throw new Error('SYNTHETIC_PROTOCOL_ABORT_FAILURE')
    // Chromium can report its blocked resource before the CDP reply arrives.
    consoleSnapshots.push(blocked)
  }
  const page = { close: async () => {}, isClosed: () => false }
  const context = {
    close: async () => { closed = true },
    isClosed: () => closed,
    newCDPSession: async () => session,
    newPage: async () => page,
    route: async (_pattern, handler) => { routeHandler = handler },
    routeWebSocket: async () => {},
  }
  await installAccountOriginFence(context, { assertActive: async () => {} }, 'http://localhost:3100',
    () => { blocked++ }, () => { failures++ })
  await context.newPage()
  return {
    async protocolRefusal() {
      session.emit('Fetch.requestPaused', { requestId: 'synthetic-request', request: { url: 'http://localhost:3199/foreign' } })
      // Drain the protocol listener's asynchronous work without a timer race.
      await new Promise(resolve => setImmediate(resolve))
    },
    async routeRefusal() {
      await routeHandler({
        request: () => ({ url: () => 'http://localhost:3199/foreign' }),
        abort: async () => {
          if (failAbort) throw new Error('SYNTHETIC_ROUTE_ABORT_FAILURE')
          consoleSnapshots.push(blocked)
        },
      })
    },
    state: () => ({ blocked, failures, closed, consoleSnapshots }),
  }
}

for (const channel of ['protocolRefusal', 'routeRefusal']) {
  test(`${channel} announces the refusal before the browser reports its blocked resource`, async () => {
    const f = await fixture()
    await f[channel]()
    assert.deepEqual(f.state(), { blocked: 1, failures: 0, closed: false, consoleSnapshots: [1] })
  })

  test(`${channel} still closes the context and fails when the requested abort fails`, async () => {
    const f = await fixture({ failAbort: true })
    await f[channel]()
    assert.deepEqual(f.state(), { blocked: 1, failures: 1, closed: true, consoleSnapshots: [] })
  })
}
