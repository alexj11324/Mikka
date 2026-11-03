import 'server-only';
import { deploymentSwitch } from '@/lib/deployment-switches'
import type { PoolClient } from 'pg';
import { pool, withDatabaseClient } from '@/lib/db';
import { issueForUser } from '@/lib/issue-access';
import { queueFactoryRun } from '@/lib/agent-runs';
import { queueFactoryCloudRun } from '@/lib/computer/queue-run';
import { tiptapToText } from '@/lib/tiptap-text';
import { dispatchNextFactoryAttempt, startFactoryCloudRuns } from './next-dispatch';
import { queueFactoryCloudQuestion } from './cloud-question-run';
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

export function factoryLifecycleEnabled() {
  return deploymentSwitch('factoryRouting') && deploymentSwitch('factoryLifecycle');
}
export const factoryAuthorize = (userId: string, issueId: string, tx: PoolClient) =>
  withDatabaseClient(tx, async () => Boolean(await issueForUser(userId, issueId)));
/** Consumer owners supply actual validators/configurators. Sixth argument is host-only recovery I/O, never tool input. Text observations need no images. */
export function factoryRuntimeForBot(botId: string | null, lifecycle: FactoryLifecycle = {}, configure: FactoryDispatchAdapters['configure'] = {}, validateCheck?: Parameters<typeof createFactoryClaim>[2], consumers: Parameters<typeof createFactoryReconciler>[3] = {}, recovery: FactoryCheckRecoveryDependencies = {}) {
  if (!factoryLifecycleEnabled()) throw new FactoryError('factoryLifecycleUnavailable');
  const store = createFactoryStore(pool,factoryAuthorize,botId,{...lifecycle,independent:factoryCheckIndependent,gates:{...factoryCheckGates,approval:approvalGate,publish:publishGate,monitor:monitorGate,...lifecycle.gates}});
  const validate = validateCheck ?? ((tx:PoolClient,task:import('./store').FactoryTask,id:string) => task.stage === 'monitor' ? factoryMonitorDispatchAssignment(tx,task.userId,id) : factoryCheckAssignment(tx,task.userId,id));
  const dispatch = createFactoryDispatch(pool,store,
    async (tx,userId,input,scopeBot,context) => {
      if (!input.options) {
        const continued = await queueFactoryCloudQuestion(tx,userId,input,context.attemptId);
        if (continued) return continued;
        const runtime = (await tx.query('SELECT "botId","workspaceId",harness FROM bot_cloud_runtimes WHERE "agentId"=$1 AND "ownerId"=$2',[input.agentId,userId])).rows[0];
        if (runtime) {
          const selected = await (await import('@/lib/computer/run-model')).chooseCloudRunModel(pool,{ownerId:userId,workspaceId:runtime.workspaceId,botId:scopeBot},input.agentId,runtime.harness);
          if ('error' in selected) throw new FactoryError('factoryCheckHarnessUnavailable');
          input = {...input,options:{cloud:{botId:runtime.botId,workspaceId:runtime.workspaceId},selection:selected}};
        }
      }
      const stage = (await tx.query('SELECT stage FROM factory_attempts WHERE id=$1',[context.attemptId])).rows[0]?.stage;
      const selected = {...input.options?.selection,readOnly:['review','verify','monitor'].includes(stage) || input.options?.selection?.readOnly === true};
      if (!input.options?.cloud) return queueFactoryRun(tx,userId,input,scopeBot,context,undefined,selected);
      const { cloud } = input.options;
      const selection = selected;
      const issue = await withDatabaseClient(tx, () => issueForUser(userId,input.issueId));
      if (!issue || !selection.model) throw new FactoryError('factoryRunMismatch');
      return queueFactoryCloudRun(tx,pool,{userId,workspaceId:cloud.workspaceId},{...input,...selection,model:selection.model,botId:cloud.botId,dispatchBotId:scopeBot,title:issue.title,body:tiptapToText(issue.content),idempotencyKey:`factory:${context.attemptId}`});
    }, {
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
  const autoDispatch = (tx: PoolClient, task: import('./store').FactoryTask) => dispatchNextFactoryAttempt(tx,store,dispatch,task);
  const observedDispatch = observeFactoryCheckDispatch(store,dispatch);
  const publicDispatch: typeof dispatch = async (userId,input,existing,options) => {
    const result = await observedDispatch(userId,input,existing,options);
    if (!existing) await startFactoryCloudRuns(pool,userId,result.task.id);
    return result;
  };
  const questions = createFactoryQuestions(pool,factoryAuthorize,store,dispatch,validate,questionSkillAssignments);
  const monitor = createFactoryMonitor(pool,store,factoryAuthorize,factoryMonitorWorkspaceKey,appendMonitorEvidence,configuredMonitorProbes(process.env),botId);
  return {store,monitor,dispatch:publicDispatch,questions,recoverCheck:createFactoryCheckRecovery(pool,store,recovery),reconcile:createFactoryReconciler(pool,store,questions,{review:(tx,store,task,run)=>reconcileFactoryCheck(tx,store,task,run,true),verify:(tx,store,task,run)=>reconcileFactoryCheck(tx,store,task,run,true),monitor:createFactoryMonitorRunConsumer(monitor),...consumers},botId,autoDispatch),claim:createFactoryClaim(store,questions,validate)};
}

/** A stopped Factory cannot issue an unfenced claim for an already queued attempt. */
export async function guardFactoryClaim(tx: PoolClient,userId:string,deviceId:string,runId:string,leaseExpiresAt:string) {
  const identity=await factoryClaimTask(tx,runId);
  if (!identity) return {};
  if (!factoryLifecycleEnabled()) throw new FactoryError('factoryLifecycleUnavailable');
  return factoryRuntimeForBot(identity.botId).claim(tx,userId,deviceId,runId,leaseExpiresAt);
}
