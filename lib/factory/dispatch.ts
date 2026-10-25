import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { bindingSchema, FactoryError } from "./contract";
import type { createFactoryStore } from "./store";
import type { DispatchInput, DispatchResult } from "../run-dispatch";

export const factoryDispatchSchema = z
  .object({
    binding: bindingSchema,
    agentId: z.uuid(),
    deviceRepoId: z.uuid(),
    note: z.string().trim().max(10000).optional(),
  })
  .strict();
export type FactoryDispatchInput = z.infer<typeof factoryDispatchSchema>;
export type QueueFactoryRun = (
  tx: PoolClient,
  userId: string,
  input: DispatchInput,
) => Promise<DispatchResult>;
/** Same transaction: task lock, #191 request+issue locks, queue, binding and ledger. */
export function createFactoryDispatch(
  pool: Pool,
  store: ReturnType<typeof createFactoryStore>,
  queue: QueueFactoryRun,
) {
  return async (userId: string, input: FactoryDispatchInput) => {
    const parsed = factoryDispatchSchema.safeParse(input);
    if (!parsed.success) throw new FactoryError("factoryInvalid");
    const { binding, agentId, deviceRepoId, note } = parsed.data;
    const eventId = binding.attemptId; // stable per attempt, including durable-step replay
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await store.lockForDispatch(userId, binding, eventId, tx);
      const run = await queue(tx, userId, {
        issueId: binding.issueId,
        agentId,
        deviceRepoId,
        note,
        requestKey: `factory:${binding.taskId}:${binding.attemptId}`,
      });
      const state = await store.apply(
        userId,
        binding,
        eventId,
        { action: "bind_run", runId: run.runId },
        tx,
      );
      await tx.query("COMMIT");
      return { ...run, ...state };
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  };
}
