import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Client, ClientConfig } from 'pg'
import { MAX_PRESENCE_SOURCES, PostgresGatewayBus } from './postgres'

type Result = { rows: Array<Record<string, unknown>> }
type Query = string | { text: string; query_timeout?: number }
type Controls = { absent?: boolean; holdInitial?: boolean; holdEnd?: boolean; holdResponse?: boolean; failCancel?: boolean; diesBeforeWait?: boolean }
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

/** Only transport timing is controlled here. Real PG lock behavior is covered
 * separately by postgres.db.test.ts against the required isolated PG17 job. */
class ControlledClient extends EventEmitter {
  connection = new EventEmitter()
  backend = { processID: Math.floor(Math.random() * 100000) + 1, secretKey: 42 }
  queries: Query[] = []
  cancellations = 0
  ending = false
  ended = false
  failPublish = false
  initial = Promise.withResolvers<Result>()
  waiting = Promise.withResolvers<Result>()
  endGate = Promise.withResolvers<void>()
  constructor(readonly options: ClientConfig, readonly controls: Controls) { super() }
  async connect() { this.connection.emit('backendKeyData', this.backend) }
  query(query: Query): Promise<Result> {
    this.queries.push(query)
    const text = typeof query === 'string' ? query : query.text
    if (text.includes('pg_try_advisory_lock_shared')) {
      if (this.controls.holdInitial) return this.response(this.initial.promise)
      return this.response(Promise.resolve({ rows: [{ absent: this.controls.absent ?? false }] }))
    }
    if (text.includes('pg_advisory_lock_shared')) return this.response(this.controls.diesBeforeWait
      ? Promise.resolve({ rows: [{}] }) : this.waiting.promise)
    if (text.includes('pg_try_advisory_lock')) return this.response(Promise.resolve({ rows: [{ held: true }] }))
    if (text.includes('pg_notify') && this.failPublish) return Promise.reject(new Error('isolated publish failure'))
    return this.response(Promise.resolve({ rows: [] }))
  }
  private response(promise: Promise<Result>) {
    return promise.then(result => { this.connection.emit('readyForQuery'); return result }, error => {
      if (this.cancellations) this.connection.emit('readyForQuery')
      throw error
    })
  }
  end() {
    if (this.ending) return this.endGate.promise
    this.ending = true
    // A socket close is not a server ReadyForQuery. Tests must distinguish
    // actual cancellation acknowledgement from local transport teardown.
    this.initial.reject(new Error('isolated connection closed'))
    this.waiting.reject(new Error('isolated connection closed'))
    if (!this.controls.holdEnd) this.endGate.resolve()
    void this.endGate.promise.then(() => { this.ended = true; this.emit('end') })
    return this.endGate.promise
  }
}

function transport(controls: Controls = {}) {
  const clients: ControlledClient[] = []
  const bus = new PostgresGatewayBus({}, options => {
    const client = new ControlledClient(options, options.application_name?.startsWith('mikka-gateway-watch:') ? controls : {})
    // A test may close before either controlled query has started.
    void client.initial.promise.catch(() => {})
    void client.waiting.promise.catch(() => {})
    clients.push(client)
    return client as unknown as Client
  }, async (options, backend) => {
    const client = clients.find(item => item.options === options)!
    assert.deepEqual(backend, client.backend, 'cancel only the key from this exact waiter session')
    client.cancellations++
    if (client.controls.failCancel) throw new Error('isolated cancellation transport unavailable')
    if (!client.controls.holdResponse) {
      client.initial.reject(new Error('isolated server cancelled query'))
      client.waiting.reject(new Error('isolated server cancelled query'))
    }
  })
  return { bus, clients, watchers: () => clients.filter(client => client.options.application_name?.startsWith('mikka-gateway-watch:')),
    async stop() { for (const client of clients) client.endGate.resolve(); await bus.stop() } }
}

test('source leases precede LISTEN and equal callbacks retain distinct shared waiter references', async t => {
  const wire = transport(); t.after(() => wire.stop())
  await wire.bus.ready()
  assert.match(String(wire.clients[0].queries[0]), /pg_try_advisory_lock/)
  assert.match(String(wire.clients[0].queries[1]), /^LISTEN /)
  const source = randomUUID(), lost = () => {}
  const first = await wire.bus.observe(source, lost), second = await wire.bus.observe(source, lost)
  assert.equal(wire.watchers().length, 1)
  assert.notEqual(wire.watchers()[0], wire.clients[0], 'the blocking waiter never occupies the LISTEN/publish session')
  first()
  assert.equal(wire.watchers()[0].ending, false, 'another reference with the same callback still owns the waiter')
  second(); await flush()
  assert.equal(wire.watchers()[0].ended, true)
  assert.equal(wire.watchers()[0].cancellations, 1)
})

