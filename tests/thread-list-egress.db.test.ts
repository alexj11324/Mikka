import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { RunFailure } from '@mikka/protocol/run-failure'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { measured, readMetrics } from './helpers/read-metrics'
import { mergeList, type ListPosition } from '../lib/list-poll'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw Error('Thread list requires a disposable loopback *_e2e database')

test('quiet thread polls return only a version; visible changes and online state still invalidate', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const actions = await import('../app/actions/task-runs')
  const owner = `thread-egress-${randomUUID()}`, peer = `thread-peer-${randomUUID()}`
  const device = randomUUID(), agent = randomUUID(), ids = Array.from({ length: 119 }, () => randomUUID())
  const poll = (known?: string, positions?: readonly ListPosition[]): ReturnType<typeof actions.pollThreads> => withActivitySession(owner, () => actions.pollThreads(known, positions))
  try {
    for (const user of [owner, peer]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    await seedFixtureWorkspace(pool, peer)
    await pool.query('INSERT INTO devices(id,"ownerId",name,"lastSeenAt") VALUES($1,$2,$3,now())', [device, owner, 'Fixture machine'])
    await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,$4)', [agent, owner, 'Fixture bot', 'codex'])
    for (const [index, id] of ids.entries()) await pool.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId",prompt,"lastReply",status,"workspaceId") VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id, owner, agent, device, `Fixture ${index} ` + 'p'.repeat(200), 'r'.repeat(240), 'queued', workspaceId])
    await poll() // Warm pool connections; cold below means no browser snapshot.
    const cold = await measured(() => poll()), first = cold.value, fullBytes = cold.bytes
    assert.equal(first.items?.length, 119)
    assert.equal(first.items?.[0].id, ids.at(-1), 'existing latest-created ordering remains')
    assert.equal(first.items?.some(row => row.waitingFor), false)
    const warm = await measured(() => poll(first.version)), quiet = warm.value, quietBytes = warm.bytes
    assert.ok('unchanged' in quiet && quiet.unchanged); assert.equal(quiet.items, undefined)
    assert.ok(quietBytes < fullBytes / 3, `quiet ${quietBytes} vs first ${fullBytes}`)
    const legacyReload = await measured(() => poll())
    const restored = await measured(() => poll(first.version, first.positions))
    assert.ok('unchanged' in restored.value && restored.value.unchanged)
    assert.equal((await poll(first.version, [{ id: 'invalid-row', version: first.version }])).items?.length, 119, 'an invalid row proof cannot acknowledge an incomplete local snapshot')
    await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [device])
    const heartbeat = await poll(first.version)
    assert.ok('unchanged' in heartbeat && heartbeat.unchanged, 'ordinary heartbeats do not invalidate visible thread rows')
    await pool.query('UPDATE devices SET "lastSeenAt"=now()-interval \'2 minutes\' WHERE id=$1', [device])
    const offline = await poll(first.version)
    assert.ok(offline.items?.every(row => row.waitingFor?.deviceId === device))
    await pool.query('UPDATE devices SET kind=\'cloud\' WHERE id=$1', [device])
    const cloud = await poll(offline.version)
    assert.equal(cloud.items?.some(row => row.waitingFor), false, 'cloud sandboxes never ask the person to turn them on')
    await pool.query('UPDATE agent_runs SET error=$2 WHERE id=$1', [ids[0], 'Changed without timestamp update'])
    const detailOnly = await poll(cloud.version, cloud.positions)
    assert.ok('unchanged' in detailOnly && detailOnly.unchanged, 'a detail-only error no longer invalidates or transfers the thread list')
    assert.equal(detailOnly.items, undefined)
    await pool.query('UPDATE agent_runs SET prompt=$2 WHERE id=$1', [ids[0], 'Visible change without timestamp update'])
    const delta = await measured(() => poll(cloud.version, cloud.positions))
    assert.equal(delta.value.delta, true)
    assert.deepEqual(delta.value.items?.map(row => row.id), [ids[0]])
    const changed = await poll(cloud.version)
    assert.ok(changed.items?.some(row => row.prompt === 'Visible change without timestamp update'))
    assert.deepEqual(mergeList(cloud.items!, delta.value), changed.items)
    await pool.query('UPDATE agent_runs SET "lastReply"=$2,"lastReplyAt"=now() WHERE id=$1', [ids[0], 'Latest reply'])
    const replied = await poll(changed.version)
    assert.equal(replied.items?.[0].id, ids[0]); assert.equal(replied.items?.[0].lastReply, 'Latest reply')
    await pool.query('UPDATE agents SET name=$2 WHERE id=$1', [agent, 'Renamed bot'])
    const renamed = await poll(replied.version)
    assert.ok(renamed.items?.every(row => row.agentName === 'Renamed bot'))
    const foreign = await withActivitySession(peer, () => actions.pollThreads(renamed.version, renamed.positions))
    assert.deepEqual(foreign.items, []); assert.notEqual(foreign.version, renamed.version)
    await assert.rejects(actions.pollThreads(renamed.version), /authRequired/)
    const failureDetails: RunFailure = { schemaVersion: 1, code: 'run_api_key_invalid', category: 'api_key', provider: 'openai', status: 401,
      providerMessage: 'Private provider response that lists must omit', causes: [{ name: 'APIError' }],
      runId: ids[2], appVersion: 'test', occurredAt: '2026-11-07T12:00:00.000Z' }
    await pool.query('UPDATE agent_runs SET "failureDetails"=$2 WHERE id=$1', [ids[2], JSON.stringify(failureDetails)])
    const failureDelta = await measured(() => poll(renamed.version, renamed.positions))
    assert.notEqual(failureDelta.value.version, renamed.version, 'diagnostic changes without a timestamp invalidate the same snapshot')
    assert.deepEqual(failureDelta.value.items?.map(row => row.id), [ids[2]])
    assert.equal(failureDelta.value.items?.[0].failureDetails?.code, 'run_api_key_invalid')
    assert.doesNotMatch(JSON.stringify(failureDelta.value.items), /Private provider response|APIError/)
    assert.equal(failureDelta.statements, delta.statements, 'diagnostic deltas keep the existing query count')
    await pool.query('UPDATE agent_runs SET "failureDetails"=$2 WHERE id=$1', [ids[2], JSON.stringify({ ...failureDetails, providerMessage: 'Changed private text only' })])
    const privateOnly = await poll(failureDelta.value.version, failureDelta.value.positions)
    assert.ok('unchanged' in privateOnly && privateOnly.unchanged, 'unexposed text does not invalidate a compact list')
    await pool.query('UPDATE agent_runs SET "failureDetails"=null WHERE id=$1', [ids[2]])
    assert.equal((await poll(renamed.version, renamed.positions)).items, undefined)
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [ids[0]])
    const deletion = await measured(() => poll(renamed.version, renamed.positions))
    assert.equal(deletion.value.items?.length, 0)
    const remaining = mergeList(renamed.items!, deletion.value)
    assert.equal(remaining.length, 118)
    await pool.query('UPDATE agent_runs SET "createdAt"=now()-interval \'31 days\' WHERE id=$1', [ids[1]])
    const expired = await poll(deletion.value.version, deletion.value.positions)
    assert.equal(expired.items?.length, 0)
    assert.equal(mergeList(remaining, expired).length, 117, 'the next read removes a row that aged out of the thirty-day window')
    t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'thread-list', scope: 'data-read-path_not_page_http', fixtureRows: 119,
      legacyReload: readMetrics(legacyReload), cold: readMetrics(cold), warmKnown: readMetrics(warm), reloadRestored: readMetrics(restored), oneRowDelta: readMetrics(delta), deletion: readMetrics(deletion) }))
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM devices WHERE id=$1', [device])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=ANY($1::text[])', [[owner, peer]])
    await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=ANY($1::text[])', [[owner, peer]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
    await pool.end()
  }
})
