/** Agent run completion states shared by the daemon and its consumers.
 * `stopped` covers an ended turn, a question, or a blocker without success or failure. */
export const TERMINAL_RUN_STATES = ['succeeded', 'stopped', 'failed', 'cancelled'] as const
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number]

export function isTerminalRunState(value: unknown): value is TerminalRunState {
  return TERMINAL_RUN_STATES.some(state => state === value)
}
