import { z } from "zod";
import { runQuestion, RUN_QUESTION_KINDS } from "@mikka/protocol/run";
import { bindingSchema } from "../contract";

export const FACTORY_QUESTION_VERSION = 1 as const;
export const QUESTION_KINDS = RUN_QUESTION_KINDS;
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
export const PENDING_QUESTION_STATUSES = ["open", "waiting_user", "resuming", "blocked"] as const satisfies readonly (typeof QUESTION_STATUSES)[number][];
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
const text = z.string().trim().min(1).max(4000);

/** Agent hand-in only; ownership and the session are derived from the actual run. */
export const questionHandoffSchema = runQuestion;
export type QuestionHandoff = z.infer<typeof questionHandoffSchema>;

export const questionReferenceSchema = z
  .object({
    questionId: z.uuid().transform(value => value.toLowerCase()),
    questionRevision: z.number().int().positive(),
    binding: bindingSchema,
    originRunId: z.uuid().transform(value => value.toLowerCase()),
    originSessionId: z.string().min(1).max(1000),
  })
  .strict();
export type QuestionReference = z.infer<typeof questionReferenceSchema>;

export const questionFactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("issue"), quote: text }).strict(),
  z
    .object({
      kind: z.literal("request"),
      sourceEventId: z.uuid().transform(value => value.toLowerCase()),
      quote: text,
    })
    .strict(),
]);
export type QuestionFact = z.infer<typeof questionFactSchema>;

// Separate adapters select these schemas. A model cannot supply an actor/source flag.
export const humanQuestionAnswerSchema = z
  .object({
    reference: questionReferenceSchema,
    answerId: z.uuid().transform(value => value.toLowerCase()),
    text,
    sourceEventId: z.uuid().transform(value => value.toLowerCase()).optional(),
  })
  .strict();
export const contextQuestionAnswerSchema = z
  .object({
    reference: questionReferenceSchema,
    answerId: z.uuid().transform(value => value.toLowerCase()),
    facts: z.array(questionFactSchema).min(1).max(10),
  })
  .strict();
export type HumanQuestionAnswer = z.infer<typeof humanQuestionAnswerSchema>;
export type ContextQuestionAnswer = z.infer<typeof contextQuestionAnswerSchema>;

export const questionEscalationSchema = z
  .object({
    reference: questionReferenceSchema,
    eventId: z.uuid().transform(value => value.toLowerCase()),
    reason: text,
  })
  .strict();

/** Explicit owner recovery has its own idempotency key; it never re-answers. */
export const questionRecoverySchema = z.object({
  requestId: z.uuid().transform(value => value.toLowerCase()),
  expectedFailedRunId: z.uuid().transform(value => value.toLowerCase()),
  reference: questionReferenceSchema,
}).strict();
