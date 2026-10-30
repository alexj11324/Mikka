import type { Pool } from "pg";

export type FactoryMonitorSweepResult = {
  enabled: boolean;
  /** (user, bot) scopes with an unobserved monitor completion, read this run. */
  scopes: number;
  observed: number;
  failed: number;
  /** Scopes left for the next run because the deadline passed. */
  deferred: number;
};

type Reconciler = { reconcile(userId: string): Promise<{ observed: number }> };

export const disabledFactoryMonitorSweep = (): FactoryMonitorSweepResult => ({
  enabled: false, scopes: 0, observed: 0, failed: 0, deferred: 0,
});

/**
 * Periodic safety net for the monitor stage: finds run_finished events of monitor attempts that
 * no factory_monitor_observations row records yet (the run-completion hook normally consumes them)
 * and hands each (user, bot) scope to that bot's existing `monitor.reconcile`. Idempotent: an
 * observed event is excluded here and replayed (no new transition) by `consume`, so overlapping or
 * repeated runs converge on one observation per event. One scope failing does not stop the others.
 */
export async function sweepFactoryMonitor(
  pool: Pick<Pool, "query">,
  monitorFor: (botId: string | null) => Reconciler,
  { deadline, limit = 100 }: { deadline: number; limit?: number },
): Promise<FactoryMonitorSweepResult> {
  const { rows } = await pool.query<{ userId: string; botId: string | null }>(
    `SELECT t."userId", t."botId" FROM factory_tasks t
     JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
     JOIN coordinator_events e ON e."runId"=a."runId" AND e."userId"=t."userId" AND e."issueId"=t."issueId" AND e.kind='run_finished'
     WHERE t.stage='monitor' AND t.status NOT IN ('cancelled','revoked')
     AND NOT EXISTS (SELECT 1 FROM factory_monitor_observations o WHERE o."userId"=t."userId" AND o."sourceEventId"=e.id)
     GROUP BY t."userId", t."botId" ORDER BY min(e."createdAt") LIMIT $1`,
    [limit],
  );
  const result: FactoryMonitorSweepResult = { enabled: true, scopes: rows.length, observed: 0, failed: 0, deferred: 0 };
  for (const [index, scope] of rows.entries()) {
    if (Date.now() >= deadline) {
      result.deferred = rows.length - index;
      break;
    }
    try {
      result.observed += (await monitorFor(scope.botId).reconcile(scope.userId)).observed;
    } catch (error) {
      result.failed++;
      // Error class/code only: never the message, which may quote task or user content.
      const code = (error as { code?: unknown })?.code;
      console.error("factory monitor sweep: scope failed", {
        error: error instanceof Error ? error.name : "unknown",
        code: typeof code === "string" ? code : undefined,
      });
    }
  }
  return result;
}
