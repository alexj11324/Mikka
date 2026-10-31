// Harness ids: an agent is identified only by its harness (Claude Code,
// Codex, Cursor, or the mock). Must match `agent.harness` in packages/db.
import { z } from "zod"

export const HARNESSES = ["claude_code", "codex", "cursor", "mock"] as const
export const harnessSchema = z.enum(HARNESSES)
export type Harness = z.infer<typeof harnessSchema>

/** One harness CLI as detected on a device. */
export const harnessInfoSchema = z.object({
  harness: harnessSchema,
  installed: z.boolean(),
  models: z.array(z.string().trim().min(1).max(128)).max(500).optional(),
  modelSlots: z
    .array(
      z.object({
        slot: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .refine((v) => v !== "auto"),
        model: z.string().trim().min(1).max(128),
        name: z.string().trim().min(1).max(200),
      }),
    )
    .max(500)
    .optional(),
  defaultModelSlot: z.string().trim().min(1).max(128).optional(),
  /** Deprecated (#312, 2026-10-27): could host the native Coordinator. The server keeps that runtime switched off. */
  coordinator: z.boolean().optional(),
  /** Set only by a runner with an isolated, owner-bound subscription broker. */
  subscriptionBroker: z.literal(true).optional(),
  /** Set only by an E2B worker with the guarded Bot computer broker. */
  computerBroker: z.literal(true).optional(),
  /** Run-scoped CLI approvals and policy-version checks are supported. */
  toolApproval: z.literal(true).optional(),
  /** Version string reported by the CLI, null when not installed. */
  version: z.string().nullable(),
})
export type HarnessInfo = z.infer<typeof harnessInfoSchema>
