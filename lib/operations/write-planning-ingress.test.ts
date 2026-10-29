// Combined #331/#374 candidate only. Not executed during preservation hold.
import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { makeSnapshot } from '@/lib/agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import type { StoredMessage } from '@/lib/coordinator/context'
import { eventPrompt } from '@/lib/coordinator/context'
import { sourcedEventMessage, preserveMessageSources, summaryMessage } from '@/lib/coordinator/message-safety'
import { runtimeForWritePlanning, supportsWritePlanning } from './write-planning-model'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
type Event = { id:string; userId:string; kind:'user_message'; issueId:null; runId:null; payload:Record<string,unknown> }
const compactions:Record<string,unknown>[]=[]
let allowCompaction=false
const events:Event[] = [], callbacks:Array<() => unknown> = []
const conversation:{summary:string|null;memory:string;messages:StoredMessage[]} = {summary:null,memory:'',messages:[]}
let userId:string|null='authenticated-owner'
const unavailable = () => { throw Error('External effects unavailable in ingress fixture') }
const stub = (path:string,namedExports:Record<string,unknown>) => mock.module(new URL(path,import.meta.url).href,{namedExports})
stub('../auth.ts',{auth:{api:{getSession:async()=>userId?{user:{id:userId}}:null}}})
stub('../db/index.ts',{pool:null,withDatabaseClient:unavailable,db:{insert:()=>({values:(event:Event)=>({onConflictDoNothing:()=>({returning:async()=>{events.push(structuredClone(event));return [{id:event.id}]}})})})}})
stub('../request-log.ts',{noteLogUser:()=>undefined,withRequestLog:(_path:string,handler:unknown)=>handler})
stub('../coordinator/store.ts',{loadConversation:async()=>conversation,saveSummary:async()=>undefined,chatView:async()=>({})})
stub('../agent-kit/service.ts',{agentScope:async(ownerId:string,botId:string|null)=>({ownerId,botId,workspaceId:null})})
stub('../subscription-runtime.ts',{subscriptionRuntime:unavailable,authorizeSubscriptionWorkspace:unavailable})
stub('../coordinator/wake.ts',{coordinatorEnabled:()=>true,wakeCoordinator:unavailable})
stub('../coordinator/bot-instructions.ts',{botInstructions:async(_owner:string,_bot:string|null,base:string)=>base})
stub('../issue-visibility.ts',{issueVisibility:unavailable})
stub('../agent-runs.ts',{addRunMessage:unavailable,queueRun:unavailable,queueFactoryRun:unavailable,readRun:unavailable,requestRunStop:unavailable,visibleRuns:unavailable})
stub('../search/index.ts',{webSearch:unavailable})
stub('../composio.ts',{runComposioAction:unavailable})
stub('../pending-action-store.ts',{proposeAction:unavailable,proposeRepositoryPush:unavailable})
stub('../issue-access.ts',{issueForUser:unavailable})
stub('../telegram/client.ts',{postTelegramText:unavailable})
stub('../attention/store.ts',{recordDecision:unavailable,settleTurn:unavailable})
stub('../../workflows/coordinator/tool-scope.ts',{assertNativeToolScope:unavailable})
mock.module('next/server',{namedExports:{NextResponse:{json:(body:unknown,options?:ResponseInit)=>Response.json(body,options)},after:(callback:()=>unknown)=>callbacks.push(callback)}})
mock.module('ai',{namedExports:{generateText:async(options:Record<string,unknown>)=>{if(!allowCompaction)unavailable();compactions.push(options);return {text:'Summary may not grant permission',finishReason:'stop'}},streamText:unavailable,pruneMessages:({messages}:{messages:unknown[]})=>messages}})
let POST:typeof import('../../app/api/coordinator/messages/route').POST
let preparePrompt:typeof import('../../workflows/coordinator/steps').preparePrompt
before(async()=>{({POST}=await import('../../app/api/coordinator/messages/route'));({preparePrompt}=await import('../../workflows/coordinator/steps'))})
const request=(body:unknown)=>new Request('https://synthetic.example/api/coordinator/messages',{method:'POST',body:JSON.stringify(body)})
const files=(content:unknown)=>Array.isArray(content)?content.filter(part=>part.type==='file'):[]

