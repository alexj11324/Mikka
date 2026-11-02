/** A finite peer-triggered chain; an authenticated new user input starts a new root. */
export const MAILBOX_NOTIFICATION_LIMIT = 8
export function mailboxTriggerDepth(events: { kind: string; dedupeKey?: string; payload?: Record<string, unknown> }[]): number {
  if (events.some(event => event.kind === 'user_message')) return -1
  // Old report/send_to_coordinator transports are peer data too. Absence of a
  // mailbox marker cannot turn their next automatic reply into a user root.
  if (!events.length) return MAILBOX_NOTIFICATION_LIMIT
  return Math.max(...events.map(event => event.dedupeKey?.startsWith('mailbox:')
    ? boundedMailboxDepth(event.payload?.mailboxWakeDepth) : MAILBOX_NOTIFICATION_LIMIT))
}
export function boundedMailboxDepth(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= -1 && value <= MAILBOX_NOTIFICATION_LIMIT ? value : MAILBOX_NOTIFICATION_LIMIT
}
export function outgoingMailboxDepth(trigger: number | undefined): number {
  return trigger === undefined ? 0 : Math.min(MAILBOX_NOTIFICATION_LIMIT, boundedMailboxDepth(trigger) + 1)
}
export function workerMailboxTriggerDepth(parent: number | undefined, incoming?: number): number {
  // The explicit host marker is written only by a new authenticated owner
  // input. Peer mail can inherit or narrow a verified parent, never invent it.
  if (incoming === -1) return -1
  const base = boundedMailboxDepth(parent)
  return incoming === undefined ? base : Math.max(base, boundedMailboxDepth(incoming))
}
