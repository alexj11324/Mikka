import type { Pool } from 'pg'
import { DEVICE_ONLINE_WINDOW_MS } from '@mikka/protocol/device'
import { ENDED_RUN_STATUSES } from './run-outcome'
import { LEASED_RUN_STATUSES } from './run-retry'
import { pendingTaskReportsSql } from './coordinator/group-factory'
import { THREAD_MACHINE_DUE_AT_SQL } from './cloud-computer/thread-lifecycle-due'

/** Mirrors OUTCOME_WINDOW_DAYS in lib/run-outcome-judge.ts (kept import-free for this query). */
const OUTCOME_WINDOW_DAYS = 7
/** How often the old minute sweep re-checked state only an outside service knows (the device gateway). */
const RECHECK = '60 seconds'
/** A bot computer still running at E2B after an idle hour is asked again this often: only a pause or loss
 * E2B already made is caught, so a minute cadence bought nothing but a pass each minute (#1371). */
const MACHINE_RECHECK = '10 minutes'

/**
 * When an ended run whose judge gave no answer is asked again (#1371): after as
 * long as it has already waited since it ended, at least an hour. A run the
 * judge cannot answer (no billing admission, the model down) is asked about
 * eight times in its 7-day window instead of every hour. `outcomeAt` is the last
 * try; the claim in lib/run-outcome-judge.ts uses the same expression.
 */
export const OUTCOME_RETRY_AT_SQL = `("outcomeAt" + greatest(interval '1 hour', "outcomeAt" - coalesce("finishedAt", "updatedAt")))`

/** The run-recovery sweeps (lib/run-recovery.ts), as RUN_RECOVERY_DUE_SQL labels each due time. */
export const RUN_RECOVERY_SWEEPS = ['leases', 'machines', 'outcomes', 'taskMachines', 'sandboxKills', 'groupTurns', 'tasks', 'resourceAccess'] as const
export type RunRecoverySweep = typeof RUN_RECOVERY_SWEEPS[number]

/** Each run-recovery due time, as rows of `at` and the `sweep` that does it; parameters $1-$4 come from runRecoveryDueParams. */
export const RUN_RECOVERY_DUE_SQL = `
    SELECT min("expiresAt") AS at, 'resourceAccess' AS sweep FROM resource_access_grants WHERE "expiresAt" IS NOT NULL
    UNION ALL SELECT min("expiresAt"), 'resourceAccess' FROM thread_execution_grants WHERE "revokedAt" IS NULL
    UNION ALL SELECT min(least(a."expiresAt",g."expiresAt",coalesce(s."expiresAt",now()),
      CASE WHEN g."revokedAt" IS NOT NULL THEN now() END)), 'resourceAccess'
      FROM thread_execution_authorizations a JOIN thread_execution_grants g ON g.id=a."grantId"
      LEFT JOIN "session" s ON s.id=a."sessionId" AND s."userId"=a."actorId" WHERE a."releasedAt" IS NULL
    UNION ALL SELECT min("createdAt"), 'resourceAccess' FROM resource_session_revocations WHERE "deliveredAt" IS NULL
    -- sweepExpiredRunLeases: a lease is lost once leaseExpiresAt < now.
    UNION ALL SELECT min("leaseExpiresAt") + interval '1 millisecond', 'leases' FROM agent_runs WHERE status = ANY($1::text[]) AND "leaseExpiresAt" IS NOT NULL
    -- ... and a queued retry whose device stopped being seen (the gateway is asked again each minute).
    UNION ALL SELECT min(CASE WHEN d."lastSeenAt" <= now() AND d."lastSeenAt" + $2::interval > now() THEN d."lastSeenAt" + $2::interval + interval '1 millisecond' ELSE now() + interval '${RECHECK}' END), 'leases'
      FROM agent_runs r LEFT JOIN devices d ON d.id = r."deviceId" WHERE r.status = 'queued' AND r."retryOf" IS NOT NULL
    -- reconcileCloudMachines: a running machine is checked with E2B once idle for an hour, then every MACHINE_RECHECK.
    UNION ALL SELECT min(CASE WHEN greatest("lastActiveAt" + interval '1 hour', "provisionLeaseUntil") > now()
        THEN greatest("lastActiveAt" + interval '1 hour', "provisionLeaseUntil") + interval '1 millisecond' ELSE now() + interval '${MACHINE_RECHECK}' END), 'machines'
      FROM cloud_machines WHERE state IN ('running','waking') AND "sandboxId" IS NOT NULL
    -- judgePendingOutcomes: an ended run is judged at once, and again OUTCOME_RETRY_AT_SQL after an unanswered try.
    UNION ALL SELECT min(coalesce(${OUTCOME_RETRY_AT_SQL} + interval '1 millisecond', now())), 'outcomes' FROM agent_runs
      WHERE outcome IS NULL AND status = ANY($3::text[]) AND coalesce("finishedAt", "updatedAt") > now() - make_interval(days => ${OUTCOME_WINDOW_DAYS})
    -- Every task machine has a persisted lifecycle deadline independent of a per-run Workflow.
    UNION ALL SELECT min(${THREAD_MACHINE_DUE_AT_SQL}), 'taskMachines'
      FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
      LEFT JOIN issues i ON i.id=m."issueId"
    -- retrySandboxKills: a kill that did not go through is tried again each minute.
    UNION ALL SELECT min(coalesce("lastAttemptAt", "createdAt") + interval '${RECHECK}'), 'sandboxKills' FROM sandbox_kill_retries
    -- resumePendingGroupTurns: queued or orphaned turns at the minute cadence, a pending judgment at its retry time.
    UNION ALL SELECT min(CASE WHEN status IN ('queued','running') THEN least("createdAt" + interval '${RECHECK}', now() + interval '${RECHECK}')
        ELSE "nextDecisionAt" END), 'groupTurns'
      FROM group_turns WHERE status IN ('queued','running') OR (status = 'failed' AND error = 'group_judgment_pending')
    -- ... and a bound task's milestone its group has not been told yet.
    UNION ALL SELECT now(), 'groupTurns' WHERE EXISTS (SELECT 1 ${pendingTaskReportsSql})
    -- sweepFactoryWatchdog: a task untouched for a minute, unless a watchdog decision set a later nextAt.
    UNION ALL SELECT min(greatest(t."updatedAt" + interval '1 minute' + interval '1 millisecond', coalesce(w."nextAt", '-infinity'))), 'tasks'
      FROM factory_tasks t JOIN factory_attempts a ON a.id = t."attemptId" LEFT JOIN agent_runs live ON live.id = a."runId"
      LEFT JOIN LATERAL (SELECT max((e.result->>'nextAt')::timestamptz) AS "nextAt" FROM factory_events e
        WHERE e."taskId" = t.id AND e.request->>'kind' = 'task_watchdog' AND e.request->>'attemptId' = t."attemptId"::text) w ON true
      WHERE $4 AND (t.status IN ('pending','running') OR (t.status = 'blocked' AND a.output->'watchdog'->>'reasonCode' = 'task_stalled'))
        AND t.stage IN ('spec','execute','review','verify','monitor') AND (live.status IS NULL OR live.status NOT IN ('paused','waiting_input'))
`

