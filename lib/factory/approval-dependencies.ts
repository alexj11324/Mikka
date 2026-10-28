import type { PoolClient } from "pg";
import type { z } from "zod";
import type {
  bindingSchema,
  candidateSchema,
  evidenceSchema,
} from "./approval-contract";

/** Required consumer lifecycle views only; no stage/state implementation.
 * The current #192 intake store uses botId as its third argument and rejects
 * finish/advance. It is not a drop-in implementation of this port.
 * A coordinated adapter must preserve #192 bot/source/owner/fence checks. */
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
  apply(
    userId: string,
    binding: z.infer<typeof bindingSchema>,
    eventId: string,
    change:
      | {
          action: "finish";
          status: "passed";
          reason: string;
          evidence: z.infer<typeof evidenceSchema>[];
          output: Record<string, unknown>;
        }
      | { action: "advance"; stage: "publish"; reason: string },
    tx: PoolClient,
  ): Promise<{ task: FactoryTask }>;
}
