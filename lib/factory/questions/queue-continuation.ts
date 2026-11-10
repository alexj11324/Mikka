import { randomUUID } from 'node:crypto';
import { copyRunPrompt } from '../../run-prompt-copy';
import type { Pool, PoolClient } from 'pg';
import type { agentRuns } from '../../db/schema';
import { retryWorkerDefinition } from '../../agent-kit/worker';
import { runMayUseCredentialSql } from '../../personal-policy';
import { FactoryError } from '../contract';
import type { FactoryQueue } from '../dispatch';
import { factoryRunBotMatches } from '../run-scope';
import type { FactoryTask } from '../store';
import { unclaimedPlanQuestionContinuation } from './execution-continuation';

/** A question resumes its server-bound executor, not the Bot's local queue.
 * The answer holds computer policy -> task -> origin locks. No provider call,
 * new consumer, model selection or credential authority is introduced here. */
export async function admitCloudQuestionContinuation(
  tx: PoolClient, userId: string, input: Parameters<FactoryQueue>[2],
  botId: string | null, context: Parameters<FactoryQueue>[4],
  questionStatus: 'answered' | 'blocked' = 'answered',
) {
  const questionOriginId = context.questionOriginRunId;
  const originId = context.questionHistoryRunId ?? questionOriginId;
  if (!originId) return null;
  const { rows: [binding] } = await tx.query('SELECT "workspaceId","botId" FROM computer_run_bindings WHERE "runId"=$1 AND "ownerId"=$2', [originId,userId]);
  if (!binding) {
    if (context.questionHistoryRunId) throw new FactoryError('factoryQuestionContinuationUnavailable');
    return null; // The original device continuation keeps its existing adapter.
  }
  const fail = (): never => { throw new FactoryError('factoryQuestionContinuationUnavailable'); };
  const { rows: [origin] } = await tx.query<typeof agentRuns.$inferSelect & { machineState: string; sandboxId: string; snapshotId: string; templateKind: string | null; machineEpoch: number; targetId: string | null }>(`SELECT r.*,m.state AS "machineState",m."sandboxId",m."snapshotId",m."templateKind",m.epoch AS "machineEpoch",m."targetId"
    FROM agent_runs r
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    JOIN bots bot ON bot.id=b."botId" AND bot."ownerId"=b."ownerId" AND bot."workspaceId"=b."workspaceId"
    JOIN agents a ON a.id=r."agentId" AND a."userId"=r."userId" AND a.harness=r."agentDefinition"->>'harness'
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.kind='cloud' AND d.enabled=true
    JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=d.id
    JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=b."ownerId" AND m."workspaceId"=b."workspaceId" AND m."botId"=b."botId"
      AND m."issueId"=r."issueId" AND m."deviceId"=r."deviceId" AND m."repoId"=r."deviceRepoId"
    JOIN byos_bindings credential ON credential.id=(r."agentDefinition"->'subscription'->>'bindingId')::uuid
      AND ${runMayUseCredentialSql('credential."ownerId"', 'r."userId"', 'b."workspaceId"')}
      AND credential."workspaceId"=b."workspaceId"::text AND credential."consumerId"=r."agentId"::text
      AND credential."modelId"=r."agentDefinition"->>'model' AND credential.route=r."agentDefinition"->'subscription'->>'route'
      AND credential."modelId"=r."agentDefinition"->'subscription'->>'modelId'
    JOIN byos_connections c ON c.id=credential."connectionId" AND c."ownerId"=credential."ownerId"
      AND c.epoch=credential."connectionRevision" AND c.state='connected' AND c.paused=false
      AND c.provider=CASE a.harness WHEN 'codex' THEN 'codex' WHEN 'claude_code' THEN 'claude' END
    WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3 AND r."agentId"=$4 AND r."deviceRepoId"=$5
      AND b."workspaceId"=$7
      AND r.status=CASE WHEN $10::uuid IS NULL THEN 'stopped' ELSE 'failed' END AND r."stopRequestedAt" IS NULL
      AND (r."agentDefinition"->'apiKey' IS NULL OR r."agentDefinition"->'apiKey'='null'::jsonb)
      AND (m.state IN ('running','paused') OR ($12='blocked' AND m.state='error')) AND m."sandboxId" IS NOT NULL
      AND ($10::uuid IS NULL OR r."questionContinuation"->>'requiredSandboxId'=m."sandboxId")
      AND (m."workerLeaseUntil" IS NULL OR m."workerLeaseUntil"<=clock_timestamp())
      AND (repo."remoteUrl" IS NOT NULL OR NOT EXISTS(SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny'))
      AND NOT EXISTS(SELECT 1 FROM agent_runs active WHERE active."deviceId"=r."deviceId" AND active.status NOT IN ('succeeded','completed','failed','stopped','cancelled'))
      AND EXISTS(SELECT 1 FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId"
        WHERE q."originRunId"=$11 AND (CASE WHEN $10::uuid IS NULL THEN q."originRunId" ELSE q."continuationRunId" END)=r.id
          AND (q."originSessionId"=r."sessionId" OR ($10::uuid IS NOT NULL AND q.stage='spec' AND r.kind='plan' AND r."sessionId" IS NULL))
          AND q."userId"=r."userId" AND q.status=$12
          AND t."issueId"=r."issueId" AND t."attemptId"=$8 AND t."sourceEventId"=$9 AND t."botId" IS NOT DISTINCT FROM $6::uuid)
    FOR UPDATE OF r,m FOR SHARE OF b,bot,a,d,repo,credential,c`, [originId,userId,input.issueId,input.agentId,input.deviceRepoId,botId,binding.workspaceId,context.attemptId,context.sourceEventId,context.questionHistoryRunId ?? null,questionOriginId,questionStatus]);
  if (!origin?.agentDefinition || !(await factoryRunBotMatches(tx, { userId, botId }, origin))) return fail();
  if (!origin.sessionId) {
    // A failed claim owns the retained machine but has no native history. Only
    // the exact accepted question's host receipt may bridge that missing SID.
    const { rows: [task] } = await tx.query<FactoryTask>(`SELECT * FROM factory_tasks
      WHERE "userId"=$1 AND "issueId"=$2 AND "attemptId"=$3 AND "sourceEventId"=$4
        AND "botId" IS NOT DISTINCT FROM $5::uuid AND stage='spec' FOR SHARE`,
      [userId,input.issueId,context.attemptId,context.sourceEventId,botId]);
    const edge = task && context.questionHistoryRunId === origin.id
      ? await unclaimedPlanQuestionContinuation(tx,task,origin.id) : null;
    if (!edge || edge.questionOriginRunId !== questionOriginId) return fail();
  }
  return { origin, binding };
}

