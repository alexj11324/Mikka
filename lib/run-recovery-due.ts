import type { Pool } from 'pg'
import { DEVICE_ONLINE_WINDOW_MS } from '@mikka/protocol/device'
import { ENDED_RUN_STATUSES } from './run-outcome'
import { LEASED_RUN_STATUSES } from './run-retry'
import { pendingTaskReportsSql } from './coordinator/group-factory'

/** Mirrors OUTCOME_WINDOW_DAYS / RETRY_AFTER in lib/run-outcome-judge.ts (kept import-free for this query). */
const OUTCOME_WINDOW_DAYS = 7
const OUTCOME_RETRY = '1 hour'
/** How often the old minute sweep re-checked state only an outside service knows (the device gateway, E2B). */
const RECHECK = '60 seconds'

/**
 * The earliest time any run-recovery work is due (epoch ms, rounded up from
 * PostgreSQL microseconds), or null when none can come due without a new write
 * (#1212 D). Each term matches the condition its sweep selects on
 * (lib/run-recovery.ts), so the run-recovery due timer wakes when the first one
 * flips. Work that depends on outside state (a device the gateway may still see,
 * a sandbox E2B may still run) is re-checked every 60 s while it exists, as the
 * minute sweep did. One statement; at idle every term is empty.
 */
export async function nextRunRecoveryDue(pool: Pick<Pool, 'query'>, options: { factoryLifecycle: boolean }): Promise<number | null> {
  const { rows } = await pool.query<{ at: string | null }>(`SELECT ceil(extract(epoch FROM min(at))*1000)::bigint::text AS at FROM (
    -- sweepExpiredRunLeases: a lease is lost once leaseExpiresAt < now.
    SELECT min("leaseExpiresAt") + interval '1 millisecond' AS at FROM agent_runs WHERE status = ANY($1::text[]) AND "leaseExpiresAt" IS NOT NULL
    -- ... and a queued retry whose device stopped being seen (the gateway is asked again each minute).
    UNION ALL SELECT min(CASE WHEN d."lastSeenAt" + $2::interval > now() THEN d."lastSeenAt" + $2::interval + interval '1 millisecond' ELSE now() + interval '${RECHECK}' END)
      FROM agent_runs r LEFT JOIN devices d ON d.id = r."deviceId" WHERE r.status = 'queued' AND r."retryOf" IS NOT NULL
    -- reconcileCloudMachines: a running machine is checked with E2B once idle for an hour, then each minute.
    UNION ALL SELECT min(CASE WHEN greatest("lastActiveAt" + interval '1 hour', "provisionLeaseUntil") > now()
        THEN greatest("lastActiveAt" + interval '1 hour', "provisionLeaseUntil") + interval '1 millisecond' ELSE now() + interval '${RECHECK}' END)
      FROM cloud_machines WHERE state IN ('running','waking') AND "sandboxId" IS NOT NULL
    -- judgePendingOutcomes: an ended run is judged at once, and again an hour after an unanswered try.
    UNION ALL SELECT min(coalesce("outcomeAt" + interval '${OUTCOME_RETRY}' + interval '1 millisecond', now())) FROM agent_runs
      WHERE outcome IS NULL AND status = ANY($3::text[]) AND coalesce("finishedAt", "updatedAt") > now() - make_interval(days => ${OUTCOME_WINDOW_DAYS})
    -- endClosedTaskMachines: a paused task sandbox whose task closed or was deleted.
    UNION ALL SELECT now() WHERE EXISTS (SELECT 1 FROM thread_machines m LEFT JOIN issues i ON i.id = m."issueId"
      WHERE m.state = 'paused' AND m."issueId" IS NOT NULL
        AND (i.id IS NULL OR i.status IN ('done','canceled','duplicate') OR i.content->'attrs'->'mikka'->>'deletedAt' IS NOT NULL))
    -- retrySandboxKills: a kill that did not go through is tried again each minute.
    UNION ALL SELECT min(coalesce("lastAttemptAt", "createdAt") + interval '${RECHECK}') FROM sandbox_kill_retries
    -- resumePendingGroupTurns: queued or orphaned turns at the minute cadence, a pending judgment at its retry time.
    UNION ALL SELECT min(CASE WHEN status IN ('queued','running') THEN least("createdAt" + interval '${RECHECK}', now() + interval '${RECHECK}')
        ELSE "nextDecisionAt" END)
      FROM group_turns WHERE status IN ('queued','running') OR (status = 'failed' AND error = 'group_judgment_pending')
    -- ... and a bound task's milestone its group has not been told yet.
    UNION ALL SELECT now() WHERE EXISTS (SELECT 1 ${pendingTaskReportsSql})
    -- sweepFactoryWatchdog: a task untouched for a minute, unless a watchdog decision set a later nextAt.
    UNION ALL SELECT min(greatest(t."updatedAt" + interval '1 minute' + interval '1 millisecond', coalesce(w."nextAt", '-infinity')))
      FROM factory_tasks t JOIN factory_attempts a ON a.id = t."attemptId" LEFT JOIN agent_runs live ON live.id = a."runId"
      LEFT JOIN LATERAL (SELECT max((e.result->>'nextAt')::timestamptz) AS "nextAt" FROM factory_events e
        WHERE e."taskId" = t.id AND e.request->>'kind' = 'task_watchdog' AND e.request->>'attemptId' = t."attemptId"::text) w ON true
      WHERE $4 AND (t.status IN ('pending','running') OR (t.status = 'blocked' AND a.output->'watchdog'->>'reasonCode' = 'task_stalled'))
        AND t.stage IN ('spec','execute','review','verify','monitor') AND (live.status IS NULL OR live.status NOT IN ('paused','waiting_input'))
  ) due`, [[...LEASED_RUN_STATUSES], `${DEVICE_ONLINE_WINDOW_MS} milliseconds`, [...ENDED_RUN_STATUSES], options.factoryLifecycle])
  return rows[0]?.at == null ? null : Number(rows[0].at)
}

/** nextRunRecoveryDue on the application database, with the Factory kill switch as deployed. */
export async function runRecoveryNextDue(): Promise<number | null> {
  const [{ pool }, { factoryLifecycleEnabled }] = await Promise.all([import('./db'), import('./factory/runtime')])
  return nextRunRecoveryDue(pool, { factoryLifecycle: factoryLifecycleEnabled() })
}
