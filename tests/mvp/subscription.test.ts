import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { streamText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { SubscriptionService } from '../../lib/subscription-service'
import type { SubscriptionRepository } from '../../lib/subscription-repository'
import { SubscriptionWorkerClient } from '../../packages/daemon/src/subscription-worker-client'
import { startMvpServices } from './services.mjs'
import { MVP_SERVICES,REPOSITORY } from './isolated-env.mjs'
import { MVP_SUBSCRIPTION_MODEL } from './subscription.mjs'

test('MVP subscription boundary retains real service authorization, private worker IPC and streamed tool calls',async()=>{
 const services=await startMvpServices(3191)
 const owner='mvp-owner',workspaceId=randomUUID(),consumerId=randomUUID(),connectionId=randomUUID(),bindingId=randomUUID()
 const binding={id:bindingId,ownerId:owner,workspaceId,consumerId,connectionId,connectionRevision:1,route:'codex_cpa' as const,modelId:MVP_SUBSCRIPTION_MODEL}
 const row={id:connectionId,ownerId:owner,workspaceId,provider:'codex' as const,state:'connected',epoch:'1',quota:{vendor:'codex',source:'official',status:'ok',plan:null,observedAt:new Date().toISOString(),windows:[{kind:'five_hour',used:0.1,resetsAt:null}]}}
 const config={scope:{ownerId:owner,workspaceId,connectionId,provider:'codex' as const},databaseUrl:'postgresql://ci:fixture@127.0.0.1:5432/mikka_e2e',infisicalOrigin:MVP_SERVICES,project:'mvp-synthetic',environment:'test',path:'/custody',workloadToken:'mvp-synthetic-custody',accessPath:'/access',accessToken:'mvp-synthetic-access'}
 const worker=new SubscriptionWorkerClient({binary:fileURLToPath(new URL('./subscription-worker.mjs',import.meta.url))},config)
 const repository={binding:async(user:string,id:string)=>{assert.equal(user,owner);assert.equal(id,bindingId);return binding},connection:async(user:string,id:string)=>{assert.equal(user,owner);assert.equal(id,connectionId);return row},scope:()=>config.scope,saveQuota:async()=>undefined} as unknown as SubscriptionRepository
 let scopeChecks=0
 const service=new SubscriptionService(repository,()=>worker,{ready:()=>true,nativeIsolation:'none'},undefined,async(user,id)=>{assert.equal(user,owner);assert.equal(id,workspaceId);scopeChecks++},async(scope,model,route)=>{assert.deepEqual(scope,{ownerId:owner,workspaceId});assert.equal(model,binding.modelId);assert.equal(route,binding.route)})
 try {
  const marker=`mvp-${randomUUID()}`,deviceId=randomUUID(),issueId=randomUUID(),agentId=randomUUID(),runId=randomUUID()
  await fetch(`${services.origin}/scenario`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({marker,title:'Subscription MVP'})})
  await fetch(`${services.origin}/scenario/device`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({deviceId})})
  const calls:string[]=[]
  const model=await service.model({ownerId:owner,workspaceId,consumerId,bindingId,execution:'model'})
  const result=streamText({model,prompt:`${marker}\nThe person selected device ${deviceId} in the task dialog.`,stopWhen:stepCountIs(5),maxRetries:0,tools:{
   create_issue:tool({inputSchema:z.object({title:z.string(),body:z.string()}),execute:()=>{calls.push('issue');return {id:issueId}}}),
   list_agents:tool({inputSchema:z.object({}),execute:()=>[{id:agentId,deviceId,harness:'mock',deviceOnline:true}]}),
   dispatch_run:tool({inputSchema:z.object({issueId:z.uuid(),agentId:z.uuid(),repo:z.string()}),execute:input=>{assert.equal(input.repo,REPOSITORY);assert.equal(input.issueId,issueId);calls.push('dispatch');return {runId,status:'queued'}}}),
  }})
  assert.match(await result.text,/启动线程/)
  assert.deepEqual(calls,['issue','dispatch']);assert.ok(scopeChecks>=4)
  row.state='disconnected'
  await assert.rejects(service.model({ownerId:owner,workspaceId,consumerId,bindingId,execution:'model'}))
  const remote=new SubscriptionWorkerClient({binary:fileURLToPath(new URL('./subscription-worker.mjs',import.meta.url))},{...config,databaseUrl:'postgresql://ci:fixture@remote.invalid/production'})
  await assert.rejects(remote.call('prepare',{revision:1}))
 } finally {await services.close()}
})
