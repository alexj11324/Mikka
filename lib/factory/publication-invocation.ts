import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { FactoryError } from "./approval-contract";
import {
  factoryDecisionScope,
  type FactoryDecisionScope,
} from "./policy-authorization";
import { digest } from "./evidence";
import { factoryPublicationJudgment } from "./decision-execution";

export interface FactoryDecisionContext {
  text: string;
  images?: readonly {
    dataUrl: string;
    detail?: "low" | "high" | "auto" | "original";
  }[];
  requiresVisual?: boolean;
}
export interface FactoryPublicationQuestion {
  type: "choice";
  name: string;
  instructions: string;
  choices: { value: string; description?: string }[];
}
/** Inject the ACTUAL shared #193 invokeDecision/decisionRequestInput exports.
 * This adapter owns no model endpoint, key, fallback, budget or provider client.
 * A caller cannot supply a result/receipt for this producer to bless later. */
export interface FactoryPublicationDecisionTransport {
  modelId: string;
  serializeInput(input: FactoryDecisionContext): unknown;
  invokeDecision(
    purpose: string,
    input: FactoryDecisionContext,
    questions: FactoryPublicationQuestion[],
  ): Promise<{
    answers: ReadonlyMap<string, unknown>;
    execution: unknown;
  } | null>;
}
declare const invocationBrand: unique symbol;
export interface FactoryPublicationInvocation {
  readonly [invocationBrand]: true;
}
const executorSchema = z
  .object({
    runId: z.uuid(),
    sessionId: z.string().min(1).max(2000),
    assignmentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    instructionsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    policyId: z.string().min(1).max(2000),
    policyRevision: z.string().min(1).max(2000),
  })
  .strict();
/** Derived from authenticated locked run/policy rows, never model JSON. */
export type FactoryPublicationExecutorContext = z.infer<typeof executorSchema>;
interface RetainedInvocation {
  scopeDigest: string;
  executorDigest: string;
  requestDigest: string;
  questionDigest: string;
  modelId: string;
  judgment: NonNullable<ReturnType<typeof factoryPublicationJudgment>>;
}
const retained = new WeakMap<
  FactoryPublicationInvocation,
  RetainedInvocation
>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Freeze the full request/scope BEFORE the real shared transport invocation.
 * Exact serialized bytes include action/target/environment/candidate/expiry,
 * evidence digest, original observations, submitted images and fixed question.
 * Result provenance is held behind an unforgeable in-process handle. The issuer
 * may only consume that handle; JSON or a result from another scope cannot be
 * rebound by attaching the current scope after the call. */
export async function invokeFactoryPublicationDecision(
  scopeInput: FactoryDecisionScope,
  executorInput: FactoryPublicationExecutorContext,
  observations: {
    text: string;
    images?: FactoryDecisionContext["images"];
    requiresVisual: boolean;
  },
  transport: FactoryPublicationDecisionTransport,
): Promise<FactoryPublicationInvocation | null> {
  const scope = freeze(factoryDecisionScope.parse(scopeInput));
  const executor = freeze(executorSchema.parse(executorInput));
  const text = observations.text,
    requiresVisual = observations.requiresVisual,
    modelId = transport.modelId;
  if (
    typeof text !== "string" ||
    text.length > 200000 ||
    typeof requiresVisual !== "boolean" ||
    !modelId
  )
    throw new FactoryError("factoryPolicyModelEvidenceUnavailable");
  const images = structuredClone(observations.images ?? []);
  const input: FactoryDecisionContext = freeze({
    text: JSON.stringify({
      contract: "factory-publication-decision.v1",
      scope,
      executor,
      observations: text,
    }),
    images,
    requiresVisual,
  });
  const questions: FactoryPublicationQuestion[] = freeze([
    {
      type: "choice",
      name: "evidence_requirement",
      instructions:
        "Judge whether this exact task/publication scope needs visual evidence to verify its behavior. Choose visual_required for appearance, browser/user-flow or other visual claims; choose text_sufficient only when the canonical text artifacts suffice. Missing images never establish text sufficiency.",
      choices: [{ value: "text_sufficient" }, { value: "visual_required" }],
    },
    {
      type: "choice",
      name: "publication",
      instructions:
        "Judge the exact supplied publication scope and observations. Select publish_current only for that scope, or defer. This answer grants no execution permission.",
      choices: [{ value: "publish_current" }, { value: "defer" }],
    },
  ]);
  // Actual shared serializer validates image bytes/formats/budgets. This is the
  // same JSON field order used by its invokeDecision(), not a post-call label.
  const body = JSON.stringify({
    model: modelId,
    input: transport.serializeInput(input),
    questions,
  });
  const imageDigests = images.map((image) =>
    sha(
      Buffer.from(
        image.dataUrl.slice(image.dataUrl.indexOf(",") + 1),
        "base64",
      ),
    ),
  );
  if (digest(imageDigests) !== digest(scope.visualEvidenceDigests))
    throw new FactoryError("factoryPolicyModelEvidenceUnavailable");
  const requestDigest = sha(body),
    scopeDigest = digest(scope),
    questionDigest = digest(questions);
  const startedAfter = new Date().toISOString();
  const result = await transport.invokeDecision(
    "factory-publication",
    input,
    questions,
  );
  const observedAt = new Date().toISOString();
  const requirement = z
    .object({
      type: z.literal("choice"),
      name: z.literal("evidence_requirement"),
      choice: z.enum(["text_sufficient", "visual_required"]),
    })
    .passthrough()
    .safeParse(result?.answers.get("evidence_requirement"));
  if (!requirement.success) return null;
  const visualRequired =
    requiresVisual || requirement.data.choice === "visual_required";
  if (visualRequired && !images.length) return null;
  const judgment = factoryPublicationJudgment(result, {
    modelId,
    requestDigest,
    imageDigests,
    requiresVisual: visualRequired,
    scopeDigest,
    evidenceDigest: scope.evidenceDigest,
    startedAfter,
    observedAt,
  });
  if (!judgment) return null;
  const handle = Object.freeze({}) as FactoryPublicationInvocation;
  retained.set(
    handle,
    freeze({
      scopeDigest,
      executorDigest: digest(executor),
      requestDigest,
      questionDigest,
      modelId,
      judgment,
    }),
  );
  return handle;
}

/** Mechanical proof lookup only. Does not call a model or choose an action. */
export function readFactoryPublicationInvocation(
  handle: FactoryPublicationInvocation,
  scope: FactoryDecisionScope,
  modelId: string,
  executor: FactoryPublicationExecutorContext,
) {
  const row = retained.get(handle);
  if (
    !row ||
    row.scopeDigest !== digest(factoryDecisionScope.parse(scope)) ||
    row.modelId !== modelId ||
    row.executorDigest !== digest(executorSchema.parse(executor))
  )
    throw new FactoryError("factoryPolicyModelEvidenceUnavailable");
  return row;
}
