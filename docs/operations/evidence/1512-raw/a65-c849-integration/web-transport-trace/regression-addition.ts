for (const outcome of ['accepted', 'expired', 'unavailable', 'disabled', 'preflight'] as const) test(`web transport ${outcome} belongs to the original request trace before any business scope`, async () => {
  const memory = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] })
  provider.register()
  try {
    const origin = 'https://app.aspectlylabs.com', authorization = `Bearer ${'s'.repeat(40)}`
    const lifetimes: Promise<unknown>[] = [], finished = Promise.withResolvers<void>()
    const sources: Request[] = [], scopes: boolean[] = [], parents: Array<string | undefined> = []
    let authenticationReads = 0, handlers = 0, afterRuns = 0, finishes = 0, finishStatus: number | undefined
    const input = Object.assign(request('write', { method: outcome === 'preflight' ? 'OPTIONS' : 'POST',
      ...(outcome === 'preflight' ? {} : { body: 'private-body-canary' }),
      headers: { origin, authorization, cookie: 'cloud=private-cookie-canary',
        ...(outcome === 'preflight' ? { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } : {}) },
    }), { waitUntil: (work: Promise<unknown>) => lifetimes.push(work) })
    const prepare = createWebTransport({ env: outcome === 'disabled' ? { MIKKA_OFFICIAL_WEB_ENABLED: '0' } : {},
      authenticate: async () => {
        authenticationReads++
        scopes.push(currentRequestScope() !== undefined)
        parents.push(trace.getActiveSpan()?.spanContext().spanId)
        // Only a numeric child span: this verifies the active-parent boundary
        // required by pg instrumentation without a database or auth SDK call.
        const lookup = trace.getTracer('application-test').startSpan('auth.lookup')
        await Promise.resolve()
        lookup.end()
        if (outcome === 'unavailable') throw new Error('authentication_fixture_failed')
        return outcome === 'expired' ? null : { user: { id: 'owner' }, session: { id: 'session' } }
      }, scope: (_identity, work) => work(),
    })
    const app = createApiHandler([fixture('write', { POST: async (adapted: Request) => {
      handlers++
      assert.equal(adapted.headers.get('origin'), 'https://example.test')
      assert.equal((await headers()).has('cookie'), false)
      assert.equal(await adapted.text(), 'private-body-canary')
      ;(await cookies()).set('must-not-cross', 'private-response-canary')
      after(() => { afterRuns++; assert.equal(memory.getFinishedSpans().some(span => span.name === 'POST /api/write'), true) })
      return new Response('accepted')
    } })], (original, route) => {
      sources.push(original)
      const active = beginRequestTrace(original, route)
      return { run: work => active.run(work), finish(status, error) { finishes++; finishStatus = status; active.finish(status, error); finished.resolve() } }
    }, (original, route) => {
      scopes.push(currentRequestScope() !== undefined)
      parents.push(trace.getActiveSpan()?.spanContext().spanId)
      return prepare(original, route)
    })
    const response = await app.fetch(input)
    const expectedStatus = { accepted: 200, expired: 401, unavailable: 503, disabled: 403, preflight: 204 }[outcome]
    assert.equal(response.status, expectedStatus)
    assert.equal(response.headers.get('access-control-allow-origin'), origin)
    assert.equal(response.headers.has('access-control-allow-credentials'), false)
    assert.equal(response.headers.has('set-cookie'), false)
    assert.deepEqual(sources, [input], 'even a transport early response owns the untouched request trace')
    await response.text()
    await finished.promise
    await Promise.all(lifetimes)
    await provider.forceFlush()
    const spans = memory.getFinishedSpans(), root = spans.find(span => span.name.endsWith(' /api/write'))!
    assert.ok(root)
    assert.ok(parents.every(parent => parent === root.spanContext().spanId), 'transport preparation and fresh authentication run under the request parent')
    assert.ok(scopes.every(value => value === false), 'business scope is created only from the adapted request')
    const expectedReads = ['accepted', 'expired', 'unavailable'].includes(outcome) ? 1 : 0
    assert.equal(authenticationReads, expectedReads)
    const lookups = spans.filter(span => span.name === 'auth.lookup')
    assert.equal(lookups.length, expectedReads)
    for (const lookup of lookups) {
      assert.equal(lookup.parentSpanContext?.spanId, root.spanContext().spanId)
      assert.equal(lookup.spanContext().traceId, root.spanContext().traceId)
    }
    assert.equal(root.attributes['http.response.status_code'], expectedStatus)
    assert.equal(root.status.code, outcome === 'unavailable' ? 2 : 0)
    assert.equal(finishes, 1); assert.equal(finishStatus, expectedStatus)
    assert.equal(handlers, outcome === 'accepted' ? 1 : 0)
    assert.equal(afterRuns, handlers)
    assert.equal(input.headers.get('origin'), origin)
    assert.equal(currentRequestScope(), undefined)
    const exported = JSON.stringify(spans.map(span => ({ name: span.name, attributes: span.attributes, events: span.events })))
    for (const canary of ['private-body-canary', 'private-cookie-canary', 'private-response-canary', authorization]) assert.equal(exported.includes(canary), false)
  } finally {
    await provider.shutdown()
    trace.disable(); otelContext.disable(); propagation.disable()
  }
})

