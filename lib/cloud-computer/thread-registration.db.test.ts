import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { finishThreadRegistration, THREAD_CREDENTIAL_SQL, FINISH_THREAD_REGISTRATION } from './thread-registration'

const url = process.env.E2E_DATABASE_URL
const allowed = disposableDatabase(process.env, url)
if (process.env.REQUIRE_DB === '1' && !allowed) throw new Error('Isolated loopback test database required')

test('registration completion requires the fresh token, device and current lease in PostgreSQL', { skip: !allowed }, async t => {
  const admin = new Pool({ connectionString: url })
  const schema = 'registration_' + randomUUID().replaceAll('-', '')
  await admin.query('CREATE SCHEMA ' + schema)
  const pool = new Pool({ connectionString: url, options: '-c search_path=' + schema, max: 4 })
  const run = randomUUID(), lease = randomUUID(), device = randomUUID(), token = randomUUID()
  const hash = 'a'.repeat(64), started = new Date('2026-11-07T00:00:00.000Z')
  try {
    await pool.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text, status text, "stopRequestedAt" timestamptz, report jsonb);
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,"lastSeenAt" timestamptz);
      CREATE TABLE device_tokens (id uuid PRIMARY KEY,"boundDeviceId" uuid,"tokenHash" text,"revokedAt" timestamptz,"lastUsedAt" timestamptz);
      CREATE TABLE thread_machines ("runId" uuid PRIMARY KEY,"ownerId" text,"deviceId" uuid,"workerLeaseId" uuid,"workerLeaseUntil" timestamptz,state text,"lastActiveAt" timestamptz,"runningSince" timestamptz,"lifecycleAt" timestamptz,lifecycle jsonb,"issueId" uuid,"sandboxId" text,epoch int,"computeSeconds" bigint,"restoreStartedAt" timestamptz)`)
    const reset = async () => {
      await pool.query('TRUNCATE agent_runs,devices,device_tokens,thread_machines')
      await pool.query("INSERT INTO agent_runs VALUES ($1,'owner','queued',NULL,NULL)", [run])
      await pool.query("INSERT INTO devices VALUES ($1,'owner',$2)", [device, new Date(started.getTime()+1)])
      await pool.query('INSERT INTO device_tokens VALUES ($1,$2,$3,NULL,$4)', [token, device, hash, new Date(started.getTime()+1)])
      await pool.query(`INSERT INTO thread_machines VALUES ($1,'owner',$2,$3,now()+interval '1 minute','starting',NULL,NULL,NULL,'{}',NULL,'vm',7,0,NULL)`, [run, device, lease])
    }
    const finish = async (maintenance?: { status: 'succeeded'|'failed'|'stopped'|'cancelled'; stopRequestedAt: string|null }) => {
      const client = await pool.connect()
      try { return await finishThreadRegistration(client, run, lease, device, hash, started, maintenance) }
      finally { client.release() }
    }
    const cases: [string, string, unknown[]][] = [
      ['revoked token', 'UPDATE device_tokens SET "revokedAt"=now()', []],
      ['old credential generation', 'UPDATE device_tokens SET "tokenHash"=$1', ['b'.repeat(64)]],
      ['token never used', 'UPDATE device_tokens SET "lastUsedAt"=NULL', []],
      ['old token use', 'UPDATE device_tokens SET "lastUsedAt"=$1', [new Date(started.getTime()-1)]],
      ['old device registration', 'UPDATE devices SET "lastSeenAt"=$1', [new Date(started.getTime()-1)]],
      ['wrong owner', "UPDATE devices SET \"ownerId\"='other'", []],
      ['wrong installed device', 'UPDATE thread_machines SET "deviceId"=$1', [randomUUID()]],
      ['stop requested', 'UPDATE agent_runs SET "stopRequestedAt"=now()', []],
      ['ended machine', "UPDATE thread_machines SET state='ended'", []],
      ['replaced lease', 'UPDATE thread_machines SET "workerLeaseId"=$1', [randomUUID()]],
    ]
    for (const [name, sql, values] of cases) await t.test(name, async () => {
      await reset(); await pool.query(sql, values)
      assert.equal((await finish()).rowCount, 0)
      assert.notEqual((await pool.query('SELECT state FROM thread_machines')).rows[0].state, 'running')
    })
    for (const status of ['queued','preparing','running','succeeded']) await t.test('normal concurrent claim: '+status, async () => {
      await reset(); await pool.query('UPDATE agent_runs SET status=$1', [status])
      assert.equal((await finish()).rowCount, 1)
      const row = (await pool.query('SELECT state,"workerLeaseId",epoch FROM thread_machines')).rows[0]
      assert.deepEqual(row, { state:'running', workerLeaseId:null, epoch:7 })
    })
    for (const status of ['stopped','cancelled'] as const) await t.test('safe terminal maintenance preserves historic stop: '+status, async()=>{
      await reset()
      await pool.query(`UPDATE agent_runs SET status=$1,"stopRequestedAt"='2026-11-06T23:59:59.123456Z',report='{"safePoint":{"session":"exited"}}'`,[status])
      const original=(await pool.query('SELECT "stopRequestedAt"::text AS stop FROM agent_runs')).rows[0].stop
      assert.equal((await finish({status,stopRequestedAt:original})).rowCount,1)
      assert.deepEqual((await pool.query('SELECT status,"stopRequestedAt"::text AS stop FROM agent_runs')).rows[0],{status,stop:original})
    })
    for (const mutation of ['new_stop','requeued','exit_removed','stop_cleared'] as const) await t.test('maintenance refuses changed '+mutation,async()=>{
      await reset()
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"='2026-11-06T23:59:59.123456Z',report='{"safePoint":{"session":"exited"}}'`)
      const original=(await pool.query('SELECT "stopRequestedAt"::text AS stop FROM agent_runs')).rows[0].stop
      if(mutation==='new_stop')await pool.query('UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp()')
      if(mutation==='requeued')await pool.query("UPDATE agent_runs SET status='queued'")
      if(mutation==='exit_removed')await pool.query("UPDATE agent_runs SET report='{}'")
      if(mutation==='stop_cleared')await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL')
      assert.equal((await finish({status:'stopped',stopRequestedAt:original})).rowCount,0)
    })
    for (const mutation of ['revoke', 'stop']) await t.test(mutation+' completed during a machine-lock wait cannot authorize registration', async () => {
      await reset()
      const blocker = await pool.connect(), finisher = await pool.connect()
      try {
        const pid = (await finisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await blocker.query('BEGIN')
        if(mutation === 'stop') await blocker.query('SELECT 1 FROM agent_runs WHERE id=$1 FOR UPDATE',[run])
        await blocker.query('SELECT 1 FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [run])
        const completing = finishThreadRegistration(finisher as never, run, lease, device, hash, started)
        let blocked = false
        for (let i=0; i<100; i++) {
          if ((await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid])).rows[0].n > 0) { blocked=true; break }
          await new Promise(resolve=>setTimeout(resolve,5))
        }
        assert.equal(blocked,true,'the completion query is actually waiting for the existing lifecycle lock')
        if (mutation === 'revoke') await pool.query('UPDATE device_tokens SET "revokedAt"=clock_timestamp()')
        else await blocker.query('UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp()')
        await blocker.query('COMMIT')
        assert.equal((await completing).rowCount,0)
      } finally { await blocker.query('ROLLBACK'); blocker.release(); finisher.release() }
    })
    await t.test('a maintenance stop change committed during the lock wait invalidates the captured historic marker',async()=>{
      await reset()
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"='2026-11-06T23:59:59.123456Z',report='{"safePoint":{"session":"exited"}}'`)
      const original=(await pool.query('SELECT "stopRequestedAt"::text AS stop FROM agent_runs')).rows[0].stop
      const blocker=await pool.connect(),finisher=await pool.connect()
      try {
        const pid=(await finisher.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM agent_runs WHERE id=$1 FOR UPDATE',[run])
        await blocker.query('SELECT 1 FROM thread_machines WHERE "runId"=$1 FOR UPDATE',[run])
        const completing=finishThreadRegistration(finisher,run,lease,device,hash,started,{status:'stopped',stopRequestedAt:original})
        let blocked=false
        for(let i=0;i<100;i++){
          if((await pool.query('SELECT cardinality(pg_blocking_pids($1)) AS n',[pid])).rows[0].n>0){blocked=true;break}
          await new Promise(resolve=>setTimeout(resolve,5))
        }
        assert.equal(blocked,true,'the real completion waits for the lifecycle transaction')
        await blocker.query('UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp()')
        await blocker.query('COMMIT')
        assert.equal((await completing).rowCount,0)
      } finally {await blocker.query('ROLLBACK');blocker.release();finisher.release()}
    })
    await t.test('normal claim committing while completion waits keeps the original lease valid', async () => {
      await reset()
      const claimer=await pool.connect(), finisher=await pool.connect()
      try {
        await claimer.query('BEGIN')
        await claimer.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[run])
        await claimer.query("UPDATE agent_runs SET status='preparing' WHERE id=$1",[run])
        const completing=finishThreadRegistration(finisher,run,lease,device,hash,started)
        await claimer.query('COMMIT')
        assert.equal((await completing).rowCount,1)
        assert.equal((await pool.query('SELECT status FROM agent_runs')).rows[0].status,'preparing')
      } finally { await claimer.query('ROLLBACK');claimer.release();finisher.release() }
    })
    await t.test('token-first revocation and run-first completion have no circular lock wait', async () => {
      await reset()
      const revoker=await pool.connect(), finisher=await pool.connect()
      let release!:()=>void, held!:()=>void
      const heldRun=new Promise<void>(resolve=>{held=resolve})
      const proceed=new Promise<void>(resolve=>{release=resolve})
      const query=finisher.query.bind(finisher)
      Object.defineProperty(finisher,'query',{configurable:true,value:async(sql:string,values?:unknown[])=>{
        if(sql===FINISH_THREAD_REGISTRATION){held();await proceed}
        return query(sql,values)
      }})
      try {
        await revoker.query('BEGIN')
        await revoker.query('SELECT id FROM device_tokens WHERE id=$1 FOR UPDATE',[token])
        await revoker.query('UPDATE device_tokens SET "revokedAt"=clock_timestamp() WHERE id=$1',[token])
        const completing=finishThreadRegistration(finisher,run,lease,device,hash,started)
        await heldRun
        const stopping=revoker.query('UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp() WHERE id=$1',[run])
        release()
        // Completion linearizes before the still-uncommitted revoke. It never
        // waits for that token while holding the run required by revocation.
        assert.equal((await completing).rowCount,1)
        await stopping;await revoker.query('COMMIT')
        assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs')).rows[0].stopRequestedAt)
        assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens')).rows[0].revokedAt)
      } finally { release();await revoker.query('ROLLBACK');delete (finisher as unknown as {query?:unknown}).query;revoker.release();finisher.release() }
    })
    await t.test('a competing lease change wins while completion waits on its machine lock', async () => {
      await reset()
      const blocker = await pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('UPDATE thread_machines SET "workerLeaseId"=$1 WHERE "runId"=$2', [randomUUID(),run])
        const completing = finish()
        await blocker.query('COMMIT')
        assert.equal((await completing).rowCount, 0)
      } finally { blocker.release() }
    })
  } finally { await pool.end(); await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end() }
})

