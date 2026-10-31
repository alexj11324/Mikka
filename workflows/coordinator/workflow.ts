import { runHostedWorkflowTurn } from '@/lib/subscription-workflow-turn'
import { isStepCount } from 'ai'
import { getWorkflowMetadata, getWritable } from 'workflow'
import type { CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'
import { coordinatorStep, turnWarning } from '@/lib/coordinator/model'
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
  const writable = getWritable<CoordinatorWorkflowStreamPart>()
  const computerEnabled = await steps.computerToolsEnabled()
  const mailboxEnabled = await steps.mailboxToolsEnabled()
  const writeEnabled = await steps.personalWriteToolsEnabled()
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const inbox = await steps.takeInbox(userId,holder,botId)
    if (!inbox.held) return
    if (!inbox.added) {
      if (await steps.releaseLease(userId,holder,botId)) continue
      return
    }
    let execution: AgentExecution | null = null
    try {
      if(inbox.scheduledRead) await steps.assertScheduleRead(userId,botId,inbox.scheduledRead)
      const selected = await native.runtime(userId)
      execution = await kit.beginAgentExecution(userId,botId,holder,round,selected)
      if (execution && execution.snapshot.runtime.harness !== selected.harness) throw new Error('agent_runtime_changed')
      const mailboxTools = mailboxEnabled ? await steps.mailboxCatalogue(userId,botId,execution?.id) : []
      const scheduleOptions = inbox.scheduledRead ? {readOnly:true,readToolIds:inbox.scheduledRead.allowedActions} : {}
      const sourceOptions = inbox.sourceEventId ? {sourceEventId:inbox.sourceEventId} : {}
      const scheduledAuthority = inbox.scheduledRead ? {botId,occurrence:inbox.scheduledRead} : undefined
      const streamId = `${holder}:${round}`
      await steps.writeStreamPart(writable,{type:'coordinator-turn-start',id:streamId,quietEligible:inbox.handoffOnly})
      const result = selected.harness === 'ai_sdk'
        ? await runHostedWorkflowTurn(execution?.snapshot.runtime ?? await kit.botRuntime(userId,botId),coordinatorTools(userId,botId,scheduledAuthority ? {scheduledRead:scheduledAuthority} : undefined,{ ...scheduleOptions,...sourceOptions,execution,writeEnabled,computerEnabled,mailboxEnabled,mailboxTools,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}),...(inbox.approvedRepositoryKey ? { approvedRepositoryKey: inbox.approvedRepositoryKey } : {}) }),{ ...(await steps.preparePrompt(userId,botId,execution?.snapshot,mailboxTools)),stopWhen:isStepCount(AGENT_MAX_ROUNDS),prepareStep:coordinatorStep,writable,preventClose:true },{ ownerId:userId,botId })
        : await nativeCoordinatorTurn(userId,holder,round,selected,scope => coordinatorTools(userId,botId,scheduledAuthority ? {...scope,scheduledRead:scheduledAuthority} : scope,{ ...scheduleOptions,...sourceOptions,execution,writeEnabled,computerEnabled,mailboxEnabled,mailboxTools,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}),...(inbox.approvedRepositoryKey ? { approvedRepositoryKey: inbox.approvedRepositoryKey } : {}) }),botId,execution?.snapshot)
      const quiet = inbox.handoffOnly && (!result.text.trim() || result.text.trim() === QUIET_REPLY)
      let through: number
      if(inbox.scheduledRead){
        if(!result.text.trim() || result.finishReason==='error') throw new Error('scheduledReadFailed')
        through = await steps.completeScheduleRead(userId,botId,inbox.scheduledRead,result.text,streamId)
      } else through = await steps.appendMessages(userId,holder,result.responseMessages,quiet ? null : turnWarning(result.finishReason,result.text),botId,streamId)
      if (inbox.handoffMatterIds.length) await steps.settleAttention(userId,inbox.handoffMatterIds,inbox.handoffOnly && !quiet)
      await kit.finishAgentExecution(userId,botId,execution?.id,!quiet && !result.text.trim() ? 'empty_reply' : result.finishReason === 'error' ? 'turn_failed' : undefined)
      // A reply to Mikka's own events (not to the person) also goes to their phones, unless the Coordinator stayed quiet; pushReply never throws.
      if (inbox.pushReasons?.length && !quiet && result.text.trim() && result.text.trim() !== QUIET_REPLY) {
        await steps.pushToPhones(userId, botId, inbox.pushHidesText ? null : result.text, inbox.pushReasons)
      }
      if (inbox.telegramTargets.length && !quiet) {
        const reply = result.text.trim() ? result.text : '没有生成回复，请再试一次'
        if (!result.text.trim()) through = await steps.appendMessages(userId, holder, [{ role: 'assistant', content: reply }], turnWarning(result.finishReason, result.text), botId,streamId)
        for (const target of inbox.telegramTargets) {
          try {
            for (const chunk of splitTelegramText(reply)) await steps.sendTelegramChunk(userId, botId, holder, target, chunk)
            await steps.acknowledgeTelegramReply(userId, botId, holder, target)
          } catch {
            console.error('Telegram reply failed')
          }
        }
      }
      await steps.writeStreamPart(writable,{type:'coordinator-turn-committed',id:streamId,through,quiet})
    } catch (error) {
      if(inbox.scheduledRead){
        const denied=error instanceof Error && ['scheduleReadAuthorityLost','scheduleWorkspaceAccessDenied','scheduleConversationUnavailable'].includes(error.message)
        try{await steps.failScheduleRead(inbox.scheduledRead,denied)}catch{/* the durable occurrence lease remains recoverable */}
      }
      // Finishing telemetry must not mask the original failure or invent a successful outcome.
      try { await kit.finishAgentExecution(userId,botId,execution?.id,'turn_failed') } catch { /* the durable execution remains inspectable */ }
      await steps.failTurn(userId,holder,error instanceof Error ? error.message : String(error),botId)
      throw error
    }
  }
  await steps.releaseLease(userId,holder,botId)
}
