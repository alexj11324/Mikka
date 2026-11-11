import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Delivery} from 'eve/sessions'
import type {SessionStreamEvent} from 'eve/client'
import {evaluationDeliveryTrace} from './evaluation-client'
import {makeSnapshot} from '../agent-kit/definition'
import {DEFAULT_AGENT_DEFINITION} from '../agent-kit/builtin'
import {CORE_EVAL_CASES} from '../agent-kit/evals'
import type {EvaluationPlan} from './evaluation-store'

const plan:EvaluationPlan={scope:{ownerId:'fixture',botId:null,workspaceId:null},snapshot:makeSnapshot('revision',1,DEFAULT_AGENT_DEFINITION,'host',{harness:'ai_sdk',model:'fixture'}),testCase:CORE_EVAL_CASES[0],instructions:'host',tools:[]}
const reply={text:'A parseable partial response.',outcome:'answered'}
function delivery(status:string,outcome:string|undefined):Delivery {
 return{sessionId:'fixture',deliveryId:'fixture',async *stream(){if(outcome)yield{type:'turn.settled',data:{outcome}} as SessionStreamEvent},async result(){return{status,data:reply}}} as unknown as Delivery
}

test('parseable output requires a native completed delivery and completed turn',async()=>{
 for(const [status,outcome]of [['completed','failed'],['completed','cancelled'],['failed','completed'],['waiting','completed'],['completed',undefined]]as const)await assert.rejects(evaluationDeliveryTrace(delivery(status,outcome),plan,new AbortController().signal),/agentEvaluationGenerationFailed/)
 assert.deepEqual(await evaluationDeliveryTrace(delivery('completed','completed'),plan,new AbortController().signal),{...reply,tools:[]})
 const controller=new AbortController();controller.abort()
 await assert.rejects(evaluationDeliveryTrace(delivery('completed','completed'),plan,controller.signal),{name:'AbortError'})
})
