import { z } from "zod";

import { bindingSchema, candidateSchema } from "./contract";
export { bindingSchema, candidateSchema, evidenceSchema, FactoryError } from "./contract";
export type { FactoryBinding, FactoryEvidence } from "./contract";

// Additive consumer contract: stage/candidate ownership remains #192's source.
export const publicationAction = z.enum([
  "deploy_preview",
  "deploy_production",
  "merge",
  "activate_skill",
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
    // Compatibility with older clients only; human approval does not require a read receipt.
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    evidenceReadId: z.uuid().optional(),
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
/** Human "request changes": sends the exact candidate back to execute. */
export const rejectRequest = z
  .object({
    binding: bindingSchema,
    eventId: z.uuid(),
    candidateId: z.uuid(),
    note: z.string().trim().max(2000).optional(),
    // Artifact refs from the current evidence manifest the person marked as failing.
    failedEvidence: z.array(z.string().min(1).max(2000)).max(100).optional(),
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
