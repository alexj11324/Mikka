import 'server-only'
import { deploymentSwitch } from '@/lib/deployment-switches'
import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { freezeHostedModelSelection } from '@/lib/subscription-model-snapshot'
import { authorizeSubscriptionWorkspace, subscriptionRuntime } from '@/lib/subscription-runtime'
import {asSchema} from 'ai'
import {makeSnapshot} from './definition'
import {createEvaluationBinding,type EvaluationPlan} from '../eve/evaluation-store'
import {runEveEvaluation} from '../eve/evaluation-client'
import {assertEveScope} from '../eve/scope'
import { createCoordinatorRegistry } from '@/workflows/coordinator/tools'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { botInstructions } from '@/lib/coordinator/bot-instructions'
import { executionInstructions, executionHostInstructions } from './execution-instructions'
import { CORE_EVAL_CASES, runEvalSuite, compareReports, type EvalCase, type EvalTrace } from './evals'
import { judgeLiveTrace } from './semantic-judge'
import { caseFromFailure } from './improvement'
import { selectRegisteredTools } from './registry'
import { AgentKitError, type AgentKitStore, type AgentScope } from './store'

/** Live means real inference with synthetic, inert tools, not real-account or native-CLI acceptance. */
export async function evaluateProposal(store: AgentKitStore, scope: AgentScope, proposalId: string, requestId: string, mode: 'fixture' | 'live') {
  if (mode === 'live' && !deploymentSwitch('agentKitLiveEval')) throw new AgentKitError('agentLiveEvaluationDisabled',409)
  const model = mode === 'live' ? COORDINATOR_MODEL : null
  const { chatBotId, isCoordinatorBot } = await import('@/lib/coordinator/coordinator-bot')
  const botId = await chatBotId(scope.ownerId, scope.botId, scope.workspaceId)
  const coordinator = await isCoordinatorBot((await import('@/lib/db')).pool, scope.ownerId, botId)
  const hostInstructions = mode === 'live' ? await botInstructions(scope.ownerId,botId,COORDINATOR_INSTRUCTIONS) : ''
  const dependencies = { service:() => subscriptionRuntime(),workspace:authorizeSubscriptionWorkspace }
  const job = await store.beginEvaluation(scope,proposalId,requestId,mode,model,mode === 'live' ? { hostInstructions,resolveRuntime:definition => freezeHostedModelSelection(scope,{ harness:'ai_sdk',model:COORDINATOR_MODEL },definition.modelSelection,dependencies) } : undefined)
  if (job.replayed) return { ...job.evaluation,replayed:true }
  const cases = [...CORE_EVAL_CASES,...job.evidence.slice(0,3).map(caseFromFailure)]
  try {
    // Eve owns each isolated evaluation session and its model/tool loop.
    // Product comparison and activation still use the same frozen model grant.
    const run = async (testCase: EvalCase, definition: typeof job.baseline.definition, signal: AbortSignal): Promise<EvalTrace> => {
      if (mode === 'fixture') {
        // Plumbing smoke test only; the activation gate always rejects fixture reports.
        return { text:testCase.expectedOutcome === 'answered' ? `Fixture response: ${testCase.mustMention.join(' ')}` : testCase.expectedOutcome === 'blocked' ? 'Cannot complete this task without the missing prerequisite.' : 'Awaiting approval.',outcome:testCase.expectedOutcome,tools:testCase.requiredTools.map(name => ({ name,outcome:testCase.expectedOutcome === 'blocked' ? 'error' : testCase.expectedOutcome === 'approval_required' ? 'approval_pending' : 'ok',authorized:false,effectPerformed:false })) }
      }
      if (!job.execution) throw new AgentKitError('agentEvaluationSnapshotMissing')
      const version=definition===job.baseline.definition?job.baseline:job.candidate
      const snapshot=makeSnapshot(version.id,version.version,definition,job.execution.snapshot.hostInstructions,job.execution.snapshot.runtime)
      const registry=selectRegisteredTools(createCoordinatorRegistry(scope.ownerId,botId,undefined,{coordinator,computerEnabled:cloudComputerRunsEnabled()}),definition.tools)
      const plan:EvaluationPlan={scope,snapshot,testCase,
        instructions:executionInstructions(snapshot)+'\n\nEvaluation response format: return JSON {"text":"your grounded answer","outcome":"answered|blocked|approval_required"}. Choose blocked for unverifiable results and approval_required for a proposed, unexecuted account action. All tools are inert evaluation fixtures.',
        tools:await Promise.all(Object.entries(registry).map(async([name,tool])=>({name,description:typeof tool.description==='string'?tool.description:name,inputSchema:await asSchema(tool.inputSchema).jsonSchema as Record<string,unknown>}))),
      }
      const {pool}=await import('../db')
      const bot=(await pool.query<{workspaceId:string}>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2',[botId,scope.ownerId])).rows[0]
      if(!bot)throw new AgentKitError('agentScopeNotFound',404)
      const eveScope=await assertEveScope({ownerId:scope.ownerId,botId,workspaceId:bot.workspaceId,surface:'web'})
      const bindingId=await createEvaluationBinding(pool,eveScope,job.evaluation.id,version.id,plan)
      return await runEveEvaluation(eveScope,bindingId,plan,signal)
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
