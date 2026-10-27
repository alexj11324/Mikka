import { WorkflowAgent } from '@ai-sdk/workflow'
import { isStepCount } from 'ai'
import { getWorkflowMetadata } from 'workflow'
import { COORDINATOR_MODEL, coordinatorStep, turnWarning } from '@/lib/coordinator/model'
import { AGENT_MAX_ROUNDS } from '@/lib/agent-rounds'
import { splitTelegramText } from '@/lib/telegram/messages'
import type { AgentExecution } from '@/lib/agent-kit/store'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import * as steps from './steps'
import * as native from './native-steps'
import * as kit from './agent-kit-steps'
import { nativeCoordinatorTurn } from './native-turn'
import { coordinatorTools } from './tools'
export { coordinatorTools } from './tools'

/** Rounds of inbox per run; later events wait for the next wake. */
const MAX_ROUNDS = 10

/** Durable host orchestration; native harnesses still own their only model/tool loop. */
export async function coordinatorTurn(userId: string, botId: string | null = null) {
  'use workflow'
  const holder = getWorkflowMetadata().workflowRunId
  const computerEnabled = await steps.computerToolsEnabled()
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const inbox = await steps.takeInbox(userId,holder,botId)
    if (!inbox.held) return
    if (!inbox.added) {
      if (await steps.releaseLease(userId,holder,botId)) continue
      return
    }
    let execution: AgentExecution | null = null
    try {
      const selected = await native.runtime(userId)
      execution = await kit.beginAgentExecution(userId,botId,holder,round,selected)
      const result = selected.harness === 'ai_sdk'
        ? await new WorkflowAgent({ model:COORDINATOR_MODEL,tools:coordinatorTools(userId,botId,undefined,{ execution,computerEnabled }) }).generate({ ...(await steps.preparePrompt(userId,botId,execution?.snapshot)),stopWhen:isStepCount(AGENT_MAX_ROUNDS),prepareStep:coordinatorStep })
        : await nativeCoordinatorTurn(userId,holder,round,selected,scope => coordinatorTools(userId,botId,scope,{ execution,computerEnabled }),botId,execution?.snapshot)
      const quiet = inbox.handoffOnly && (!result.text.trim() || result.text.trim() === QUIET_REPLY)
      await steps.appendMessages(userId,holder,result.responseMessages,quiet ? null : turnWarning(result.finishReason,result.text),botId)
      if (inbox.handoffMatterIds.length) await steps.settleAttention(userId,inbox.handoffMatterIds,inbox.handoffOnly && !quiet)
      await kit.finishAgentExecution(userId,botId,execution?.id,!quiet && !result.text.trim() ? 'empty_reply' : result.finishReason === 'error' ? 'turn_failed' : undefined)
      if (inbox.telegramTargets.length && result.text.trim()) {
        const threads = await steps.telegramReplyThreads(userId,inbox.telegramTargets)
        for (const threadId of threads) {
          try {
            for (const chunk of splitTelegramText(result.text)) await steps.sendTelegramChunk(threadId,chunk)
          } catch (error) {
            console.error('Telegram reply failed',error instanceof Error ? error.message : String(error))
          }
        }
      }
    } catch (error) {
      // Finishing telemetry must not mask the original failure or invent a successful outcome.
      try { await kit.finishAgentExecution(userId,botId,execution?.id,'turn_failed') } catch { /* the durable execution remains inspectable */ }
      await steps.failTurn(userId,holder,error instanceof Error ? error.message : String(error),botId)
      throw error
    }
  }
  await steps.releaseLease(userId,holder,botId)
}
