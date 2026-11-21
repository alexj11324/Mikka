import type { Pool } from 'pg'
import { supportedModelEfforts } from './model-routing'
import { parseRunSettings, type TaskRunSettings } from './task-run-settings-schema'
import type { WorkerModelDispatch } from './agent-kit/worker'

export { parseRunSettings, taskRunSettingsSchema, type TaskRunSettings } from './task-run-settings-schema'

/** The run settings of an authenticated request event of this person, or none. */
export async function requestedRunSettings(executor: Pick<Pool, 'query'>, userId: string, eventId: string | undefined | null): Promise<TaskRunSettings> {
  if (!eventId) return {}
  const { rows: [row] } = await executor.query<{ run: unknown }>(`SELECT payload->'taskCommand'->'run' AS run FROM coordinator_events
    WHERE id=$1 AND "userId"=$2 AND kind='user_message'`, [eventId, userId])
  return storedRunSettings(row?.run, eventId)
}

/** Settings read back from a stored request: a field that does not fit is dropped alone, and logged by name. */
export function storedRunSettings(raw: unknown, eventId?: string | null): TaskRunSettings {
  const { settings, dropped } = parseRunSettings(raw)
  if (dropped.length) console.warn('task_run_settings_dropped', { fields: dropped, ...(eventId ? { eventId } : {}) })
  return settings
}

/** The requested effort on the run's model dispatch, when that model takes it; otherwise the dispatch as it was. */
export function withRequestedEffort(dispatch: WorkerModelDispatch, settings: TaskRunSettings, model: string): WorkerModelDispatch {
  const effort = settings.model?.effort
  const harness = dispatch.entry?.harness
  if (!effort || !harness || !supportedModelEfforts(model, harness).includes(effort)) return dispatch
  return { ...dispatch, effort }
}
