import 'server-only';
import type { PoolClient } from 'pg';
import { pool, withDatabaseClient } from '@/lib/db';
import { issueForUser } from '@/lib/issue-access';
import { queueRun } from '@/lib/agent-runs';
import { freezeWorkerDefinition, retryWorkerDefinition } from '@/lib/agent-kit/worker';
import { factoryCheckIndependent } from './check-independence';
import { createFactoryReconciler } from './reconcile';
import { configureFactoryCheck, factoryCheckAssignment, factoryCheckGates, factoryRepairBrief } from './checks';
import { reconcileFactoryCheck } from './reconcile-check';
import { createFactoryClaim, factoryClaimTask } from './claim';
import { FactoryError } from './contract';
import { createFactoryStore, type FactoryLifecycle } from './store';
import { createFactoryDispatch, type FactoryDispatchAdapters } from './dispatch';
import { createFactoryQuestions } from './questions/store';

export function factoryLifecycleEnabled() {
  return process.env.MIKKA_FACTORY_ROUTING_ENABLED === '1' && process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED === '1';
}
export const factoryAuthorize = (userId: string, issueId: string, tx: PoolClient) =>
  withDatabaseClient(tx, async () => Boolean(await issueForUser(userId, issueId)));
/** Consumer owners supply their own actual validators/configurators; absent means denied. */
export function factoryRuntimeForBot(botId: string | null, lifecycle: FactoryLifecycle = {}, configure: FactoryDispatchAdapters['configure'] = {}, validateCheck?: Parameters<typeof createFactoryClaim>[2], consumers: Parameters<typeof createFactoryReconciler>[3] = {}) {
  if (!factoryLifecycleEnabled()) throw new FactoryError('factoryLifecycleUnavailable');
  const store = createFactoryStore(pool,factoryAuthorize,botId,{...lifecycle,independent:factoryCheckIndependent,gates:{...factoryCheckGates,...lifecycle.gates}});
  const validate = validateCheck ?? ((tx:PoolClient,task:import('./store').FactoryTask,id:string) => factoryCheckAssignment(tx,task.userId,id));
  const dispatch = createFactoryDispatch(pool,store,
    (tx,userId,input,scopeBot) => withDatabaseClient(tx,()=>queueRun(userId,input,scopeBot)), {
      configure: {
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
  const questions = createFactoryQuestions(pool,factoryAuthorize,store,dispatch,validate);
  return {store,dispatch,questions,reconcile:createFactoryReconciler(pool,store,questions,{review:reconcileFactoryCheck,verify:reconcileFactoryCheck,...consumers},botId),claim:createFactoryClaim(store,questions,validate)};
}

/** Returns before any Factory SQL when default-off; ordinary claims retain their path. */
export async function guardFactoryClaim(tx: PoolClient,userId:string,deviceId:string,runId:string,leaseExpiresAt:string) {
  if (!factoryLifecycleEnabled()) return {};
  const identity=await factoryClaimTask(tx,runId);
  if (!identity) return {};
  return factoryRuntimeForBot(identity.botId).claim(tx,userId,deviceId,runId,leaseExpiresAt);
}
