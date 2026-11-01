import { FatalError } from 'workflow'
import { freezeBotModel } from '@/lib/bot-model-selection'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from '@/lib/subscription-runtime'
import type { CoordinatorRuntime } from '@mikka/protocol/coordinator'
import { agentKitEnabled, agentKitStore, agentScope, agentKitDefaults } from '@/lib/agent-kit/service'
import { AgentKitError, type AgentExecution } from '@/lib/agent-kit/store'
import type { ToolOutcome } from '@/lib/agent-kit/instrument'
import type { FailureCode } from '@/lib/agent-kit/improvement'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { personalCoordinatorInstructions } from '@/lib/coordinator/native-prompt'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { assertNativeToolScope, type NativeToolScope } from './tool-scope'

/** A refusal is a decision, not a transient failure: fail the step once with its code, never retry it. */
async function refusalIsFinal<T>(work: Promise<T>): Promise<T> {
  try { return await work } catch (error) {
    if (error instanceof SubscriptionRefusal) throw new FatalError(error.code)
    throw error
  }
}

export async function beginAgentExecution(userId: string, botId: string, holder: string, round: number, runtime: CoordinatorRuntime): Promise<AgentExecution | null> {
  'use step'
  if (!agentKitEnabled()) return null
  const scope = await agentScope(userId,botId)
  const instructions = await botInstructions(userId,botId,runtime.harness === 'ai_sdk' ? COORDINATOR_INSTRUCTIONS : personalCoordinatorInstructions())
  const { personalPlugins } = await import('@/lib/plugins/runtime')
  return refusalIsFinal(agentKitStore.beginExecution(scope,`${holder}:${round}`,instructions,() => runtime.harness === 'ai_sdk' ? freezeBotModel(scope,{service:()=>subscriptionRuntime(),workspace:authorizeSubscriptionWorkspace}) : Promise.resolve({harness:runtime.harness,model:'model' in runtime ? runtime.model ?? null : null}),agentKitDefaults(), client => personalPlugins.snapshot(userId,client)))
}
/** Durable model selection also applies when versioned definitions are disabled. */
export async function botRuntime(userId:string,botId:string|null) {
  'use step'
  return refusalIsFinal(freezeBotModel({ownerId:userId,botId,workspaceId:null},{service:()=>subscriptionRuntime(),workspace:authorizeSubscriptionWorkspace}))
}
export async function beforeAgentTool(userId: string, botId: string, executionId: string, callId: string, name: string, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope)
  await agentKitStore.recordTool(await agentScope(userId,botId),executionId,callId,name,'start')
}
export async function afterAgentTool(userId: string, botId: string, executionId: string, callId: string, name: string, outcome: ToolOutcome, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope)
  await agentKitStore.recordTool(await agentScope(userId,botId),executionId,callId,name,'finish',outcome)
}
export async function loadAgentSkill(userId: string, botId: string, executionId: string | undefined, skillId: string, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope)
  if (!executionId) return { error:'noSkillsAssigned' }
  const execution = await agentKitStore.readExecution(await agentScope(userId,botId),executionId)
  if (execution.status !== 'running') return { error:'agentExecutionClosed' }
  const skill = execution.snapshot.definition.skills.find(item => item.id === skillId)
  return skill ? { id:skill.id,name:skill.name,body:skill.body,definitionVersion:execution.snapshot.revision,definitionDigest:execution.snapshot.definitionDigest } : { error:'skillNotAssigned' }
}
export async function finishAgentExecution(userId: string, botId: string, executionId: string | undefined, failure?: FailureCode) {
  'use step'
  if (!executionId) return
  const scope = await agentScope(userId,botId)
  await agentKitStore.finishExecution(scope,executionId,failure ? 'failed' : 'completed',failure)
  const execution = await agentKitStore.readExecution(scope,executionId)
  if (!execution.snapshot.definition.hooks.includes('failure_cases')) return
  // A stable revision key yields at most one automatic guidance candidate, never activation.
  try {
    await agentKitStore.propose(scope,execution.snapshot.revision,execution.snapshot.revisionId,agentKitDefaults())
  } catch (error) {
    if (error instanceof AgentKitError && ['agentImprovementInsufficientEvidence','agentImprovementNoChange','agentVersionConflict'].includes(error.code)) return
    console.error('Agent improvement proposal unavailable; existing definition remains active')
  }
}
