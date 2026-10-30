import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { postgresCiPollAdapter } from '../cloudflare/linear-sync/src/ci-poll-store'
import { deliverCiOutbox } from '../cloudflare/linear-sync/src/ci-outbox'
import { pollActiveCi } from '../cloudflare/linear-sync/src/ci-poller'
import { scopedCiToken } from '../cloudflare/linear-sync/src/ci-token-cache'

test('durable CI polling leases, fencing and outbox survive overlapping workers', async () => {
  const url=process.env.CI_NATIVE_RETAINED_DATABASE_URL
  if (!url || new URL(url).hostname!=='127.0.0.1' || new URL(url).pathname!=='/mikka_ci_native') throw Error('isolated retained fixture required')
  const admin=new Pool({connectionString:url})
  const schema=`ci_poll_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scopedURL=new URL(url); scopedURL.searchParams.set('options',`-c search_path=${schema}`)
  const db=new Pool({connectionString:scopedURL.toString()})
  await db.query(`CREATE TABLE github_ci_observations ("userId" text,"issueId" uuid,"remoteKey" text,"prNumber" integer,"originRunId" uuid,"watchId" uuid,generation bigint,"nextCheckAt" timestamptz,"expiresAt" timestamptz,"scopeVersion" integer,primary key("userId","issueId","remoteKey","prNumber"));
    CREATE TABLE issues (id uuid,"userId" text,"scopeVersion" integer,content jsonb,scope text);
    CREATE TABLE github_repository_installations ("userId" text,"remoteKey" text,"installationId" bigint,"repositoryId" bigint,"githubAccountId" text);
    CREATE TABLE account ("userId" text,"providerId" text,"accountId" text,"createdAt" timestamptz);
    CREATE TABLE run_publications ("runId" uuid,"userId" text,"issueId" uuid,"remoteKey" text,status text,branch text);`)
  await db.query(await readFile(new URL('../drizzle/20261030030000_ci_poll_queue.sql',import.meta.url),'utf8'))
  const issue=randomUUID(), run=randomUUID(), watch=randomUUID(), remote='v2/github.com/example/repo'
  await db.query(`INSERT INTO issues VALUES ($1,'synthetic',1,'{}'::jsonb,'personal')`,[issue])
  await db.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","watchId",generation,"nextCheckAt","expiresAt","scopeVersion","pollLeaseId","pollLeaseUntil","pollAttempt","pollObservation") VALUES ('synthetic',$1,$2,1,$3,$4,0,now(),now()+interval '1 hour',1,NULL,NULL,0,NULL)`,[issue,remote,run,watch])
  await db.query(`INSERT INTO github_repository_installations VALUES ('synthetic',$1,4,5,'synthetic-github')`,[remote])
  await db.query(`INSERT INTO account VALUES ('synthetic','github','synthetic-github',now())`)
  await db.query(`INSERT INTO run_publications VALUES ($1,'synthetic',$2,$3,'published','feature')`,[run,issue,remote])
  const read=async()=>({head:'a'.repeat(40),open:true,snapshot:{checks:[],statuses:[]}})
  const authority=async()=>({async check(){},async close(){}})
  const one=postgresCiPollAdapter(db,read,authority),two=postgresCiPollAdapter(db,read,authority)
  const batches=await Promise.all([one.lease(1,Date.now()),two.lease(1,Date.now())])
  assert.equal(batches[0].length+batches[1].length,1)
  const lease=batches.flat()[0]
  let issuance=0
  const token=async()=>{issuance++;return {token:'synthetic-repository-token',expiresAt:new Date(Date.now()+3600000).toISOString()}}
  const cacheSecret='synthetic-ci-cache-secret-at-least-32-bytes'
  assert.equal(await scopedCiToken(db,lease,cacheSecret,token),'synthetic-repository-token')
  assert.equal(await scopedCiToken(db,lease,cacheSecret,token),'synthetic-repository-token')
  assert.equal(issuance,1)
  const cached=(await db.query(`SELECT "pollTokenEnvelope" FROM github_ci_observations WHERE "watchId"=$1`,[watch])).rows[0]
  assert.equal(cached.pollTokenEnvelope.includes(Buffer.from('synthetic-repository-token')),false)
  const state={head:'a'.repeat(40),fingerprint:'synthetic-fingerprint',firstSeenAt:1,deliveredFingerprint:null}
  await one.complete(lease,state,{head:state.head,fingerprint:state.fingerprint,outcome:'success',failed:[]})
  await assert.rejects(two.complete(lease,state,{head:state.head,fingerprint:state.fingerprint,outcome:'success',failed:[]}))
  assert.equal((await db.query('SELECT count(*)::int AS n FROM github_ci_poll_outbox')).rows[0].n,1)
  let calls=0
  const failed=await deliverCiOutbox(db,async()=>{calls++;return false},{limit:1,deadline:Date.now()+30000,authorize:authority})
  assert.equal(failed.failed,1); assert.equal(calls,1)
  assert.equal((await db.query('SELECT "pollObservation" FROM github_ci_observations')).rows[0].pollObservation.deliveredFingerprint,null)
  await db.query(`UPDATE github_ci_poll_outbox SET "nextAttemptAt"=now()`)
  const sent=await Promise.all([deliverCiOutbox(db,async()=>{calls++;return true},{limit:1,deadline:Date.now()+30000,authorize:authority}),deliverCiOutbox(db,async()=>{calls++;return true},{limit:1,deadline:Date.now()+30000,authorize:authority})])
  assert.equal(sent.reduce((n,x)=>n+x.sent,0),1); assert.equal(calls,2)
  assert.ok((await db.query('SELECT "deliveredAt" FROM github_ci_poll_outbox')).rows[0].deliveredAt)
  assert.equal((await db.query('SELECT "pollObservation" FROM github_ci_observations')).rows[0].pollObservation.deliveredFingerprint,state.fingerprint)
  // A second watch exercises provider snapshots through real leases and the
  // real durable outbox; intermediate reads do not invoke the application.
  const issue2=randomUUID(),run2=randomUUID(),watch2=randomUUID(),head='b'.repeat(40)
  await db.query(`INSERT INTO issues VALUES ($1,'synthetic',1,'{}'::jsonb,'personal')`,[issue2])
  await db.query(`INSERT INTO github_ci_observations ("userId","issueId","remoteKey","prNumber","originRunId","watchId",generation,"nextCheckAt","expiresAt","scopeVersion","pollLeaseId","pollLeaseUntil","pollAttempt","pollObservation") VALUES ('synthetic',$1,$2,2,$3,$4,0,now(),now()+interval '1 hour',1,NULL,NULL,0,NULL)`,[issue2,remote,run2,watch2])
  await db.query(`INSERT INTO run_publications VALUES ($1,'synthetic',$2,$3,'published','feature')`,[run2,issue2,remote])
  let clock=Date.now()+1000, finished=false, callbacks=0
  const reader=postgresCiPollAdapter(db,async()=>({head,open:true,snapshot:{checks:[{id:'1',name:'build',status:'completed',conclusion:'success'},...(finished?[{id:'2',name:'test',status:'completed',conclusion:'success'}]:[])],statuses:[],requiredChecks:[{context:'test',appId:null}],workflows:[{id:'1',attempt:1,name:'build',status:'completed',conclusion:'success'},{id:'2',attempt:1,name:'test',status:finished?'completed':'in_progress',conclusion:finished?'success':null}]} }),authority)
  const poll=async()=>{await db.query(`UPDATE github_ci_observations SET "nextCheckAt"=now() WHERE "watchId"=$1`,[watch2]);return pollActiveCi(reader,{now:()=>clock,random:()=>0,deadline:clock+30000})}
  await poll(); assert.equal((await deliverCiOutbox(db,async()=>{callbacks++;return true},{limit:4,deadline:Date.now()+30000,authorize:authority})).sent,0)
  finished=true; await poll(); assert.equal(callbacks,0)
  clock+=120_000; assert.equal((await poll()).completed,1)
  assert.equal((await deliverCiOutbox(db,async()=>{callbacks++;return true},{limit:4,deadline:Date.now()+30000,authorize:authority})).sent,1)
  clock+=120_000; await poll(); await deliverCiOutbox(db,async()=>{callbacks++;return true},{limit:4,deadline:Date.now()+30000,authorize:authority}); assert.equal(callbacks,1)
  console.log(`Retained CI polling schema: ${schema}`)
  await db.end(); await admin.end()
})
