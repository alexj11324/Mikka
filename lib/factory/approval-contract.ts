import { z } from "zod";
import { bindingSchema, candidateSchema } from "./contract";

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
    // Returned by the authenticated evidence read, never an agent's assertion.
    evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceReadId: z.uuid(),
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
