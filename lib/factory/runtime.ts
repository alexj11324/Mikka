import { syncFactoryPresentation } from './stage-progress';
import { prepareCloudQuestionRecovery, queueCloudQuestionContinuation, wakeCloudQuestionContinuation } from './questions/queue-continuation';
import { queueLocalQuestionContinuation } from './questions/queue-local-continuation';
import 'server-only';
import { deploymentSwitch } from '@/lib/deployment-switches'
import { automaticFactoryDispatch } from './automatic-dispatch'
import type { PoolClient } from 'pg';
import { pool } from '@/lib/db';
import { factoryAuthorize } from './authorize';
import { queueFactoryRun } from '@/lib/agent-runs';
import { lockCliAgentPolicy } from '@/lib/agent-tool-approval/policy-store';
import { freezeWorkerDefinition, retryWorkerDefinition } from '@/lib/agent-kit/worker';
import { factoryCheckIndependent } from './check-independence';
import { createFactoryReconciler } from './reconcile';
import { configureFactoryCheck, factoryCheckAssignment, factoryCheckGates, factoryRepairBrief } from './checks';
import { reconcileFactoryCheck } from './reconcile-check';
import { createFactoryCheckRecovery, type FactoryCheckRecoveryDependencies } from './check-recovery';
import { observeFactoryCheckDispatch } from './check-dispatch';
import { createFactoryClaim, factoryClaimTask } from './claim';
import { FactoryError } from './contract';
import { createFactoryStore, type FactoryLifecycle } from './store';
import { createFactoryDispatch, defaultFactoryDispatchAdapters, type FactoryDispatchAdapters } from './dispatch';
import { approvalGate,publishGate } from './approval';
import { createFactoryMonitor,createFactoryMonitorRunConsumer,monitorGate } from './monitor';
import { configuredMonitorProbes } from './monitor-probe';
import { factoryMonitorDispatchAssignment } from './monitor-dispatch';
import { appendMonitorEvidence } from './monitor-evidence';
import { factoryMonitorWorkspaceKey,questionSkillAssignments } from './server';
import { createFactoryQuestions } from './questions/store';
import { bindFactoryStoreWorkspace, bindFactoryQuestionsWorkspace, factoryBackgroundReference, factoryTaskWorkspaceBoundary, withFactoryBackgroundWorkspace } from './background-workspace';

export function factoryLifecycleEnabled() {
  return deploymentSwitch('factoryRouting') && deploymentSwitch('factoryLifecycle');
}
export { factoryAuthorize } from './authorize';
/** Consumer owners supply actual validators/configurators. Sixth argument is host-only recovery I/O, never tool input. Text observations need no images. */
export function factoryRuntimeForBot(botId: string | null, lifecycle: FactoryLifecycle = {}, configure: FactoryDispatchAdapters['configure'] = {}, validateCheck?: Parameters<typeof createFactoryClaim>[2], consumers: Parameters<typeof createFactoryReconciler>[3] = {}, recovery: FactoryCheckRecoveryDependencies = {}) {
  if (!factoryLifecycleEnabled()) throw new FactoryError('factoryLifecycleUnavailable');
  const store = bindFactoryStoreWorkspace(pool,createFactoryStore(pool,factoryAuthorize,botId,{onTransition:syncFactoryPresentation,...lifecycle,independent:factoryCheckIndependent,gates:{...factoryCheckGates,approval:approvalGate,publish:publishGate,monitor:monitorGate,...lifecycle.gates}}),botId);
  const validate = validateCheck ?? ((tx:PoolClient,task:import('./store').FactoryTask,id:string) => task.stage === 'monitor' ? factoryMonitorDispatchAssignment(tx,task.userId,id) : factoryCheckAssignment(tx,task.userId,id));
  const dispatch = createFactoryDispatch(pool,store,
    async (tx,userId,input,scopeBot,context) => await queueCloudQuestionContinuation(tx,userId,input,scopeBot,context) ?? await queueLocalQuestionContinuation(tx,userId,input,scopeBot,context) ?? queueFactoryRun(tx,userId,input,scopeBot,context), {
      lockAdmission: async (tx,userId,input) => { await lockCliAgentPolicy(tx,userId,input.agentId,botId); },
      replay: defaultFactoryDispatchAdapters.replay,
      configure: {
        ...defaultFactoryDispatchAdapters.configure,
        execute: factoryRepairBrief,
        review: configureFactoryCheck,
        verify: configureFactoryCheck,
        spec: async (tx,_task,id) => { await tx.query("UPDATE agent_runs SET kind='plan' WHERE id=$1",[id]); },
        ...configure,
      },
      freeze: async (tx,task,id) => {
        const {rows:[run]}=await tx.query('SELECT r.*,a.harness,a.instructions FROM agent_runs r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId" WHERE r.id=$1 AND r."userId"=$2 FOR UPDATE OF r FOR SHARE OF a',[id,task.userId]);
        if (!run) throw new FactoryError('factoryRunMismatch');
        const snapshot=run.agentDefinition
          ? retryWorkerDefinition(run.agentDefinition,run.prompt)
          : freezeWorkerDefinition({harness:run.harness,instructions:run.instructions,prompt:run.prompt,parent:null,executionId:null});
        await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1',[id,JSON.stringify(snapshot)]);
      },
    });
  const questions = bindFactoryQuestionsWorkspace(pool,createFactoryQuestions(pool,factoryAuthorize,store,dispatch,validate,questionSkillAssignments,
    (userId,result)=>wakeCloudQuestionContinuation(pool,userId,result),
    (userId,scope)=>prepareCloudQuestionRecovery(pool,userId,scope)),botId);
  const workspace = factoryTaskWorkspaceBoundary(pool,botId);
  const monitor = createFactoryMonitor(pool,store,factoryAuthorize,factoryMonitorWorkspaceKey,appendMonitorEvidence,configuredMonitorProbes(process.env),botId,workspace);
  const observedDispatch = observeFactoryCheckDispatch(store,dispatch);
  const recoverCheck = createFactoryCheckRecovery(pool,store,recovery);
  const claim = createFactoryClaim(store,questions,validate);
  return {store,monitor,
    dispatch: ((...args:Parameters<typeof observedDispatch>) => workspace(args[0],factoryBackgroundReference(args[1],'taskId'),()=>observedDispatch(...args),args[2])),
    questions,
    recoverCheck: ((...args:Parameters<typeof recoverCheck>) => workspace(args[0],factoryBackgroundReference(args[1],'taskId'),()=>recoverCheck(...args))),
    reconcile:createFactoryReconciler(pool,store,questions,{review:reconcileFactoryCheck,verify:reconcileFactoryCheck,monitor:createFactoryMonitorRunConsumer(monitor),...consumers},botId,automaticFactoryDispatch(pool),workspace),
    claim: ((...args:Parameters<typeof claim>) => withFactoryBackgroundWorkspace(pool,args[1],{kind:'run',id:args[3]},()=>claim(...args),args[0]))};
}

/** Returns before any Factory SQL when default-off; ordinary claims retain their path. */
export async function guardFactoryClaim(tx: PoolClient,userId:string,deviceId:string,runId:string,leaseExpiresAt:string) {
  if (!factoryLifecycleEnabled()) return {};
  const identity=await factoryClaimTask(tx,runId);
  if (!identity) return {};
  return factoryRuntimeForBot(identity.botId).claim(tx,userId,deviceId,runId,leaseExpiresAt);
}
