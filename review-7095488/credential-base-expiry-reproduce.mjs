import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {PostgresCredentialAuthority} from './lib/credentials/authority.ts';
import {CredentialBroker} from './lib/credentials/broker.ts';
const schema='expiry_'+randomUUID().replaceAll('-','');
const admin=new Pool({connectionString:'postgresql://postgres@127.0.0.1:55433/mikka_e2e'});
await admin.query(`CREATE SCHEMA "${schema}"`);
const pool=new Pool({connectionString:'postgresql://postgres@127.0.0.1:55433/mikka_e2e',options:`-c search_path=${schema}`});
const owner=randomUUID(),session=randomUUID(),device=randomUUID(),run=randomUUID(),issue=randomUUID(),workspace=randomUUID();
try{
 await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY);CREATE TABLE session(id text,"userId" text,"expiresAt" timestamptz);CREATE TABLE devices(id uuid,"ownerId" text,enabled boolean,"lastSeenAt" timestamptz);CREATE TABLE issues(id uuid,"userId" text,content jsonb);CREATE TABLE agent_runs(id uuid,"userId" text,"issueId" uuid,"deviceId" uuid,"sessionId" text,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz);CREATE TABLE mikka_workspaces(id uuid);CREATE TABLE mikka_workspace_members("workspaceId" uuid,"userId" text,status text);CREATE TABLE mikka_team_issues("workspaceId" uuid,"issueId" uuid)`);
 await pool.query('INSERT INTO "user" VALUES($1)',[owner]);await pool.query('INSERT INTO session VALUES($1,$2,now()+interval \'1 hour\')',[session,owner]);await pool.query('INSERT INTO devices VALUES($1,$2,true,now())',[device,owner]);await pool.query('INSERT INTO issues VALUES($1,$2,\'{}\')',[issue,owner]);await pool.query('INSERT INTO agent_runs VALUES($1,$2,$3,$4,$5,\'running\',null,now()+interval \'90 seconds\')',[run,owner,issue,device,randomUUID()]);await pool.query('INSERT INTO mikka_workspaces VALUES($1)',[workspace]);await pool.query('INSERT INTO mikka_workspace_members VALUES($1,$2,\'active\')',[workspace,owner]);await pool.query('INSERT INTO mikka_team_issues VALUES($1,$2)',[workspace,issue]);
 const authority=new PostgresCredentialAuthority(pool,pool),principal={ownerId:owner,authSessionId:session};
 assert.ok(await authority.resolve(principal,workspace,run));
 await pool.query('UPDATE devices SET "lastSeenAt"=now()-interval \'61 seconds\' WHERE id=$1',[device]);
 assert.equal(await authority.resolve(principal,workspace,run),null);
 const broker=new CredentialBroker({pool,authority,services:new Map(),vault:{put:async()=>{throw Error('must not call vault')},read:async()=>{throw Error('must not call vault')},remove:async()=>{throw Error('must not call vault')}}});
 await assert.rejects(broker.create(principal,{workspaceId:workspace,runId:run,serviceId:'fixture',mode:'browser_login'}),e=>e.code==='credential_not_found'&&e.status===404);
 await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1',[device]);await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()+interval \'90 seconds\' WHERE id=$1',[run]);assert.ok(await authority.resolve(principal,workspace,run));
 await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1',[run]);assert.equal(await authority.resolve(principal,workspace,run),null);
 const result={sourceSha:'20e2f2e4ed14a9b08b3ef02fb56199809e29558e',utc:new Date().toISOString(),schema,layer:'actual frozen-base authority and broker with real isolated PostgreSQL; synthetic deterministic clock-state injection, not a full Chromium suite rerun',checks:{freshContextAdmitted:true,deviceAge61sAuthorityNull:true,deviceAge61sBroker404CredentialNotFound:true,explicitSyntheticHeartbeatRestoresFreshContext:true,expiredRunLeaseStillDenied:true},noProductionChanges:true,noVaultCalls:true};await writeFile('/tmp/audit-credential-base-expiry-repro.json',JSON.stringify(result,null,2));console.log(result);
}finally{await pool.end();await admin.end()}
