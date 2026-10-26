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
  /** This daemon can host a Mikka personal Coordinator on this harness. */
  coordinator: z.boolean().optional(),
  /** Version string reported by the CLI, null when not installed. */
  version: z.string().nullable(),
})
export type HarnessInfo = z.infer<typeof harnessInfoSchema>
