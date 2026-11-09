import { z } from 'zod'
import { AgentKitError } from '@/lib/agent-kit/store'
import { COORDINATOR_EVENT_KINDS, COORDINATOR_EVENT_TIERS } from '@/lib/db/schema'
import type { InboxTake } from './store'

/** Only run settings and inbox metadata cross the first startup checkpoint.
 * Credentials, model objects and authorization decisions never enter this receipt. */
const candidateSchema = z.object({
  computerEnabled: z.boolean(), mailboxEnabled: z.boolean(), writeEnabled: z.boolean(), agentKitEnabled: z.boolean(),
  switches: z.object({ issueTools: z.boolean(), factoryRouting: z.boolean(), factoryLifecycle: z.boolean() }).strict(),
  runtime: z.object({ harness: z.literal('ai_sdk') }).strict(),
}).strict()
const settingsSchema = candidateSchema.extend({ coordinator: z.boolean() })
const id = z.string().min(1)
const inboxSchema = z.object({
  held: z.literal(true), added: z.number().int().min(0),
  telegramTargets: z.array(z.object({ threadId: id, telegramUserId: id, sourceEventIds: z.array(id) }).strict()),
  handoffMatterIds: z.array(id), handoffOnly: z.boolean(),
  pushEvents: z.array(z.object({ kind: z.enum(COORDINATOR_EVENT_KINDS), tier: z.enum(COORDINATOR_EVENT_TIERS).nullable(), runId: id.nullable(), issueId: id.nullable() }).strict()),
  pushHidesText: z.boolean(), taskEventId: id.optional(), sourceEventId: id.optional(),
  attentionQuestions: z.array(z.object({ eventId: id, taskId: id, issueId: id, questionId: id, runId: id }).strict()).optional(),
  scheduledRead: z.object({ occurrenceId: id, leaseToken: id, allowedActions: z.array(id), prompt: z.string() }).strict().optional(),
}).strict()

// Version 1 is first introduced with this storage format. The JSON columns
// remain objects; neither this encoding nor a receipt grants current authority.
// Settings bits: computer, mailbox, write, agent kit, issue tools, factory
// routing, factory lifecycle, Coordinator. The harness value is kept verbatim.
const storedSettingsSchema = z.object({
  f: z.number().int().min(0).max(255), r: candidateSchema.shape.runtime.shape.harness,
}).strict()
// Inbox bits 0/1 hold handoffOnly/pushHidesText. The remaining bits declare
// field presence, so deleting nonempty metadata cannot silently default to [].
const inboxPresenceBits = { t: 4, m: 8, p: 16, k: 32, s: 64, q: 128, d: 256 } as const
const storedInboxSchema = z.object({
  a: inboxSchema.shape.added, f: z.number().int().min(0).max(511),
  t: inboxSchema.shape.telegramTargets.min(1).optional(),
  m: inboxSchema.shape.handoffMatterIds.min(1).optional(),
  p: inboxSchema.shape.pushEvents.min(1).optional(),
  k: inboxSchema.shape.taskEventId, s: inboxSchema.shape.sourceEventId,
  q: inboxSchema.shape.attentionQuestions, d: inboxSchema.shape.scheduledRead,
}).strict().superRefine((value, context) => {
  for (const key of Object.keys(inboxPresenceBits) as (keyof typeof inboxPresenceBits)[]) {
    const present = Object.hasOwn(value, key)
    if (present !== Boolean(value.f & inboxPresenceBits[key]) || (present && value[key] === undefined)) {
      context.addIssue({ code: 'custom', path: [key], message: 'Startup receipt field presence does not match its bitmap' })
    }
  }
})
const storedReceiptSchema = z.object({ version: z.literal(1), settings: storedSettingsSchema, inbox: storedInboxSchema }).strict()

export type CoordinatorStartupSettingsCandidate = z.infer<typeof candidateSchema>
export type CoordinatorStartupSettings = z.infer<typeof settingsSchema>
export interface CoordinatorStartupReceipt { settings: CoordinatorStartupSettings; inbox: InboxTake }
export type StoredCoordinatorStartupSettings = z.infer<typeof storedSettingsSchema>
export type StoredCoordinatorStartupInbox = z.infer<typeof storedInboxSchema>
export interface StoredCoordinatorStartupReceipt { settings: StoredCoordinatorStartupSettings; inbox: StoredCoordinatorStartupInbox }
export type CoordinatorStartupTake =
  | ({ kind: 'ready'; replayed: boolean } & CoordinatorStartupReceipt)
  | ({ kind: 'inbox-only' } & CoordinatorStartupReceipt)
  | { kind: 'not-held'; inbox: InboxTake }
  | ({ kind: 'lost'; replayed: true } & CoordinatorStartupReceipt)

export function startupReceiptConflict(cause: unknown): AgentKitError {
  const error = new AgentKitError('agentEventConflict')
  error.cause = cause
  return error
}

