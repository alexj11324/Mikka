import type { PoolClient } from "pg";
import { FactoryError } from "./contract";

/** Acquire the task fence before issue/run locks. Receipt history is not permission. */
export async function lockFactoryRun(
  tx: PoolClient,
  userId: string,
  runId: string,
  stages: readonly string[] = [
    "spec",
    "execute",
    "review",
    "verify",
    "monitor",
  ],
) {
  const { rows: tasks } = await tx.query(
    `WITH RECURSIVE lineage AS (
          SELECT id,"retryOf","continuesRunId" FROM agent_runs WHERE id=$1
          UNION SELECT r.id,r."retryOf",r."continuesRunId" FROM agent_runs r JOIN lineage l ON r.id=l."retryOf" OR r.id=l."continuesRunId"
        ) SELECT t.* FROM factory_tasks t WHERE t.id IN (
          SELECT a."taskId" FROM factory_attempts a JOIN lineage l ON l.id=a."runId"
        ) ORDER BY t.id FOR UPDATE OF t`,
    [runId],
  );
  if (tasks.length > 1) throw new FactoryError("factoryRunMismatch");
  if (tasks.length) {
    const task = tasks[0];
    if (
      task.userId !== userId ||
      task.status !== "running" ||
      !stages.includes(task.stage)
    )
      throw new FactoryError("factoryStopped");
    const {
      rows: [attempt],
    } = await tx.query(
      `SELECT "runId",stage,status FROM factory_attempts WHERE id=$1 AND "taskId"=$2`,
      [task.attemptId, task.id],
    );
    if (
      !attempt ||
      attempt.runId !== runId ||
      attempt.stage !== task.stage ||
      attempt.status !== "running"
    )
      throw new FactoryError("factoryRunMismatch");
    return task;
  }
  return null;
}