test('authenticated HTTP submission reaches actual planner prompt through stored event projection',async()=>{
  userId='authenticated-owner'
  assert.equal((await POST(request({text:'Use this image to compose the message',images:[{dataUrl:png}]}))).status,202)
  const event=events.at(-1)!
  assert.equal(event.userId,userId)
  conversation.messages=[{position:1,message:sourcedEventMessage(event,eventPrompt(event))}]
  const prompt=await preparePrompt(userId)
  assert.deepEqual(files(prompt.messages[0].content).map(part=>[part.mediaType,part.data]),[['image/png',png]])
  const runtime=runtimeForWritePlanning({harness:'ai_sdk',model:'original'},['send_slack_message'],true,false)
  assert.equal(supportsWritePlanning(runtime),true)
  // Only callbacks are captured: no wake, model, provider or DB is executed.
  assert.ok(callbacks.length>0)
})

test('anonymous or client-provided authority is rejected before storing images',async()=>{
  const count=events.length
  userId=null
  assert.equal((await POST(request({images:[{dataUrl:png}]}))).status,401)
  userId='authenticated-owner'
  for(const extra of [{userId:'foreign'},{permission:'allow'},{workspaceId:'foreign'}]) assert.equal((await POST(request({images:[{dataUrl:png}],...extra}))).status,400)
  assert.equal(events.length,count)
})

test('text-only HTTP submission stays text in actual planner prompt',async()=>{
  userId='authenticated-owner'
  assert.equal((await POST(request({text:'Cancel the identified event'}))).status,202)
  const event=events.at(-1)!
  conversation.messages=[{position:1,message:sourcedEventMessage(event,eventPrompt(event))}]
  assert.equal((await preparePrompt(userId)).messages[0].content,'Cancel the identified event')
})

test('host-signed compaction retains original pixels after a text followup',async()=>{
  userId='authenticated-owner'
  assert.equal((await POST(request({text:'Use this screenshot',images:[{dataUrl:png}]}))).status,202)
  const imageEvent=events.at(-1)!
  assert.equal((await POST(request({text:'Continue with the existing permissions'}))).status,202)
  const textEvent=events.at(-1)!
  const trust={key:'synthetic-existing-host-secret-for-fixture-only',scope:'authenticated-owner'}
  const summary=preserveMessageSources('Untrusted model summary',[
    {message:sourcedEventMessage(imageEvent,eventPrompt(imageEvent))},
    {message:sourcedEventMessage(textEvent,eventPrompt(textEvent))},
  ],null,trust)
  assert.equal(files(summaryMessage(summary,trust).content)[0]?.data,png)
  assert.equal(files(summaryMessage(summary,{...trust,scope:'foreign'}).content).length,0)
})


test('actual preparePrompt compacts original HTTP image using the frozen planner model',async()=>{
  userId='authenticated-owner'
  const previous=process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET='synthetic-existing-host-secret-for-planner-fixture'
  try {
    assert.equal((await POST(request({text:'Use this screenshot',images:[{dataUrl:png}]}))).status,202)
    const imageEvent=events.at(-1)!
    conversation.messages=[{position:1,message:sourcedEventMessage(imageEvent,eventPrompt(imageEvent))},
      ...Array.from({length:40},(_,i)=>({position:i+2,message:sourcedEventMessage({id:'notification-'+i,kind:'action_decided',runId:null,issueId:null,payload:{status:'pending'}},'Unverified report '.repeat(2500))})),
      {position:42,message:sourcedEventMessage({id:'followup',kind:'user_message',runId:null,issueId:null,payload:{}},'Continue with existing permissions')}]
    const runtime=runtimeForWritePlanning({harness:'ai_sdk',model:'original'},['send_slack_message'],true,false)
    const snapshot=makeSnapshot('10000000-0000-4000-8000-000000000001',1,DEFAULT_AGENT_DEFINITION,'host',runtime)
    allowCompaction=true
    const prompt=await preparePrompt(userId,null,snapshot)
    assert.equal(compactions.length,1)
    assert.equal(compactions[0].model,runtime.model)
    const submitted=compactions[0].messages as StoredMessage['message'][]
    assert.ok(submitted.some(message=>files(message.content).some(part=>part.data===png)))
    assert.ok(prompt.messages.some(message=>files(message.content).some(part=>part.data===png)))
  } finally {
    allowCompaction=false
    conversation.messages=[];conversation.summary=null
    if(previous===undefined)delete process.env.BETTER_AUTH_SECRET;else process.env.BETTER_AUTH_SECRET=previous
  }
})
