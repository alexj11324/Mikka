import 'server-only'
import { serverRunFailure } from '../run-failure-details'
import type { Pool } from 'pg'
import { factoryAutomaticRuntime } from './automatic-dispatch'

type Actor = { userId: string; workspaceId: string }

/** Host-only durable work: never called inside the completed worker's request. */
export async function handoffFactoryCloudStage(pool: Pool, actor: Actor, previousRunId: string | null, runId: string, providerContinuation = false) {
  const { rows: [handoff] } = await pool.query(`SELECT r.status,to_jsonb(r) AS run,to_jsonb(previous) AS previous,to_jsonb(i) AS issue
    FROM agent_runs r
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    JOIN issues i ON i.id=r."issueId"
    LEFT JOIN agent_runs previous ON previous.id=$4
    WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3
      AND (EXISTS (SELECT 1 FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
        WHERE a."runId"=r.id AND t."userId"=r."userId" AND t."issueId"=r."issueId" AND t.status='running')
        OR ($5::boolean AND NOT EXISTS (SELECT 1 FROM factory_attempts a WHERE a."runId" IN (r.id,$4::uuid))))
      AND r."stopRequestedAt" IS NULL
      AND (r.status='queued' OR (r.status IN ('preparing','running','waiting_input') AND r."leaseExpiresAt">now()
        AND EXISTS(SELECT 1 FROM thread_machines m WHERE m."runId"=r.id AND m."ownerId"=r."userId"
          AND m."workspaceId"=b."workspaceId" AND m."botId"=b."botId" AND m."issueId"=r."issueId"
          AND m."deviceId"=r."deviceId" AND m."repoId"=r."deviceRepoId" AND m.state='running' AND m."sandboxId" IS NOT NULL)))
      AND ($4::uuid IS NULL OR (previous."userId"=r."userId" AND previous."issueId"=r."issueId"
        AND previous.status IN ('succeeded','failed','stopped','cancelled')))`, [runId, actor.userId, actor.workspaceId, previousRunId, providerContinuation])
  if (!handoff) return false // A cancelled, superseded or unowned handoff has no work.
  if (providerContinuation) {
    const [{ providerContinuationLaunchMatches }, { mayCompleteIssue }] = await Promise.all([import('../run-provider-fallback'), import('../run-completion')])
    // The same lifecycle can serve a non-Factory provider continuation only
    // with its immutable host receipt. A superseded Factory attempt cannot use
    // this path to escape the current-task binding above.
    if (!handoff.previous || handoff.previous.status !== 'failed' || !await providerContinuationLaunchMatches(pool, handoff.previous, handoff.run) ||
      handoff.run.agentDefinition?.executionIdentity?.workspaceId !== actor.workspaceId ||
      ['done', 'cancelled', 'canceled'].includes(handoff.issue.status) || !await mayCompleteIssue(handoff.issue, actor.userId)) return false
  }
  // A lost step response can replay after the worker claimed. Continue this
  // durable workflow's lifecycle without parking or bootstrapping active work.
  if (handoff.status !== 'queued') return true
  try { if (previousRunId) await factoryAutomaticRuntime.park(pool, actor, previousRunId, runId) }
  catch {
    await failFactoryCloudStage(pool, actor, runId, 'Previous stage artifacts could not be retained')
    return false
  }
  const started = await factoryAutomaticRuntime.start(actor, runId)
  // Native continuations and later stages retain the task's existing VM on
  // wake failure. Retry this durable step instead of discarding its history.
  if (started?.state === 'unavailable') throw new Error(started.reason === 'retained_runtime' ? 'Retained task machine unavailable'
    : started.reason === 'provisioning' ? 'Thread provisioning in progress' : 'Original question machine unavailable')
  return started?.state === 'running'
}

export async function failFactoryCloudStage(pool: Pool, actor: Actor, runId: string, message: string) {
  const { rows: [ended] } = await pool.query(`UPDATE agent_runs r SET status='failed',"stopReason"='device_lost',error=$4,"failureDetails"=$5::jsonb,"finishedAt"=now(),"updatedAt"=now()
    WHERE r.id=$1 AND r."userId"=$2 AND r.status='queued' AND EXISTS (
      SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."ownerId"=r."userId" AND b."workspaceId"=$3) RETURNING r.*`, [runId, actor.userId, actor.workspaceId, message, JSON.stringify(serverRunFailure(runId, new Date()))])
  if (!ended) return
  const [{ db }, { recordCoordinatorEvent }, { runFinishedEvent }, { wakeCoordinator }, { afterRunEnded }] = await Promise.all([
    import('@/lib/db'), import('@/lib/coordinator-event-store'), import('@/lib/coordinator-events'), import('@/lib/coordinator/wake'), import('@/lib/run-completion-effects'),
  ])
  await recordCoordinatorEvent(db, runFinishedEvent(ended))
  await afterRunEnded(actor.userId, runId)
  await wakeCoordinator(actor.userId).catch(() => undefined)
}
