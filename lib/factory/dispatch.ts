import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { configureFactoryCheck, factoryRepairBrief } from "./checks";
import { factoryEventId } from "./event-id";
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
      const task = await store.lockForDispatch(userId, binding, eventId, tx);
      const run = await queue(tx, userId, {
        issueId: binding.issueId,
        agentId,
        deviceRepoId,
        note,
        requestKey: `factory:${binding.taskId}:${binding.attemptId}`,
      });
      if (task.stage === "spec" && !run.replayed) {
        // Reuse the existing Harness planning run. The queue gate and caller
        // parameter fingerprint remain unchanged; the stage is server-owned.
        const {
          rows: [queued],
        } = await tx.query(
          "SELECT prompt FROM agent_runs WHERE id=$1 FOR UPDATE",
          [run.runId],
        );
        const instruction =
          "Factory stage: spec. Produce the specification needed for this request and hand in the planning output. Implementation waits for the next execute attempt.";
        await tx.query(
          "UPDATE agent_runs SET kind='plan',prompt=$2 WHERE id=$1",
          [
            run.runId,
            `${instruction}\n\n${queued.prompt.slice(0, 100000 - instruction.length - 2)}`,
          ],
        );
      }
      if (!run.replayed) {
        if (task.stage === "review" || task.stage === "verify") {
          await configureFactoryCheck(tx, task, run.runId);
        } else if (task.stage === "execute") {
          await factoryRepairBrief(tx, task, run.runId);
        }
      }
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
      // Missing authorized inputs become durable blocked state, with no orphan queue row.
      const code =
        error instanceof Error && "code" in error ? String(error.code) : null;
      if (
        [
          "factoryCheckCommandRequired",
          "factoryCheckHarnessUnavailable",
          "factoryCheckUnchangedCandidate",
          "agentNoDevice",
          "agentRepoMissing",
        ].includes(code ?? "")
      ) {
        try {
          await tx.query("BEGIN");
          await store.apply(
            userId,
            binding,
            factoryEventId("dispatch-blocked", binding.attemptId),
            {
              action: "finish",
              status: "blocked",
              reason: `Dispatch blocked: ${code}; authorized Harness/repository/verify environment required`,
              evidence: [],
              output: { dispatchError: code },
            },
            tx,
          );
          await tx.query("COMMIT");
        } catch (blockedError) {
          await tx.query("ROLLBACK");
          if (
            !(blockedError instanceof FactoryError) ||
            !["factoryStale", "factoryStopped"].includes(blockedError.code)
          )
            throw blockedError;
        }
      }
      throw error;
    } finally {
      tx.release();
    }
  };
}
