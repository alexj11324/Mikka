import {Client,type ClientSession,type SessionStreamEvent} from 'eve/client'
import type {Delivery} from 'eve/sessions'
import {z} from 'zod'
import {internalEveHeaders} from './auth'
import {eveInternalOrigin} from './server-client'
import type {EveScope} from './scope'
import type {EvaluationPlan} from './evaluation-store'
import {evaluationObservation} from '../agent-kit/eval-fixtures'
import {canonicalJSON} from '../agent-kit/definition'
import type {EvalTrace,ToolObservation} from '../agent-kit/evals'

export const evaluationReplySchema=z.strictObject({text:z.string().max(16000),outcome:z.enum(['answered','blocked','approval_required'])})

/** Observe the native durable terminal facts; partial JSON is never a result. */
export async function evaluationDeliveryTrace(delivery:Delivery,plan:EvaluationPlan,signal:AbortSignal):Promise<EvalTrace> {
  const events:SessionStreamEvent[]=[]
  for await(const event of delivery.stream({signal}))events.push(event)
  const result=await delivery.result({signal})
  signal.throwIfAborted()
  const settled=events.find(event=>event.type==='turn.settled')
  if(result.status!=='completed'||settled?.data.outcome!=='completed')throw new Error('agentEvaluationGenerationFailed')
  const reply=evaluationReplySchema.parse(result.data??JSON.parse(result.reply??''))
  const tools:ToolObservation[]=[]
  for(const event of events) {
    if(event.type!=='call.requested')continue
    const {capability,callId,input}=event.data
    if(capability.kind==='control')continue
    const terminal=events.find(item=>item.type==='call.settled'&&item.data.callId===callId)
    if(!plan.tools.some(tool=>tool.name===capability.name)||terminal?.type!=='call.settled'||terminal.data.outcome!=='completed') {
      tools.push({name:capability.name,outcome:'error',authorized:false,effectPerformed:false})
      continue
    }
    const observation=evaluationObservation(capability.name,input,plan.testCase,plan.snapshot.definition)
    if(canonicalJSON(terminal.data.output??null)!==canonicalJSON(observation.evidence??null))throw new Error('agentEvaluationMismatch')
    tools.push(observation)
  }
  return {...reply,tools}
}

/** End is a native command. Follow its terminal fact even when its delivery
 * completes before the terminal commit; there is no timer/polling loop. */
async function endEvaluationSession(session:ClientSession) {
  const signal=AbortSignal.timeout(30000)
  const end=await session.end({reason:'Agent Kit evaluation complete',signal})
  await end.result({signal}).catch(()=>{})
  const snapshot=await session.snapshot({signal})
  if(!snapshot.events.some(event=>event.type==='session.ended')) {
    for await(const event of session.stream({startIndex:snapshot.session.streamIndex,signal}))if(event.type==='session.ended')break
  }
  if(!(await session.snapshot({signal})).events.some(event=>event.type==='session.ended'))throw new Error('agentEvaluationGenerationFailed')
}

/** Public Client owns sends, streaming, settlement, cancellation and teardown. */
export async function runEveEvaluation(scope:EveScope,bindingId:string,plan:EvaluationPlan,signal:AbortSignal) {
  const base=new URL(eveInternalOrigin())
  base.pathname=base.pathname.replace(/\/$/,'')+'/mikka/evaluations'
  const client=new Client({baseUrl:base.toString(),headers:()=>({...internalEveHeaders(scope),'x-mikka-evaluation-id':bindingId})})
  let session:ClientSession|undefined,trace:EvalTrace|undefined,failure:{error:unknown}|undefined
  try {
    session=(await client.sessions.create({signal})).session
    const delivery=await session.send(plan.testCase.input,{signal,outputSchema:evaluationReplySchema})
    trace=await evaluationDeliveryTrace(delivery,plan,signal)
  } catch(error) {failure={error}}
  try {if(session)await endEvaluationSession(session)} catch(error) {
    if(failure)throw new AggregateError([failure.error,error],'agentEvaluationGenerationFailed')
    throw error
  }
  if(failure)throw failure.error
  return trace!
}
