import { personalMessagePacket } from './personal-agent-message'

/** Server call-site classification, never taken from tool/user input JSON.
 * Existing forwarding has no authenticated source session or reply route. */
export function personalRunMessageText(id: string, text: string, origin: 'user' | 'peer'): string {
  if (origin === 'user') return text
  if (origin !== 'peer') throw new Error('Unknown server message origin')
  return personalMessagePacket({ messageId: id, senderId: null, origin: 'peer_agent',
    taskId: null, runId: null, deliveryState: 'queued', sourceSessionId: null,
    replyToSessionId: null, sentAt: null, receivedAt: null, pendingCount: null,
  }, text)
}
