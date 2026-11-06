// Import-free (lib/run-recovery-due.ts reads it): how long ready thread
// machines (thread-machine-pool.ts) are kept, and when the reaper is due.
/** A ready instance unused this long is killed. */
export const POOL_IDLE_DAYS = 7
/** A refill that has not finished by then died with its function; its instance pauses itself (onTimeout). */
export const WARMING_LIMIT = '20 minutes'
/** A claim whose run never recorded the sandbox (the dispatch died between claim and record). */
export const CLAIM_LIMIT = '1 hour'

/** The run-recovery due term: when the first pool row needs the reaper. */
export const THREAD_MACHINE_POOL_DUE_SQL = `SELECT min(CASE
    WHEN "claimedBy" IS NOT NULL THEN least("claimedAt" + interval '${CLAIM_LIMIT}', CASE WHEN EXISTS(SELECT 1 FROM thread_machines m WHERE m."sandboxId"=p."sandboxId") THEN now() END)
    WHEN state='warming' THEN "createdAt" + interval '${WARMING_LIMIT}'
    ELSE "readyAt" + make_interval(days => ${POOL_IDLE_DAYS}) END) + interval '1 millisecond' AS at, 'threadPool' AS sweep FROM thread_machine_pool p`
