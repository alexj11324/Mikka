import type { Pool, PoolClient } from "pg";
import { FactoryError } from "./contract";
import type { FactoryAuthorize } from "./store";

/** Ordinary runs retain their contract. Factory runs must have a current,
 * adopted spec/execute binding. Lock order matches cancellation: task, issue,
 * run. A retry child is not an ordinary run while adoption is pending. */
export function createExecutionClaim(pool: Pool, authorize: FactoryAuthorize) {
  const guard=createExecutionClaimGuard(authorize);
  return async (
    userId: string,
    deviceId: string,
    runId: string,
    leaseExpiresAt: string,
  ) => {
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await guard(tx,userId,runId);
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$4,"updatedAt"=now()
         WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3 AND status='queued' AND "stopRequestedAt" IS NULL RETURNING id`,
        [runId, userId, deviceId, leaseExpiresAt],
      );
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

/** Same existing Factory lineage fence, with caller-owned transaction/CAS. */
export function createExecutionClaimGuard(authorize:FactoryAuthorize){
  return async(tx:PoolClient,userId:string,runId:string)=>{
      const { rows: tasks } = await tx.query(
        `WITH RECURSIVE lineage AS (
          SELECT id,"retryOf" FROM agent_runs WHERE id=$1
          UNION SELECT r.id,r."retryOf" FROM agent_runs r JOIN lineage l ON r.id=l."retryOf"
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
          !["spec", "execute"].includes(task.stage)
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
  };
}
