import { runHostedWorkflowTurn } from '@/lib/subscription-workflow-turn'
import { isStepCount } from 'ai'
import { createHook, getWorkflowMetadata, getWritable } from 'workflow'
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
import { coordinatorStopToken, stoppedMessages } from '@/lib/coordinator/stop'
export { coordinatorTools } from './tools'

/** Rounds of inbox per run; later events wait for the next wake. */
const MAX_ROUNDS = 10

/** Durable host orchestration; native harnesses still own their only model/tool loop. */
export async function coordinatorTurn(userId: string, botId: string) {
  'use workflow'
  const holder = getWorkflowMetadata().workflowRunId
  const writable = getWritable<CoordinatorWorkflowStreamPart>()
  const computerEnabled = await steps.computerToolsEnabled()
  const mailboxEnabled = await steps.mailboxToolsEnabled()
  const writeEnabled = await steps.personalWriteToolsEnabled()
  const coordinator = await steps.isCoordinatorChat(userId,botId)
  // 停止 (lib/coordinator/stop.ts) aborts the round in flight; a later round, for messages sent after it, runs normally.
  let controller = new AbortController()
  const stop = createHook<Record<string, never>>({ token: coordinatorStopToken(holder) })
  void (async () => { for await (const _ of stop) controller.abort() })()
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (controller.signal.aborted) controller = new AbortController()
    const signal = controller.signal
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
      const hosted = selected.harness === 'ai_sdk' ? execution?.snapshot.runtime ?? await kit.botRuntime(userId,botId) : null
      // A scheduled read publishes only its fenced result, never a chat line.
      if (hosted && !inbox.scheduledRead) await steps.noteQuotaSwitch(userId,holder,hosted,botId)
      // A model call cut short by 停止 may surface as an abort error; nothing of it was kept, so the turn ends with what streamed.
      const result = await (selected.harness === 'ai_sdk'
        ? runHostedWorkflowTurn(hosted ?? await kit.botRuntime(userId,botId),coordinatorTools(userId,botId,scheduledAuthority ? {scheduledRead:scheduledAuthority} : undefined,{ ...scheduleOptions,...sourceOptions,coordinator,execution,writeEnabled,computerEnabled,mailboxEnabled,mailboxTools,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}),...(inbox.approvedRepositoryKey ? { approvedRepositoryKey: inbox.approvedRepositoryKey } : {}) }),{ ...(await steps.preparePrompt(userId,botId,execution?.snapshot,mailboxTools)),stopWhen:isStepCount(AGENT_MAX_ROUNDS),prepareStep:coordinatorStep,writable,preventClose:true,...(inbox.scheduledRead ? {} : { abortSignal:signal }) },{ ownerId:userId,botId })
        : nativeCoordinatorTurn(userId,holder,round,selected,scope => coordinatorTools(userId,botId,scheduledAuthority ? {...scope,scheduledRead:scheduledAuthority} : scope,{ ...scheduleOptions,...sourceOptions,coordinator,execution,writeEnabled,computerEnabled,mailboxEnabled,mailboxTools,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}),...(inbox.approvedRepositoryKey ? { approvedRepositoryKey: inbox.approvedRepositoryKey } : {}) }),botId,execution?.snapshot,inbox.scheduledRead ? undefined : signal))
        .catch((error: unknown) => { if (signal.aborted && !inbox.scheduledRead) return { text:'',finishReason:'stop',responseMessages:[] }; throw error })
      // A scheduled read is not stoppable from the chat: it posts only its fenced result.
      if (signal.aborted && !inbox.scheduledRead) {
        await steps.writeStreamPart(writable,{type:'coordinator-turn-stopped',id:streamId})
        const said = await steps.stoppedStepText(holder,streamId)
        const through = await steps.appendMessages(userId,holder,stoppedMessages(result.responseMessages,said,result.text),null,botId,streamId,true)
        if (inbox.handoffMatterIds.length) await steps.settleAttention(userId,inbox.handoffMatterIds,false)
        await kit.finishAgentExecution(userId,botId,execution?.id)
        await steps.writeStreamPart(writable,{type:'coordinator-turn-committed',id:streamId,through,quiet:false})
        continue
      }
      const quiet = inbox.handoffOnly && (!result.text.trim() || result.text.trim() === QUIET_REPLY)
      let through: number
      if(inbox.scheduledRead){
        if(turnWarning(result.finishReason,result.text)) throw new Error('scheduledReadFailed')
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
