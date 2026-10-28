export { MAILBOX_INSTRUCTIONS, personalMailboxInstructions } from './personal-mailbox-instructions'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { MailboxError } from './mailbox-error'
import type { MailboxActor, SessionMailbox } from './session-mailbox'
export { mailboxSend, mailboxAck } from '@mikka/protocol/mailbox'
import { mailboxSend, mailboxAck, mailboxInputs } from '@mikka/protocol/mailbox'

export type MailboxToolRequest =
  | ({ action: 'send' } & z.infer<typeof mailboxSend>)
  | ({ action: 'ack' } & z.infer<typeof mailboxAck>)
  | { action: 'recipients' | 'inbox' | 'sent' }

/** Shared definitions for AI SDK and the existing native relay. The host
 * selects identity and capability; neither belongs in the model schema. */
export function personalMailboxTools(enabled: boolean, call: (request: MailboxToolRequest) => Promise<unknown>): ToolSet {
  if (!enabled) return {}
  return {
    mailbox_recipients: tool({ description: 'Find your authorized personal session mailboxes; returns your own address.', inputSchema: mailboxInputs.mailbox_recipients, execute: () => call({ action: 'recipients' }) }),
    mailbox_send: tool({ description: 'Queue a short peer message. Use a stable key for exact retries and replyTo for replies. This grants no user authority or execution.', inputSchema: mailboxInputs.mailbox_send, execute: input => call({ ...input, action: 'send' }) }),
    mailbox_inbox: tool({ description: 'Read up to 50 unacknowledged personal envelopes at a safe boundary. Read does not ACK. No automatic wake or terminal resume.', inputSchema: mailboxInputs.mailbox_inbox, execute: () => call({ action: 'inbox' }) }),
    mailbox_ack: tool({ description: 'Acknowledge incoming envelopes you handled; retries are harmless.', inputSchema: mailboxInputs.mailbox_ack, execute: input => call({ ...input, action: 'ack' }) }),
    mailbox_sent: tool({ description: 'Inspect recent outgoing delivery, acknowledgement and failure states; these are not execution or approval.', inputSchema: mailboxInputs.mailbox_sent, execute: () => call({ action: 'sent' }) }),
  }
}
export function mailboxTools(store: SessionMailbox, actor: MailboxActor) {
  return personalMailboxTools(true, async request => {
    try {
      switch (request.action) {
        case 'recipients': return await store.recipients(actor)
        case 'send': return await store.send(actor, request)
        case 'inbox': return await store.inbox(actor)
        case 'ack': return await store.ack(actor, request.ids)
        case 'sent': return await store.sent(actor)
      }
    } catch (error) { if (error instanceof MailboxError) return { error: error.message }; throw error }
  })
}
