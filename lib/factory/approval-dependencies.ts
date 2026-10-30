import type { PoolClient } from "pg";
import type { z } from "zod";
import type {
  bindingSchema,
  candidateSchema,
  evidenceSchema,
} from "./approval-contract";

/** Consumer views only; no stage/state implementation. #192's lifecycle store
 * supplies this port. Its third argument is botId; lifecycle is the fourth.
 * The older intake-only store cannot perform finish/advance. */
export interface FactoryCandidate extends z.infer<typeof candidateSchema> {
  id: string;
}
export interface FactoryTask extends Omit<
  z.infer<typeof bindingSchema>,
  "taskId"
> {
  id: string;
  userId: string;
  stage: string;
  status: string;
}
export type FactoryAuthorize = (
  userId: string,
  issueId: string,
  tx: PoolClient,
) => Promise<boolean>;
export type FactoryGate = (
  tx: PoolClient,
  task: FactoryTask,
  attempt: unknown,
  change: { output: unknown; evidence: unknown },
) => Promise<boolean>;
export interface FactoryApprovalStore {
  /** #192 owns task/issue locks and live owner, Bot and source-event checks. */
  lockTask(
    tx: PoolClient,
    userId: string,
    taskId: string,
  ): Promise<FactoryTask>;
  apply(
    userId: string,
    binding: z.infer<typeof bindingSchema>,
    eventId: string,
    change:
      | {
          action: "finish";
          status: "passed" | "failed";
          reason: string;
          evidence: z.infer<typeof evidenceSchema>[];
          output: Record<string, unknown>;
        }
      | { action: "advance"; stage: "publish"; reason: string }
      | { action: "repair"; reason: string },
    tx: PoolClient,
  ): Promise<{ task: FactoryTask }>;
}
