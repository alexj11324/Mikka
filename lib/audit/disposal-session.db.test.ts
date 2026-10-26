// REQUIRE_DB: retained receipt/session tests only; no approval file or deletion test import.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {prepareAuditDisposal,openAuditFixtureSession,consumeAuditFixtureReceipt,type PreparedAuditFixture} from './disposal-session';
import {validateDeletedEvents} from './disposal-contract';
import {appendAudit,transaction} from './store';

const raw=process.env.AUDIT_APP_TEST_URL;
if(!raw)throw Error('Explicit retained audit fixture admin database required');
const adminURL=new URL(raw);
assert.equal(adminURL.hostname,'127.0.0.1');assert.equal(adminURL.pathname,'/mikka_audit_app_e2e');assert.equal(adminURL.search,'');assert.equal(adminURL.hash,'');

test('retained PG audit session: environment, ownership, snapshot, one-use receipt and connection failure',async t=>{
 const admin=new Pool({connectionString:raw,max:3});
 const directory=await mkdtemp(join(tmpdir(),'r0-audit-session-'));
 const created:string[]=[];
 const sql=(await readFile(new URL('../../drizzle/20261025170000_security_audit_application.sql',import.meta.url),'utf8')).split('-- Retain captured ownership')[0];
 const drop='DROP TRIGGER IF EXISTS security_audit_immutable ON security_audit_events;\n';assert.equal(sql.split(drop).length,2);
 const core=sql.replace(drop,'')+'\nCOMMIT;\n';
 async function fixture(){
  const runId='r0-disposal-'+randomUUID();
  const plan={runId,tenant:randomUUID(),agedTenant:randomUUID(),eventId:randomUUID(),agedEventId:randomUUID(),exportId:randomUUID(),owner:'audit_pending_'+runId};
  const database='mikka_audit_disposal_'+runId.slice(12).replaceAll('-','')+'_e2e';assert.match(database,/^mikka_audit_disposal_[a-f0-9]{32}_e2e$/);
  await admin.query(`CREATE DATABASE "${database}"`);created.push(database);
  const url=new URL(adminURL);url.pathname='/'+database;
  const bootstrap=new Pool({connectionString:url.href});try{await bootstrap.query(core);}finally{await bootstrap.end();}
  const planPath=join(directory,runId+'.plan.json'),manifestPath=join(directory,runId+'.manifest.json');
  await writeFile(planPath,JSON.stringify(plan),{flag:'wx',mode:0o600});
  await prepareAuditDisposal(planPath,manifestPath,url.href);
  const m=JSON.parse(await readFile(manifestPath,'utf8')) as PreparedAuditFixture;
  return {m,url:url.href,open:()=>openAuditFixtureSession(url.href,plan)};
 }
 async function consumeState(url:string){const p=new Pool({connectionString:url});try{return (await p.query('SELECT consumed FROM audit_disposal_owner')).rows[0].consumed;}finally{await p.end();}}
 try {
  await t.test('environment mismatch and forged receipt owner/source are refused without consumption',async()=>{
   const f=await fixture();
   for(const patch of [{oid:'0'},{system:'0'},{schema:'other'},{database:'other'}] as Record<string,string>[]){
    const p=await f.open();try{await assert.rejects(consumeAuditFixtureReceipt(p,{...f.m,environment:{...f.m.environment,...patch}},f.m.sourceHash));}finally{await p.end();}
   }
   const p=await f.open();try{
    await assert.rejects(consumeAuditFixtureReceipt(p,{...f.m,plan:{...f.m.plan,owner:'forged'}},f.m.sourceHash));
    await p.query("UPDATE audit_disposal_owner SET source_hash='forged'");
    await assert.rejects(consumeAuditFixtureReceipt(p,f.m,f.m.sourceHash));
    await p.query('UPDATE audit_disposal_owner SET source_hash=$1',[f.m.sourceHash]);
    await p.query("UPDATE audit_disposal_owner SET run_id='other-fixture'");
    await assert.rejects(consumeAuditFixtureReceipt(p,f.m,f.m.sourceHash));
    await p.query('UPDATE audit_disposal_owner SET run_id=$1',[f.m.plan.runId]);
    assert.equal(await consumeState(f.url),false);
   }finally{await p.end();}
  });
  await t.test('new retained event invalidates the frozen snapshot',async()=>{
   const f=await fixture(),p=await f.open();try{
    await appendAudit(p,f.m.plan.tenant,{actorId:f.m.plan.owner,actorType:'human',resourceId:randomUUID(),action:'fixture.updated',outcome:'success',reason:'changed'});
    await assert.rejects(consumeAuditFixtureReceipt(p,f.m,f.m.sourceHash),/fixture changed/);
    assert.equal(await consumeState(f.url),false);assert.equal((await p.query('SELECT count(*)::int n FROM security_audit_events')).rows[0].n,3);
   }finally{await p.end();}
  });
  await t.test('concurrent receipt admission has one winner and replay remains refused',async()=>{
   const f=await fixture(),a=await f.open(),b=await f.open();
   try{const results=await Promise.allSettled([consumeAuditFixtureReceipt(a,f.m,f.m.sourceHash),consumeAuditFixtureReceipt(b,f.m,f.m.sourceHash)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);}
   finally{await a.end();await b.end();}
   assert.equal(await consumeState(f.url),true);
   const replay=await f.open();try{await assert.rejects(consumeAuditFixtureReceipt(replay,f.m,f.m.sourceHash));}finally{await replay.end();}
  });
  for(const phase of ['before-update','before-commit'] as const) await t.test(phase==='before-update'?'connection loss before receipt update rolls back and pinned session cannot reconnect':'connection loss after receipt update before commit rolls back and releases its lock',async()=>{
   const f=await fixture(),p=await f.open();const pid=(await p.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const original=p.query.bind(p);let interrupted=false;
   Object.defineProperty(p,'query',{value:async(sql:string,values?:unknown[])=>{
    if((phase==='before-update'?sql.startsWith('UPDATE audit_disposal_owner'):sql==='COMMIT')&&!interrupted){interrupted=true;const killed=await admin.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND backend_type='client backend'",[pid,f.m.environment.database]);assert.deepEqual(killed.rows,[{killed:true}]);}
    return original(sql,values);
   }});
   try{await assert.rejects(consumeAuditFixtureReceipt(p,f.m,f.m.sourceHash));assert.equal(interrupted,true);await assert.rejects(p.query('SELECT 1'));}finally{await p.end();}
   assert.equal(await consumeState(f.url),false);
   const recovered=await f.open();try{await consumeAuditFixtureReceipt(recovered,f.m,f.m.sourceHash);}finally{await recovered.end();}
   assert.equal(await consumeState(f.url),true);
  });
  await t.test('over-budget or wrong-ID result rolls back a real transaction without deleting rows',async()=>{
   const f=await fixture(),p=await f.open();
   const before=[{tenant:f.m.plan.agedTenant,id:f.m.plan.agedEventId},{tenant:f.m.plan.tenant,id:f.m.plan.eventId}];
   try{
    for(const [removed,after] of [['2',[]],['1',[before[0]]]] as const){
     await assert.rejects(transaction(p,async tx=>{await tx.query("UPDATE audit_disposal_owner SET source_hash='must-rollback'");validateDeletedEvents(removed,before,[...after],f.m.plan.agedTenant,f.m.plan.agedEventId);}));
     assert.equal((await p.query('SELECT source_hash FROM audit_disposal_owner')).rows[0].source_hash,f.m.sourceHash);
    }
    assert.equal((await p.query('SELECT count(*)::int n FROM security_audit_events')).rows[0].n,2);assert.equal(await consumeState(f.url),false);
   }finally{await p.end();}
  });
 }finally{
  await writeFile(join(directory,'retained-resources.json'),JSON.stringify({databases:created,directory,approvalFilesCreated:0,deletionsExecuted:0},null,2),{mode:0o600});
  console.log('Audit session fixtures retained: '+JSON.stringify({directory,databases:created}));await admin.end();
 }
});
