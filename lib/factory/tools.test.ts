import assert from 'node:assert/strict'
import {test,before,mock} from 'node:test'
import {randomUUID} from 'node:crypto'
const intake=mock.fn(async()=>({task:{stage:'execute',status:'pending'}}))
mock.module('@/workflows/coordinator/steps',{namedExports:{intakeFactoryRequest:intake,listFactoryRequests:async()=>[],readFactoryTask:async()=>({}),resolveFactoryTask:async()=>({})}})
mock.module('@/workflows/coordinator/agent-kit-steps',{namedExports:{}})
mock.module('@/lib/composio-actions',{namedExports:{createComposioAITools:()=>({}),createGoogleAITools:()=>({})}})
let registry:typeof import('@/workflows/coordinator/tools')
before(async()=>{registry=await import('@/workflows/coordinator/tools')})
test('actual tool adapter keeps host owner/Bot/scope and requires both rollout flags',async()=>{
 const old=[process.env.MIKKA_FACTORY_ROUTING_ENABLED,process.env.MIKKA_ISSUE_TOOLS_ENABLED]
 try{
 delete process.env.MIKKA_FACTORY_ROUTING_ENABLED;process.env.MIKKA_ISSUE_TOOLS_ENABLED='1'
 assert.equal(registry.createCoordinatorRegistry('owner','bot').intake_factory_request,undefined)
 process.env.MIKKA_FACTORY_ROUTING_ENABLED='1';process.env.MIKKA_ISSUE_TOOLS_ENABLED='0'
 assert.equal(registry.createCoordinatorRegistry('owner','bot').intake_factory_request,undefined)
 process.env.MIKKA_ISSUE_TOOLS_ENABLED='1'
 const scope={holder:'host',turnId:'turn',callId:'call'},input={title:'Task',body:'',sourceEventId:randomUUID(),rationale:'User asked',missingInformation:[],missingPermissions:[],needsSpec:false}
 await registry.createCoordinatorRegistry('owner','bot',scope).intake_factory_request!.execute!(input,{toolCallId:'sdk-call',messages:[],context:{}})
 assert.deepEqual(intake.mock.calls[0].arguments,['owner',input,scope,'bot'])
 type Execution=NonNullable<NonNullable<Parameters<typeof registry.coordinatorTools>[3]>['execution']>
 const execution={id:'execution',snapshot:{effectiveTools:['get_issue']}} as unknown as Execution
 assert.deepEqual(Object.keys(registry.coordinatorTools('owner','bot',scope,{execution})),['get_issue'])
 }finally{for(const [i,k] of ['MIKKA_FACTORY_ROUTING_ENABLED','MIKKA_ISSUE_TOOLS_ENABLED'].entries()){if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i]}}
})
