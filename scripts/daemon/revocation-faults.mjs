// Actual route and PostgreSQL, no HTTP transport/provider. Retain every fixture.
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { POST } from '../../app/v1/runs/[runId]/events/route.ts'
import { revokeDeviceCredential } from '../../lib/device-revocation.ts'
import { withDeviceDatabaseAuthority, deviceScopedPool } from '../../lib/db/device-scope.ts'
import { verifyAudit } from '../../lib/audit/store.ts'
const target = new URL(process.env.E2E_DATABASE_URL)
assert.ok(['localhost','127.0.0.1'].includes(target.hostname))
assert.equal(target.pathname,'/mikka_e2e')
assert.equal(process.env.MIKKA_DATABASE_URL,target.toString())
const db = new Pool({connectionString:target.toString(),max:5})
const evidence = {sha:process.env.GITHUB_SHA ?? null,environment:'actual route + isolated PG; no HTTP transport',startedAt:new Date().toISOString(),checks:[]}
async function fixture(){
 const owner='fault178-'+randomUUID(),device=randomUUID(),agent=randomUUID(),run=randomUUID(),tokenId=randomUUID(),workerId=randomUUID(),token='orv_'+randomBytes(32).toString('hex')
 await db.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,$3)',[device,owner,'Synthetic fault fixture'])
 await db.query('INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,$3,$4,$5)',[agent,owner,'codex','Synthetic fault fixture',device])
 await db.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId","deviceTokenId",status,"leaseExpiresAt") VALUES($1,$2,$3,$4,$5,$6,now()+interval \'90 seconds\')',[run,owner,agent,device,tokenId,'preparing'])
 await db.query('INSERT INTO device_tokens(id,"userId","tokenHash","lastUsedAt") VALUES($1,$2,$3,now())',[tokenId,owner,createHash('sha256').update(token).digest('hex')])
 await db.query('INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES($1,$2,$3,$4,now()+interval \'1 hour\')',[workerId,run,owner,createHash('sha256').update(randomBytes(32)).digest('hex')])
 return {owner,device,agent,run,tokenId,workerId,token}
}
async function until(fn){for(let i=0;i<100;i++){const r=await fn();if(r)return r;await new Promise(resolve=>setTimeout(resolve,25))}throw new Error('isolated gate timeout')}
async function auditCount(f){return Number((await db.query('SELECT count(*) FROM security_audit_events WHERE tenant=$1 AND event->>\'action\'=$2 AND event->>\'resourceId\'=$3',['personal:'+f.owner,'device.credential.revoked',f.tokenId])).rows[0].count)}
async function state(f){return(await db.query(`SELECT t."revokedAt",t."revokedBy",r."stopRequestedAt",r."leaseExpiresAt",k."revokedAt" AS "workerRevokedAt" FROM device_tokens t JOIN agent_runs r ON r."deviceTokenId"=t.id JOIN run_tokens k ON k."runId"=r.id WHERE t.id=$1 AND r.id=$2 AND k.id=$3`,[f.tokenId,f.run,f.workerId])).rows[0]}
try{
 const f=await fixture(), gate='fence_'+randomUUID().replaceAll('-',''),locker=await db.connect()
 let operation
 try{
  await db.query(`CREATE FUNCTION ${gate}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${gate}',0)); RETURN NEW; END $$`)
  await db.query(`CREATE TRIGGER ${gate} BEFORE INSERT ON run_chunks FOR EACH ROW WHEN (NEW."runId"='${f.run}'::uuid) EXECUTE FUNCTION ${gate}()`)
  await locker.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[gate])
  const pid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  operation=POST(new Request('http://localhost/mikka/v1/runs/'+f.run+'/events',{method:'POST',headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},body:JSON.stringify({fromSeq:1,chunks:[{type:'text-delta',delta:'Synthetic fault'}]})}),{params:Promise.resolve({runId:f.run})}).then(r=>({status:r.status}),()=>({rejected:true}))
  const writers=await until(async()=>{const rows=(await db.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rows;return rows.length?rows:null})
  assert.equal(writers.length,1)
  // The write connection now owns its token lock; no independent admission
  // connection exists. Terminating this one backend rolls the write back.
  await db.query('SELECT pg_terminate_backend($1)',[writers[0].pid])
  await revokeDeviceCredential(db,f.owner,f.tokenId)
  await locker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate])
  assert.deepEqual(await operation,{rejected:true})
  assert.equal(Number((await db.query('SELECT count(*) FROM run_chunks WHERE "runId"=$1',[f.run])).rows[0].count),0)
  assert.equal(await auditCount(f),1)
  evidence.checks.push({name:'write-connection loss then committed revoke',persistedChunks:0,auditEvents:1,runId:f.run})
 }finally{await locker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[gate]).catch(()=>{});locker.release();if(operation)await operation}
 const a=await fixture(), fault='auditfail_'+randomUUID().replaceAll('-','')
 await db.query('CREATE TABLE IF NOT EXISTS daemon_audit_fault_controls(id uuid PRIMARY KEY,enabled boolean NOT NULL)')
 await db.query('INSERT INTO daemon_audit_fault_controls VALUES($1,true)',[a.tokenId])
 await db.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM daemon_audit_fault_controls WHERE id='${a.tokenId}'::uuid AND enabled) THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`)
 await db.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON security_audit_events FOR EACH ROW WHEN (NEW.event->>'resourceId'='${a.tokenId}') EXECUTE FUNCTION ${fault}()`)
 const before=await state(a)
 await assert.rejects(revokeDeviceCredential(db,a.owner,a.tokenId))
 assert.deepEqual(await state(a),before)
 assert.equal(await auditCount(a),0)
 await db.query('UPDATE daemon_audit_fault_controls SET enabled=false WHERE id=$1',[a.tokenId])
 const one=await revokeDeviceCredential(db,a.owner,a.tokenId),two=await revokeDeviceCredential(db,a.owner,a.tokenId)
 assert.deepEqual(one,two);assert.equal(await auditCount(a),1)
 const auditClient=await db.connect();try{await verifyAudit(auditClient,'personal:'+a.owner)}finally{auditClient.release()}
 evidence.checks.push({name:'actual revoke audit failure rolls back token, run, worker token and lease; success/retry once',auditEvents:1,tokenId:a.tokenId})
 const live=await fixture()
 await Promise.all(Array.from({length:6},()=>withDeviceDatabaseAuthority({userId:live.owner,tokenId:live.tokenId},async()=>{
  const pool=deviceScopedPool(db)
  assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n,1)
  const orm=drizzle(pool)
  await orm.transaction(async tx=>{await tx.execute(sql`SELECT 1`);await tx.transaction(inner=>inner.execute(sql`SELECT 2`))})
  const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT 3');await c.query('COMMIT')}finally{c.release()}
 })))
 await revokeDeviceCredential(db,live.owner,live.tokenId)
 await withDeviceDatabaseAuthority({userId:live.owner,tokenId:live.tokenId},async()=>{
  const pool=deviceScopedPool(db)
  await assert.rejects(pool.query('UPDATE devices SET name=$1 WHERE id=$2',['must not persist',live.device]))
  await assert.rejects(drizzle(pool).transaction(tx=>tx.execute(sql`SELECT 1`)))
  const c=await pool.connect();try{await assert.rejects(c.query('BEGIN'))}finally{c.release()}
 })
 assert.equal((await db.query('SELECT name FROM devices WHERE id=$1',[live.device])).rows[0].name,'Synthetic fault fixture')
 evidence.checks.push({name:'six concurrent implicit/explicit/Drizzle nested transactions; all interfaces refuse after revoke',concurrency:6})
 evidence.finishedAt=new Date().toISOString()
 mkdirSync('test-results/daemon-faults',{recursive:true})
 writeFileSync('test-results/daemon-faults/device-revocation-fault-evidence.json',JSON.stringify(evidence,null,2))
 console.log(JSON.stringify(evidence))
}finally{await db.end()}
// Route imports initialize application background handles. All fixture queries
// and the retained fixture pool have completed above; end this standalone runner.
process.exit(0)
