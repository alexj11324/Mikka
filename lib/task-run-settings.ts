import { z } from 'zod'
import type { Pool } from 'pg'
import { MODEL_ROUTING_EFFORTS, supportedModelEfforts } from './model-routing'
import type { WorkerModelDispatch } from './agent-kit/worker'
import { MACHINE_SIZES, type MachineSize } from './cloud-computer/machine-pricing'

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

/** The run settings of an authenticated request event of this person, or none. */
export async function requestedRunSettings(executor: Pick<Pool, 'query'>, userId: string, eventId: string | undefined | null): Promise<TaskRunSettings> {
  if (!eventId) return {}
  const { rows: [row] } = await executor.query<{ run: unknown }>(`SELECT payload->'taskCommand'->'run' AS run FROM coordinator_events
    WHERE id=$1 AND "userId"=$2 AND kind='user_message'`, [eventId, userId])
  const parsed = taskRunSettingsSchema.safeParse(row?.run ?? undefined)
  return parsed.success && parsed.data ? parsed.data : {}
}

/** The requested effort on the run's model dispatch, when that model takes it; otherwise the dispatch as it was. */
export function withRequestedEffort(dispatch: WorkerModelDispatch, settings: TaskRunSettings, model: string): WorkerModelDispatch {
  const effort = settings.model?.effort
  const harness = dispatch.entry?.harness
  if (!effort || !harness || !supportedModelEfforts(model, harness).includes(effort)) return dispatch
  return { ...dispatch, effort }
}
