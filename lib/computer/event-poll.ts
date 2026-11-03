/** While events are arriving, look again quickly. An idle stream waits longer: each empty poll is still a database read. */
export const COMPUTER_EVENT_ACTIVE_MS = 1_000
export const COMPUTER_EVENT_IDLE_MS = 8_000

export function computerEventPollDelay(rowCount: number): number {
  return rowCount > 0 ? COMPUTER_EVENT_ACTIVE_MS : COMPUTER_EVENT_IDLE_MS
}
