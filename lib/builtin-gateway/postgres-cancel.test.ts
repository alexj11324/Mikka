import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Client } from 'pg'
import { cancelGatewayQuery } from './postgres-cancel'

function transport(ssl: boolean, direct = false) {
  const calls: string[] = [], key = { processID: 12345, secretKey: 42 }
  const connection = Object.assign(new EventEmitter(), {
    sslNegotiation: direct ? 'direct' : 'postgres',
    stream: { destroy() { calls.push('destroy') } },
    connect() { calls.push('connect') },
    requestSsl() { calls.push('ssl-request') },
    cancel(processID: number, secretKey: number) { assert.deepEqual({ processID, secretKey }, key); calls.push('cancel') },
  })
  const client = { host: 'isolated.test', port: 5432, ssl, connection } as unknown as Client
  const pending = cancelGatewayQuery({}, key, () => client)
  return { connection, calls, pending }
}

test('cancellation preserves ordinary TLS negotiation and waits for the cancellation transport to close', async () => {
  const wire = transport(true)
  wire.connection.emit('connect')
  assert.deepEqual(wire.calls, ['connect', 'ssl-request'])
  wire.connection.emit('sslconnect')
  assert.deepEqual(wire.calls, ['connect', 'ssl-request', 'cancel'])
  wire.connection.emit('end')
  await wire.pending
})

test('direct TLS waits for the pg transport handshake without a plaintext SSLRequest or cancellation', async () => {
  const wire = transport(true, true)
  wire.connection.emit('connect')
  assert.deepEqual(wire.calls, ['connect'])
  wire.connection.emit('sslconnect')
  assert.deepEqual(wire.calls, ['connect', 'cancel'])
  wire.connection.emit('end')
  await wire.pending
})

test('a refused TLS handshake never downgrades or sends the backend cancellation key', async () => {
  const wire = transport(true)
  wire.connection.emit('connect')
  wire.connection.emit('error', new Error('isolated certificate refusal'))
  wire.connection.emit('sslconnect')
  await assert.rejects(wire.pending, { message: 'BUILTIN_GATEWAY_CANCEL_UNAVAILABLE' })
  assert.deepEqual(wire.calls, ['connect', 'ssl-request', 'destroy'])
})

test('an unencrypted configured transport sends only CancelRequest and has a bounded cancellation deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const wire = transport(false)
  wire.connection.emit('connect')
  assert.deepEqual(wire.calls, ['connect', 'cancel'])
  t.mock.timers.tick(5_000)
  await assert.rejects(wire.pending, { message: 'BUILTIN_GATEWAY_CANCEL_UNAVAILABLE' })
  assert.deepEqual(wire.calls, ['connect', 'cancel', 'destroy'])
})
