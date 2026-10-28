import type { PoolClient } from 'pg';
import { FactoryError } from './contract';
import type { createFactoryStore, FactoryTask } from './store';
import type { createFactoryQuestions } from './questions/store';

/** Run lineage lookup is read-only; task lock precedes issue/access and run locks. */
export async function factoryClaimTask(tx: PoolClient, runId: string) {
  const {rows}=await tx.query(`WITH RECURSIVE lineage AS (
    SELECT id,"retryOf",0 AS depth,ARRAY[id] AS seen FROM agent_runs WHERE id=$1
    UNION ALL SELECT r.id,r."retryOf",l.depth+1,l.seen||r.id FROM agent_runs r
      JOIN lineage l ON r.id=l."retryOf" WHERE l.depth<32 AND NOT r.id=ANY(l.seen)
    ) SELECT DISTINCT t.id,t."userId",t."botId" FROM lineage l
      JOIN factory_attempts a ON a."runId"=l.id JOIN factory_tasks t ON t.id=a."taskId"`,[runId]);
  if(rows.length>1) throw new FactoryError('factoryRunMismatch');
  return rows[0] as {id:string;userId:string;botId:string|null}|undefined;
}
export function createFactoryClaim(store: ReturnType<typeof createFactoryStore>, questions: Pick<ReturnType<typeof createFactoryQuestions>,'claimContinuation'>,
  validateCheck?: (tx: PoolClient, task: FactoryTask, runId: string)=>Promise<Record<string,unknown>>) {
  return async (tx: PoolClient,userId:string,deviceId:string,runId:string,leaseExpiresAt:string):Promise<Record<string,unknown>> => {
    const identity=await factoryClaimTask(tx,runId);
    if(!identity) return {};
    const task=await store.lockTask(tx,userId,identity.id);
    const {rows:[attempt]}=await tx.query('SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2',[task.attemptId,task.id]);
    if(task.status!=='running'||!attempt||attempt.status!=='running'||attempt.runId!==runId||attempt.candidateId!==task.candidateId) throw new FactoryError('factoryClaimStale');
    const {rows:[run]}=await tx.query('SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE',[runId]);
    if(!run||run.userId!==userId||run.issueId!==task.issueId||run.botId!==task.botId||run.deviceId!==deviceId||run.status!=='queued'||run.stopRequestedAt) throw new FactoryError('factoryRunMismatch');
    const authorized = await tx.query(`SELECT a.id FROM agents a
      JOIN device_repos repo ON repo.id=$2 AND repo."deviceId"=$3 AND repo."userId"=$4
      JOIN devices d ON d.id=$3 AND d."ownerId"=$4 AND d.enabled=true
      WHERE a.id=$1 AND a."userId"=$4 FOR SHARE OF a,repo,d`,[run.agentId,run.deviceRepoId,deviceId,userId]);
    if (!authorized.rowCount) throw new FactoryError('factoryRunMismatch');
    if(run.questionContinuation) return {...await questions.claimContinuation(userId,deviceId,runId,leaseExpiresAt,tx),preserveQuestionWorktree:true};
    if(['review','verify','monitor'].includes(task.stage)) {
      if(!validateCheck) throw new FactoryError('factoryDispatchAdapterRequired');
      return {...await validateCheck(tx,task,runId),preserveQuestionWorktree:true};
    }
    return {preserveQuestionWorktree:true};
  };
}
