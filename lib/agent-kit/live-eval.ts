import 'server-only'
import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { freezeHostedModelSelection, resolveFrozenHostedModel } from '@/lib/subscription-model-snapshot'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from '@/lib/subscription-runtime'
import { generateText, streamText, isStepCount } from 'ai'
import { createCoordinatorRegistry } from '@/workflows/coordinator/tools'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { executionInstructions, executionHostInstructions } from './execution-instructions'
import { CORE_EVAL_CASES, runEvalSuite, compareReports, type EvalCase, type EvalTrace, type ToolObservation } from './evals'
import { evaluationTools } from './eval-fixtures'
import { judgeLiveTrace } from './semantic-judge'
import { caseFromFailure } from './improvement'
import { selectRegisteredTools } from './registry'
import { AgentKitError, type AgentKitStore, type AgentScope } from './store'
import { completedEvaluationReply } from './eval-generation'

/** Live means real inference with synthetic, inert tools, not real-account or native-CLI acceptance. */
export async function evaluateProposal(store: AgentKitStore, scope: AgentScope, proposalId: string, requestId: string, mode: 'fixture' | 'live') {
  if (mode === 'live' && process.env.MIKKA_AGENT_KIT_LIVE_EVAL !== '1') throw new AgentKitError('agentLiveEvaluationDisabled',409)
  const model = mode === 'live' ? COORDINATOR_MODEL : null
  const { chatBotId, isCoordinatorBot } = await import('@/lib/coordinator/coordinator-bot')
  const botId = await chatBotId(scope.ownerId, scope.botId)
  const coordinator = await isCoordinatorBot((await import('@/lib/db')).pool, scope.ownerId, botId)
  const hostInstructions = mode === 'live' ? await botInstructions(scope.ownerId,botId,COORDINATOR_INSTRUCTIONS) : ''
  const dependencies = { service:() => subscriptionRuntime(),workspace:authorizeSubscriptionWorkspace }
  const job = await store.beginEvaluation(scope,proposalId,requestId,mode,model,mode === 'live' ? { hostInstructions,resolveRuntime:definition => freezeHostedModelSelection(scope,{ harness:'ai_sdk',model:COORDINATOR_MODEL },definition.modelSelection,dependencies) } : undefined)
  if (job.replayed) return { ...job.evaluation,replayed:true }
  const cases = [...CORE_EVAL_CASES,...job.evidence.slice(0,3).map(caseFromFailure)]
  try {
    // Same host path as the AI SDK Coordinator, captured once for both revisions.
    // This hosted-model comparison is still not native CC/Codex acceptance.
    const run = async (testCase: EvalCase, definition: typeof job.baseline.definition, signal: AbortSignal): Promise<EvalTrace> => {
      if (mode === 'fixture') {
        // Plumbing smoke test only; the activation gate always rejects fixture reports.
        return { text:testCase.expectedOutcome === 'answered' ? `Fixture response: ${testCase.mustMention.join(' ')}` : testCase.expectedOutcome === 'blocked' ? 'Cannot complete this task without the missing prerequisite.' : 'Awaiting approval.',outcome:testCase.expectedOutcome,tools:testCase.requiredTools.map(name => ({ name,outcome:testCase.expectedOutcome === 'blocked' ? 'error' : testCase.expectedOutcome === 'approval_required' ? 'approval_pending' : 'ok',authorized:false,effectPerformed:false })) }
      }
      const observations: ToolObservation[] = []
      const registry = selectRegisteredTools(createCoordinatorRegistry(scope.ownerId,botId,undefined,{ coordinator,computerEnabled:cloudComputerTasksEnabled() && process.env.MIKKA_BYOS_ENABLED === '1' }),definition.tools)
      const tools = evaluationTools(registry,testCase,observations,definition)
      if (!job.execution) throw new AgentKitError('agentEvaluationSnapshotMissing')
      const frozenRuntime = job.execution.snapshot.runtime
      const resolvedModel = await resolveFrozenHostedModel(scope,frozenRuntime,dependencies,signal)
      let failed=false
      const options = {
        model:resolvedModel,
        instructions:executionInstructions({ ...job.execution.snapshot, definition }) + '\n\nEvaluation response format: end with only JSON {"text":"your grounded answer","outcome":"answered|blocked|approval_required"}. Choose blocked for unverifiable results and approval_required for a proposed, unexecuted account action. All tools are inert evaluation fixtures.',
        prompt:testCase.input,tools,stopWhen:isStepCount(5),abortSignal:signal,maxOutputTokens:1400,maxRetries:0,onError:()=>{failed=true},
      }
      const result = frozenRuntime.modelSelection ? streamText(options) : await generateText(options)
      const reply = await completedEvaluationReply(result,signal,()=>failed)
      return { ...reply,tools:observations }
    }
    const judge: typeof judgeLiveTrace = async (input, signal) => {
      const [{ hostedBillingScope }, { executionWorkspace }] = await Promise.all([import('../abuse/context'), import('../execution-settings')])
      const workspaceId = scope.workspaceId ?? await executionWorkspace(scope.ownerId, scope.botId)
      return hostedBillingScope.run({ workspaceId, ownerId: scope.ownerId }, () => judgeLiveTrace(input, signal))
    }
    const common = { cases,mode,model:job.evaluation.model ?? undefined,hostInstructions:job.execution ? executionHostInstructions(job.execution.snapshot) : hostInstructions,run,judge:mode === 'live' ? judge : undefined,caseTimeoutMs:15_000 }
    const baseline = await runEvalSuite({ ...common,definition:job.baseline.definition })
    const candidate = await runEvalSuite({ ...common,definition:job.candidate.definition })
    const completed = await store.finishEvaluation(scope,job.evaluation.id,{ baseline,candidate })
    if (job.execution) await store.finishExecution(scope,job.execution.id,'completed')
    return { ...completed,comparison:compareReports(baseline,candidate),replayed:false }
  } catch (error) {
    await store.finishEvaluation(scope,job.evaluation.id,null)
    if (job.execution) await store.finishExecution(scope,job.execution.id,'failed')
    throw error
  }
}
