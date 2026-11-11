import { FatalError } from 'workflow'
import { freezeBotModel } from '@/lib/bot-model-selection'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from '@/lib/subscription-runtime'
import type { CoordinatorRuntime } from '@mikka/protocol/coordinator'
import { agentKitEnabled, agentKitStore, agentScope, agentScopeWithBotMetadata, agentKitDefaults } from '@/lib/agent-kit/service'
import { AgentKitError, type AgentExecution, type AgentScope } from '@/lib/agent-kit/store'
import type { ToolOutcome } from '@/lib/agent-kit/instrument'
import type { FailureCode } from '@/lib/agent-kit/improvement'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { personalCoordinatorInstructions } from '@/lib/coordinator/native-prompt'
import { botInstructions, formatBotInstructions } from '@/lib/coordinator/bot-instructions'
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
  return reserveAgentExecution(userId,botId,holder,round,runtime)
}
/** The hosted composite reuses its run's durable setting on every preparation attempt. */
export async function beginPreparedAgentExecution(userId: string, botId: string, holder: string, round: number, runtime: Extract<CoordinatorRuntime, { harness: 'ai_sdk' }>, enabled: boolean): Promise<AgentExecution | null> {
  'use step'
  if (!enabled) return null
  return reserveAgentExecution(userId,botId,holder,round,runtime)
}
async function reserveAgentExecution(userId: string, botId: string, holder: string, round: number, runtime: CoordinatorRuntime): Promise<AgentExecution> {
  let scope: AgentScope, instructions: string
  if (runtime.harness === 'ai_sdk') {
    const current = await agentScopeWithBotMetadata(userId,botId)
    scope = current.scope
    instructions = formatBotInstructions(COORDINATOR_INSTRUCTIONS,current.bot)
  } else {
    scope = await agentScope(userId,botId)
    instructions = await botInstructions(userId,botId,personalCoordinatorInstructions())
  }
  const { personalPlugins } = await import('@/lib/plugins/runtime')
  return refusalIsFinal(agentKitStore.beginExecution(scope,`${holder}:${round}`,instructions,() => runtime.harness === 'ai_sdk' ? freezeBotModel(scope,{service:()=>subscriptionRuntime(),workspace:authorizeSubscriptionWorkspace}) : Promise.resolve({harness:runtime.harness,model:'model' in runtime ? runtime.model ?? null : null}),agentKitDefaults(), client => personalPlugins.snapshot(userId,client,scope.workspaceId)))
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
/**
 * One personally installed skill's body, for `read_personal_skill` (ALE-75).
 *
 * Not `loadAgentSkill`: that reads `execution.snapshot.definition.skills`, the
 * agent-kit definition, which is empty for everyone who only installed skills
 * in the personal plugin store. This reads `personal_skills` through the same
 * store the prompt's section is built from, so the list the model sees and the
 * body it fetches come from one source.
 *
 * The execution is still required and still checked: the tool is only granted
 * to a running execution, so a fetch belongs to a live round and a closed one
 * must not serve a body. It does not gate on the snapshot's skill list, which
 * would deny exactly the skills this tool exists to serve.
 */
export async function readPersonalSkill(userId: string, botId: string, executionId: string | undefined, skillId: string, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope)
  if (!executionId) return { error:'noSkillsInstalled' }
  const execution = await agentKitStore.readExecution(await agentScope(userId,botId),executionId)
  if (execution.status !== 'running') return { error:'agentExecutionClosed' }
  const { personalPlugins } = await import('@/lib/plugins/runtime')
  const skill = await personalPlugins.readSkillBody(userId, skillId)
  return skill ? { id:skill.id,name:skill.name,body:skill.body } : { error:'skillNotInstalled' }
}
export async function finishAgentExecution(userId: string, botId: string, executionId: string | undefined, failure?: FailureCode) {
  'use step'
  if (!executionId) return
  const scope = await agentScope(userId,botId)
  const finished = await agentKitStore.finishExecution(scope,executionId,failure ? 'failed' : 'completed',failure)
  await proposeAfterFinish(scope,finished)
}
/** Called only after the combined preparation has exhausted its ordinary step retries. */
export async function failAgentPreparation(userId: string, botId: string, holder: string, round: number) {
  'use step'
  const scope = await agentScope(userId,botId)
  const finished = await agentKitStore.failExecutionByKey(scope,`${holder}:${round}`)
  if (finished) await proposeAfterFinish(scope,finished)
}
async function proposeAfterFinish(scope: AgentScope, finished: { failureCases: boolean; revision: number; revisionId: string }) {
  if (!finished.failureCases) return
  // A stable revision key yields at most one automatic guidance candidate, never activation.
  try {
    await agentKitStore.propose(scope,finished.revision,finished.revisionId,agentKitDefaults())
  } catch (error) {
    if (error instanceof AgentKitError && ['agentImprovementInsufficientEvidence','agentImprovementNoChange','agentVersionConflict'].includes(error.code)) return
    console.error('Agent improvement proposal unavailable; existing definition remains active')
  }
}
