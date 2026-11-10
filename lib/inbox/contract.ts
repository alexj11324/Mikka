import { z } from 'zod'
export const itemType = z.enum(['task', 'suggestion'])
export const inboxQuery = z.object({
  workspaceId: z.uuid(), tab: z.enum(['pending', 'snoozed', 'done']).default('pending'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(256).optional(),
}).strict()
export const inboxCommand = z.discriminatedUnion('action', [
  z.object({ workspaceId: z.uuid(), type: itemType, id: z.uuid(), action: z.literal('snooze'), until: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ workspaceId: z.uuid(), type: itemType, id: z.uuid(), action: z.enum(['reject', 'undo_reject', 'reopen']) }).strict(),
])
export type InboxCommand = z.infer<typeof inboxCommand>
export class InboxError extends Error {
  constructor(readonly code: 'inboxNotFound' | 'inboxInvalid' | 'workspaceAccessDenied' | 'inboxConflict', readonly status: 404 | 422 | 403 | 409, options?: ErrorOptions) { super(code, options) }
}
export type InboxSource = { id: string; type: 'task' | 'suggestion'; source: string; title: string; issueId: string | null; ownerId: string; pending: boolean; rejectedAt?: Date | null; rejectedBy?: string | null; canReply?: boolean; runId?: string | null; reason?: 'needsReply' | 'confirm' | 'review' | null }

export type InboxEntry = Omit<InboxSource, 'rejectedAt'> & {
  rejectedAt: string | null; status: 'pending' | 'snoozed' | 'done'; snoozedUntil: string | null; actions: string[];
  completion?: { id: string; action: string; actorId: string; at: string; runId: string | null }
}
export type InboxPage = { items: InboxEntry[]; nextCursor: string | null; historySince: string }

export const isInboxId = (value: unknown) => z.uuid().safeParse(value).success
