import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { before, after, test } from 'node:test'
import { Pool } from 'pg'
import { NativeCoordinatorStore } from './native-store'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const url = process.env.NATIVE_COORDINATOR_TEST_DATABASE_URL ?? (process.env.REQUIRE_DB === '1' ? process.env.E2E_DATABASE_URL : undefined)
if (url) {
  const parsed = new URL(url)
  if (!['127.0.0.1','localhost'].includes(parsed.hostname) || (parsed.pathname !== '/mikka_native_test' && !disposableDatabase(process.env, url)) || parsed.search || parsed.hash) throw new Error('Native Coordinator tests require an isolated localhost test database')
} else if (process.env.REQUIRE_DB === '1') throw new Error('Native Coordinator database is required')
const schema = `native_${randomUUID().replaceAll('-','')}`
const admin = url ? new Pool({ connectionString: url }) : null
const pool = url ? new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 }) : null
const store = pool ? new NativeCoordinatorStore(pool) : null
const check = (name: string, fn: () => Promise<void>) => test(name,{ skip: !url },fn)

before(async () => {
  if (!admin || !pool) return
  await admin.query(`CREATE SCHEMA ${schema}`)
  await pool.query(`CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,enabled boolean DEFAULT true,"removedAt" timestamptz,"lastSeenAt" timestamptz DEFAULT now(),harnesses jsonb);
    CREATE TABLE coordinator_sessions ("userId" text PRIMARY KEY,"leaseHolder" text,"leaseUntil" timestamptz);`)
  await pool.query(await readFile(new URL('../../drizzle/20261026170000_native_coordinator.sql',import.meta.url),'utf8'))
})
after(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin?.end() })

async function pendingCall() {
  const userId = randomUUID(), deviceId = randomUUID(), holder = randomUUID(), id = randomUUID()
  await pool!.query('INSERT INTO devices (id,"ownerId") VALUES ($1,$2)', [deviceId, userId])
  await pool!.query(`INSERT INTO coordinator_sessions ("userId","leaseHolder","leaseUntil") VALUES ($1,$2,now()+interval '10 minutes')`, [userId,holder])
  await pool!.query(`INSERT INTO native_coordinator_turns (id,"userId","deviceId",holder,round,payload,status,"expiresAt")
    VALUES ($1,$2,$3,$4,0,'{}'::jsonb,'running',now()+interval '10 minutes')`, [id,userId,deviceId,holder])
  await pool!.query(`INSERT INTO native_coordinator_tools ("turnId","callId",name,input) VALUES ($1,'call','propose_reply','{}'::jsonb)`, [id])
  return { userId, deviceId, holder, id }
}

check('persisted tool authority binds the exact owner, holder, turn and pending call', async () => {
  const { userId, holder, id } = await pendingCall()
  await store!.assertToolActive(userId,holder,id,'call')
  for (const wrong of [
    [randomUUID(),holder,id,'call'], [userId,'other-holder',id,'call'],
    [userId,holder,randomUUID(),'call'], [userId,holder,id,'other-call'],
  ] as const) {
    const [otherOwner, otherHolder, otherId, otherCall] = wrong
    await assert.rejects(store!.assertToolActive(otherOwner,otherHolder,otherId,otherCall), /LeaseLost/)
  }
})

for (const revoked of ['device','owner','holder','released','lease','deadline','failed','closed','completed','done'] as const) {
  check(`persisted tool authority is checked again after ${revoked}`, async () => {
    const {userId,deviceId,holder,id} = await pendingCall()
    await store!.assertToolActive(userId,holder,id,'call')
    if (revoked === 'device') await pool!.query('UPDATE devices SET enabled=false WHERE id=$1',[deviceId])
    else if (revoked === 'owner') await pool!.query('UPDATE devices SET "ownerId"=$2 WHERE id=$1',[deviceId,randomUUID()])
    else if (revoked === 'holder') await pool!.query('UPDATE coordinator_sessions SET "leaseHolder"=$2 WHERE "userId"=$1',[userId,'replacement'])
    else if (revoked === 'released') await pool!.query('UPDATE coordinator_sessions SET "leaseHolder"=NULL,"leaseUntil"=NULL WHERE "userId"=$1',[userId])
    else if (revoked === 'lease') await pool!.query('UPDATE coordinator_sessions SET "leaseUntil"=now() WHERE "userId"=$1',[userId])
    else if (revoked === 'deadline') await pool!.query('UPDATE native_coordinator_turns SET "expiresAt"=now() WHERE id=$1',[id])
    else if (revoked === 'done') await pool!.query(`UPDATE native_coordinator_tools SET status='done' WHERE "turnId"=$1`,[id])
    else await pool!.query('UPDATE native_coordinator_turns SET status=$2 WHERE id=$1',[id,revoked])
    await assert.rejects(store!.assertToolActive(userId,holder,id,'call'),/LeaseLost/)
  })
}
