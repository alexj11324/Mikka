import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { retryWorkerDefinition } from '@/lib/agent-kit/worker'
import { threadRunModel } from '@/lib/computer/run-model'
import { nativeRunBinding } from '@/lib/computer/native-run-binding'
import { runCredentialSource } from '@/lib/run-credential-source'
import { FactoryError } from './contract'

/** An answered cloud question resumes its own stopped executor. The task,
 * question, owner, repository and credential are rechecked under the dispatch
 * transaction; a new machine/session cannot replace the original one. */
export async function queueFactoryCloudQuestion(tx: PoolClient, userId: string, input: {issueId:string;agentId:string;deviceRepoId:string;note?:string}, attemptId: string) {
  const source = (await tx.query(`SELECT r.*,b."botId" AS "runtimeBotId",b."workspaceId" FROM factory_questions q
    JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=q."issueId" AND t."attemptId"=$5 AND t."candidateId" IS NOT DISTINCT FROM q."candidateId" AND t.stage=q.stage
    JOIN agent_runs r ON r.id=q."originRunId" AND r."userId"=q."userId" AND r."issueId"=q."issueId" AND r."botId" IS NOT DISTINCT FROM t."botId"
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE q."userId"=$1 AND q."issueId"=$2 AND r."agentId"=$3 AND r."deviceRepoId"=$4
      AND q.status='answered' AND q."answerId" IS NOT NULL AND r.status='stopped' AND r."stopRequestedAt" IS NULL
    FOR UPDATE OF r`,[userId,input.issueId,input.agentId,input.deviceRepoId,attemptId])).rows[0]
  if (!source) return null
  const selected = threadRunModel(source.agentDefinition)
  if (!selected) throw new FactoryError('factoryQuestionContinuationUnavailable')
  const binding = selected.subscriptionBindingId ? await nativeRunBinding(tx,userId,source.agentId,source.agentDefinition.harness,source.workspaceId,selected.subscriptionBindingId) : null
  if (selected.subscriptionBindingId && (!binding || binding.modelId !== selected.model)) throw new FactoryError('factoryQuestionContinuationUnavailable')
  const credential = await runCredentialSource(tx,{ownerId:userId,botId:source.botId,harness:source.agentDefinition.harness,model:selected.model,keyId:selected.apiKeyId,botWorkspaceId:source.botId ? source.workspaceId : null,choiceWorkspaceId:source.workspaceId,subscription:binding})
  if (!(selected.apiKeyId ? credential.apiKey?.keyId === selected.apiKeyId : credential.subscription?.id === selected.subscriptionBindingId)) throw new FactoryError('factoryQuestionContinuationUnavailable')
  const followUp = `\n\n${input.note ?? ''}`
  const prompt = source.prompt.slice(0,100000-followUp.length)+followUp
  const definition = retryWorkerDefinition(source.agentDefinition,prompt)
  if (!definition) throw new FactoryError('factoryQuestionContinuationUnavailable')
  const runId = randomUUID()
  await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,kind,"baseBranch",prompt,"agentDefinition")
    VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$11)`,[runId,userId,source.issueId,source.agentId,source.deviceId,source.deviceRepoId,source.botId,source.kind,source.baseBranch,prompt,JSON.stringify(definition)])
  await tx.query(`INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`,[runId,source.runtimeBotId,source.workspaceId,userId])
  await tx.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state) VALUES ($1,$2,$3,$4,'pending',$5,'starting')`,[runId,source.workspaceId,userId,source.runtimeBotId,randomUUID()])
  await tx.query(`INSERT INTO run_publications ("runId","userId","issueId","scopeVersion","issueTitle","remoteUrl","remoteKey",identifier,branch,"baseBranch","pushApproved")
    SELECT $1,"userId","issueId","scopeVersion","issueTitle","remoteUrl","remoteKey",identifier,branch,"baseBranch","pushApproved" FROM run_publications WHERE "runId"=$2 AND "userId"=$3`,[runId,source.id,userId])
  return {runId}
}
