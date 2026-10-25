import { createHash } from "node:crypto";
import { z } from "zod";
import { bindingSchema } from "../contract";
import { factoryEventId } from "../event-id";

export const FACTORY_QUESTION_VERSION = 1 as const;
export const QUESTION_KINDS = [
  "context",
  "decision",
  "permission",
  "external",
] as const;
export const QUESTION_STATUSES = [
  "open",
  "waiting_user",
  "answered",
  "resuming",
  "resolved",
  "blocked",
  "cancelled",
  "expired",
  "superseded",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
const text = z.string().trim().min(1).max(4000);

/** Agent hand-in only; ownership and the session are derived from the actual run. */
export const questionHandoffSchema = z
  .object({
    questionId: z.uuid(),
    kind: z.enum(QUESTION_KINDS).default("decision"),
    question: text,
    context: z.string().trim().max(4000).optional(),
    options: z.array(text).max(20).default([]),
  })
  .strict();
export type QuestionHandoff = z.infer<typeof questionHandoffSchema>;

export const questionReferenceSchema = z
  .object({
    questionId: z.uuid(),
    questionRevision: z.number().int().positive(),
    binding: bindingSchema,
    originRunId: z.uuid(),
    originSessionId: z.string().min(1).max(1000),
  })
  .strict();
export type QuestionReference = z.infer<typeof questionReferenceSchema>;

export const questionFactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue"), quote: text }).strict(),
  z
    .object({
      kind: z.literal("request"),
      sourceEventId: z.uuid(),
      quote: text,
    })
    .strict(),
]);
export type QuestionFact = z.infer<typeof questionFactSchema>;

// Separate adapters select these schemas. A model cannot supply an actor/source flag.
export const humanQuestionAnswerSchema = z
  .object({
    reference: questionReferenceSchema,
    answerId: z.uuid(),
    text,
    sourceEventId: z.uuid().optional(),
  })
  .strict();
export const contextQuestionAnswerSchema = z
  .object({
    reference: questionReferenceSchema,
    answerId: z.uuid(),
    facts: z.array(questionFactSchema).min(1).max(10),
  })
  .strict();
export type HumanQuestionAnswer = z.infer<typeof humanQuestionAnswerSchema>;
export type ContextQuestionAnswer = z.infer<typeof contextQuestionAnswerSchema>;

export const questionEscalationSchema = z
  .object({
    reference: questionReferenceSchema,
    eventId: z.uuid(),
    reason: text,
  })
  .strict();

export function legacyQuestionId(runId: string): string {
  return factoryEventId("execution-question", z.uuid().parse(runId));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Hash canonical parsed data, including authenticated actor/source, not transport key order. */
export function questionFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function orchestratorMayAnswer(kind: QuestionKind): boolean {
  return kind === "context";
}

export function questionClosed(status: QuestionStatus): boolean {
  return ["resolved", "blocked", "cancelled", "expired", "superseded"].includes(
    status,
  );
}
