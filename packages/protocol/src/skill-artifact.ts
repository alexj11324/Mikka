import { z } from 'zod'

/** Capability marker only, never an authorization grant or binary attestation. */
export const SKILL_ARTIFACT_HEADER = 'x-mikka-skill-artifacts'
export const skillArtifactRefSchema = z.object({
  schemaVersion: z.literal(1), registryId: z.literal('mikka-builtin'),
  skillId: z.uuid(), versionId: z.uuid(), format: z.literal('single-skill-md-v1'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export const skillAssignmentReceiptSchema = z.object({
  id: z.uuid(), runId: z.uuid(), issueId: z.uuid(), agentId: z.uuid(),
  repoId: z.uuid(), deviceId: z.uuid(), leaseExpiresAt: z.iso.datetime(),
  assignedAt: z.iso.datetime(), artifact: skillArtifactRefSchema,
}).strict()
export type SkillArtifactRef = z.infer<typeof skillArtifactRefSchema>
export type SkillAssignmentReceipt = z.infer<typeof skillAssignmentReceiptSchema>
export const skillReceiptRevalidationSchema = z.object({
  skillReceipt:skillAssignmentReceiptSchema,leaseExpiresAt:z.iso.datetime(),
}).strict()
export type SkillReceiptRevalidation = z.infer<typeof skillReceiptRevalidationSchema>