export function startupSettingsCandidate(value: unknown): CoordinatorStartupSettingsCandidate {
  const parsed = candidateSchema.safeParse(value)
  if (!parsed.success) throw startupReceiptConflict(parsed.error)
  return parsed.data
}

/** Presence is decided by the row key, never by JSON truthiness. Invalid data
 * fails closed; it is not permission to consume a newer inbox. */
export function readStartupReceipt(version: unknown, settings: unknown, inbox: unknown): CoordinatorStartupReceipt {
  const parsed = z.object({ version: z.literal(1), settings: settingsSchema, inbox: inboxSchema }).strict().safeParse({ version, settings, inbox })
  if (!parsed.success) throw startupReceiptConflict(parsed.error)
  return { settings: parsed.data.settings, inbox: parsed.data.inbox }
}

/** Compact persistence only. All writes first pass the unchanged canonical
 * schema; all public takes and recovery reads still return canonical objects. */
export function encodeStoredStartupReceipt(value: CoordinatorStartupReceipt): StoredCoordinatorStartupReceipt {
  // The public InboxTake is wider than the schema-validated result. Keep
  // that precise shape locally after the existing parse, with no second read.
  const { settings, inbox } = readStartupReceipt(1, value.settings, value.inbox) as {
    settings: CoordinatorStartupSettings; inbox: z.infer<typeof inboxSchema>
  }
  for (const key of ['taskEventId', 'sourceEventId', 'attentionQuestions', 'scheduledRead'] as const) {
    // JSON cannot preserve an explicitly present undefined. Product takes
    // omit absent optional fields; reject this ambiguous storage input.
    if (Object.hasOwn(inbox, key) && inbox[key] === undefined) throw startupReceiptConflict(new Error('coordinatorStartupUndefinedField'))
  }
  const flags = [settings.computerEnabled, settings.mailboxEnabled, settings.writeEnabled, settings.agentKitEnabled,
    settings.switches.issueTools, settings.switches.factoryRouting, settings.switches.factoryLifecycle, settings.coordinator]
    .reduce((bits, enabled, index) => bits | (Number(enabled) << index), 0)
  const packed: StoredCoordinatorStartupInbox = { a: inbox.added, f: Number(inbox.handoffOnly) | (Number(inbox.pushHidesText) << 1) }
  if (inbox.telegramTargets.length) { packed.t = inbox.telegramTargets; packed.f |= inboxPresenceBits.t }
  if (inbox.handoffMatterIds.length) { packed.m = inbox.handoffMatterIds; packed.f |= inboxPresenceBits.m }
  if (inbox.pushEvents.length) { packed.p = inbox.pushEvents; packed.f |= inboxPresenceBits.p }
  if (inbox.taskEventId !== undefined) { packed.k = inbox.taskEventId; packed.f |= inboxPresenceBits.k }
  if (inbox.sourceEventId !== undefined) { packed.s = inbox.sourceEventId; packed.f |= inboxPresenceBits.s }
  if (inbox.attentionQuestions !== undefined) { packed.q = inbox.attentionQuestions; packed.f |= inboxPresenceBits.q }
  if (inbox.scheduledRead !== undefined) { packed.d = inbox.scheduledRead; packed.f |= inboxPresenceBits.d }
  return { settings: { f: flags, r: settings.runtime.harness }, inbox: packed }
}

/** A malformed stored receipt never falls back to a new take or another
 * format. Decode the closed representation, then recheck the public schema. */
export function decodeStoredStartupReceipt(version: unknown, settings: unknown, inbox: unknown): CoordinatorStartupReceipt {
  const parsed = storedReceiptSchema.safeParse({ version, settings, inbox })
  if (!parsed.success) throw startupReceiptConflict(parsed.error)
  const { settings: packedSettings, inbox: packed } = parsed.data
  const flags = packedSettings.f
  return readStartupReceipt(1, {
    computerEnabled: Boolean(flags & 1), mailboxEnabled: Boolean(flags & 2),
    writeEnabled: Boolean(flags & 4), agentKitEnabled: Boolean(flags & 8),
    switches: { issueTools: Boolean(flags & 16), factoryRouting: Boolean(flags & 32), factoryLifecycle: Boolean(flags & 64) },
    coordinator: Boolean(flags & 128), runtime: { harness: packedSettings.r },
  }, {
    held: true, added: packed.a, telegramTargets: packed.t ?? [], handoffMatterIds: packed.m ?? [],
    handoffOnly: Boolean(packed.f & 1), pushEvents: packed.p ?? [], pushHidesText: Boolean(packed.f & 2),
    ...(packed.k !== undefined ? { taskEventId: packed.k } : {}),
    ...(packed.s !== undefined ? { sourceEventId: packed.s } : {}),
    ...(packed.q !== undefined ? { attentionQuestions: packed.q } : {}),
    ...(packed.d !== undefined ? { scheduledRead: packed.d } : {}),
  })
}
