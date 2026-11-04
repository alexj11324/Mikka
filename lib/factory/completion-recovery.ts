import type { PoolClient } from 'pg'
import type { FactoryTask } from './store'

/** Read-only eligibility, shared by the owner control and its locked transaction.
 * A model-supplied finish/output cannot manufacture the host watchdog receipt. */
export async function completedRunForRecovery(tx: Pick<PoolClient, 'query'>, task: FactoryTask, lock = false) {
  if (task.stage !== 'execute' || task.status !== 'blocked' || task.candidateId !== null) return null
  const { rows: [run] } = await tx.query(`SELECT r.*,repo."remoteUrl",repo."repoPath" FROM factory_tasks t
    JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."attemptId"=$3 AND t.revision=$4 AND t."sourceEventId"=$5
      AND t.stage='execute' AND t.status='blocked' AND t."candidateId" IS NULL
      AND a.stage='execute' AND a.status='blocked' AND a."candidateId" IS NULL
      AND (a.output->>'requestEpoch' IS NULL OR a.output->>'requestEpoch'=$5::text)
      AND a.output->'watchdog'->>'reasonCode'='recovery_exhausted' AND a.output->'watchdog'->>'requestEpoch'=$5::text
      AND r.status='succeeded' AND r."stopReason"='submitted' AND r."stopRequestedAt" IS NULL
      AND r."sessionId" IS NOT NULL AND r.report IS NOT NULL
      AND EXISTS(SELECT 1 FROM factory_events w WHERE w."taskId"=t.id AND w.request->>'kind'='task_watchdog'
        AND w.request->>'attemptId'=a.id::text AND w.request->>'requestEpoch'=$5::text
        AND w.result->>'action'='reconcile' AND w.result->>'blocked'='true')
      AND NOT EXISTS(SELECT 1 FROM factory_attempts prior JOIN agent_runs live ON live.id=prior."runId"
        WHERE prior."taskId"=t.id AND live.status IN ('queued','preparing','running','paused','waiting_input','finishing'))
      AND NOT EXISTS(SELECT 1 FROM factory_questions q WHERE q."taskId"=t.id AND q.status NOT IN ('resolved','cancelled','expired','superseded'))
      AND NOT EXISTS(SELECT 1 FROM factory_publications p WHERE p."taskId"=t.id AND p.status IN ('reserved','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM operation_ledger o JOIN factory_attempts prior ON prior."taskId"=t.id
        AND (prior."runId"=o."runId" OR prior."runId"::text=o.binding->>'executionRunId')
        WHERE o."ownerId"=t."userId" AND o.status IN ('executing','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM run_publications p JOIN factory_attempts prior ON prior."runId"=p."runId"
        WHERE prior."taskId"=t.id AND p."userId"=t."userId" AND p.status='processing')${lock ? ' FOR UPDATE OF a,r' : ''}`,
  [task.id, task.userId, task.attemptId, task.revision, task.sourceEventId])
  return run ?? null
}
