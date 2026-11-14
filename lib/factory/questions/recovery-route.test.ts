import assert from 'node:assert/strict';
import { mock,test } from 'node:test';
import { FactoryError } from '../contract';
let enabled=true,owner:string|null='owner',sessionId:string|null='session',queries=0,calls=0;
const verifiedUsers = new WeakSet<object>();
mock.module('@/lib/api-auth',{namedExports:{auth:{api:{getSession:async()=>{if(!owner)return null;const user={id:owner};verifiedUsers.add(user);return {user,session:sessionId?{id:sessionId}:null};}}}}});
// This unit preserves the actual credential, origin and Factory adapters.
// Workspace authorization and transaction ownership are covered by the real PG suite.
mock.module("@/lib/factory/workspace-http", { namedExports: {
  factoryHumanWorkspaceResponse: async (user: object | null | undefined, work: () => Promise<Response>) => {
    assert.ok(user && verifiedUsers.has(user), "the adapter must retain the complete verified user");
    return work();
  },
} });

mock.module('@/lib/db',{namedExports:{pool:{query:async()=>{queries++;return {rows:[{botId:null}]};}}}});
let recoveryError: FactoryError | undefined;
mock.module('@/lib/factory/runtime',{namedExports:{factoryLifecycleEnabled:()=>enabled,factoryRuntimeForBot:()=>({questions:{recover:async(actor:unknown,body:unknown)=>{calls++;if(recoveryError)throw recoveryError;return {actor,body};}}})}});
const id='00000000-0000-4000-8000-000000000001';
const body={requestId:id,expectedFailedRunId:id,reference:{questionId:id,questionRevision:3,binding:{taskId:id,issueId:id,attemptId:id,candidateId:null,revision:12},originRunId:id,originSessionId:'sid'}};
test('owner recovery has a bounded Node runtime budget for retained-machine preparation',async()=>{
 const route=await import('@/app/api/factory/questions/[questionId]/recover/route');
 assert.equal(route.runtime,'nodejs');assert.equal(route.maxDuration,300);
});
async function call(headers:Record<string,string>={},input:unknown=body){
 const {POST}=await import('@/app/api/factory/questions/[questionId]/recover/route');
 const response=await POST(new Request(`https://mikka.test/api/factory/questions/${id}/recover`,{method:'POST',headers:{origin:'https://mikka.test',...headers},body:JSON.stringify(input)}),{params:Promise.resolve({questionId:id})});
 return {status:response.status,body:await response.json()};
}
test('recovery requires enabled feature, normal human session and same origin before state access',async()=>{
 enabled=false;assert.equal((await call()).status,404);enabled=true;
 assert.equal((await call({authorization:'Bearer synthetic'})).status,401);
 owner=null;assert.equal((await call()).status,401);owner='owner';
 sessionId=null;assert.equal((await call()).status,401);sessionId='session';
 assert.equal((await call({origin:'https://other.test'})).status,403);
 assert.equal(queries,0);assert.equal(calls,0);
});
test('recovery rejects caller answer, model, credential and history source; accepts only current reference',async()=>{
 for(const extra of [{text:'answer'},{model:'model'},{subscriptionBindingId:id},{historyRunId:id}]) assert.equal((await call({},{...body,...extra})).status,422);
 assert.equal(calls,0);
 const result=await call();assert.equal(result.status,200);assert.deepEqual(result.body.actor,{source:'human',userId:'owner',sessionId:'session'});assert.deepEqual(result.body.body,body);assert.equal(calls,1);
});

test('cloud recovery sends only its public failure code', async () => {
 const cause = new Error('private fixture diagnostic');
 recoveryError = new FactoryError('factoryQuestionContinuationUnavailable', { cause });
 try {
   assert.deepEqual(await call(), { status: 409, body: { error: 'factoryQuestionContinuationUnavailable' } });
 } finally {
   recoveryError = undefined;
 }
});
