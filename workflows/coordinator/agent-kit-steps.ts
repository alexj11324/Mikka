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
import { pool } from '@/lib/db'
import { botChatOwnerExclusive, sharedBotRuntime } from '@/lib/collaboration/bot-chat'
import { SHARED_BOT_CHAT_TOOLS } from '@/lib/collaboration/bot-chat-contract'

/** A refusal is a decision, not a transient failure: fail the step once with its code, never retry it. */
async function refusalIsFinal<T>(work: Promise<T>): Promise<T> {
  try { return await work } catch (error) {
    if (error instanceof SubscriptionRefusal) throw new FatalError(error.code)
    throw error
  }
}

export async function beginAgentExecution(userId: string, botId: string, holder: string, round: number, runtime: CoordinatorRuntime, sourceEventId?: string): Promise<AgentExecution | null> {
  'use step'
  if (!agentKitEnabled() && await botChatOwnerExclusive(pool, userId, botId)) return null
  return reserveAgentExecution(userId,botId,holder,round,runtime,sourceEventId)
}
/** The hosted composite reuses its run's durable setting on every preparation attempt. */
export async function beginPreparedAgentExecution(userId: string, botId: string, holder: string, round: number, runtime: Extract<CoordinatorRuntime, { harness: 'ai_sdk' }>, enabled: boolean, sourceEventId?: string): Promise<AgentExecution | null> {
  'use step'
  if (!enabled && await botChatOwnerExclusive(pool, userId, botId)) return null
  return reserveAgentExecution(userId,botId,holder,round,runtime,sourceEventId)
}
async function reserveAgentExecution(userId: string, botId: string, holder: string, round: number, runtime: CoordinatorRuntime, sourceEventId?: string): Promise<AgentExecution> {
  const shared = await sharedBotRuntime(userId, botId, sourceEventId)
  if (shared) {
    if (runtime.harness !== 'ai_sdk') throw new FatalError('sharedBotHostedRequired')
    const scope = await agentScope(userId, botId)
    const defaults = agentKitDefaults()
    const definition = { ...defaults, instructions: '', skills: [], tools: [...SHARED_BOT_CHAT_TOOLS], hooks: ['audit' as const] }
    // Existing definitions, private skills and personal plugins remain saved;
    // this execution freezes a separate clean projection of platform defaults.
    delete definition.modelSelection
    return agentKitStore.beginExecution(scope, `${holder}:${round}`, COORDINATOR_INSTRUCTIONS, shared, defaults,
      undefined, { contextIsolation: 'shared_clean', definition })
  }
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
  // This private coordinator is reached only through its authenticated owner
  // or a verified owner-owned schedule. Group turns pass their sender separately.
  return refusalIsFinal(agentKitStore.beginExecution(scope,`${holder}:${round}`,instructions,() => runtime.harness === 'ai_sdk' ? freezeBotModel({...scope,actorId:userId},{service:()=>subscriptionRuntime(),workspace:authorizeSubscriptionWorkspace}) : Promise.resolve({harness:runtime.harness,model:'model' in runtime ? runtime.model ?? null : null}),agentKitDefaults(), client => personalPlugins.snapshot(userId,client,scope.workspaceId)))
}
/** Durable model selection also applies when versioned definitions are disabled. */
export async function botRuntime(userId:string,botId:string|null,sourceEventId?:string) {
  'use step'
  if (botId) {
    const shared = await sharedBotRuntime(userId, botId, sourceEventId)
    if (shared) return shared
  }
  return refusalIsFinal(freezeBotModel({ownerId:userId,actorId:userId,botId,workspaceId:null},{service:()=>subscriptionRuntime(),workspace:authorizeSubscriptionWorkspace}))
}
export async function beforeAgentTool(userId: string, botId: string, executionId: string, callId: string, name: string, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope,name)
  await agentKitStore.recordTool(await agentScope(userId,botId),executionId,callId,name,'start')
}
export async function afterAgentTool(userId: string, botId: string, executionId: string, callId: string, name: string, outcome: ToolOutcome, nativeScope?: NativeToolScope) {
  'use step'
  await assertNativeToolScope(userId,nativeScope,name)
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