export async function queueCloudQuestionContinuation(
  tx: PoolClient, userId: string, input: Parameters<FactoryQueue>[2],
  botId: string | null, context: Parameters<FactoryQueue>[4],
): Promise<{ runId: string } | null> {
  const admitted = await admitCloudQuestionContinuation(tx,userId,input,botId,context);
  if (!admitted) return null;
  const { origin, binding } = admitted, originId = origin.id;
  const runId = randomUUID();
  const copied = copyRunPrompt(origin, `${origin.prompt}\n\n${input.note ?? ''}`);
  const { prompt } = copied;
  await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",source,status,mode,kind,"baseBranch",prompt,"agentDefinition",attempt,"promptTaskStart","promptTaskLength")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13,$14,$15,$16)`, [runId,userId,origin.issueId,origin.agentId,origin.deviceId,origin.deviceRepoId,origin.botId,origin.source,origin.mode,origin.kind,origin.baseBranch,prompt,JSON.stringify(retryWorkerDefinition(origin.agentDefinition,prompt)),origin.attempt,copied.promptTaskStart,copied.promptTaskLength]);
  await tx.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [runId,binding.botId,binding.workspaceId,userId]);
  // Same transfer shape as adoptTaskMachine: history retains its scope; only
  // the task's own new run takes custody of the existing sandbox.
  await tx.query(`UPDATE thread_machines SET state='ended',"endedAt"=COALESCE("endedAt",now()),"sandboxId"=NULL,
    "computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL WHERE "runId"=$1`, [originId]);
  await tx.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","snapshotId","operationId",state,"sandboxId","deviceId","repoId",epoch,"targetId","runningSince","templateKind")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $8='running' THEN now() ELSE NULL END,$14)`, [runId,binding.workspaceId,userId,binding.botId,origin.issueId,origin.snapshotId,randomUUID(),origin.machineState,origin.sandboxId,origin.deviceId,origin.deviceRepoId,origin.machineEpoch,origin.targetId,origin.templateKind]);
  await tx.query(`INSERT INTO run_publications ("runId","userId","issueId","scopeVersion","issueTitle","remoteUrl","remoteKey",identifier,branch,"baseBranch","pushApproved")
    SELECT $1,"userId","issueId","scopeVersion","issueTitle","remoteUrl","remoteKey",identifier,branch,"baseBranch","pushApproved"
    FROM run_publications WHERE "runId"=$2 AND "userId"=$3 AND "issueId"=$4`, [runId,originId,userId,origin.issueId]);
  return { runId };
}

/** Host-only preparation, after admission committed and before recovery dispatch. */
export async function prepareCloudQuestionRecovery(pool: Pool, userId: string, scope: { runId: string; workspaceId: string }) {
  try {
    await (await import('../../cloud-computer/thread-machines')).threadMachineAction(pool,{userId,workspaceId:scope.workspaceId},scope.runId,'refresh_runtime');
  } catch {
    throw new FactoryError('factoryQuestionContinuationUnavailable');
  }
}

/** Only after the answer transaction committed; a replay wakes the same run. */
export async function wakeCloudQuestionContinuation(pool: Pool, userId: string, result: { continuationRunId: string }) {
  const { wakeQueuedQuestionContinuation } = await import('./wake');
  if ((await wakeQueuedQuestionContinuation(pool,userId,result.continuationRunId)).recognized) return;
  const {rows:[binding]}=await pool.query('SELECT "workspaceId" FROM computer_run_bindings WHERE "runId"=$1 AND "ownerId"=$2',[result.continuationRunId,userId]);
  if (binding) await (await import('../automatic-dispatch')).factoryAutomaticRuntime.enqueue(pool,{userId,workspaceId:binding.workspaceId},null,result.continuationRunId);
}
