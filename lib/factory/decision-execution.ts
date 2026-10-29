import { z } from "zod";
import { FactoryError } from "./approval-contract";
import { digest } from "./evidence";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Structural consumer of the actual shared #331/#193 DecisionExecution.
 * This defines no model caller, capability registry, permission or receipt issuer. */
export const factoryDecisionExecution = z
  .object({
    executionId: z.uuid(),
    modelId: z.string().min(1).max(200),
    providerGenerationId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    requestDigest: hash,
    imageDigests: z.array(hash).max(8),
    vision: z.enum(["image-input-submitted", "no-image-input"]),
  })
  .strict();
export type FactoryDecisionExecution = z.infer<typeof factoryDecisionExecution>;
export interface FactoryDecisionExpectation {
  /** Actual host-selected vision-capable model and serialized request digest,
   * ordered submitted image-byte hashes, not values from model/tool JSON. */
  modelId: string;
  requestDigest: string;
  imageDigests: readonly string[];
  requiresVisual: boolean;
  scopeDigest: string;
  evidenceDigest: string;
  startedAfter: string;
  observedAt: string;
}

export function factoryDecisionExecutionMatches(
  raw: unknown,
  expected: FactoryDecisionExpectation,
) {
  const parsed = factoryDecisionExecution.safeParse(raw);
  if (!parsed.success) return false;
  const e = parsed.data;
  return (
    e.modelId === expected.modelId &&
    e.requestDigest === expected.requestDigest &&
    digest(e.imageDigests) === digest(expected.imageDigests) &&
    e.vision ===
      (e.imageDigests.length ? "image-input-submitted" : "no-image-input") &&
    (!expected.requiresVisual || e.imageDigests.length > 0) &&
    Date.parse(e.startedAt) >= Date.parse(expected.startedAfter) &&
    Date.parse(e.completedAt) >= Date.parse(e.startedAt) &&
    Date.parse(e.completedAt) <= Date.parse(expected.observedAt)
  );
}

/** Consume the shared invokeDecision() result's actual Map/host receipt. The
 * model selects publish_current/defer; confidence is not a program threshold.
 * This produces semantic evidence only, never allow/ask/deny or permission.
 * Caller is trusted host code holding the actual invocation result, not JSON. */
export function factoryPublicationJudgment(
  result: { answers: ReadonlyMap<string, unknown>; execution: unknown } | null,
  expected: FactoryDecisionExpectation,
) {
  if (typeof result?.answers?.get !== "function") return null;
  const answer = result?.answers?.get("publication");
  const parsed = z
    .object({
      type: z.literal("choice"),
      name: z.literal("publication"),
      choice: z.enum(["publish_current", "defer"]),
    })
    .passthrough()
    .safeParse(answer);
  if (!parsed.success || parsed.data.choice === "defer") return null;
  if (!factoryDecisionExecutionMatches(result?.execution, expected))
    throw new FactoryError("factoryPolicyModelEvidenceUnavailable");
  const execution = factoryDecisionExecution.parse(result!.execution);
  return {
    receiptId: execution.executionId,
    model: execution.modelId,
    capability: "vision" as const,
    visualInputRequired: expected.requiresVisual,
    scopeDigest: expected.scopeDigest,
    evidenceDigest: expected.evidenceDigest,
    imageDigests: [...execution.imageDigests],
    choice: "publish_current" as const,
    requestDigest: expected.requestDigest,
    execution,
  };
}
