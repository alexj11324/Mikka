import type { PoolClient } from "pg";
import type { z } from "zod";
import type {
  bindingSchema,
  candidateSchema,
  evidenceSchema,
} from "./approval-contract";

/** Consumer views only. #192 owns persistence, stages, transitions and fences. */
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
