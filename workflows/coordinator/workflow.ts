import { runHostedWorkflowTurn, type ToolTiming } from '@/lib/subscription-workflow-turn'
import { isStepCount } from 'ai'
import { createHook, getWorkflowMetadata, getWritable } from 'workflow'
import type { CoordinatorWorkflowStreamPart } from '@/lib/coordinator/stream'
import { ScopedCoordinatorWritable } from '@/lib/coordinator/scoped-stream'
import { coordinatorStep, turnWarning } from '@/lib/coordinator/model'
import { AGENT_MAX_ROUNDS } from '@/lib/agent-rounds'
import { splitTelegramText } from '@/lib/telegram/messages'
import type { AgentExecution } from '@/lib/agent-kit/store'
import { QUIET_REPLY } from '@/lib/attention/handoff'
import * as steps from './steps'
import * as kit from './agent-kit-steps'
import { prepareHostedAgentRound } from './round-preparation'
import { nativeCoordinatorTurn } from './native-turn'
import { coordinatorTools } from './tools'
import { coordinatorStopToken, lastAssistantText, stoppedMessages, untilStopped } from '@/lib/coordinator/stop'
import type { ModelMessage } from 'ai'
import { promptOptions } from '@/lib/prompt-cache'
import { isWelcomeOnlyTurn } from '@/lib/agent-welcome'
export { coordinatorTools } from './tools'

/** Rounds of inbox per run; later events wait for the next wake. */
const MAX_ROUNDS = 10

type PreparationPhase = 'settings' | 'inbox' | 'begin' | 'prepare' | 'agentPreparation'
type PreparationTimings = Partial<Record<PreparationPhase, number>>
/** Workflow event-clock elapsed time, including each existing durable wait. */
async function timedPreparation<T>(phases: PreparationTimings, phase: PreparationPhase, work: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try { return await work() } finally { phases[phase] = Math.max(0, Date.now() - started) }
}

