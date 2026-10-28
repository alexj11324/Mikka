import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import type { AgentKitStore } from './store'

let effects=0
const forbidden=()=>{effects++;throw new Error('External effect forbidden in offline test')}
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
stub('../subscription-runtime.ts',{authorizeSubscriptionWorkspace:forbidden,subscriptionRuntime:forbidden})
stub('../coordinator/bot-instructions.ts',{botInstructions:forbidden})
stub('../../workflows/coordinator/tools.ts',{createCoordinatorRegistry:forbidden})
mock.module('ai',{namedExports:{generateText:forbidden,streamText:forbidden,isStepCount:forbidden}})

test('live evaluation remains disabled and refuses before store, model or custody access',async()=>{
  // This test never enables the live-eval flag.
  delete process.env.MIKKA_AGENT_KIT_LIVE_EVAL
  const {evaluateProposal}=await import('./live-eval')
  const store=new Proxy({}, {get:()=>forbidden}) as AgentKitStore
  await assert.rejects(evaluateProposal(store,{ownerId:'synthetic-owner',botId:null,workspaceId:null},'synthetic-proposal','synthetic-request','live'),{message:'agentLiveEvaluationDisabled'})
  assert.equal(effects,0)
})
