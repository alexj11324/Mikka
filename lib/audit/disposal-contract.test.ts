import test from 'node:test';
import assert from 'node:assert/strict';
import { hash,validatePlan,validateTarget,validateApproval,validatePruneRows } from './disposal-contract';
const plan={runId:'r0-disposal-3f1259ac-a4d1-4911-a050-9055dcc5df51',tenant:'039cb3d5-f804-4109-80e1-c3598ddb360a',agedTenant:'02a6f500-9d2f-4741-9e5d-6a6996835592',eventId:'b6b95f84-f3d2-41f7-9475-3bd405c17f00',agedEventId:'03b2c5bf-32ad-493a-85e5-f02b59fda082',exportId:'5eb9914c-652c-454d-a293-91df62220707',owner:'audit_pending_r0-disposal-3f1259ac-a4d1-4911-a050-9055dcc5df51'};
test('exact run-bound IDs and database reject broad loopback or duplicate identity',()=>{
 validatePlan(plan);
 const url='postgres://127.0.0.1/mikka_audit_disposal_3f1259aca4d14911a0509055dcc5df51_e2e';validateTarget(url,plan);
 for(const u of [url.replace('127.0.0.1','example.test'),url+'?options=evil',url.replace('3f1259aca4d14911a0509055dcc5df51','other')]) assert.throws(()=>validateTarget(u,plan));
 assert.throws(()=>validatePlan({...plan,agedTenant:plan.tenant}));
});
test('approval binds bytes/source/run/budget/expiry; no flag grants approval',()=>{
 const text='exact manifest\n', now=10000000;
 const a={manifestHash:hash(text),sourceHash:'source',runId:plan.runId,decision:'approve-one-audit-disposal-run',expiresAt:new Date(now+60000).toISOString(),authorizationReference:'test-only-not-an-approval',maxPersistentDeletedEvents:1};
 validateApproval(a,text,'source',plan.runId,now);
 for(const patch of [{manifestHash:hash(text+' ')},{sourceHash:'other'},{runId:'other'},{decision:'true'},{maxPersistentDeletedEvents:2},{authorizationReference:''},{expiresAt:new Date(now-1).toISOString()},{expiresAt:new Date(now+3600001).toISOString()}]) assert.throws(()=>validateApproval({...a,...patch},text,'source',plan.runId,now));
 assert.throws(()=>validateApproval({} as never,text,'source',plan.runId,now));
});

test('destructive probes always rollback, including unexpected success and assertion failure',async()=>{
 const {rollbackProbe}=await import('./disposal-contract');
 for(const fails of [false,true]) {
  const calls:string[]=[];const db={query:async(sql:string)=>{calls.push(sql);}};
  const probe=rollbackProbe(db,async()=>{calls.push('probe');if(fails)throw Error('unexpected probe result');return 'unexpected success';});
  if(fails)await assert.rejects(probe);else assert.equal(await probe,'unexpected success');
  assert.deepEqual(calls,['BEGIN','probe','ROLLBACK']);
 }
});

test('prune allows only frozen expired event and fresh exact export ID; rejects extra or aged export',()=>{
 const rows=[
  {id:plan.agedEventId,seq:'1',floor:'0',retention:90,expired:true,event:{actorId:plan.owner,actorType:'human',resourceId:plan.eventId,action:'credential.revoked',outcome:'success',reason:'revoked'}},
  {id:plan.exportId,seq:'2',floor:'0',retention:90,expired:false,event:{actorId:plan.owner,actorType:'human',resourceId:plan.exportId,action:'audit.export',outcome:'success',reason:'snapshot'}}
 ];
 validatePruneRows(rows,plan);
 for(const changed of [[rows[0]], [...rows,rows[1]], [rows[0],{...rows[1],expired:true}], [rows[0],{...rows[1],id:plan.eventId}], [{...rows[0],floor:'1'},rows[1]], [rows[0],{...rows[1],event:{...rows[1].event,actorId:'other'}}]]) assert.throws(()=>validatePruneRows(changed,plan));
});

test('absolute checkout B entry hashes B even from checkout A cwd; A manifest fails before DB',async()=>{
 const {mkdtemp,mkdir,readFile,writeFile,symlink}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join,dirname}=await import('node:path');
 const {fileURLToPath}=await import('node:url');const {execFileSync}=await import('node:child_process');
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const dir=await mkdtemp(join(tmpdir(),'r0-audit-source-bind-'));
 const files=['lib/audit/disposal-contract.ts','lib/audit/disposal-session.ts','lib/audit/postgres-deletion.pending.test.ts','lib/audit/store.ts','drizzle/20261025170000_security_audit_application.sql','scripts/prepare-audit-disposal.ts','package.json','pnpm-lock.yaml','tsconfig.json'];
 for(const checkout of ['a','b']){
  for(const file of files){const target=join(dir,checkout,file);await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile(join(root,file)));}
  await symlink(join(root,'node_modules'),join(dir,checkout,'node_modules'),'dir');
  await writeFile(join(dir,checkout,'probe.ts'),`import {auditSourceHash,claimAuditDisposal} from './lib/audit/disposal-session';\nif(process.argv[2]==='hash') console.log(await auditSourceHash()); else { try { await claimAuditDisposal(process.argv[2],'/absent-approval',process.argv[3]); throw Error('unexpected admission'); } catch(e) { if((e as {code?:string}).code!=='ERR_ASSERTION') throw e;console.log('source-mismatch-before-db'); } }`);
 }
 await writeFile(join(dir,'b','lib/audit/store.ts'),(await readFile(join(dir,'b','lib/audit/store.ts'),'utf8'))+'\n// checkout B changed source\n');
 const run=(entry:string,args:string[])=>execFileSync(process.execPath,['--import','tsx',entry,...args],{cwd:join(dir,'a'),encoding:'utf8'}).trim();
 const a=run(join(dir,'a','probe.ts'),['hash']), b=run(join(dir,'b','probe.ts'),['hash']);assert.notEqual(a,b);
 const manifest=join(dir,'manifest-a.json');
 const raw='postgres://127.0.0.1/mikka_audit_disposal_3f1259aca4d14911a0509055dcc5df51_e2e';
 await writeFile(manifest,JSON.stringify({version:1,maxPersistentDeletedEvents:1,plan,target:validateTarget(raw,plan),sourceHash:a}),{mode:0o600});
 assert.equal(run(join(dir,'b','probe.ts'),[manifest,raw]),'source-mismatch-before-db');
 // Preserve both checkout fixtures and manifest; no cleanup/deletion in this test.
});
