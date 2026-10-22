// Harness ids: an agent is identified only by its harness (Claude Code,
// Codex, Cursor, or the mock). Must match `agent.harness` in packages/db.
import { z } from "zod"

export const HARNESSES = ["claude_code", "codex", "cursor", "mock"] as const
export const harnessSchema = z.enum(HARNESSES)
export type Harness = z.infer<typeof harnessSchema>

/**
 * One model a harness CLI offers, as the CLI itself lists it (the Claude
 * Agent SDK's `supportedModels()`, Codex app-server's `model/list`).
 * `value` is what the CLI takes as its model; `efforts` are the reasoning
 * effort levels it accepts for that model, lowest first, empty when it has
 * none.
 */
export const harnessModelSchema = z.object({
  value: z.string().min(1).max(200),
  displayName: z.string().max(200),
  efforts: z.array(z.string().min(1).max(40)).max(20),
})
export type HarnessModel = z.infer<typeof harnessModelSchema>

/** One harness CLI as detected on a device. */
export const harnessInfoSchema = z.object({
  harness: harnessSchema,
  installed: z.boolean(),
  /** Version string reported by the CLI, null when not installed. */
  version: z.string().nullable(),
  /**
   * The models the CLI reported, when the daemon could ask it. Absent from
   * older daemons and when the CLI could not be asked (not signed in, timed
   * out); the server then offers only the CLI's default.
   */
  models: z.array(harnessModelSchema).max(100).optional(),
  /**
   * The permission modes the CLI takes, as its own `--help` lists them
   * (Claude Code's `--permission-mode` choices, Codex's `--ask-for-approval`
   * values), in the CLI's order. Absent from older daemons and when the help
   * could not be read; the server then offers only Mikka's default.
   */
  permissionModes: z.array(z.string().min(1).max(40)).max(20).optional(),
})
export type HarnessInfo = z.infer<typeof harnessInfoSchema>