test('the actual credential INSERT supplies a fresh floor without exposing a token before commit', { skip: !allowed }, async t => {
  const admin = new Pool({ connectionString:url })
  const schema='registration_clock_'+randomUUID().replaceAll('-','')
  await admin.query('CREATE SCHEMA '+schema)
  const pool=new Pool({connectionString:url,options:'-c search_path='+schema,max:3})
  const writer=await pool.connect()
  try {
    await pool.query('CREATE TABLE device_tokens (id uuid PRIMARY KEY,"userId" text,name text,"tokenHash" text,"boundDeviceId" uuid,"boundWorkspaceId" uuid,"expiresAt" timestamptz,"lastUsedAt" timestamptz,"revokedAt" timestamptz)')
    const device=randomUUID(), workspace=randomUUID()
    for(const kind of ['fresh','reused-device','rotated-device']) await t.test(kind,async()=>{
      await writer.query('BEGIN')
      await writer.query('UPDATE device_tokens SET "revokedAt"=now() WHERE "boundDeviceId"=$1',[device])
      const tokenId=randomUUID(), tokenHash=randomUUID()
      const floor=(await writer.query(THREAD_CREDENTIAL_SQL,[tokenId,'owner','Thread worker',tokenHash,device,workspace])).rows[0].now
      assert.ok(floor instanceof Date)
      assert.equal((await pool.query('SELECT id FROM device_tokens WHERE id=$1',[tokenId])).rowCount,0)
      assert.equal((await writer.query('SELECT "lastUsedAt" FROM device_tokens WHERE id=$1',[tokenId])).rows[0].lastUsedAt,null)
      await writer.query('COMMIT')
      const used=(await pool.query('UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE id=$1 RETURNING "lastUsedAt"',[tokenId])).rows[0].lastUsedAt
      assert.ok(used.getTime()>=floor.getTime())
      assert.equal((await pool.query('SELECT id FROM device_tokens WHERE "boundDeviceId"=$1 AND "revokedAt" IS NULL',[device])).rowCount,1)
    })
  } finally { await writer.query('ROLLBACK');writer.release();await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end() }
})
