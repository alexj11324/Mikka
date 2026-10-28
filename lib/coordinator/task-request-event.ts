/** Host selects a source only from this claimed inbox, never model prose. */
export function taskRequestEventId(events: readonly { id: string; kind: string; payload: Record<string, unknown> }[]): string | null | undefined {
  const users = events.filter(event => event.kind === 'user_message')
  const targeted = users.filter(event => {
    const destination = event.payload.taskDestination
    return Boolean(destination && typeof destination === 'object' && (destination as { kind?: unknown }).kind === 'device')
  })
  return targeted.length ? users.length === 1 && targeted.length === 1 ? targeted[0].id : null : undefined
}
