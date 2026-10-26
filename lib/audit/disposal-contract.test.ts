import test from 'node:test';
import assert from 'node:assert/strict';
import { hash,validatePlan,validateTarget,validateApproval } from './disposal-contract';
const plan={runId:'r0-disposal-3f1259ac-a4d1-4911-a050-9055dcc5df51',tenant:'039cb3d5-f804-4109-80e1-c3598ddb360a',agedTenant:'02a6f500-9d2f-4741-9e5d-6a6996835592',eventId:'b6b95f84-f3d2-41f7-9475-3bd405c17f00',agedEventId:'03b2c5bf-32ad-493a-85e5-f02b59fda082',owner:'audit_pending_r0-disposal-3f1259ac-a4d1-4911-a050-9055dcc5df51'};
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
