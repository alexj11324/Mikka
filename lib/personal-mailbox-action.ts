import { z } from 'zod'
import { mailboxAck, mailboxSend } from '@mikka/protocol/mailbox'
import { MailboxError, type MailboxActor, type SessionMailbox } from './session-mailbox'

export const personalMailboxRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), ...mailboxSend.shape }).strict(),
  z.object({ action: z.literal('ack'), ...mailboxAck.shape }).strict(),
  z.object({ action: z.enum(['recipients', 'inbox', 'sent']) }).strict(),
])
/** Neither actor nor capability enablement is accepted from request JSON. */
export async function personalMailboxAction(input: unknown, dependencies: {
  enabled: boolean
  store: Pick<SessionMailbox, 'recipients' | 'send' | 'inbox' | 'ack' | 'sent'>
  actor: () => Promise<MailboxActor>
}): Promise<{ status: number; body: unknown }> {
  if (!dependencies.enabled) return { status: 503, body: { error: 'personal_mailbox_unavailable' } }
  const parsed = personalMailboxRequest.safeParse(input)
  if (!parsed.success) return { status: 400, body: { error: 'Invalid mailbox request' } }
  try {
    const actor = await dependencies.actor(), request = parsed.data
    let body: unknown
    switch (request.action) {
      case 'recipients': body = await dependencies.store.recipients(actor); break
      case 'send': body = await dependencies.store.send(actor, request); break
      case 'inbox': body = await dependencies.store.inbox(actor); break
      case 'ack': body = await dependencies.store.ack(actor, request.ids); break
      case 'sent': body = await dependencies.store.sent(actor); break
    }
    return { status: 200, body }
  } catch (error) {
    if (error instanceof MailboxError) return { status: error.status, body: { error: error.message, ...(error.commitState ? { commitState: error.commitState } : {}) } }
    throw error
  }
}
