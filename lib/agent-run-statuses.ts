import { LEASED_RUN_STATUSES } from './run-retry'

/** Every nonterminal status counts as in flight; queued runs do not hold a lease. */
export const UNFINISHED_RUN_STATUSES = ['queued', ...LEASED_RUN_STATUSES] as const

/** Unfinished and already picked up by a device: an agent is working on it now. `queued` is excluded. */
export const WORKING_RUN_STATUSES = LEASED_RUN_STATUSES
