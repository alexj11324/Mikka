import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Duplex } from 'node:stream'
import { Client, type PoolClient } from 'pg'
import { cancelMailboxBackend } from './mailbox-pg-cancel'

const original = (ssl: unknown = false, sslnegotiation = 'postgres') => ({ processID: 321, secretKey: -12345,
  connectionParameters: { host: '127.0.0.1', port: 55587, ssl, sslnegotiation } }) as unknown as PoolClient
function wire() {
  const calls: unknown[] = []
  const w = Object.assign(new EventEmitter(), {
    stream: { destroy() { calls.push('destroy') } },
    connect(...args: unknown[]) { calls.push(args); queueMicrotask(() => w.emit('connect')) },
    requestSsl() { calls.push('SSLRequest') },
    cancel(pid: number, key: number) { calls.push({ pid, key }); queueMicrotask(() => w.emit('end')) },
  })
  return { w, calls }
}
test('real pg connection serializer sends only the 16-byte keyed CancelRequest, no startup/password/SQL', async () => {
  const frames: Buffer[] = []
  class MemorySocket extends Duplex {
    _read() {}
    _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { frames.push(Buffer.from(chunk)); done(); queueMicrotask(() => this.emit('close')) }
    setNoDelay() { return this }
    connect(port: number, host: string) { assert.equal(port, 55587); assert.equal(host, '127.0.0.1'); queueMicrotask(() => this.emit('connect')); return this }
  }
  const result = await cancelMailboxBackend(original(), options => (new Client({ ...options, stream: new MemorySocket() } as never) as unknown as { connection: ReturnType<NonNullable<Parameters<typeof cancelMailboxBackend>[1]>> }).connection)
  assert.equal(result, 'closed-after-send'); assert.equal(frames.length, 1)
  assert.deepEqual([...Array(4)].map((_, i) => frames[0].readInt32BE(i * 4)), [16, 80877102, 321, -12345])
})
test('real pg Client.end with an active query only destroys the local stream; it does not emit CancelRequest', () => {
  const frames: Buffer[] = []
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { frames.push(Buffer.from(chunk)); done() } })
  const client = new Client({ stream: socket } as never) as unknown as { connection: { _connecting: boolean }; _activeQuery: unknown; end(callback: () => void): void }
  client.connection._connecting = true; client._activeQuery = {}
  client.end(() => {})
  assert.equal(socket.destroyed, true); assert.equal(frames.length, 0)
})
test('TLS reuses the original verified options; cancellation key is not sent before SSL negotiation', async () => {
  for (const negotiation of ['postgres', 'direct']) {
    const { w, calls } = wire(), ssl = { ca: 'synthetic-ca', rejectUnauthorized: true }
    const pending = cancelMailboxBackend(original(ssl, negotiation), options => { assert.equal(options.ssl, ssl); assert.equal(options.host, '127.0.0.1'); assert.equal(options.port, 55587); return w })
    await Promise.resolve(); assert.equal(calls.some(x => typeof x === 'object' && x !== null && 'key' in x), false)
    assert.equal(calls.includes('SSLRequest'), negotiation === 'postgres')
    w.emit('sslconnect'); assert.equal(await pending, 'closed-after-send')
  }
})
test('SSL failure never falls back to plaintext and unsupported/ambient identities never open a control connection', async () => {
  const { w, calls } = wire(), pending = cancelMailboxBackend(original(true), () => w)
  await Promise.resolve(); w.emit('error', Error('Synthetic certificate refusal'))
  assert.equal(await pending, 'failed'); assert.equal(calls.some(x => typeof x === 'object' && x !== null && 'key' in x), false)
  for (const value of [{}, { ...original(), processID: 0 }, { ...original(), secretKey: undefined }, original({ rejectUnauthorized: false })]) {
    assert.equal(await cancelMailboxBackend(value as PoolClient, () => { throw Error('must not connect') }), 'unavailable')
  }
})
test('a blackholed cancel connection has a 1000ms bound, destroys only itself and does not claim backend cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { w, calls } = wire(); w.cancel = () => { calls.push('sent-without-ack') }
  const pending = cancelMailboxBackend(original(), () => w); await Promise.resolve(); t.mock.timers.tick(1001)
  assert.equal(await pending, 'timeout'); assert.equal(calls.filter(x => x === 'destroy').length, 1)
  w.emit('error', Error('late transport error')); assert.equal(calls.filter(x => x === 'destroy').length, 1)
})