test('a missing source is rejected and source death between try and blocking wait cannot lose its notification', async t => {
  for (const controls of [{ absent: true }, { diesBeforeWait: true }]) {
    const wire = transport(controls); t.after(() => wire.stop())
    await wire.bus.ready()
    let lost = 0
    const pending = wire.bus.observe(randomUUID(), () => { lost++ })
    if ('absent' in controls) await assert.rejects(pending)
    else {
      // PG can deliver the release just after observe returns; either order
      // must revoke that same subscription exactly once, never lose the edge.
      const release = await pending.catch(() => undefined)
      await flush()
      release?.()
    }
    assert.equal(lost, 1)
    assert.equal(wire.watchers()[0].ending, true, 'an acquired shared lock is released immediately')
  }
})

test('unwatch aborts a pending initial lease query and releases its client before readiness', async t => {
  const wire = transport({ holdInitial: true }); t.after(() => wire.stop())
  await wire.bus.ready()
  const controller = new AbortController()
  let lost = 0
  const pending = wire.bus.observe(randomUUID(), () => { lost++ }, controller.signal)
  await flush()
  assert.equal(wire.watchers().length, 1)
  controller.abort()
  await assert.rejects(pending)
  await flush()
  assert.equal(wire.watchers()[0].ending, true)
  assert.equal(lost, 0, 'a cancelled subscriber does not receive a late loss callback')
})

test('a completed lock wait revokes all current observers once and closes its session', async t => {
  const wire = transport(); t.after(() => wire.stop())
  await wire.bus.ready()
  const source = randomUUID()
  let lost = 0
  await wire.bus.observe(source, () => { lost++ })
  await wire.bus.observe(source, () => { lost++ })
  wire.watchers()[0].waiting.resolve({ rows: [{}] })
  await flush()
  assert.equal(lost, 2)
  assert.equal(wire.watchers()[0].ended, true)
  const initial = wire.watchers()[0].queries.find(query => typeof query !== 'string' && query.text.includes('pg_try_advisory_lock_shared'))
  assert.equal(typeof initial !== 'string' && initial?.query_timeout, 5000)
  assert.equal(wire.watchers()[0].options.query_timeout, 0, 'only initialization is timed; the lifetime wait is not a polling timer')
  assert.ok(wire.watchers()[0].queries.some(query => typeof query !== 'string' && query.text.includes('SET client_connection_check_interval = 1000')),
    'only dedicated waiters check their kernel socket inside PG; no periodic SQL is sent')
  assert.equal(wire.watchers()[0].cancellations, 0, 'a completed wait ends immediately without another cancellation connection')
})

test('the source limit includes clients still closing during repeated watch/unwatch', async t => {
  const wire = transport({ holdEnd: true }); t.after(() => wire.stop())
  await wire.bus.ready()
  for (let index = 0; index < MAX_PRESENCE_SOURCES; index++) (await wire.bus.observe(randomUUID(), () => {}))()
  await flush()
  assert.equal(wire.watchers().length, MAX_PRESENCE_SOURCES)
  assert.ok(wire.watchers().every(client => client.ending && !client.ended))
  await assert.rejects(wire.bus.observe(randomUUID(), () => {}))
  assert.equal(wire.watchers().length, MAX_PRESENCE_SOURCES)
  for (const client of wire.watchers()) client.endGate.resolve()
  await flush()
  const release = await wire.bus.observe(randomUUID(), () => {})
  assert.equal(wire.watchers().length, MAX_PRESENCE_SOURCES + 1)
  release()
})

test('cancellation waits for the original server response before freeing the client and capacity', async t => {
  const wire = transport({ holdResponse: true }); t.after(() => wire.stop())
  await wire.bus.ready()
  const release = await wire.bus.observe(randomUUID(), () => {})
  release(); await flush()
  const waiter = wire.watchers()[0]
  assert.equal(waiter.cancellations, 1)
  assert.equal(waiter.ending, false, 'a successful CancelRequest socket close is not acknowledgement from the query backend')
  waiter.waiting.reject(new Error('isolated server cancellation response'))
  await flush()
  assert.equal(waiter.ended, true)
})

test('unconfirmed cancellation retains its capacity reservation instead of leaking unbounded server waiters', async t => {
  const wire = transport({ failCancel: true }); t.after(() => wire.stop())
  await wire.bus.ready()
  for (let index = 0; index < MAX_PRESENCE_SOURCES; index++) (await wire.bus.observe(randomUUID(), () => {}))()
  await flush()
  assert.ok(wire.watchers().every(client => client.ended))
  await assert.rejects(wire.bus.observe(randomUUID(), () => {}))
  assert.equal(wire.watchers().length, MAX_PRESENCE_SOURCES, 'local socket closure alone cannot reclaim an unconfirmed server slot')
})

test('failed publishing ends the protected source session and cancels observers instead of keeping a false ACK', async t => {
  const wire = transport(); t.after(() => wire.stop())
  await wire.bus.ready()
  let listenerLost = 0, sourceLost = 0
  wire.bus.subscribe(() => {}, () => { listenerLost++ })
  await wire.bus.observe(randomUUID(), () => { sourceLost++ })
  wire.clients[0].failPublish = true
  await assert.rejects(wire.bus.publish({ type: 'work', key: randomUUID() }))
  await flush()
  assert.equal(listenerLost, 1)
  assert.equal(sourceLost, 1)
  assert.ok(wire.clients.every(client => client.ended))
})
