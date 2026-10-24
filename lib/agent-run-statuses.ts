// The one place that says which agent_runs statuses are "not finished yet".
// Two names because two questions are asked, not two definitions:

/** Every status before a terminal one: the run still holds a lease and counts as in flight. */
export const UNFINISHED_RUN_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const

/** Unfinished and already picked up by a device: an agent is working on it now. `queued` is excluded. */
export const WORKING_RUN_STATUSES = UNFINISHED_RUN_STATUSES.filter(
  (status): status is Exclude<(typeof UNFINISHED_RUN_STATUSES)[number], 'queued'> => status !== 'queued',
)
