import type { Pool } from "pg";
import { lockFactoryRun } from "./run-fence";
import { FactoryError } from "./contract";
import type { FactoryAuthorize } from "./store";

/** Ordinary runs retain their contract. Factory runs must have a current,
 * adopted spec/execute binding. Lock order matches cancellation: task, issue,
 * run. A retry child is not an ordinary run while adoption is pending. */
export function createExecutionClaim(pool: Pool, authorize: FactoryAuthorize) {
  return async (
    userId: string,
    deviceId: string,
    runId: string,
    leaseExpiresAt: string,
    onClaim?: (tx: import("pg").PoolClient) => Promise<void>,
  ) => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const task = await lockFactoryRun(tx, userId, runId, ["spec", "execute"]);
      if (task) {
        if (!(await authorize(userId, task.issueId, tx)))
          throw new FactoryError("factoryNotFound");
        const {
          rows: [run],
        } = await tx.query(
          `SELECT "issueId" FROM agent_runs WHERE id=$1 FOR UPDATE`,
          [runId],
        );
        if (!run || run.issueId !== task.issueId)
          throw new FactoryError("factoryRunMismatch");
      }
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$4,"updatedAt"=now()
         WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3 AND status='queued' AND "stopRequestedAt" IS NULL
           AND ("mailboxId" IS NULL OR EXISTS (SELECT 1 FROM session_mailboxes m WHERE m.id=agent_runs."mailboxId" AND NOT m.disabled)) RETURNING id`,
        [runId, userId, deviceId, leaseExpiresAt],
      );
      if (rows.length) await onClaim?.(tx);
      await tx.query("COMMIT");
      return rows;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  };
}
