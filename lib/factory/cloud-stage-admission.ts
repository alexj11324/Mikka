import 'server-only'
import type { PoolClient } from 'pg'
import { computerTemplate, taskTemplate } from '../secrets/e2b-runtime'
import type { FactoryBinding } from './contract'

/** Host-only context from the locked automatic stage. Never a queue/tool input. */
export type FactoryCloudStageAdmission = {
  binding: FactoryBinding
  sourceEventId: string
  sourceRunId: string
}

type Target = { deviceId: string; instructions: string; harness: string; baseBranch: string; remoteUrl: string | null }

/** Stage an independent thread from its prepared, sleeping parent metadata.
 * The existing durable handoff starts the thread; this never calls a provider
 * or changes the parent. Ordinary queues still require a running parent. */
export async function sleepingFactoryCloudTarget(
  tx: Pick<PoolClient, 'query'>,
  actor: { userId: string; workspaceId: string },
  input: { botId: string; issueId: string; agentId: string; deviceRepoId: string; withoutBot?: boolean },
  admission: FactoryCloudStageAdmission,
  queuedRunId: string | null = null,
): Promise<Target | null> {
  if (admission.binding.issueId !== input.issueId) return null
  const { rows: [target] } = await tx.query<Target>(`SELECT m."deviceId",a.instructions,a.harness,repo."baseBranch",repo."remoteUrl"
    FROM factory_tasks t JOIN factory_attempts pending ON pending.id=t."attemptId" AND pending."taskId"=t.id
    JOIN coordinator_events e ON e.id=t."sourceEventId" AND e."userId"=t."userId" AND e.kind='user_message'
      AND e."botId" IS NOT DISTINCT FROM t."botId" AND (e."issueId" IS NULL OR e."issueId"=t."issueId")
    JOIN factory_attempts previous ON previous."taskId"=t.id AND previous.stage='execute' AND previous."runId"=$12
    JOIN agent_runs source ON source.id=previous."runId" AND source."userId"=t."userId" AND source."issueId"=t."issueId"
    JOIN computer_run_bindings origin ON origin."runId"=source.id AND origin."ownerId"=t."userId"
      AND origin."botId"=$1 AND origin."workspaceId"=$3
    JOIN bots b ON b.id=origin."botId" AND b."ownerId"=origin."ownerId" AND b."workspaceId"=origin."workspaceId" AND b."archivedAt" IS NULL
    JOIN bot_desktops desktop ON desktop."botId"=b.id AND desktop."ownerId"=b."ownerId" AND desktop."workspaceId"=b."workspaceId"
    JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
    JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
    JOIN agents a ON a.id=$4 AND (a.id=source."agentId" OR pending.stage IN ('review','verify')) AND a."userId"=b."ownerId" AND a."deviceId"=dev.id
    JOIN bot_cloud_runtimes runtime ON runtime."agentId"=a.id AND runtime.harness=a.harness
      AND runtime."botId"=b.id AND runtime."ownerId"=b."ownerId" AND runtime."workspaceId"=b."workspaceId"
    JOIN device_repos repo ON repo.id=$5 AND repo."deviceId"=dev.id AND repo."userId"=b."ownerId"
    JOIN device_repos original_repo ON original_repo.id=source."deviceRepoId" AND original_repo."userId"=source."userId"
      AND original_repo."deviceId"=source."deviceId" AND original_repo."remoteUrl" IS NOT DISTINCT FROM repo."remoteUrl"
      AND (repo."remoteUrl" IS NOT NULL OR original_repo."repoPath"=repo."repoPath")
    WHERE t.id=$6 AND t."userId"=$2 AND t."issueId"=$7 AND t."attemptId"=$8 AND t.revision=$9
      AND t."candidateId" IS NOT DISTINCT FROM $10::uuid AND t."sourceEventId"=$11
      AND t.status='pending' AND t.stage IN ('execute','review','verify')
      AND pending.status='pending' AND pending."runId" IS NULL AND pending.stage=t.stage
      AND pending."candidateId" IS NOT DISTINCT FROM t."candidateId"
      AND (pending.output->>'requestEpoch' IS NULL OR pending.output->>'requestEpoch'=t."sourceEventId"::text)
      AND (t."botId" IS NULL OR EXISTS(SELECT 1 FROM bots chat WHERE chat.id=t."botId" AND chat."ownerId"=$2 AND chat."workspaceId"=$3 AND chat."archivedAt" IS NULL))
      AND source.status IN ('succeeded','failed','stopped','cancelled')
      AND source."botId" IS NOT DISTINCT FROM CASE WHEN $13::boolean THEN NULL::uuid ELSE b.id END
      AND NOT EXISTS(SELECT 1 FROM factory_attempts newer JOIN agent_runs r ON r.id=newer."runId"
        WHERE newer."taskId"=t.id AND newer.stage='execute' AND newer.position>previous.position)
      AND m.state='sleeping' AND m."runtimeReady"=true AND m."sandboxId" IS NOT NULL
      AND m."provisionLeaseId" IS NULL AND m."provisionLeaseUntil" IS NULL
      AND m."workerLeaseId" IS NULL AND m."workerLeaseUntil" IS NULL
      AND (repo."remoteUrl" IS NOT NULL OR NOT EXISTS(SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny'))
      AND ($14::uuid IS NULL OR EXISTS(SELECT 1 FROM agent_runs queued JOIN computer_run_bindings binding ON binding."runId"=queued.id
        JOIN thread_machines machine ON machine."runId"=queued.id AND machine."ownerId"=queued."userId"
          AND machine."workspaceId"=binding."workspaceId" AND machine."botId"=binding."botId"
        WHERE queued.id=$14 AND queued."userId"=$2 AND queued."issueId"=$7 AND queued."agentId"=$4 AND queued."deviceRepoId"=$5
          AND queued."deviceId"=dev.id AND queued.status='queued' AND queued."stopRequestedAt" IS NULL
          AND queued."botId" IS NOT DISTINCT FROM CASE WHEN $13::boolean THEN NULL::uuid ELSE b.id END
          AND binding."ownerId"=$2 AND binding."workspaceId"=$3 AND binding."botId"=$1
          AND machine.state='starting' AND machine."snapshotId"='pending' AND machine."deviceId" IS NULL AND machine."sandboxId" IS NULL))
    FOR SHARE OF m,dev,a,repo`, [input.botId, actor.userId, actor.workspaceId, input.agentId, input.deviceRepoId,
    admission.binding.taskId, input.issueId, admission.binding.attemptId, admission.binding.revision, admission.binding.candidateId,
    admission.sourceEventId, admission.sourceRunId, input.withoutBot === true, queuedRunId])
  if (!target) return null
  // This admission requires the official template/adoption path. It cannot
  // authorize a custom snapshot that depends on a live parent.
  if (target.remoteUrl) taskTemplate(target.harness)
  else computerTemplate()
  return target
}
