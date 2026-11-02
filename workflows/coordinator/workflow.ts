import { runHostedWorkflowTurn, type ToolTiming } from '@/lib/subscription-workflow-turn'
import { isStepCount } from 'ai'
import { createHook, getWorkflowMetadata, getWritable } from 'workflow'
import type { CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'
import { coordinatorStep, turnWarning } from '@/lib/coordinator/model'
import { AGENT_MAX_ROUNDS } from '@/lib/agent-rounds'
import { splitTelegramText } from '@/lib/telegram/messages'
import type { AgentExecution } from '@/lib/agent-kit/store'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import * as steps from './steps'
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
  // One step for what the run reads once (each step is a durable round trip of about a second).
  const { computerEnabled, mailboxEnabled, writeEnabled, switches, coordinator, runtime: selected } = await steps.turnSettings(userId,botId)
  // 停止 (lib/coordinator/stop.ts) aborts the round in flight; a later round, for messages sent after it, runs normally.
  let controller = new AbortController()
  const stop = createHook<Record<string, never>>({ token: coordinatorStopToken(holder) })
  void (async () => { for await (const _ of stop) controller.abort() })()
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (controller.signal.aborted) controller = new AbortController()
    const signal = controller.signal
    const inbox = await steps.takeInbox(userId,holder,botId)
    // The Workflow clock is the durable event time: this is when the inbox was taken.
    const takenAt = Date.now()
    if (!inbox.held) return
    if (!inbox.added) {
      if (await steps.releaseLease(userId,holder,botId)) continue
      return
    }
    let execution: AgentExecution | null = null
    // A tool's finish record does not hold up the next model call; every record is awaited before the reply is stored.
    const audits: Promise<unknown>[] = []
    try {
      if(inbox.scheduledRead) await steps.assertScheduleRead(userId,botId,inbox.scheduledRead)
      const scheduleOptions = inbox.scheduledRead ? {readOnly:true,readToolIds:inbox.scheduledRead.allowedActions} : {}
      const sourceOptions = inbox.sourceEventId ? {sourceEventId:inbox.sourceEventId} : {}
      const scheduledAuthority = inbox.scheduledRead ? {botId,occurrence:inbox.scheduledRead} : undefined
      const streamId = `${holder}:${round}`
      // Independent: the execution and the stream's start run side by side.
      ;[execution] = await Promise.all([kit.beginAgentExecution(userId,botId,holder,round,selected),steps.writeStreamPart(writable,{type:'coordinator-turn-start',id:streamId,quietEligible:inbox.handoffOnly})])
      if (execution && execution.snapshot.runtime.harness !== selected.harness) throw new Error('agent_runtime_changed')
      const hosted = selected.harness === 'ai_sdk' ? execution?.snapshot.runtime ?? await kit.botRuntime(userId,botId) : null
      // One step for the mailbox catalogue, the model-switch notice (never on a scheduled read, which publishes only its
      // fenced result) and the prompt.
      const prepared = selected.harness === 'ai_sdk'
        ? await steps.prepareTurn(userId,botId,holder,{ snapshot:execution?.snapshot,executionId:execution?.id,mailboxEnabled,runtime:inbox.scheduledRead ? null : hosted })
        : { mailboxTools:mailboxEnabled ? await steps.mailboxCatalogue(userId,botId,execution?.id) : [],prompt:null }
      const mailboxTools = prepared.mailboxTools
      // A model call cut short by 停止 may surface as an abort error; nothing of it was kept, so the turn ends with what streamed.
      const result = await (selected.harness === 'ai_sdk'
        ? runHostedWorkflowTurn(hosted ?? await kit.botRuntime(userId,botId),coordinatorTools(userId,botId,scheduledAuthority ? {scheduledRead:scheduledAuthority} : undefined,{ ...scheduleOptions,...sourceOptions,switches,coordinator,execution,writeEnabled,computerEnabled,mailboxEnabled,mailboxTools,audits,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}) }),{ ...prepared.prompt!,stopWhen:isStepCount(AGENT_MAX_ROUNDS),prepareStep:coordinatorStep,writable,preventClose:true,...(inbox.scheduledRead ? {} : { abortSignal:signal }) },{ ownerId:userId,botId })
        : nativeCoordinatorTurn(userId,holder,round,selected,scope => coordinatorTools(userId,botId,scheduledAuthority ? {...scope,scheduledRead:scheduledAuthority} : scope,{ ...scheduleOptions,...sourceOptions,switches,coordinator,execution,writeEnabled,computerEnabled,mailboxEnabled,mailboxTools,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}) }),botId,execution?.snapshot,inbox.scheduledRead ? undefined : signal))
        .catch((error: unknown) => { if (signal.aborted && !inbox.scheduledRead) return { text:'',finishReason:'stop',responseMessages:[] }; throw error })
      // A scheduled read is not stoppable from the chat: it posts only its fenced result.
      if (signal.aborted && !inbox.scheduledRead) {
        await steps.writeStreamPart(writable,{type:'coordinator-turn-stopped',id:streamId})
        const said = await steps.stoppedStepText(holder,streamId)
        await Promise.all(audits)
        const through = await steps.appendMessages(userId,holder,stoppedMessages(result.responseMessages,said,result.text),null,botId,streamId,true)
        if (inbox.handoffMatterIds.length) await steps.settleAttention(userId,inbox.handoffMatterIds,false)
        await kit.finishAgentExecution(userId,botId,execution?.id)
        await steps.writeStreamPart(writable,{type:'coordinator-turn-committed',id:streamId,through,quiet:false})
        continue
      }
      const quiet = inbox.handoffOnly && (!result.text.trim() || result.text.trim() === QUIET_REPLY)
      let through: number
      await Promise.all(audits)
      if(inbox.scheduledRead){
        if(turnWarning(result.finishReason,result.text)) throw new Error('scheduledReadFailed')
        through = await steps.completeScheduleRead(userId,botId,inbox.scheduledRead,result.text,streamId)
      } else through = await steps.appendMessages(userId,holder,result.responseMessages,quiet ? null : turnWarning(result.finishReason,result.text),botId,streamId)
      const storedAt = Date.now()
      if (inbox.handoffMatterIds.length) await steps.settleAttention(userId,inbox.handoffMatterIds,inbox.handoffOnly && !quiet)
      await kit.finishAgentExecution(userId,botId,execution?.id,!quiet && !result.text.trim() ? 'empty_reply' : result.finishReason === 'error' ? 'turn_failed' : undefined)
      // Whether the reply also goes to the person's phones is the Decisions API's answer (lib/push-reasons.ts); pushToPhones never throws.
      if (inbox.pushEvents?.length && !quiet && result.text.trim() && result.text.trim() !== QUIET_REPLY) {
        await steps.pushToPhones(userId, botId, inbox.pushHidesText ? null : result.text, inbox.pushEvents)
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
      // After the reply is stored and committed, so it never delays what the person sees.
      await steps.logTurnTiming({ workflowRunId:holder,round,route:selected.harness !== 'ai_sdk' ? 'native' : hosted?.modelSelection ? 'subscription' : 'hosted',untilStoredMs:storedAt - takenAt,modelCalls:(result as { modelCalls?: number }).modelCalls ?? null,tools:(result as { toolTimings?: ToolTiming[] }).toolTimings ?? [] })
    } catch (error) {
      // Records already started finish before the turn is marked failed.
      await Promise.allSettled(audits)
      if(inbox.scheduledRead){
        const denied=error instanceof Error && ['scheduleReadAuthorityLost','scheduleWorkspaceAccessDenied','scheduleConversationUnavailable'].includes(error.message)
        try{await steps.failScheduleRead(inbox.scheduledRead,denied)}catch{/* the durable occurrence lease remains recoverable */}
      }
      // Mikka 默认 or the subscription refused it: Telegram and the phone get the words the web keeps under the message (never a silent failure).
      if (!inbox.scheduledRead) try { await steps.noticeTurnFailure(userId,botId,holder,error instanceof Error ? error.message : String(error),inbox.telegramTargets,inbox.pushEvents ?? []) } catch { /* the notice must not mask the turn's own failure */ }
      // Finishing telemetry must not mask the original failure or invent a successful outcome.
      try { await kit.finishAgentExecution(userId,botId,execution?.id,'turn_failed') } catch { /* the durable execution remains inspectable */ }
      await steps.failTurn(userId,holder,error instanceof Error ? error.message : String(error),botId)
      throw error
    }
  }
  await steps.releaseLease(userId,holder,botId)
}
