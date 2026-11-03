import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'

// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('a heartbeat re-checks execution identities only when the harnesses change or the device comes back, and renews the leases of the runs it reports', async t => {
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const [{ createRequestDatabaseScope, pool }, { POST }] = await Promise.all([import('./db'), import('../app/v1/devices/[deviceId]/heartbeat/route')])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-heartbeat-${randomUUID()}`
  const device = randomUUID(), run = randomUUID(), stranger = randomUUID()
  const token = `orv_${randomBytes(32).toString('base64url')}`
  t.after(async () => {
    await scope.run(async () => {
      await pool.query('delete from agent_runs where "userId"=$1', [owner])
      await pool.query('delete from agents where "userId"=$1', [owner])
      await pool.query('delete from device_token_devices where "deviceId"=$1', [device]).catch(() => undefined)
      await pool.query('delete from device_tokens where "userId"=$1', [owner])
      await pool.query('delete from devices where "ownerId"=$1', [owner])
      await pool.query('delete from "user" where id=$1', [owner])
    })
    await scope.close()
  })
  const codex = { harness: 'codex', installed: true, version: '1.0.0' }
  const claude = { harness: 'claude_code', installed: true, version: '2.1.0' }
  const beat = async (body: Record<string, unknown>, version = '0.0.375') => {
    const response = await POST(new Request(`http://127.0.0.1/v1/devices/${device}/heartbeat`, {
      method: 'POST', headers: { 'x-mikka-client-version': version, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ runs: [], worktreeDiskBytes: 0, ...body }),
    }), { params: Promise.resolve({ deviceId: device }) })
    assert.equal(response.status, 200)
    return await response.json() as { leases: Record<string, string>; revoked?: string[] }
  }
  await scope.run(async () => {
    await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Heartbeat fixture', $1 || '@example.invalid', false, now(), now())`, [owner])
    await pool.query(`insert into devices (id, name, "ownerId", harnesses, "lastSeenAt", "updateFailure") values ($1, 'mine', $2, $3, now(), $4)`,
      [device, owner, JSON.stringify([codex]), JSON.stringify({ code: 'download_failed' })])
    await pool.query(`insert into device_tokens (id, "userId", "tokenHash") values ($1, $2, $3)`, [randomUUID(), owner, createHash('sha256').update(token).digest('hex')])
    const identities = async () => (await pool.query(`select harness from agents where "userId"=$1 and "deviceId"=$2 order by harness`, [owner, device])).rows.map(row => row.harness)
    const seen = async () => (await pool.query(`select "lastSeenAt", "deviceType", "updateFailure", harnesses from devices where id=$1`, [device])).rows[0]

    // Online with unchanged harnesses: the identities are taken as checked.
    const before = (await seen()).lastSeenAt
    const idle = await beat({ harnesses: [codex] })
    assert.deepEqual([idle.leases, idle.revoked], [{}, []], 'an idle device has no leases')
    const after = await seen()
    assert.ok(after.lastSeenAt > before, 'the beat records the device as seen')
    assert.deepEqual(after.updateFailure, { code: 'download_failed' }, 'a beat without an update result keeps the last one')
    assert.deepEqual(await identities(), [], 'unchanged harnesses on an online device: no re-check')

    // The identity check fails: the beat fails (Next answers 500) and the new harnesses
    // are not stored, so the next beat still sees a change and checks again.
    const guard = `heartbeat_test_${randomUUID().replaceAll('-', '')}`
    await pool.query(`create function ${guard}() returns trigger language plpgsql as $$ begin raise exception 'identity check failed'; end $$`)
    await pool.query(`create trigger ${guard} before insert on agents for each row when (NEW."userId" = '${owner}') execute function ${guard}()`)
    try {
      await assert.rejects(beat({ harnesses: [codex, claude] }), /identity check failed/)
    } finally {
      await pool.query(`drop trigger ${guard} on agents`)
      await pool.query(`drop function ${guard}()`)
    }
    assert.deepEqual((await seen()).harnesses.map((info: { harness: string }) => info.harness), ['codex'], 'the harnesses stay as last checked')
    assert.deepEqual(await identities(), [])

    // A harness appears (the beat after the failure): the identities follow at once.
    await beat({ harnesses: [codex, claude], deviceType: 'server', updateFailure: null })
    assert.deepEqual(await identities(), ['claude_code', 'codex'])
    const changed = await seen()
    assert.equal(changed.deviceType, 'server')
    assert.equal(changed.updateFailure, null, 'a successful update clears the failure')
    assert.deepEqual(changed.harnesses.map((info: { harness: string }) => info.harness), ['codex', 'claude_code'])

    // A harness goes away: its identity loses the device.
    await beat({ harnesses: [claude] })
    assert.deepEqual(await identities(), ['claude_code'])

    // Back after being offline, same harnesses: checked again.
    await pool.query(`update agents set "deviceId"=null where "userId"=$1`, [owner])
    await pool.query(`update devices set "lastSeenAt"=now() - interval '10 minutes' where id=$1`, [device])
    await beat({ harnesses: [claude] })
    assert.deepEqual(await identities(), ['claude_code'], 'a device coming back online re-checks its identities')

    // With a run, its lease is renewed; a run the device no longer holds is revoked.
    const [{ id: agent }] = (await pool.query(`select id from agents where "userId"=$1 and "deviceId"=$2`, [owner, device])).rows
    await pool.query(`insert into agent_runs (id, "agentId", "userId", "deviceId", status, "leaseExpiresAt") values ($1, $2, $3, $4, 'running', now() + interval '5 seconds')`, [run, agent, owner, device])
    const ownToken = (await pool.query('SELECT id FROM device_tokens WHERE "tokenHash"=$1', [createHash('sha256').update(token).digest('hex')])).rows[0].id
    await pool.query('UPDATE agent_runs SET "deviceTokenId"=$2 WHERE id=$1', [run, ownToken])
    const old = await beat({ harnesses: [claude, codex], runs: [{ runId: run, lastProgressAt: new Date().toISOString() }, { runId: stranger, lastProgressAt: new Date().toISOString() }, { runId: 'not-a-uuid', lastProgressAt: new Date().toISOString() }] }, '0.0.329')
    assert.ok(old.leases[run], 'old original claim can finish its own live run')
    assert.deepEqual(old.revoked?.sort(), ['not-a-uuid', stranger].sort())
    assert.deepEqual(await identities(), ['claude_code'], 'obsolete heartbeat cannot provision new execution identities')
    assert.deepEqual((await seen()).harnesses.map((info: { harness: string }) => info.harness), ['claude_code'])
    const leased = await beat({ harnesses: [claude], runs: [{ runId: run, lastProgressAt: new Date().toISOString() }, { runId: stranger, lastProgressAt: new Date().toISOString() }] })
    assert.ok(leased.leases[run], 'the held run\'s lease is renewed')
    assert.deepEqual(leased.revoked, [stranger])
    const [{ leaseExpiresAt }] = (await pool.query(`select "leaseExpiresAt" from agent_runs where id=$1`, [run])).rows
    assert.ok(leaseExpiresAt.getTime() > Date.now() + 60_000, 'the stored lease moved forward')
    assert.equal(new Date(leased.leases[run]).getTime(), leaseExpiresAt.getTime())
  })
})
