import { z } from 'zod'
import { SCHEDULE_READ_TOOL_IDS } from '@/lib/coordinator/scheduled-read-tools'

export class ScheduleError extends Error {
  constructor(public code: string, public status = 409) { super(code); this.name = 'ScheduleError' }
}
export const timingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal('interval'), start: z.iso.datetime({ offset: true }), minutes: z.number().int().min(1).max(525600) }).strict(),
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), fold: z.enum(['earlier', 'later']), gap: z.literal('skip') }).strict(),
])
export const READ_ACTIONS = SCHEDULE_READ_TOOL_IDS
export const taskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reminder'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('issue_snapshot'), issueId: z.uuid() }).strict(),
  z.object({ kind: z.literal('agent_read'), prompt: z.string().trim().min(1).max(8000), allowedActions: z.array(z.enum(READ_ACTIONS)).min(1).max(READ_ACTIONS.length) }).strict(),
])
export const definitionSchema = z.object({
  title: z.string().trim().min(1).max(200), timezone: z.string().min(1).max(100), timing: timingSchema, task: taskSchema,
  misfire: z.enum(['skip', 'catch_up_once']), maxLatenessMinutes: z.number().int().min(1).max(10080),
}).strict()
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), requestId: z.string().min(1).max(200), definition: definitionSchema }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('history'), scheduleId: z.uuid() }).strict(),
  z.object({ action: z.literal('update'), scheduleId: z.uuid(), version: z.number().int().positive(), definition: definitionSchema }).strict(),
  z.object({ action: z.enum(['pause', 'resume', 'cancel']), scheduleId: z.uuid(), version: z.number().int().positive() }).strict(),
])
export type Definition = z.infer<typeof definitionSchema>
export type Command = z.infer<typeof commandSchema>
export type Actor = { ownerId: string; workspaceId: string | null; botId: string | null; sourceEventId?: string }
export type ScheduledRead = { occurrenceId: string; leaseToken: string; allowedActions: readonly string[]; prompt: string }
export const SCHEDULE_INSTRUCTIONS = `Use schedule_create/list/history/update/pause/resume/cancel for user-requested schedules. Reminders, read-only issue snapshots and explicitly scoped agent_read tasks are supported. agent_read uses only its named read tools and requires the existing model/connection configuration; external writes require separate approval and are not permitted. Never claim arbitrary external tasks were scheduled. Specify an explicit IANA timezone, exact next execution, task, misfire policy and scope in your reply. For daily times use gap=skip and ask the user to resolve an ambiguous fold (earlier/later); do not silently choose. Persist through tools before claiming success. Updates replace the definition and use its current version; cancellation is permanent. Scheduling grants no external write/connection permission.`
