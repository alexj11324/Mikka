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

export type CoordinatorStartupSettingsCandidate = z.infer<typeof candidateSchema>
export type CoordinatorStartupSettings = z.infer<typeof settingsSchema>
export interface CoordinatorStartupReceipt { settings: CoordinatorStartupSettings; inbox: InboxTake }
export type CoordinatorStartupTake =
  | ({ kind: 'ready'; replayed: boolean } & CoordinatorStartupReceipt)
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
