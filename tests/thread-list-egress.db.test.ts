import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw Error('Thread list requires a disposable loopback *_e2e database')
const sockets = new Set<Socket>(), original = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  sockets.add(this); return Reflect.apply(original, this, args)
} as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)

test('quiet thread polls return only a version; visible changes and online state still invalidate', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const actions = await import('../app/actions/task-runs')
  const owner = `thread-egress-${randomUUID()}`, peer = `thread-peer-${randomUUID()}`
  const device = randomUUID(), agent = randomUUID(), ids = Array.from({ length: 119 }, () => randomUUID())
  const poll = (known?: string): ReturnType<typeof actions.pollThreads> => withActivitySession(owner, () => actions.pollThreads(known))
  try {
    await pool.query('INSERT INTO devices(id,"ownerId",name,"lastSeenAt") VALUES($1,$2,$3,now())', [device, owner, 'Fixture machine'])
    await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,$4)', [agent, owner, 'Fixture bot', 'codex'])
    for (const [index, id] of ids.entries()) await pool.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId",prompt,"lastReply",status) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, owner, agent, device, `Fixture ${index} ` + 'p'.repeat(200), 'r'.repeat(240), 'queued'])
    const start = received(), first = await poll(), fullBytes = received() - start
    assert.equal(first.items?.length, 119)
    assert.equal(first.items?.[0].id, ids.at(-1), 'existing latest-created ordering remains')
    assert.equal(first.items?.some(row => row.waitingFor), false)
    const before = received(), quiet = await poll(first.version), quietBytes = received() - before
    assert.equal(quiet.unchanged, true); assert.equal(quiet.items, undefined)
    assert.ok(quietBytes < fullBytes / 3, `quiet ${quietBytes} vs first ${fullBytes}`)
    await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [device])
    assert.equal((await poll(first.version)).unchanged, true, 'ordinary heartbeats do not invalidate visible thread rows')
    await pool.query('UPDATE devices SET "lastSeenAt"=now()-interval \'2 minutes\' WHERE id=$1', [device])
    const offline = await poll(first.version)
    assert.ok(offline.items?.every(row => row.waitingFor?.deviceId === device))
    await pool.query('UPDATE devices SET kind=\'cloud\' WHERE id=$1', [device])
    const cloud = await poll(offline.version)
    assert.equal(cloud.items?.some(row => row.waitingFor), false, 'cloud sandboxes never ask the person to turn them on')
    await pool.query('UPDATE agent_runs SET error=$2 WHERE id=$1', [ids[0], 'Changed without timestamp update'])
    const changed = await poll(cloud.version)
    assert.equal(changed.unchanged, true, 'a detail-only error no longer invalidates or transfers the thread list')
    assert.equal(changed.items, undefined)
    await pool.query('UPDATE agent_runs SET "lastReply"=$2,"lastReplyAt"=now() WHERE id=$1', [ids[0], 'Latest reply'])
    const replied = await poll(changed.version)
    assert.equal(replied.items?.[0].id, ids[0]); assert.equal(replied.items?.[0].lastReply, 'Latest reply')
    await pool.query('UPDATE agents SET name=$2 WHERE id=$1', [agent, 'Renamed bot'])
    const renamed = await poll(replied.version)
    assert.ok(renamed.items?.every(row => row.agentName === 'Renamed bot'))
    const foreign = await withActivitySession(peer, () => actions.pollThreads(renamed.version))
    assert.deepEqual(foreign.items, []); assert.notEqual(foreign.version, renamed.version)
    await assert.rejects(actions.pollThreads(renamed.version), /authRequired/)
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [ids[0]])
    assert.equal((await poll(renamed.version)).items?.length, 118)
    t.diagnostic(JSON.stringify({ fixtureRows: 119, fullDatabaseSocketBytes: fullBytes, quietDatabaseSocketBytes: quietBytes, measurement: 'isolated_pg_socket_not_provider_billing' }))
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM devices WHERE id=$1', [device])
    await pool.end()
  }
})
