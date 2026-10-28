import test from 'node:test';
import assert from 'node:assert/strict';
import type { FactoryTask } from './store';
import { composeFactoryConsumers, assertFactoryArtifactBinding, type FactoryConsumerAdapter } from './consumer-contract';
const task = {id:'task',userId:'owner',botId:'bot',issueId:'issue',sourceEventId:'source',attemptId:'attempt',revision:4,candidateId:'candidate',stage:'monitor',status:'running'} as FactoryTask;
const run: Parameters<typeof assertFactoryArtifactBinding>[1] = {id:'run',userId:'owner',botId:'bot',issueId:'issue',sessionId:'session',stopRequestedAt:null,definitionDigest:'frozen'};
const now = Date.parse('2026-10-28T19:00:00Z');
const artifact = {userId:task.userId,botId:task.botId,issueId:task.issueId,sourceEventId:task.sourceEventId,taskId:task.id,attemptId:task.attemptId,revision:task.revision,candidateId:'candidate',stage:'monitor' as const,runId:run.id,sessionId:'session',sha:'a'.repeat(40),definitionDigest:'frozen',artifactId:'trusted:artifact',artifactDigest:'b'.repeat(64),observedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+1000).toISOString()};
const check = (a=artifact,t=task,r=run) => assertFactoryArtifactBinding(t,r,'a'.repeat(40),a,{now,maxAgeMs:5000});
test('trusted binding envelope rejects every identity change and expiry; does not confer source trust',()=>{
  check();
  for(const key of ['userId','botId','issueId','sourceEventId','taskId','attemptId','candidateId','stage','runId','sessionId','sha','definitionDigest'] as const)
    assert.throws(()=>check({...artifact,[key]:'different'}),/factoryArtifactBindingInvalid/,key);
  for(const change of [{revision:3},{artifactDigest:'bad'},{artifactId:''},{observedAt:'invalid'},{observedAt:new Date(now+1).toISOString()},{observedAt:new Date(now-5001).toISOString()},{expiresAt:new Date(now).toISOString()}])
    assert.throws(()=>check({...artifact,...change}),/factoryArtifactBindingInvalid/);
  for(const status of ['cancelled','revoked','waiting','passed','failed'] as const)
    assert.throws(()=>check(artifact,{...task,status}),/factoryArtifactBindingInvalid/);
  assert.throws(()=>check(artifact,task,{...run,stopRequestedAt:'cancelled'}),/factoryArtifactBindingInvalid/);
  assert.throws(()=>check(artifact,task,{...run,sessionId:'new-session'}),/factoryArtifactBindingInvalid/);
});
test('all hooks required atomically; duplicate and missing phase registration deny',async()=>{
  const tx={} as Parameters<FactoryConsumerAdapter['validateClaim']>[0];
  let called=0;
  const adapter:FactoryConsumerAdapter={stage:'monitor',configure:async()=>{},gate:async()=>false,validateClaim:async(actualTx,actualTask,id)=>{assert.equal(actualTx,tx);assert.equal(actualTask,task);assert.equal(id,'run');called++;return {fixture:true};},reconcile:async()=>{}};
  const installed=composeFactoryConsumers([adapter]);
  assert.equal(installed.configure.monitor,adapter.configure);
  assert.equal(installed.gates.monitor,adapter.gate);
  assert.equal(installed.consumers.monitor,adapter.reconcile);
  assert.deepEqual(await installed.validateClaim(tx,task,'run'),{fixture:true});
  assert.equal(called,1);
  await assert.rejects(()=>installed.validateClaim(tx,{...task,stage:'verify'},'run'),/factoryDispatchAdapterRequired/);
  await assert.rejects(()=>composeFactoryConsumers().validateClaim(tx,task,'run'),/factoryDispatchAdapterRequired/);
  assert.throws(()=>composeFactoryConsumers([adapter,adapter]),/factoryConsumerRegistrationInvalid/);
  for(const hook of ['configure','gate','validateClaim','reconcile'])
    assert.throws(()=>composeFactoryConsumers([{...adapter,[hook]:undefined} as unknown as FactoryConsumerAdapter]),/factoryConsumerRegistrationInvalid/);
});
