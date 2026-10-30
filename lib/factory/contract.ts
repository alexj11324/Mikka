import { z } from "zod";

export const FACTORY_CONTRACT_VERSION = 1 as const;
export const FACTORY_STAGES = [
  "clarify",
  "spec",
  "execute",
  "review",
  "verify",
  "approval",
  "publish",
  "monitor",
] as const;
export const FACTORY_STATUSES = [
  "pending",
  "running",
  "waiting",
  "passed",
  "failed",
  "blocked",
  "cancelled",
  "revoked",
] as const;
export type FactoryStage = (typeof FACTORY_STAGES)[number];
export type FactoryStatus = (typeof FACTORY_STATUSES)[number];
const canonicalUuid = z.uuid().transform((value) => value.toLowerCase());
const reason = z.string().trim().min(1).max(4000);
export const routeSchema = z
  .object({
    issueId: canonicalUuid,
    eventId: canonicalUuid,
    // The source is an existing authenticated Coordinator event, not a new inbox.
    sourceEventId: canonicalUuid,
    rationale: reason,
    missingInformation: z.array(reason).max(20).default([]),
    missingPermissions: z.array(reason).max(20).default([]),
    needsSpec: z.boolean().default(false),
  })
  .strict();
export type FactoryRoute = z.infer<typeof routeSchema>;
export function routeStage(
  route: Pick<
    FactoryRoute,
    "missingInformation" | "missingPermissions" | "needsSpec"
  >,
): FactoryStage {
  return route.missingInformation.length || route.missingPermissions.length
    ? "clarify"
    : route.needsSpec
      ? "spec"
      : "execute";
}
export const bindingSchema = z
  .object({
    taskId: canonicalUuid,
    issueId: canonicalUuid,
    attemptId: canonicalUuid,
    revision: z.number().int().positive(),
    candidateId: canonicalUuid.nullable(),
  })
  .strict();
export type FactoryBinding = z.infer<typeof bindingSchema>;
/** Request fence. taskId identifies the owned task; every lifecycle change
 * increments revision. Legacy display fields are accepted but not authority. */
export const revisionBindingSchema = z.object({
  taskId: canonicalUuid,
  revision: z.number().int().positive(),
});
export type FactoryRevisionBinding = z.infer<typeof revisionBindingSchema>;
export type FactoryBindingInput = FactoryRevisionBinding & Partial<Omit<FactoryBinding, keyof FactoryRevisionBinding>>;
export const candidateSchema = z
  .object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    repository: reason,
    environment: reason,
    scope: reason,
  })
  .strict();
export const evidenceSchema = z
  .object({
    // References to existing, access controlled artifacts. No embedded logs or credentials.
    artifact: z.string().min(1).max(2000),
    kind: z.enum(["log", "report", "screenshot", "video", "request"]),
    runId: canonicalUuid,
    sessionId: z.string().min(1).max(1000),
    candidateId: canonicalUuid.nullable(),
    sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    environment: reason,
    recordedAt: z.iso.datetime(),
  })
  .strict();
export type FactoryEvidence = z.infer<typeof evidenceSchema>;
export const changeSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("adopt_retry"), runId: canonicalUuid, reason })
    .strict(),
  z
    .object({
      action: z.literal("resolve"),
      sourceEventId: canonicalUuid,
      rationale: reason,
      missingInformation: z.array(reason).max(20),
      missingPermissions: z.array(reason).max(20),
      needsSpec: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal("bind_run"), runId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("candidate"),
      candidate: candidateSchema,
      runId: canonicalUuid,
    })
    .strict(),
  z
    .object({
      action: z.literal("finish"),
      status: z.enum(["passed", "failed", "blocked", "waiting"]),
      reason,
      evidence: z.array(evidenceSchema).max(100).default([]),
      output: z.record(z.string(), z.unknown()).default({}),
    })
    .strict(),
  z
    .object({
      action: z.literal("advance"),
      stage: z.enum(FACTORY_STAGES),
      reason,
    })
    .strict(),
  z.object({ action: z.literal("retry"), reason }).strict(),
  z.object({ action: z.literal("retry_publication"), publicationId: canonicalUuid, reason }).strict(),
  z.object({ action: z.literal("repair"), reason }).strict(),
  z.object({ action: z.literal("cancel"), reason }).strict(),
  z.object({ action: z.literal("revoke"), reason }).strict(),
]);
export type FactoryChange = z.infer<typeof changeSchema>;
export class FactoryError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function nextStage(stage: FactoryStage): FactoryStage | undefined {
  return FACTORY_STAGES[FACTORY_STAGES.indexOf(stage) + 1];
}
