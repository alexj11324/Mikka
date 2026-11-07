import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { GatewayHub, type GatewayPeer } from './hub'
import { PostgresGatewayBus } from './postgres'
import { builtinGatewayConfig } from './config'
import { gatewayUpgrade } from './request'
import { sessionLiveTicket } from '../live/session-ticket'
import { liveChannelId } from '../live/scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs an isolated PostgreSQL database')
if (url) assert.ok(isE2eTarget(url), 'session revocation tests require a loopback *_e2e database')

function peer() {
  const messages: string[] = [], closes: number[] = [], closed = Promise.withResolvers<void>()
  const value: GatewayPeer = { id: randomUUID(), send: message => messages.push(message), close(code) { closes.push(code); closed.resolve() } }
  return { value, messages, closes, closed: closed.promise }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('isolated gateway notification timed out')), 3_000) })])
  } finally { clearTimeout(timer) }
}

async function barrier(receiver: PostgresGatewayBus, sender: PostgresGatewayBus) {
  const key = randomUUID(), delivered = Promise.withResolvers<void>()
  const stop = receiver.subscribe(message => { if (message.type === 'work' && message.key === key) delivered.resolve() }, () => delivered.reject(new Error('isolated gateway listener ended')))
  try { await sender.publish({ type: 'work', key }); await bounded(delivered.promise) } finally { stop() }
}

test('PG17: committed session deletion closes all replicas, denies ticket replay, and leaves other sessions live', { skip: !url, timeout: 30_000 }, async t => {
  // Refuse unsafe targets before constructing any client, including the buses.
  assert.ok(isE2eTarget(url))
  const database = new Pool({ connectionString: url, max: 2 })
  const firstBus = new PostgresGatewayBus({ connectionString: url }), secondBus = new PostgresGatewayBus({ connectionString: url })
  const first = new GatewayHub(firstBus, Date.now, '', id => firstBus.authorizeSession(id))
  const second = new GatewayHub(secondBus, Date.now, '', id => secondBus.authorizeSession(id))
  const userId = `live-session-${randomUUID()}`, sessionId = randomUUID(), otherId = randomUUID(), expiredId = randomUUID(), racingId = randomUUID()
  const env = { BETTER_AUTH_URL: 'https://self.example', BETTER_AUTH_SECRET: 'isolated-session-revocation-fixture' }
  const config = builtinGatewayConfig(env)!
  const channel = liveChannelId({ ownerId: userId, workspaceId: randomUUID() })
  t.after(async () => {
    first.stop(); second.stop()
    await Promise.all([firstBus.stop(), secondBus.stop()])
    await database.query('DELETE FROM "user" WHERE id=$1', [userId])
    await database.end()
  })
  await database.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
  for (const id of [sessionId, otherId, expiredId, racingId]) {
    await database.query('INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,now(),now())',
      [id, userId, randomUUID(), new Date(Date.now() + (id === expiredId ? -60_000 : 3_600_000))])
  }
  await Promise.all([firstBus.ready(), secondBus.ready()])
  const ticket = sessionLiveTicket(channel, sessionId, config.secret)
  const request = (protocol = ticket.protocol) => new Request(`https://self.example/mikka/v1/live/${channel}/socket`, {
    headers: { host: 'self.example', origin: 'https://webapp.aspectlylabs.com', upgrade: 'websocket', 'sec-websocket-protocol': protocol },
  })
  const admitted = gatewayUpgrade(request(), env)
  assert.ok(!(admitted instanceof Response))
  assert.equal(await first.authorize(admitted.socket), true)
  assert.equal(await firstBus.authorizeSession(expiredId), false)
  assert.equal(await firstBus.authorizeSession(randomUUID()), false)
  const a = peer(), b = peer(), other = peer()
  await first.open(a.value, admitted.socket)
  await second.open(b.value, admitted.socket)
  await second.open(other.value, { ...admitted.socket, sessionId: otherId })
  assert.equal(JSON.parse(a.messages[0]).type, 'live_ready')
  assert.equal(JSON.parse(b.messages[0]).type, 'live_ready')

  const transaction = await database.connect()
  try {
    await transaction.query('BEGIN')
    await transaction.query('DELETE FROM "session" WHERE id=$1', [sessionId])
    await transaction.query('ROLLBACK')
    await Promise.all([barrier(firstBus, secondBus), barrier(secondBus, firstBus)])
    assert.deepEqual(a.closes, []); assert.deepEqual(b.closes, [])
    assert.equal(await first.authorize(admitted.socket), true, 'a rolled-back revoke has no effect')
    await transaction.query('BEGIN')
    await transaction.query('DELETE FROM "session" WHERE id=$1', [sessionId])
    assert.equal(await first.authorize(admitted.socket), true, 'uncommitted deletion cannot revoke another connection')
    await transaction.query('COMMIT')
  } finally { await transaction.query('ROLLBACK'); transaction.release() }
  await bounded(Promise.all([a.closed, b.closed]))
  assert.equal(a.closes.length, 1); assert.equal(b.closes.length, 1)
  assert.deepEqual(other.closes, [], 'a second session of the same owner remains live')
  const replay = gatewayUpgrade(request(), env)
  assert.ok(!(replay instanceof Response), 'the unexpired signature alone is intentionally insufficient')
  assert.equal(await first.authorize(replay.socket), false, 'the upgrade authorizer freshly rejects the deleted session')
  const denied = peer()
  await first.open(denied.value, replay.socket)
  assert.equal(denied.closes.length, 1); assert.deepEqual(denied.messages, [])
  const before = a.messages.length
  await first.live(channel, [{ kind: 'thread', id: randomUUID(), rev: 5 }])
  await barrier(secondBus, firstBus)
  assert.equal(a.messages.length, before)
  assert.equal(JSON.parse(other.messages.at(-1)!).kind, 'thread')
  assert.equal((gatewayUpgrade(request(ticket.protocol), env, ticket.expiresAt) as Response).status, 401)
  assert.equal((gatewayUpgrade(request('mikka-ticket-invalid'), env) as Response).status, 401)

  // The fresh query may complete before DELETE while open awaits its result.
  // The trigger must still find and remove the already registered connection.
  const checked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const racing = new GatewayHub(firstBus, Date.now, '', async id => {
    const allowed = await firstBus.authorizeSession(id)
    checked.resolve(); await release.promise
    return allowed
  })
  t.after(() => racing.stop())
  const late = peer(), opening = racing.open(late.value, { ...admitted.socket, sessionId: racingId })
  try {
    await bounded(checked.promise)
    await database.query('DELETE FROM "session" WHERE id=$1', [racingId])
    await bounded(late.closed)
  } finally { release.resolve(); await opening }
  assert.deepEqual(late.messages, [], 'a successful query result cannot revive the revoked connection')

  // Better Auth user deletion uses an FK cascade rather than a session endpoint.
  await database.query('DELETE FROM "user" WHERE id=$1', [userId])
  await bounded(other.closed)
  assert.equal(other.closes.length, 1, 'the same database trigger covers account deletion cascades')
})
