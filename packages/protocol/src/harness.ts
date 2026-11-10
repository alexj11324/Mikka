// Harness ids: an agent is identified only by its harness (Claude Code,
// Codex, Cursor, or the mock). Must match `agent.harness` in packages/db.
import { z } from "zod"
import type { UserErrorDetail } from "./user-error-codes"

export const HARNESSES = ["claude_code", "codex", "cursor", "mock"] as const
export const harnessSchema = z.enum(HARNESSES)
export type Harness = z.infer<typeof harnessSchema>

/** Safe reasons a local subscription runner failed its startup check; never CLI output. */
export const SUBSCRIPTION_PREFLIGHT_FAILURES = ["env_not_clean", "cli_missing", "cli_version_mismatch", "adapter_start_failed"] as const satisfies readonly UserErrorDetail<"subscription_local_runtime_unavailable">[]
export const subscriptionPreflightSchema = z.enum(SUBSCRIPTION_PREFLIGHT_FAILURES)
export type SubscriptionPreflightFailure = z.infer<typeof subscriptionPreflightSchema>

/**
 * Which harness runs a model (Alex, 2026-10-31): GPT/OpenAI models run on
 * Codex; every other model (Mikka 默认, API-key and custom-provider models
 * included) runs on Claude Code. A per-model override from settings wins.
 */
export function harnessForModel(model: string, overrides: Readonly<Record<string, Harness>> = {}): Harness {
  const chosen = overrides[model]
  if (chosen) return chosen
  return /^(?:openai\/)?(?:gpt-|o\d|codex)/i.test(model.trim()) ? "codex" : "claude_code"
}

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
  /**
   * Set only by a runner that runs subscriptions under owner-bound custody:
   * the hosted runner's broker, or a device daemon that takes one run's
   * short-lived access lease (never the refresh grant) and wipes it at run end.
   */
  subscriptionBroker: z.literal(true).optional(),
  /** The broker can verify full Claude model IDs against the run's own account
   * catalogue instead of treating the CLI shortcut menu as exhaustive. */
  subscriptionModelCatalogue: z.literal(true).optional(),
  /** A failed local startup check takes precedence over a stale broker flag. Omitted after a successful recheck. */
  subscriptionPreflight: subscriptionPreflightSchema.optional(),
  /** Set only by an E2B worker with the guarded Bot computer broker. */
  computerBroker: z.literal(true).optional(),
  /** Run-scoped CLI approvals and policy-version checks are supported. */
  toolApproval: z.literal(true).optional(),
  /**
   * Thread interaction modes this runner enforces (#1730). Absent on an
   * older daemon: only Execute is admitted, never a mode it cannot enforce.
   */
  threadModes: z.array(z.enum(["plan", "execute", "ask"])).max(3).optional(),
  /**
   * The CLI exists but `installed` stays false because the daemon cannot run it
   * in a sandbox. `missing` names the absent packages; empty means the machine
   * itself refused isolation. `reason` names a refusal the person can lift
   * (`userns_restricted`: Ubuntu's AppArmor user namespace restriction), and
   * `detail` is the probe's own error, already sanitized by the daemon.
   */
  sandboxBlocked: z.object({
    missing: z.array(z.string().trim().min(1).max(64)).max(8),
    reason: z.enum(["userns_restricted"]).optional(),
    detail: z.string().max(300).optional(),
  }).optional(),
  /** Version string reported by the CLI, null when not installed. */
  version: z.string().nullable(),
})
export type HarnessInfo = z.infer<typeof harnessInfoSchema>

/**
 * Whether a harness's own report lists a model: a reported id (a CLI model
 * slot) or a slot's resolved model. Null when it reported no models at all (a
 * daemon from before the model probe, or a probe that got no answer). The one
 * rule for "this machine can run this model" (Alex, 2026-11-03: no guessing),
 * used by dispatch on the server and by the cloud daemon before a run starts.
 */
export function harnessReportsModel(info: Pick<HarnessInfo, "models" | "modelSlots">, model: string): boolean | null {
  const ids = [...(info.models ?? []), ...(info.modelSlots ?? []).flatMap((slot) => [slot.slot, slot.model])]
  return ids.length ? ids.includes(model) : null
}
