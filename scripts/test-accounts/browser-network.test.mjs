import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { installAccountOriginFence } from '../../tests/e2e/test-account-network.ts'
import { SYNTHETIC_PNG } from '../../tests/helpers/browser-image.ts'

// Protocol event interleavings only. Actual Chromium and reachable loopback
// sinks remain covered by test-account-origin-fence.spec.ts in Browser CI.
async function fixture({ failAbort = false, failFulfill = false, failLease = false, failContinue, cancelDuringLease, navigationDuringLease, networkDuringLease, failNetwork = false, failPage = false, images = [] } = {}) {
  let blocked = 0, failures = 0, closed = false, routeHandler
  const diagnostics = []
  let pendingCancellation = cancelDuringLease
  let pendingNavigation = navigationDuringLease
  let pendingNetwork = networkDuringLease
  const consoleSnapshots = []
  const transport = []
  const session = new EventEmitter()
  session.send = async (method, params) => {
    if (!['Fetch.enable', 'Network.enable', 'Page.enable'].includes(method)) transport.push({ method, params })
    if (method === 'Network.enable' && failNetwork) throw new Error('SYNTHETIC_NETWORK_SETUP_FAILURE')
    if (method === 'Page.enable' && failPage) throw new Error('SYNTHETIC_PAGE_SETUP_FAILURE')
    if (method === 'Fetch.continueRequest' && failContinue) throw new Error(failContinue)
    if (method === 'Fetch.fulfillRequest' && failFulfill) throw new Error('SYNTHETIC_PROTOCOL_FULFILL_FAILURE')
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
  await installAccountOriginFence(context, { assertActive: async () => {
    if (pendingCancellation) { session.emit('Network.loadingFailed', pendingCancellation); pendingCancellation = undefined }
    if (pendingNavigation) { session.emit('Page.frameNavigated', pendingNavigation); pendingNavigation = undefined }
    if (pendingNetwork) { session.emit('Network.requestWillBeSent', pendingNetwork); pendingNetwork = undefined }
    if (failLease) throw new Error('SYNTHETIC_LEASE_LOST')
  } }, 'http://localhost:3100',
    () => { blocked++ }, diagnostic => { failures++; diagnostics.push(diagnostic) }, images)
  await context.newPage()
  const defaults = { url: 'http://localhost:3199/foreign', method: 'GET', resourceType: 'image' }
  async function protocolRequest(request = {}) {
    const value = { ...defaults, ...request }
    session.emit('Fetch.requestPaused', { requestId: 'synthetic-request', networkId: value.networkId, frameId: value.frameId, request: { url: value.url, method: value.method }, resourceType: value.resourceType })
    await new Promise(resolve => setImmediate(resolve))
  }
  async function routeRequest(request = {}) {
    const value = { ...defaults, ...request }
    await routeHandler({
      request: () => ({ url: () => value.url, method: () => value.method, resourceType: () => value.resourceType, frame: () => ({ page: () => page }) }),
      abort: async () => {
        transport.push({ method: 'route.abort' })
        if (failAbort) throw new Error('SYNTHETIC_ROUTE_ABORT_FAILURE')
        consoleSnapshots.push(blocked)
      },
      continue: async () => { transport.push({ method: 'route.continue' }) },
      fulfill: async params => {
        transport.push({ method: 'route.fulfill', params })
        if (failFulfill) throw new Error('SYNTHETIC_ROUTE_FULFILL_FAILURE')
      },
    })
  }
  return {
    protocolRefusal: protocolRequest, routeRefusal: routeRequest, protocolRequest, routeRequest,
    transport: () => transport,
    diagnostics: () => diagnostics,
    cancelNetwork: event => session.emit('Network.loadingFailed', event),
    requestNetwork: event => session.emit('Network.requestWillBeSent', event),
    finishNetwork: event => session.emit('Network.loadingFinished', event),
    state: () => ({ blocked, failures, closed, consoleSnapshots }),
  }
}

const invalidInterception = 'cdpSession.send: Protocol error (Fetch.continueRequest): Invalid InterceptionId.'
const allowed = { url: 'http://localhost:3100/allowed', resourceType: 'Fetch', networkId: 'synthetic-network' }
const requestDocument = { requestId: allowed.networkId, frameId: 'synthetic-frame', loaderId: 'old-document', type: 'Fetch', request: { url: allowed.url } }
const replacement = { frame: { id: requestDocument.frameId, loaderId: 'new-document' } }
test('only the exact old subrequest document permits a stale continuation after reload', async () => {
  for (const lateMetadata of [false, true]) {
    const f = await fixture({ failContinue: invalidInterception, navigationDuringLease: replacement, networkDuringLease: lateMetadata ? requestDocument : undefined })
    if (!lateMetadata) f.requestNetwork(requestDocument)
    await f.protocolRequest({ ...allowed, frameId: requestDocument.frameId })
    assert.equal(f.state().closed, false)
    assert.equal(f.state().failures, 0)
    assert.deepEqual(f.transport().map(call => call.method), ['Fetch.continueRequest'])
    // Consumed metadata cannot authorize another request with a reused network ID.
    await f.protocolRequest({ ...allowed, frameId: requestDocument.frameId })
    assert.equal(f.state().failures, 1)
  }
})
test('navigation needs a matching network/frame and a replaced loader; Document and finished requests remain fenced', async () => {
  for (const change of ['missing-network', 'missing-metadata', 'different-frame', 'same-loader', 'missing-loader', 'document', 'finished', 'foreign-metadata']) {
    const f = await fixture({ failContinue: invalidInterception, navigationDuringLease: change === 'same-loader' ? { frame: { ...replacement.frame, loaderId: requestDocument.loaderId } } : replacement })
    if (change !== 'missing-metadata') f.requestNetwork({ ...requestDocument,
      ...(change === 'missing-loader' ? { loaderId: '' } : {}),
      ...(change === 'foreign-metadata' ? { request: { url: 'http://localhost:3199/foreign' } } : {}) })
    if (change === 'finished') f.finishNetwork({ requestId: allowed.networkId })
    await f.protocolRequest({ ...allowed, frameId: change === 'different-frame' ? 'other-frame' : requestDocument.frameId,
      ...(change === 'document' ? { resourceType: 'Document' } : {}), ...(change === 'missing-network' ? { networkId: undefined } : {}) })
    assert.equal(f.state().closed, true, change)
    assert.equal(f.state().failures, 1, change)
  }
})
test('a replaced document cannot suppress a lost lease, failed image fulfillment, foreign abort or another protocol error', async () => {
  for (const failure of [{ failLease: true }, { failFulfill: true }, { failAbort: true }, { failContinue: 'SYNTHETIC_OTHER_PROTOCOL_FAILURE' }]) {
    const f = await fixture({ ...failure, navigationDuringLease: replacement, images: [{ url: allowed.url, body: SYNTHETIC_PNG }] })
    f.requestNetwork(requestDocument)
    await f.protocolRequest({ ...allowed, frameId: requestDocument.frameId,
      ...(failure.failAbort ? { url: 'http://localhost:3199/foreign' } : {}), ...(failure.failFulfill ? { resourceType: 'Image' } : {}) })
    assert.equal(f.state().closed, true)
    assert.equal(f.state().failures, 1)
  }
})
test('only an exact canceled request exempts an invalid interception when continuing', async () => {
  const f = await fixture({ failContinue: invalidInterception, cancelDuringLease: { requestId: allowed.networkId, canceled: true } })
  await f.protocolRequest(allowed)
  assert.equal(f.state().closed, false)
  assert.equal(f.state().failures, 0)
  assert.deepEqual(f.transport().map(call => call.method), ['Fetch.continueRequest'])
  // No cancellation tombstone survives the completed paused handler.
  await f.protocolRequest(allowed)
  assert.equal(f.state().closed, true)
  assert.equal(f.state().failures, 1)
})

test('active, mismatched, missing and already-finished cancellation evidence stays fail closed', async () => {
  for (const cancelDuringLease of [undefined, { requestId: 'other-network', canceled: true }, { requestId: allowed.networkId, canceled: false }]) {
    const f = await fixture({ failContinue: invalidInterception, cancelDuringLease })
    await f.protocolRequest(allowed)
    assert.equal(f.state().closed, true)
    assert.equal(f.state().failures, 1)
  }
  const missing = await fixture({ failContinue: invalidInterception, cancelDuringLease: { requestId: allowed.networkId, canceled: true } })
  await missing.protocolRequest({ ...allowed, networkId: undefined })
  assert.equal(missing.state().closed, true)
  const early = await fixture({ failContinue: invalidInterception })
  early.cancelNetwork({ requestId: allowed.networkId, canceled: true })
  await early.protocolRequest(allowed)
  assert.equal(early.state().closed, true)
})

test('matching cancellation cannot suppress lease, fulfillment, abort or other protocol failures', async () => {
  for (const failure of [{ failLease: true }, { failFulfill: true }, { failAbort: true }, { failContinue: 'SYNTHETIC_OTHER_PROTOCOL_FAILURE' }]) {
    const f = await fixture({ ...failure, images: [{ url: 'http://localhost:3100/allowed', body: SYNTHETIC_PNG }], cancelDuringLease: { requestId: allowed.networkId, canceled: true } })
    await f.protocolRequest(failure.failAbort ? { ...allowed, url: 'http://localhost:3199/foreign' } : { ...allowed, resourceType: failure.failFulfill ? 'Image' : 'Fetch' })
    assert.equal(f.state().closed, true)
    assert.equal(f.state().failures, 1)
  }
})

test('fence diagnostics expose only fixed phase and category, never protocol payloads', async () => {
  const privateError = 'Protocol error: https://private:synthetic-secret@localhost/cookie?token=private-value'
  const f = await fixture({ failContinue: privateError })
  await f.protocolRequest(allowed)
  assert.deepEqual(f.diagnostics(), [{ phase: 'cdp-continue', category: 'unknown' }])
  assert.equal(JSON.stringify(f.diagnostics()).includes('private'), false)
  assert.equal(JSON.stringify(f.diagnostics()).includes('synthetic-secret'), false)
})

test('Network instrumentation setup failure refuses the browser page', async () => {
  await assert.rejects(fixture({ failNetwork: true }), /TEST_ACCOUNT_ORIGIN_FENCE_FAILED/)
  await assert.rejects(fixture({ failPage: true }), /TEST_ACCOUNT_ORIGIN_FENCE_FAILED/)
})

const imageURL = 'http://localhost:3199/fixture.png'
for (const channel of ['protocolRequest', 'routeRequest']) {
  test(`${channel} fulfills a copied exact static PNG without continuing or aborting`, async () => {
    const body = Buffer.from(SYNTHETIC_PNG)
    const f = await fixture({ images: [{ url: imageURL, body }] })
    body.fill(0)
    await f[channel]({ url: imageURL, resourceType: channel === 'protocolRequest' ? 'Image' : 'image' })
    assert.deepEqual(f.state(), { blocked: 0, failures: 0, closed: false, consoleSnapshots: [] })
    assert.equal(f.transport().length, 1)
    const result = f.transport()[0]
    assert.equal(result.method, channel === 'protocolRequest' ? 'Fetch.fulfillRequest' : 'route.fulfill')
    assert.deepEqual(channel === 'protocolRequest' ? Buffer.from(result.params.body, 'base64') : result.params.body, SYNTHETIC_PNG)
    const headers = channel === 'protocolRequest' ? result.params.responseHeaders : result.params.headers
    assert.equal(JSON.stringify(headers).toLowerCase().includes('cookie'), false)
    assert.equal(JSON.stringify(headers).toLowerCase().includes('location'), false)
  })

  test(`${channel} keeps unregistered URLs, methods and resource types denied`, async () => {
    for (const patch of [{ url: `${imageURL}?extra=1` }, { url: `${imageURL}/other` }, { method: 'POST' }, { resourceType: 'Fetch' }, { resourceType: 'Document' }]) {
      const f = await fixture({ images: [{ url: imageURL, body: SYNTHETIC_PNG }] })
      await f[channel]({ url: imageURL, ...patch })
      assert.deepEqual(f.state(), { blocked: 1, failures: 0, closed: false, consoleSnapshots: [1] })
      assert.equal(f.transport().length, 1)
      assert.equal(f.transport()[0].method, channel === 'protocolRequest' ? 'Fetch.failRequest' : 'route.abort')
    }
  })

  test(`${channel} checks the lease before any static fulfillment and closes on fulfillment failure`, async () => {
    for (const failure of [{ failLease: true }, { failFulfill: true }]) {
      const f = await fixture({ ...failure, images: [{ url: imageURL, body: SYNTHETIC_PNG }] })
      await f[channel]({ url: imageURL })
      assert.equal(f.state().failures, 1)
      assert.equal(f.state().closed, true)
      assert.equal(f.transport().some(call => call.method.endsWith('continue') || call.method === 'Fetch.continueRequest'), false)
      assert.equal(f.transport().filter(call => call.method === 'Fetch.fulfillRequest' || call.method === 'route.fulfill').length, failure.failLease ? 0 : 1)
      assert.equal(f.transport().at(-1).method, channel === 'protocolRequest' ? 'Fetch.failRequest' : 'route.abort')
    }
  })
}

test('static image fixture configuration rejects credentials, queries, fragments and non-PNG bytes', async () => {
  for (const value of [
    { url: 'http://private:secret@localhost:3199/fixture.png', body: SYNTHETIC_PNG },
    { url: `${imageURL}?secret=value`, body: SYNTHETIC_PNG },
    { url: `${imageURL}#fragment`, body: SYNTHETIC_PNG },
    { url: 'data:image/png;base64,ignored', body: SYNTHETIC_PNG },
    { url: imageURL, body: Buffer.from('<html>not an image</html>') },
  ]) await assert.rejects(fixture({ images: [value] }))
})

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
