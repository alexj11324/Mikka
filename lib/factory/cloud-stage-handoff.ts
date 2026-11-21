import 'server-only'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { recordCoordinatorEvent } from '../coordinator-event-store'
import { runFinishedEvent } from '../coordinator-events'
import { wakeCoordinatorAfterCommit } from '../coordinator/wake-after-commit'
import { afterRunEnded } from '../run-completion-effects'
import { serverRunFailure } from '../run-failure-details'
import type { Pool } from 'pg'
import { withDatabaseClient } from '../db'
import type { agentRuns } from '../db/schema'
import { factoryAutomaticRuntime } from './automatic-dispatch'
import { assertRunProjectResources, isProjectExecutionRefusal, withRunProjectResources } from '../project-resources/run-lease'

type Actor = { userId: string; workspaceId: string }

/** Host-only durable work: never called inside the completed worker's request. */
export async function handoffFactoryCloudStage(pool: Pool, actor: Actor, previousRunId: string | null, runId: string, providerContinuation = false) {
  const { rows: [handoff] } = await pool.query(`SELECT r.status,to_jsonb(r) AS run,to_jsonb(previous) AS previous,to_jsonb(i) AS issue
    FROM agent_runs r
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    JOIN issues i ON i.id=r."issueId"
    LEFT JOIN agent_runs previous ON previous.id=$4
    WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND r."workspaceId"=b."workspaceId"
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
  try {
    return await withRunProjectResources(pool, handoff.run, async () => {
      try {
        if (previousRunId) {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const { rows: [current] } = await client.query<typeof agentRuns.$inferSelect>(`SELECT r.* FROM agent_runs r
              JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
              WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3 AND b."workspaceId"=r."workspaceId"
                AND r."issueId"=$4 AND r.status='queued' AND r."stopRequestedAt" IS NULL FOR UPDATE OF r`,
            [runId, actor.userId, actor.workspaceId, handoff.run.issueId])
            if (!current) { await client.query('ROLLBACK'); return false }
            // The next Run's current placement remains locked through parent
            // retention/park. Release it before ensure acquires its own lock.
            await assertRunProjectResources(client, current)
            await withDatabaseClient(client, () => factoryAutomaticRuntime.park(pool, actor, previousRunId, runId, client))
            await client.query('COMMIT')
          } catch (error) { await client.query('ROLLBACK'); throw error }
          finally { client.release() }
        }
      } catch (error) {
        if (isProjectExecutionRefusal(error)) throw error
        await failFactoryCloudStage(pool, actor, runId, 'Previous stage artifacts could not be retained')
        return false
      }
      const started = await factoryAutomaticRuntime.start(actor, runId)
      if (started?.state === 'unavailable' && started.reason === 'project_resources') return false
      // Native continuations and later stages retain the task's existing VM on
      // wake failure. Retry this durable step instead of discarding its history.
      if (started?.state === 'unavailable') throw new Error(started.reason === 'retained_runtime' ? 'Retained task machine unavailable'
        : started.reason === 'provisioning' ? 'Thread provisioning in progress' : 'Original question machine unavailable')
      return started?.state === 'running'
    })
  } catch (error) {
    if (isProjectExecutionRefusal(error)) return false
    throw error
  }
}

export async function failFactoryCloudStage(pool: Pool, actor: Actor, runId: string, message: string) {
  const ended = await drizzle(pool).transaction(async tx => {
    const { rows: [run] } = await tx.execute<Parameters<typeof runFinishedEvent>[0]>(sql`UPDATE agent_runs r
      SET status='failed',"stopReason"='device_lost',error=${message},"failureDetails"=${JSON.stringify(serverRunFailure(runId, new Date()))}::jsonb,
        "finishedAt"=now(),"updatedAt"=now()
      WHERE r.id=${runId} AND r."userId"=${actor.userId} AND r.status='queued' AND EXISTS (
        SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."ownerId"=r."userId" AND b."workspaceId"=${actor.workspaceId}) RETURNING r.*`)
    if (!run) return false
    await recordCoordinatorEvent(tx, runFinishedEvent(run))
    // The terminal transition also wakes an already persisted completion row.
    // Its commit key coalesces with the event writer's when the row is new.
    wakeCoordinatorAfterCommit(tx, actor.userId)
    return true
  })
  if (ended) await afterRunEnded(actor.userId, runId)
}
