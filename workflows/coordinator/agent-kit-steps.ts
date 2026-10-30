import { freezeHostedModelSelection } from '@/lib/subscription-model-snapshot'
import { botRunModelSource } from '@/lib/bot-runtime-model'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from '@/lib/subscription-runtime'
import type { CoordinatorRuntime } from '@mikka/protocol/coordinator'
import { agentKitEnabled, agentKitStore, agentScope, agentKitDefaults } from '@/lib/agent-kit/service'
import { AgentKitError, type AgentExecution } from '@/lib/agent-kit/store'
import type { ToolOutcome } from '@/lib/agent-kit/instrument'
import type { FailureCode } from '@/lib/agent-kit/improvement'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { personalCoordinatorInstructions } from '@/lib/coordinator/native-prompt'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { personalWritesEnabled } from '@/lib/operations/write-feature'
import { runtimeForWritePlanning } from '@/lib/operations/write-planning-model'
import { assertNativeToolScope, type NativeToolScope } from './tool-scope'

export async function beginAgentExecution(userId: string, botId: string | null, holder: string, round: number, runtime: CoordinatorRuntime): Promise<AgentExecution | null> {
  'use step'
  // A bot runs on its owner's model (设置 › Bot, docs/design/bot-settings.md): Mikka's hosted model,
  // or the owner's own subscription. Without the agent kit only the hosted model can run, so any
  // other choice refuses the turn instead of silently running on Mikka.
  const hosted = runtime.harness === 'ai_sdk'
  if (!agentKitEnabled()) {
    if (botId && hosted) await botRunModelSource(userId,botId,undefined)
    return null
  }
  const scope = await agentScope(userId,botId)
  const instructions = await botInstructions(userId,botId,hosted ? COORDINATOR_INSTRUCTIONS : personalCoordinatorInstructions())
  const configured = { harness:runtime.harness,model:hosted ? COORDINATOR_MODEL : ('model' in runtime ? runtime.model ?? null : null) }
  return agentKitStore.beginExecution(scope,`${holder}:${round}`,instructions,async definition => {
    const selection = botId && hosted ? await botRunModelSource(userId,botId,definition.modelSelection) : definition.modelSelection
    return freezeHostedModelSelection(scope,runtimeForWritePlanning(configured,definition.tools,personalWritesEnabled(),Boolean(selection)),selection,{ service:() => subscriptionRuntime(),workspace:authorizeSubscriptionWorkspace })
  },agentKitDefaults())
}
export async function beforeAgentTool(userId: string, botId: string | null, executionId: string, callId: string, name: string, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope)
  await agentKitStore.recordTool(await agentScope(userId,botId),executionId,callId,name,'start')
}
export async function afterAgentTool(userId: string, botId: string | null, executionId: string, callId: string, name: string, outcome: ToolOutcome, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope)
  await agentKitStore.recordTool(await agentScope(userId,botId),executionId,callId,name,'finish',outcome)
}
export async function loadAgentSkill(userId: string, botId: string | null, executionId: string | undefined, skillId: string, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope)
  if (!executionId) return { error:'noSkillsAssigned' }
  const execution = await agentKitStore.readExecution(await agentScope(userId,botId),executionId)
  if (execution.status !== 'running') return { error:'agentExecutionClosed' }
  const skill = execution.snapshot.definition.skills.find(item => item.id === skillId)
  return skill ? { id:skill.id,name:skill.name,body:skill.body,definitionVersion:execution.snapshot.revision,definitionDigest:execution.snapshot.definitionDigest } : { error:'skillNotAssigned' }
}
export async function finishAgentExecution(userId: string, botId: string | null, executionId: string | undefined, failure?: FailureCode) {
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
