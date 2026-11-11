import type {DynamicModelContext} from 'eve'
import type {LanguageModel} from 'ai'
import {defineTool} from 'eve/tools'
import {evaluationBindingId} from './evaluation-context'
import {scopeFromAuth} from './scope'
import {loadEvaluationBinding} from './evaluation-store'
import {evaluationObservation} from '../agent-kit/eval-fixtures'
import {HostedWorkflowModel} from '../abuse/workflow-model'
import {SubscriptionWorkflowModel} from '../subscription-workflow-model'
import {streamingModel} from './streaming-model'

export async function evaluationForSession(ctx:DynamicModelContext) {
  const id=evaluationBindingId(ctx.session.auth.current)
  if(!id)return null
  return ctx.memo(['mikka-evaluation',id],async()=>{
    const {pool}=await import('../db')
    const binding=await loadEvaluationBinding(pool,scopeFromAuth(ctx.session.auth.current),id)
    if(!binding||binding.session_id!==ctx.session.id)throw new Error('agentEvaluationMismatch')
    return binding.plan
  })
}
export function evaluationModel(plan:NonNullable<Awaited<ReturnType<typeof evaluationForSession>>>) {
  const {runtime}=plan.snapshot
  if(runtime.harness!=='ai_sdk'||!runtime.model)throw new Error('subscription_model_unavailable')
  const model=runtime.modelSelection?streamingModel(new SubscriptionWorkflowModel(runtime.modelSelection)):new HostedWorkflowModel(plan.scope.ownerId,plan.scope.botId,runtime.model)
  return evaluationModelBudget(model)
}

/** Preserve the product's per-response evaluation budget at the model
 * transport boundary. Eve retains all turn/step/retry decisions. */
export function evaluationModelBudget(model:Extract<LanguageModel,{specificationVersion:'v4'}>) {
  const cap=(options:Parameters<typeof model.doStream>[0])=>({...options,maxOutputTokens:Math.min(options.maxOutputTokens??1400,1400)})
  return {specificationVersion:'v4' as const,provider:model.provider,modelId:model.modelId,supportedUrls:model.supportedUrls,
    doStream:(options:Parameters<typeof model.doStream>[0])=>model.doStream(cap(options)),
    doGenerate:(options:Parameters<typeof model.doGenerate>[0])=>model.doGenerate(cap(options)),
  }
}
export function evaluationNativeTools(plan:NonNullable<Awaited<ReturnType<typeof evaluationForSession>>>) {
  return Object.fromEntries(plan.tools.map(tool=>[tool.name,defineTool({description:tool.description,inputSchema:tool.inputSchema as never,
    execute:async(input:unknown)=>evaluationObservation(tool.name,input,plan.testCase,plan.snapshot.definition).evidence,
  })]))
}