test('a rejected transport preparation keeps the original H3 error response and finishes its trace once', async () => {
  const error = new Error('transport_fixture_failed'), finished = Promise.withResolvers<void>()
  const observed: Array<{ status: number; error?: unknown }> = []
  let traced = 0, handlers = 0
  const app = createApiHandler([fixture('one', { GET: () => { handlers++; return new Response('unreachable') } })], () => {
    traced++
    return { run: work => work(), finish(status, cause) { observed.push({ status, error: cause }); finished.resolve() } }
  }, async () => { throw error })
  app.config.silent = true
  const response = await app.fetch(request())
  assert.equal(response.status, 500)
  assert.equal(traced, 1)
  await response.text(); await finished.promise
  assert.equal(handlers, 0)
  assert.deepEqual(observed, [{ status: 500, error }])
  assert.equal(currentRequestScope(), undefined)
})

for (const outcome of ['complete', 'cancel', 'error'] as const) test(`adapted Web stream ${outcome} retains tracing and after disposal`, async () => {
  const active = new AsyncLocalStorage<string>()
  const afterDone = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>(), lifetimes: Promise<unknown>[] = []
  let controller!: ReadableStreamDefaultController<Uint8Array>, afterRuns = 0, finishes = 0, authenticationReads = 0
  const seen: Array<string | undefined> = []
  const app = createApiHandler([fixture('one', { GET: () => {
    seen.push(active.getStore())
    after(async () => { afterRuns++; seen.push(active.getStore()); assert.equal(finishes, 1); await afterDone.promise })
    return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(new Uint8Array([65])) } }))
  } })], () => ({ run: work => active.run('request', work), finish(status) { assert.equal(status, 200); finishes++; finished.resolve() } }),
  createWebTransport({ env: {}, authenticate: async () => {
    authenticationReads++; seen.push(active.getStore())
    return { user: { id: 'owner' }, session: { id: 'session' } }
  }, scope: (_identity, work) => work() }))
  const input = Object.assign(request('one', { headers: { origin: 'https://app.aspectlylabs.com', authorization: `Bearer ${'s'.repeat(40)}` } }), { waitUntil: (work: Promise<unknown>) => lifetimes.push(work) })
  const response = await app.fetch(input)
  assert.equal(afterRuns, 0); assert.equal(finishes, 0)
  const reader = response.body!.getReader()
  assert.deepEqual((await reader.read()).value, new Uint8Array([65]))
  if (outcome === 'complete') { controller.close(); assert.equal((await reader.read()).done, true) }
  else if (outcome === 'cancel') await reader.cancel()
  else { controller.error(new Error('stream_fixture_failed')); await assert.rejects(reader.read(), /stream_fixture_failed/) }
  await finished.promise
  afterDone.resolve(); await Promise.all(lifetimes)
  assert.equal(authenticationReads, 1); assert.equal(afterRuns, 1); assert.equal(finishes, 1)
  assert.deepEqual(seen, ['request', 'request', 'request'])
  assert.equal(currentRequestScope(), undefined)
})
