import { runHostedWorkflowTurn } from '@/lib/subscription-workflow-turn'
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
  const mailboxEnabled = await steps.mailboxToolsEnabled()
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
      if (execution && execution.snapshot.runtime.harness !== selected.harness) throw new Error('agent_runtime_changed')
      const mailboxTools = mailboxEnabled ? await steps.mailboxCatalogue(userId,botId,execution?.id) : []
      const result = selected.harness === 'ai_sdk'
        ? await runHostedWorkflowTurn(execution?.snapshot.runtime ?? { harness:'ai_sdk',model:COORDINATOR_MODEL },coordinatorTools(userId,botId,undefined,{ execution,computerEnabled,mailboxEnabled,mailboxTools,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}) }),{ ...(await steps.preparePrompt(userId,botId,execution?.snapshot,mailboxTools)),stopWhen:isStepCount(AGENT_MAX_ROUNDS),prepareStep:coordinatorStep })
        : await nativeCoordinatorTurn(userId,holder,round,selected,scope => coordinatorTools(userId,botId,scope,{ execution,computerEnabled,mailboxEnabled,mailboxTools,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}) }),botId,execution?.snapshot)
      const quiet = inbox.handoffOnly && (!result.text.trim() || result.text.trim() === QUIET_REPLY)
      await steps.appendMessages(userId,holder,result.responseMessages,quiet ? null : turnWarning(result.finishReason,result.text),botId)
      if (inbox.handoffMatterIds.length) await steps.settleAttention(userId,inbox.handoffMatterIds,inbox.handoffOnly && !quiet)
      await kit.finishAgentExecution(userId,botId,execution?.id,!quiet && !result.text.trim() ? 'empty_reply' : result.finishReason === 'error' ? 'turn_failed' : undefined)
      // A reply to Mikka's own events (not to the person) also goes to their phones, unless the Coordinator stayed quiet; pushReply never throws.
      if (inbox.pushReasons?.length && !quiet && result.text.trim() && result.text.trim() !== QUIET_REPLY) {
        await steps.pushToPhones(userId, botId, inbox.pushHidesText ? null : result.text, inbox.pushReasons)
      }
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