export const runRecoveryDueParams = (factoryLifecycle: boolean) => [[...LEASED_RUN_STATUSES], `${DEVICE_ONLINE_WINDOW_MS} milliseconds`, [...ENDED_RUN_STATUSES], factoryLifecycle]

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
  const { rows } = await pool.query<{ at: string | null }>(`SELECT ceil(extract(epoch FROM min(at))*1000)::bigint::text AS at FROM (${RUN_RECOVERY_DUE_SQL}) due`, runRecoveryDueParams(options.factoryLifecycle))
  return rows[0]?.at == null ? null : Number(rows[0].at)
}

/**
 * nextRunRecoveryDue and which sweeps are due now, in the same one statement,
 * so a pass runs only the sweeps whose work has come instead of all seven (#1371).
 */
export async function runRecoveryDueSweeps(pool: Pick<Pool, 'query'>, options: { factoryLifecycle: boolean }): Promise<{ next: number | null; due: Set<RunRecoverySweep> }> {
  const { rows } = await pool.query<{ sweep: RunRecoverySweep; at: string; due: boolean }>(`SELECT sweep, ceil(extract(epoch FROM min(at))*1000)::bigint::text AS at, min(at) <= now() AS due
    FROM (${RUN_RECOVERY_DUE_SQL}) due WHERE at IS NOT NULL GROUP BY sweep`, runRecoveryDueParams(options.factoryLifecycle))
  const next = rows.length ? Math.min(...rows.map(row => Number(row.at))) : null
  return { next, due: new Set(rows.filter(row => row.due).map(row => row.sweep)) }
}

/** nextRunRecoveryDue on the application database, with the Factory kill switch as deployed. */
export async function runRecoveryNextDue(): Promise<number | null> {
  const [{ pool }, { factoryLifecycleEnabled }] = await Promise.all([import('./db'), import('./factory/runtime')])
  return nextRunRecoveryDue(pool, { factoryLifecycle: factoryLifecycleEnabled() })
}

/**
 * One run-recovery due-timer pass (#1371): runs only the sweeps due now and
 * returns the next due time. A pass with nothing due (a wake that found no work)
 * costs this one statement.
 */
export async function runRecoveryPass(): Promise<number | null> {
  const [{ pool }, { factoryLifecycleEnabled }] = await Promise.all([import('./db'), import('./factory/runtime')])
  const options = { factoryLifecycle: factoryLifecycleEnabled() }
  const { next, due } = await runRecoveryDueSweeps(pool, options)
  if (!due.size) return next
  // In a Workflow step the group-turn sweep runs inline: there is no request to run it after.
  await (await import('./run-recovery')).recoverRuns(work => work(), due)
  return nextRunRecoveryDue(pool, options)
}
