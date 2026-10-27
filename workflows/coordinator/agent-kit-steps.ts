import type { CoordinatorRuntime } from '@mikka/protocol/coordinator'
import { agentKitEnabled, agentKitStore, agentScope } from '@/lib/agent-kit/service'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import type { AgentExecution } from '@/lib/agent-kit/store'
import type { ToolOutcome } from '@/lib/agent-kit/instrument'
import type { FailureCode } from '@/lib/agent-kit/improvement'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { personalCoordinatorInstructions } from '@/lib/coordinator/native-prompt'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { assertNativeToolScope, type NativeToolScope } from './tool-scope'

export async function beginAgentExecution(userId: string, botId: string | null, holder: string, round: number, runtime: CoordinatorRuntime): Promise<AgentExecution | null> {
  'use step'
  if (!agentKitEnabled()) return null
  const scope = await agentScope(userId,botId)
  const instructions = await botInstructions(userId,botId,runtime.harness === 'ai_sdk' ? COORDINATOR_INSTRUCTIONS : personalCoordinatorInstructions())
  return agentKitStore.beginExecution(scope,`${holder}:${round}`,instructions,{ harness:runtime.harness,model:runtime.harness === 'ai_sdk' ? COORDINATOR_MODEL : ('model' in runtime ? runtime.model ?? null : null) },DEFAULT_AGENT_DEFINITION)
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
  if (executionId) await agentKitStore.finishExecution(await agentScope(userId,botId),executionId,failure ? 'failed' : 'completed',failure)
}
