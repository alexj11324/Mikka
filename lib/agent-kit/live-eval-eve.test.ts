import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mock,test} from 'node:test'
import {z} from 'zod'
import {DEFAULT_AGENT_DEFINITION} from './builtin'
import {makeSnapshot,digest} from './definition'
import {CORE_EVAL_CASES,type SemanticVerdict} from './evals'
import {evaluationObservation,COLLABORATION_MESSAGE,COLLABORATION_RUN_ID} from './eval-fixtures'
import type {AgentKitStore} from './store'
import type {EvaluationPlan} from '../eve/evaluation-store'
import {DECISION_MODEL} from '../coordinator/decision'

const stub=(path:string,namedExports:Record<string,unknown>)=>mock.module(new URL(path,import.meta.url).href,{namedExports})
const scope={ownerId:'owned-evaluation-user',botId:randomUUID(),workspaceId:randomUUID()}
const baseline={id:randomUUID(),version:1,definition:{...DEFAULT_AGENT_DEFINITION,instructions:'Baseline guidance'}}
const candidate={id:randomUUID(),version:2,definition:{...baseline.definition,instructions:'Candidate guidance'}}
const runtime={harness:'ai_sdk' as const,model:'frozen-provider-model'}
const snapshot=makeSnapshot(baseline.id,baseline.version,baseline.definition,'Frozen host instructions',runtime)
let freezing=0,realEffects=0,nativeFailure=false
const plans:EvaluationPlan[]=[]
const forbidden=()=>{realEffects++;throw Error('Real effects forbidden')}
stub('../deployment-switches.ts',{deploymentSwitch:()=>true})
stub('../cloud-computer-flag.ts',{cloudComputerRunsEnabled:()=>false})
stub('../subscription-runtime.ts',{authorizeSubscriptionWorkspace:forbidden,subscriptionRuntime:forbidden})
stub('../subscription-model-snapshot.ts',{freezeHostedModelSelection:async()=>{freezing++;return runtime}})
stub('../coordinator/bot-instructions.ts',{botInstructions:async()=>snapshot.hostInstructions})
stub('../coordinator/coordinator-bot.ts',{chatBotId:async()=>scope.botId,isCoordinatorBot:async()=>false})
stub('../execution-settings.ts',{executionWorkspace:async()=>scope.workspaceId})
stub('../db/index.ts',{pool:{query:async()=>({rows:[{workspaceId:scope.workspaceId}]})}})
stub('../eve/scope.ts',{assertEveScope:async(value:unknown)=>value})
stub('../../workflows/coordinator/tools.ts',{createCoordinatorRegistry:()=>Object.fromEntries(baseline.definition.tools.map(name=>[name,{description:name,inputSchema:z.object({}),execute:forbidden}]))})
stub('../eve/evaluation-store.ts',{createEvaluationBinding:async(_pool:unknown,eveScope:unknown,_evaluationId:string,version:string,plan:EvaluationPlan)=>{
 assert.deepEqual(eveScope,{...scope,surface:'web'});assert.equal(plan.snapshot.revisionId,version);plans.push(plan);return randomUUID()
}})
stub('../eve/evaluation-client.ts',{runEveEvaluation:async(_scope:unknown,_binding:string,plan:EvaluationPlan)=>{
 if(nativeFailure)throw Error('agentEvaluationGenerationFailed')
 const testCase=plan.testCase
 return{text:testCase.expectedOutcome==='answered'?'2026-01-15 queued':'Cannot verify; awaiting approval.',outcome:testCase.expectedOutcome,tools:testCase.requiredTools.map(name=>evaluationObservation(name,name==='send_to_run'?{runId:COLLABORATION_RUN_ID,text:COLLABORATION_MESSAGE}:{},testCase,plan.snapshot.definition))}
}})
const judge:SemanticVerdict={decision:'pass',execution:{executionId:randomUUID(),modelId:DECISION_MODEL,providerGenerationId:'offline-judge',startedAt:'2026-11-11T00:00:00Z',completedAt:'2026-11-11T00:00:01Z',requestDigest:digest('offline-judge'),imageDigests:[],vision:'no-image-input'}}
stub('./semantic-judge.ts',{judgeLiveTrace:async()=>judge})

test('live comparison uses native Eve cases for both frozen revisions and preserves product reports',async()=>{
 const {evaluateProposal}=await import('./live-eval')
 const finished:unknown[]=[]
 const store={async beginEvaluation(_scope:unknown,_proposal:string,_request:string,_mode:string,_model:unknown,hosted:{resolveRuntime:(definition:typeof baseline.definition)=>Promise<unknown>}){
  assert.deepEqual(await hosted.resolveRuntime(baseline.definition),runtime)
  return{replayed:false,evaluation:{id:randomUUID(),model:runtime.model},baseline,candidate,evidence:[],execution:{id:randomUUID(),snapshot}}
 },async finishEvaluation(_scope:unknown,_id:string,reports:unknown){finished.push(reports);return{reports}},async finishExecution(){}} as unknown as AgentKitStore
 const result=await evaluateProposal(store,scope,randomUUID(),randomUUID(),'live')
 assert.equal(result.replayed,false);assert.equal(freezing,1);assert.equal(realEffects,0)
 assert.equal(plans.length,CORE_EVAL_CASES.length*2)
 for(const plan of plans){assert.deepEqual(plan.snapshot.runtime,runtime);assert.equal(plan.snapshot.hostInstructions,snapshot.hostInstructions);assert.deepEqual(plan.tools.map(tool=>tool.name),baseline.definition.tools);assert.ok(plan.instructions.includes(plan.snapshot.definition.instructions))}
 assert.deepEqual(plans.slice(0,CORE_EVAL_CASES.length).map(plan=>plan.snapshot.revisionId),Array(CORE_EVAL_CASES.length).fill(baseline.id))
 assert.deepEqual(plans.slice(CORE_EVAL_CASES.length).map(plan=>plan.snapshot.revisionId),Array(CORE_EVAL_CASES.length).fill(candidate.id))
 assert.equal(finished.length,1)
 nativeFailure=true;plans.length=0
 const failed=await evaluateProposal(store,scope,randomUUID(),randomUUID(),'live')
 assert.ok('comparison'in failed);assert.equal(failed.comparison.activationEligible,false)
 assert.equal(plans.length,CORE_EVAL_CASES.length*2,'no custom attempt or fallback loop')
 assert.equal(realEffects,0)
})
