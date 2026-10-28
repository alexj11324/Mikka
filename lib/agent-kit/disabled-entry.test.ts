import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
let effects=0
const forbidden=()=>{effects++;throw new Error('Unexpected authority, database or provider access')}
const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
stub('./service.ts',{agentKitEnabled:()=>false,agentScope:forbidden,agentKitStore:new Proxy({},{get:()=>forbidden})})
stub('../subscription-runtime.ts',{authorizeSubscriptionWorkspace:forbidden,subscriptionRuntime:forbidden})
stub('../coordinator/bot-instructions.ts',{botInstructions:forbidden})
stub('../coordinator/instructions.ts',{COORDINATOR_INSTRUCTIONS:'synthetic host'})
stub('../coordinator/native-prompt.ts',{personalCoordinatorInstructions:forbidden})
stub('../../workflows/coordinator/tool-scope.ts',{assertNativeToolScope:forbidden})
test('disabled execution entry returns before scope, binding or model access',async()=>{
  const {beginAgentExecution}=await import('../../workflows/coordinator/agent-kit-steps')
  assert.equal(await beginAgentExecution('synthetic-owner',null,'synthetic-workflow',0,{harness:'ai_sdk'}),null)
  assert.equal(effects,0)
})
