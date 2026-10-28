import { personalMessagePacket } from './personal-agent-message'

/** Values below are projected ONLY from authenticated actor / DB rows. */
export interface StoredPersonalPeer {
  id: string
  senderMailboxId: string | null
  text: string
  createdAt?: Date | string | null
  deliveredAt?: Date | string | null
  acknowledgedAt?: Date | string | null
  sourceRunId?: string | null
}
function timestamp(value: Date | string | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : value ?? null
}
export function personalPeerText(row: StoredPersonalPeer): string {
  // Old result records can have a run but no mailbox. Never use a display name.
  const sender = row.senderMailboxId ?? null
  return personalMessagePacket({
    messageId: row.id, senderId: sender, sourceSessionId: sender,
    replyToSessionId: row.senderMailboxId, origin: 'peer_agent',
    taskId: null, runId: row.sourceRunId ?? null,
    // Inbox delivery/ACK do not establish execution or approval.
    deliveryState: row.acknowledgedAt ? 'acknowledged' : row.deliveredAt ? 'delivered' : 'queued',
    sentAt: timestamp(row.createdAt), receivedAt: timestamp(row.deliveredAt),
    pendingCount: null, // Batch size is not the total pending count.
  }, row.text)
}
export function presentPersonalInboxRow<T extends StoredPersonalPeer & { origin: 'owner' | 'peer' }>(row: T): T {
  // An owner event is already classified by the server. A body claiming owner
  // or containing peer JSON cannot change this branch in either direction.
  if (row.origin === 'owner') return row
  if (row.origin === 'peer') return { ...row, text: personalPeerText(row) }
  throw new Error('Unknown server mailbox origin; original provenance required')
}
