import { z } from 'zod'
import { MODEL_ROUTING_EFFORTS } from './model-routing'
import { MACHINE_SIZES, type MachineSize } from './cloud-computer/machine-pricing'

// Kept free of server imports: the task commands that carry it (lib/task-create-command.ts) are shared with the
// mobile and web clients. The server reads it back through lib/task-run-settings.ts.
/**
 * How a dispatched task's new thread is set up, beyond the request itself: chosen by an automation (or another host
 * command) and stored on the request event's `taskCommand.run`. The run-creation paths read it from that authenticated
 * event, never from the dispatching model's tool input.
 */
export const taskRunSettingsSchema = z.strictObject({
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
