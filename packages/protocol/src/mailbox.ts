import { z } from 'zod'

// Shared personal-message schemas. Source identity and capability never belong
// in a model/CLI request. The existing server and host bridge use these alike.
export const mailboxSend = z.object({ to: z.uuid(), key: z.uuid().describe('Stable idempotency key; reuse only to retry this exact envelope.'), text: z.string().trim().min(1).max(4000), replyTo: z.uuid().optional() }).strict()
export const mailboxAck = z.object({ ids: z.array(z.uuid()).max(50) }).strict()
export const mailboxInputs = {
  mailbox_recipients: z.object({}).strict(),
  mailbox_send: mailboxSend,
  mailbox_inbox: z.object({}).strict(),
  mailbox_ack: mailboxAck,
  mailbox_sent: z.object({}).strict(),
}
export type MailboxToolName = keyof typeof mailboxInputs
