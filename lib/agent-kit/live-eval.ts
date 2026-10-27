import 'server-only'
import { generateText, isStepCount } from 'ai'
import { z } from 'zod'
import { createCoordinatorRegistry } from '@/workflows/coordinator/tools'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { definitionInstructions } from './definition'
import { CORE_EVAL_CASES, runEvalSuite, compareReports, type EvalCase, type EvalTrace, type ToolObservation } from './evals'
import { evaluationTools } from './eval-fixtures'
import { caseFromFailure } from './improvement'
import { selectRegisteredTools } from './registry'
import { AgentKitError, type AgentKitStore, type AgentScope } from './store'

const finalReply = z.strictObject({ text:z.string().max(16_000),outcome:z.enum(['answered','blocked','approval_required']) })

/** Live means real inference with synthetic, inert tools, not real-account or native-CLI acceptance. */
export async function evaluateProposal(store: AgentKitStore, scope: AgentScope, proposalId: string, requestId: string, mode: 'fixture' | 'live') {
  if (mode === 'live' && process.env.MIKKA_AGENT_KIT_LIVE_EVAL !== '1') throw new AgentKitError('agentLiveEvaluationDisabled',409)
  const model = mode === 'live' ? COORDINATOR_MODEL : null
  const job = await store.beginEvaluation(scope,proposalId,requestId,mode,model)
  if (job.replayed) return { ...job.evaluation,replayed:true }
  const cases = [...CORE_EVAL_CASES,...job.evidence.slice(0,3).map(caseFromFailure)]
  try {
    // Same host path as the AI SDK Coordinator, captured once for both revisions.
    // This hosted-model comparison is still not native CC/Codex acceptance.
    const hostInstructions = await botInstructions(scope.ownerId,scope.botId,COORDINATOR_INSTRUCTIONS)
    const run = async (testCase: EvalCase, definition: typeof job.baseline.definition, signal: AbortSignal): Promise<EvalTrace> => {
      if (mode === 'fixture') {
        // Plumbing smoke test only; the activation gate always rejects fixture reports.
        return { text:testCase.expectedOutcome === 'answered' ? `Fixture response: ${testCase.mustMention.join(' ')}` : testCase.expectedOutcome === 'blocked' ? 'Cannot complete this task without the missing prerequisite.' : 'Awaiting approval.',outcome:testCase.expectedOutcome,tools:testCase.requiredTools.map(name => ({ name,outcome:testCase.expectedOutcome === 'blocked' ? 'error' : testCase.expectedOutcome === 'approval_required' ? 'approval_pending' : 'ok',authorized:false,effectPerformed:false })) }
      }
      const observations: ToolObservation[] = []
      const registry = selectRegisteredTools(createCoordinatorRegistry(scope.ownerId,scope.botId,undefined,{ computerEnabled:process.env.MIKKA_CLOUD_COMPUTER_TASKS === '1' && process.env.MIKKA_BYOS_ENABLED === '1' }),definition.tools)
      const tools = evaluationTools(registry,testCase,observations,definition)
      const result = await generateText({
        model:COORDINATOR_MODEL,
        instructions:definitionInstructions(hostInstructions,definition) + '\n\nEvaluation response format: end with only JSON {"text":"your grounded answer","outcome":"answered|blocked|approval_required"}. Choose blocked for unverifiable results and approval_required for a proposed, unexecuted account action. All tools are inert evaluation fixtures.',
        prompt:testCase.input,tools,stopWhen:isStepCount(5),abortSignal:signal,maxOutputTokens:1400,
      })
      const reply = finalReply.parse(JSON.parse(result.text))
      return { ...reply,tools:observations }
    }
    const common = { cases,mode,model:model ?? undefined,hostInstructions,run,caseTimeoutMs:15_000 }
    const baseline = await runEvalSuite({ ...common,definition:job.baseline.definition })
    const candidate = await runEvalSuite({ ...common,definition:job.candidate.definition })
    const completed = await store.finishEvaluation(scope,job.evaluation.id,{ baseline,candidate })
    return { ...completed,comparison:compareReports(baseline,candidate),replayed:false }
  } catch (error) {
    await store.finishEvaluation(scope,job.evaluation.id,null)
    throw error
  }
}