/** Durable host orchestration; native harnesses still own their only model/tool loop. */
export async function coordinatorTurn(userId: string, botId: string) {
  'use workflow'
  const holder = getWorkflowMetadata().workflowRunId
  const writable = getWritable<CoordinatorWorkflowStreamPart>()
  // 停止 (lib/coordinator/stop.ts) aborts the round in flight; a later round, for messages sent after it, runs normally.
  // The hook is registered before the run takes the chat (stop-turn.ts relies on it).
  let controller = new AbortController()
  const stop = createHook<Record<string, never>>({ token: coordinatorStopToken(holder) })
  void (async () => { for await (const _ of stop) controller.abort() })()
  // What the run reads once and its first inbox, side by side: each step is a durable round trip, and they are independent.
  const initialMs: PreparationTimings = {}
  const [{ computerEnabled, mailboxEnabled, writeEnabled, agentKitEnabled, switches, coordinator, runtime: selected }, firstInbox] = await Promise.all([
    timedPreparation(initialMs, 'settings', () => steps.turnSettings(userId,botId)),
    timedPreparation(initialMs, 'inbox', () => steps.takeInbox(userId,holder,botId)),
  ])
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // A stop while the first steps were running belongs to the first inbox.
    // Only a later inbox, after that stopped round, gets a fresh signal.
    if (round > 0 && controller.signal.aborted) controller = new AbortController()
    const signal = controller.signal
    const phaseMs: PreparationTimings = round === 0 ? { ...initialMs } : {}
    const inbox = round === 0 ? firstInbox : await timedPreparation(phaseMs, 'inbox', () => steps.takeInbox(userId,holder,botId))
    // The Workflow clock is the durable event time: this is when the inbox was taken.
    const takenAt = Date.now()
    if (!inbox.held) return
    if (!inbox.added) {
      if (await steps.releaseLease(userId,holder,botId)) continue
      return
    }
    let execution: AgentExecution | null = null
    let preparing: ReturnType<typeof prepareHostedAgentRound> | undefined
    let starting: ReturnType<typeof steps.writeStreamPart> | undefined
    let preparationBodyMs: { begin: number; prepare: number } | undefined
    const streamId = `${holder}:${round}`
    const modelWritable = new ScopedCoordinatorWritable(writable, streamId)
    const streamStart: CoordinatorWorkflowStreamPart = { type:'coordinator-turn-start',id:streamId,quietEligible:inbox.handoffOnly,...(selected.harness === 'ai_sdk' ? {modelStream:'scoped-v1' as const} : {}) }
    const finished: ModelMessage[] = []
    // A tool's finish record does not hold up the next model call; every record is awaited before the reply is stored.
    const audits: Promise<unknown>[] = []
    try {
      if(inbox.scheduledRead) await steps.assertScheduleRead(userId,botId,inbox.scheduledRead)
      const scheduleOptions = inbox.scheduledRead ? {readOnly:true,readToolIds:inbox.scheduledRead.allowedActions} : {}
      const sourceOptions = inbox.sourceEventId ? {sourceEventId:inbox.sourceEventId} : {}
      const scheduledAuthority = inbox.scheduledRead ? {botId,occurrence:inbox.scheduledRead} : undefined
      let hosted: AgentExecution['snapshot']['runtime'] | Awaited<ReturnType<typeof kit.botRuntime>> | null = null
      let prepared: Awaited<ReturnType<typeof steps.prepareTurn>> | { mailboxTools: Awaited<ReturnType<typeof steps.mailboxCatalogue>>; prompt: null; contextMs: null }
      if (selected.harness === 'ai_sdk' && typeof agentKitEnabled === 'boolean') {
        // This is a single Workflow event-clock span, not the old two step timings.
        preparing = timedPreparation(phaseMs, 'agentPreparation', () => prepareHostedAgentRound(userId,botId,holder,round,selected,mailboxEnabled,Boolean(inbox.scheduledRead),agentKitEnabled))
        starting = steps.writeStreamPart(writable,streamStart)
        const [preparation] = await Promise.all([preparing,starting])
        if (preparation.kind === 'ready') {
          execution = preparation.execution
          hosted = preparation.hosted
          prepared = preparation.prepared
          preparationBodyMs = preparation.bodyMs
        } else {
          hosted = await kit.botRuntime(userId,botId)
          prepared = await timedPreparation(phaseMs, 'prepare', () => steps.prepareTurn(userId,botId,holder,{mailboxEnabled,runtime:inbox.scheduledRead ? null : hosted}))
        }
      } else {
        // Native harnesses and older recorded settings retain their original boundaries.
        ;[execution] = await Promise.all([timedPreparation(phaseMs, 'begin', () => kit.beginAgentExecution(userId,botId,holder,round,selected)),steps.writeStreamPart(writable,streamStart)])
        if (execution && execution.snapshot.runtime.harness !== selected.harness) throw new Error('agent_runtime_changed')
        hosted = selected.harness === 'ai_sdk' ? execution?.snapshot.runtime ?? await kit.botRuntime(userId,botId) : null
        prepared = selected.harness === 'ai_sdk'
          ? await timedPreparation(phaseMs, 'prepare', () => steps.prepareTurn(userId,botId,holder,{snapshot:execution?.snapshot,executionId:execution?.id,mailboxEnabled,runtime:inbox.scheduledRead ? null : hosted}))
          : {mailboxTools:mailboxEnabled ? await steps.mailboxCatalogue(userId,botId,execution?.id) : [],prompt:null,contextMs:null}
      }
      const mailboxTools = prepared.mailboxTools
      const welcomeOnly = selected.harness === 'ai_sdk' && isWelcomeOnlyTurn(prepared.prompt?.messages)
      // Every model call that finished with its tools, as it finishes: 停止 keeps these without waiting for the rest.
      const turn = signal.aborted && !inbox.scheduledRead
        ? Promise.resolve({ text:'',finishReason:'stop',responseMessages:[] as ModelMessage[] })
        : selected.harness === 'ai_sdk'
        ? runHostedWorkflowTurn(hosted ?? await kit.botRuntime(userId,botId),welcomeOnly ? {} : coordinatorTools(userId,botId,scheduledAuthority ? {scheduledRead:scheduledAuthority} : undefined,{ ...scheduleOptions,...sourceOptions,switches,coordinator,execution,writeEnabled,computerEnabled,mailboxEnabled,mailboxTools,audits,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}) }),{ ...promptOptions(prepared.prompt!),stopWhen:isStepCount(AGENT_MAX_ROUNDS),prepareStep:coordinatorStep,...(welcomeOnly ? {toolChoice:'none' as const,activeTools:[]} : {}),writable:modelWritable,preventClose:true,onStepEnd:step => { finished.push(...step.response.messages) },...(inbox.scheduledRead ? {} : { abortSignal:signal }) },{ ownerId:userId,botId })
        : nativeCoordinatorTurn(userId,holder,round,selected,scope => coordinatorTools(userId,botId,scheduledAuthority ? {...scope,scheduledRead:scheduledAuthority} : scope,{ ...scheduleOptions,...sourceOptions,switches,coordinator,execution,writeEnabled,computerEnabled,mailboxEnabled,mailboxTools,...(inbox.taskEventId ? { taskEventId: inbox.taskEventId } : {}) }),botId,execution?.snapshot,inbox.scheduledRead ? undefined : signal,finished)
      // A scheduled read is not stoppable from the chat: it posts only its fenced result. Otherwise 停止 ends a hosted
      // turn at once: the model call in flight is aborted, a tool call already running finishes on its own and nothing
      // follows it. A native turn answers 停止 itself between the device's calls, and closes the device's job as it ends.
      const ended = inbox.scheduledRead ? { stopped: false as const, result: await turn }
        : selected.harness === 'ai_sdk' ? await untilStopped(turn, signal)
        : { stopped: false as const, result: await turn.catch((error: unknown) => { if (signal.aborted) return { text:'',finishReason:'stop',responseMessages:[] as ModelMessage[] }; throw error }) }
      if (ended.stopped || (signal.aborted && !inbox.scheduledRead)) {
        const said = await steps.markStopped(writable,holder,streamId)
        await Promise.all(audits)
        const through = await steps.appendMessages(userId,holder,stoppedMessages(ended.stopped ? finished : ended.result.responseMessages,said,ended.stopped ? lastAssistantText(finished) : ended.result.text),null,botId,streamId,true)
        if (inbox.handoffMatterIds.length) await steps.settleAttention(userId,inbox.handoffMatterIds,false)
        await kit.finishAgentExecution(userId,botId,execution?.id)
        await steps.writeStreamPart(writable,{type:'coordinator-turn-committed',id:streamId,through,quiet:false})
        continue
      }
      const result = ended.result
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
      await steps.logTurnTiming({ workflowRunId:holder,round,route:selected.harness !== 'ai_sdk' ? 'native' : hosted?.modelSelection ? 'subscription' : 'hosted',untilStoredMs:storedAt - takenAt,modelCalls:(result as { modelCalls?: number }).modelCalls ?? null,tools:(result as { toolTimings?: ToolTiming[] }).toolTimings ?? [],
        // Context reads overlap inside prepare: their durations are not additive.
        phaseMs: { ...phaseMs, execution:prepared.contextMs?.execution ?? 0,personal:prepared.contextMs?.personal ?? 0,github:prepared.contextMs?.github ?? 0 },...(preparationBodyMs ? {preparationBodyMs} : {}) })
    } catch (error) {
      // Either branch can fail first: wait for a possible late execution commit
      // and for the already-started writer before terminal cleanup/publication.
      // Keep the first failure as the cause, regardless of settlement order.
      let failedPreparation = false
      if (preparing) {
        const [settled] = await Promise.allSettled([preparing,starting])
        if (settled.status === 'rejected') failedPreparation = true
        else if (settled.value.kind === 'ready') execution = settled.value.execution
      }
      // Records already started finish before the turn is marked failed.
      await Promise.allSettled(audits)
      if(inbox.scheduledRead){
        const denied=error instanceof Error && ['scheduleReadAuthorityLost','scheduleWorkspaceAccessDenied','scheduleConversationUnavailable'].includes(error.message)
        try{await steps.failScheduleRead(inbox.scheduledRead,denied)}catch{/* the durable occurrence lease remains recoverable */}
      }
      // Mikka 默认 or the subscription refused it: Telegram and the phone get the words the web keeps under the message (never a silent failure).
      if (!inbox.scheduledRead) try { await steps.noticeTurnFailure(userId,botId,holder,error instanceof Error ? error.message : String(error),inbox.telegramTargets,inbox.pushEvents ?? []) } catch { /* the notice must not mask the turn's own failure */ }
      // Finishing telemetry must not mask the original failure or invent a successful outcome.
      try {
        if (failedPreparation) await kit.failAgentPreparation(userId,botId,holder,round)
        else await kit.finishAgentExecution(userId,botId,execution?.id,'turn_failed')
      } catch { /* the durable execution remains inspectable */ }
      const reason = error instanceof Error ? error.message : String(error)
      const completed = reason === 'model_tool_unavailable' && finished.length ? { messages:finished,streamId } : undefined
      try { await steps.failTurn(userId,holder,reason,botId,completed) }
      catch (persistenceError) {
        // A credential guard can refuse these receipts before the transaction.
        // Still release the failed turn's lease once, without persisting unsafe
        // output, and retain both causes for server diagnostics.
        if (completed) await steps.failTurn(userId,holder,reason,botId)
        throw new AggregateError([error,persistenceError],reason,{ cause:persistenceError })
      }
      throw error
    }
  }
  await steps.releaseLease(userId,holder,botId)
}
