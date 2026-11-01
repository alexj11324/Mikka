import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { StoredMessage } from './context'

// Actual durable prompt functions, with every external/DB/model effect replaced
// by explicit fixtures. No database, provider or native job is started.
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
const conversation: { summary: string | null; memory: string; messages: StoredMessage[] } = { summary: null, memory: '', messages: [] }
const saved: unknown[][] = [], enqueued: unknown[][] = [], forwarded: unknown[][] = []
let streamed=0, deny=false, streamFailure=false
let streamFinishOverride:string|undefined, streamErrorEvent=false
const model={synthetic:true}
const resolved: unknown[][]=[]
let modelCalls = 0
stub('./store.ts', { loadConversation: async () => conversation, saveSummary: async (...args: unknown[]) => { saved.push(args) } })
stub('./native.ts', { nativeCoordinatorEnabled: () => true, nativeCoordinatorStore: { enqueue: async (...args: unknown[]) => { enqueued.push(args); return 'pure-turn' } } })
stub('./bot-instructions.ts', { botInstructions: async (_owner: string, _bot: string | null, base: string) => base })
stub('./personal-instructions.ts', { withPersonalInstructions: async (_owner: string, base: string) => base })
stub('../db/index.ts', { db: null, pool: null, withDatabaseClient: () => { throw Error('No database transaction in prompt fixture') } })
stub('../issue-visibility.ts', { issueVisibility: () => { throw Error('No database in pure test') } })
stub('../agent-runs.ts', { addRunMessage: async (...args: unknown[]) => { forwarded.push(args) }, queueRun: () => {}, queueFactoryRun: () => { throw Error('No Factory dispatch in prompt fixture') }, readRun: () => {}, requestRunStop: () => {}, visibleRuns: () => {} })
stub('../search/index.ts', { webSearch: () => {} })
stub('../device-link.ts', { DEVICE_ONLINE_WINDOW_MS: 60000, WORKSPACE_ID: 'synthetic-unused' })
stub('../composio.ts', { runComposioAction: () => {} })
// Factory issue-link registration is imported by the tool graph; prompt tests never authorize GitHub reads.
stub('../github/user-access.ts', { readAuthorizedIssue: () => { throw Error('No GitHub authorization or provider I/O in prompt fixture') } })
stub('../pending-action-store.ts', { proposeAction: () => {}, writeAccountAction: () => {}, proposeRepositoryPush: () => {} })
stub('../issue-access.ts', { issueForUser: () => {} })
stub('../telegram/client.ts', { postTelegramText: () => {} })
stub('../attention/store.ts', { recordDecision: () => {}, settleTurn: () => {} })
stub('../../workflows/coordinator/tool-scope.ts', { assertNativeToolScope: async () => {} })
stub('../subscription-model-snapshot.ts', { resolveFrozenHostedModel: async (...args:unknown[])=>{resolved.push(args);if(deny)throw new Error('binding_mismatch');const runtime=args[1] as {model:string;modelSelection?:unknown};return runtime.modelSelection?model:runtime.model} })
stub('../subscription-runtime.ts', { subscriptionRuntime:()=>{throw new Error('No real custody')}, authorizeSubscriptionWorkspace:()=>{throw new Error('No real workspace') } })
import * as actualAI from 'ai'
mock.module('ai', { namedExports: { ...actualAI,
 generateText:async(options:{model:unknown})=>{modelCalls++;assert.equal(options.model,'saved-default');return {text:'default summary',finishReason:'stop'}},
 streamText:(options:{model:unknown,maxRetries:number,onError?:(event:{error:Error})=>void})=>{streamed++;assert.equal(options.model,model);assert.equal(options.maxRetries,0);if(streamErrorEvent)options.onError?.({error:new Error('Synthetic stream error')});return {text:Promise.resolve('subscription summary'),finishReason:Promise.resolve(streamFinishOverride??(streamFailure?'error':'stop'))}},
 pruneMessages:({messages}:{messages:unknown[]})=>messages,
} })

import { makeSnapshot } from '../agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const selection={type:'subscription' as const,bindingId:id(3),ownerId:'owner',consumerId:id(1),workspaceId:id(2),connectionId:id(4),connectionRevision:7,modelId:'saved-model',route:'claude_cpa' as const}
const snapshot=(subscription=true)=>makeSnapshot(id(8),1,DEFAULT_AGENT_DEFINITION,'saved instructions',subscription?{harness:'ai_sdk',model:selection.modelId,modelSelection:selection}:{harness:'ai_sdk',model:'saved-default'})
test('actual preparePrompt compacts with frozen subscription, preserves provenance, and never calls default on refusal',async()=>{
 process.env.BETTER_AUTH_SECRET='synthetic-test-provenance-secret-000000'
 const sdk=await import('../../workflows/coordinator/steps')
 conversation.messages=Array.from({length:46},(_,i)=>({position:i+1,message:{role:'user' as const,content:'retained user request '.repeat(3500)}}))
 const prompt=await sdk.preparePrompt('owner',id(1),snapshot())
 assert.equal(streamed,1);assert.equal(modelCalls,0);assert.equal(saved.length,1)
 assert.equal((resolved[0][0] as {ownerId:string}).ownerId,'owner')
 assert.equal((resolved[0][0] as {botId:string}).botId,id(1))
 assert.ok(JSON.stringify(prompt.messages).includes('subscription summary'))
 deny=true
 await assert.rejects(sdk.preparePrompt('owner',id(1),snapshot()),/binding_mismatch/)
 assert.equal(streamed,1);assert.equal(modelCalls,0);assert.equal(saved.length,1)
 deny=false
 streamFailure=true
 await assert.rejects(sdk.preparePrompt('owner',id(1),snapshot()),/subscription_generation_failed/)
 assert.equal(saved.length,1);assert.equal(modelCalls,0)
 streamFailure=false
 for(const reason of ['length','content-filter','other','tool-calls']){
  streamFinishOverride=reason
  await assert.rejects(sdk.preparePrompt('owner',id(1),snapshot()),/subscription_generation_failed/)
  assert.equal(saved.length,1,'partial or abnormal summary cannot advance the cursor')
  assert.equal(modelCalls,0,'an abnormal subscription finish cannot fall back')
 }
 streamFinishOverride=undefined
 streamErrorEvent=true
 await assert.rejects(sdk.preparePrompt('owner',id(1),snapshot()),/subscription_generation_failed/)
 assert.equal(saved.length,1,'stream error callback wins over a contradictory stop envelope')
 assert.equal(modelCalls,0)
 streamErrorEvent=false
 await sdk.preparePrompt('owner',id(1),snapshot(false))
 assert.equal(modelCalls,1)
 const malformed=snapshot();malformed.runtime.modelSelection=null as never
 await assert.rejects(sdk.preparePrompt('owner',id(1),malformed),/subscription_model_unavailable/)
 assert.equal(modelCalls,1)
 const native=snapshot();native.runtime.harness='codex'
 await assert.rejects(sdk.preparePrompt('owner',id(1),native),/subscription_model_unavailable/)
 assert.equal(modelCalls,1)
})
