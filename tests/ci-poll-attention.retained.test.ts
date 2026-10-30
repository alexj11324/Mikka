import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
mock.module(new URL('../lib/github/ci/authority.ts',import.meta.url).href,{namedExports:{acquireCiMembership:async(_i:unknown,user:unknown)=>{if(user==='revoked')throw Error('revoked');return {held:false,async check(){},async close(){}}},ciIssueAuthorized:()=>true}})
mock.module(new URL('../lib/credentials/chat-guard.ts',import.meta.url).href,{namedExports:{assertCredentialSafeChat:async()=>{}}})
test('retained PG: stale poll failures never create notices and undelivered notices can be rewoken',async()=>{
 const url=process.env.CI_NATIVE_RETAINED_DATABASE_URL;if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/mikka_ci_native')throw Error('isolated retained fixture required')
 const {recordCiAttention}=await import('../lib/github/ci/notice')
 const admin=new Pool({connectionString:url}),schema=`ci_alert_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE SCHEMA "${schema}"`)
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);const db=new Pool({connectionString:scoped.toString()})
 await db.query(`CREATE TABLE issues (id uuid,"userId" text,scope text,"scopeVersion" int,content jsonb); CREATE TABLE agent_runs(id uuid,"userId" text,"issueId" uuid,"botId" uuid); CREATE TABLE github_ci_observations("userId" text,"issueId" uuid,"remoteKey" text,"prNumber" int,"originRunId" uuid,"scopeVersion" int,generation bigint,"watchId" uuid,"expiresAt" timestamptz,"pendingReason" text,"pendingReasonSince" timestamptz,"pollObservation" jsonb,"nextCheckAt" timestamptz); CREATE TABLE github_ci_attention_cursor(id boolean primary key,"watchId" uuid,kind text,"leaseId" uuid,"leaseUntil" timestamptz); CREATE TABLE coordinator_events(id uuid,"userId" text,"botId" uuid,kind text,"dedupeKey" text unique,"issueId" uuid,"runId" uuid,payload jsonb,tier text,"deliveredAt" timestamptz); CREATE TABLE github_ci_poll_outbox("userId" text,"issueId" uuid,"remoteKey" text,"prNumber" int,"originRunId" uuid,generation bigint,"deliveredAt" timestamptz,head text,payload jsonb,attempts int,"createdAt" timestamptz)`)
 const id={userId:'fixture',issueId:randomUUID(),remoteKey:'repo',prNumber:1,originRunId:randomUUID(),scopeVersion:1,generation:'1',watchId:randomUUID(),failureKind:'poll' as const}
 await db.query(`INSERT INTO issues VALUES ($1,$2,'personal',1,'{}')`,[id.issueId,id.userId])
 await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,NULL)`,[id.originRunId,id.userId,id.issueId])
 await db.query(`INSERT INTO github_ci_observations VALUES ($1,$2,$3,1,$4,1,1,$5,now()+interval '1 hour','unavailable',now()-interval '20 minutes','{}',now())`,[id.userId,id.issueId,id.remoteKey,id.originRunId,id.watchId])
 assert.equal(await recordCiAttention(db,id,'key','synthetic'),true)
 assert.equal(await recordCiAttention(db,id,'key','synthetic'),true)
 await db.query(`UPDATE github_ci_observations SET "pendingReason"=NULL`)
 assert.equal(await recordCiAttention(db,id,'key','synthetic'),false)
 assert.equal((await db.query('SELECT count(*)::int AS n FROM coordinator_events')).rows[0].n,1)
 const delivery={...id,failureKind:'delivery' as const}
 await db.query(`UPDATE github_ci_observations SET "pollObservation"=$2 WHERE "watchId"=$1`,[id.watchId,JSON.stringify({head:'b',fingerprint:'fresh'})])
 await db.query(`INSERT INTO github_ci_poll_outbox VALUES ($1,$2,$3,1,$4,1,NULL,'a',$5,2,now()-interval '20 minutes')`,[id.userId,id.issueId,id.remoteKey,id.originRunId,JSON.stringify({fingerprint:'old'})])
 assert.equal(await recordCiAttention(db,delivery,'old-delivery','synthetic'),false)
 await db.query(`UPDATE github_ci_poll_outbox SET head='b',payload=$1`,[JSON.stringify({fingerprint:'fresh'})])
 assert.equal(await recordCiAttention(db,delivery,'current-delivery','synthetic'),true)
 await db.query(`UPDATE github_ci_poll_outbox SET "deliveredAt"=now()`)
 for(let i=0;i<22;i++) {
   const user=i<21?'revoked':'valid', iid=randomUUID(),rid=randomUUID(),wid=`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`
   await db.query(`INSERT INTO issues VALUES ($1,$2,'personal',1,'{}')`,[iid,user])
   await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,NULL)`,[rid,user,iid])
   await db.query(`INSERT INTO github_ci_observations VALUES ($1,$2,'repo',1,$3,1,1,$4,now()+interval '1 hour','unavailable',now()-interval '20 minutes','{}',CASE WHEN $1='revoked' THEN now()-interval '1 hour' ELSE now() END)`,[user,iid,rid,wid])
 }
 const {notifyPollFailures}=await import('../lib/github/ci/poll-attention')
 let wakes=0
 const first=await notifyPollFailures(db,Date.now()+10000,async()=>{wakes++});assert.equal(first.attempted,20);assert.equal(wakes,0)
 await db.query(`UPDATE github_ci_observations SET "nextCheckAt"=now()+interval '1 hour' WHERE "userId"='revoked'`)
 await db.query(`UPDATE github_ci_attention_cursor SET "leaseId"=$1,"leaseUntil"=now()+interval '1 minute'`,[randomUUID()])
 assert.equal((await notifyPollFailures(db,Date.now()+10000,async()=>{wakes++})).attempted,0)
 await db.query(`UPDATE github_ci_attention_cursor SET "leaseUntil"=now()-interval '1 second'`)
 const second=await notifyPollFailures(db,Date.now()+10000,async()=>{wakes++});assert.ok(second.attempted>=2);assert.equal(wakes,1)
 console.log(`Retained CI attention schema: ${schema}`);await db.end();await admin.end()
})
