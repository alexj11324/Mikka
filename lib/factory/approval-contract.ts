import { z } from "zod";

const reason = z.string().trim().min(1).max(4000);

export const bindingSchema = z
  .object({
    taskId: z.uuid(),
    issueId: z.uuid(),
    attemptId: z.uuid(),
    revision: z.number().int().positive(),
    candidateId: z.uuid().nullable(),
  })
  .strict();
export type FactoryBinding = z.infer<typeof bindingSchema>;
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
    runId: z.uuid(),
    sessionId: z.string().min(1).max(1000),
    candidateId: z.uuid().nullable(),
    sha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    environment: reason,
    recordedAt: z.iso.datetime(),
  })
  .strict();
export type FactoryEvidence = z.infer<typeof evidenceSchema>;

export class FactoryError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// Additive consumer contract: stage/candidate ownership remains #192's source.
export const publicationAction = z.enum([
  "deploy_preview",
  "deploy_production",
  "merge",
]);
export const approvalRequest = z
  .object({
    binding: bindingSchema,
    eventId: z.uuid(),
    candidate: candidateSchema,
    action: publicationAction,
    target: z.string().trim().min(1).max(2000),
    targetEnvironment: z.string().trim().min(1).max(4000),
    expiresAt: z.iso.datetime(),
    // Returned by the authenticated evidence read, never an agent's assertion.
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceReadId: z.uuid(),
    // Opaque reference to the existing host policy authority, not an LLM claim.
    // Optional only for historical receipt parsing; new grants require it.
    decisionCredentialId: z.string().min(1).max(2000).optional(),
  })
  .strict();
export const approvalControl = z
  .object({
    binding: bindingSchema,
    eventId: z.uuid(),
    approvalId: z.uuid(),
  })
  .strict();
export const publicationRequest = approvalControl
  .extend({
    action: publicationAction,
    target: z.string().trim().min(1).max(2000),
    targetEnvironment: z.string().trim().min(1).max(4000),
  })
  .strict();

/** Constructed only by the browser-session adapter, never from JSON/tool input. */
export interface FactoryHuman {
  userId: string;
  sessionId: string;
}
/** Authenticated host principal. A browser supplies its real session; an
 * existing backend transport supplies its authorized owner. Never JSON input. */
export interface FactoryActor {
  userId: string;
  sessionId?: string;
}
