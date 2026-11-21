import { z } from 'zod'
import { MODEL_ROUTING_EFFORTS } from './model-routing'
import { MACHINE_SIZES, type MachineSize } from './cloud-computer/machine-pricing'
import { workVisibilitySchema } from '@mikka/protocol/work-visibility'

// Kept free of server imports: the task commands that carry it (lib/task-create-command.ts) are shared with the
// mobile and web clients. The server reads it back through lib/task-run-settings.ts.
/**
 * How a dispatched task's new thread is set up, beyond the request itself: chosen by an automation (or another host
 * command) and stored on the request event's `taskCommand.run`. The run-creation paths read it from that authenticated
 * event, never from the dispatching model's tool input.
 */
export const taskRunSettingsSchema = z.strictObject({
  /** An authenticated choice for this new root thread, never a model tool argument. */
  visibility: workVisibilitySchema.optional(),
  /** The workspace Environment the run uses instead of its Project's default. */
  environmentId: z.uuid().optional(),
  /** The model the run asks for, and its reasoning effort. */
  model: z.strictObject({ id: z.string().trim().min(1).max(200), effort: z.enum(MODEL_ROUTING_EFFORTS).optional() }).optional(),
  /** The Cloudflare machine size; else the Environment's default, else Mikka's. */
  machineSize: z.enum(Object.keys(MACHINE_SIZES) as [MachineSize, ...MachineSize[]]).optional(),
  /** Pin the new thread for its owner. */
  pin: z.literal(true).optional(),
})
export type TaskRunSettings = z.infer<typeof taskRunSettingsSchema>

const RUN_SETTING_FIELDS = Object.keys(taskRunSettingsSchema.shape) as (keyof TaskRunSettings)[]
/**
 * A stored request's run settings, field by field: a field that does not fit (an older or hand-edited event) is left
 * out and named in `dropped`, and the rest still apply. Anything that is not an object is no settings.
 */
export function parseRunSettings(raw: unknown): { settings: TaskRunSettings; dropped: string[] } {
  if (raw === undefined || raw === null) return { settings: {}, dropped: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { settings: {}, dropped: ['run'] }
  const settings: Record<string, unknown> = {}, dropped: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    const field = (RUN_SETTING_FIELDS as string[]).includes(key) ? taskRunSettingsSchema.shape[key as keyof TaskRunSettings] : undefined
    const parsed = field?.safeParse(value)
    if (parsed?.success) { if (parsed.data !== undefined) settings[key] = parsed.data }
    else dropped.push(key)
  }
  return { settings: settings as TaskRunSettings, dropped }
}
