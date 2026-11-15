import { z } from 'zod'
import { SCHEDULE_READ_TOOL_IDS } from '@/lib/coordinator/scheduled-read-tools'
import { taskDestinationSchema } from '@/lib/task-destination'
import { taskTitleInputSchema } from '@/lib/task-title-input'
import { agentProfileReferenceSchema } from '@/lib/factory/agent-profile-reference'

export class ScheduleError extends Error {
  constructor(public code: string, public status = 409, options?: ErrorOptions) { super(code, options); this.name = 'ScheduleError' }
}
export const timingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal('interval'), start: z.iso.datetime({ offset: true }), minutes: z.number().int().min(1).max(525600) }).strict(),
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), fold: z.enum(['earlier', 'later']), gap: z.literal('skip') }).strict(),
  z.object({ kind: z.literal('cron'), expression: z.string().trim().min(9).max(100) }).strict(),
  // No schedule: the automation runs only when someone runs it (run_now).
  z.object({ kind: z.literal('manual') }).strict(),
])
export const READ_ACTIONS = SCHEDULE_READ_TOOL_IDS
export const taskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reminder'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('issue_snapshot'), issueId: z.uuid() }).strict(),
  z.object({ kind: z.literal('agent_read'), prompt: z.string().trim().min(1).max(8000), allowedActions: z.array(z.enum(READ_ACTIONS)).min(1).max(READ_ACTIONS.length) }).strict(),
  // 交给 a Bot (null: the Coordinator) the request, as 新建任务's 创建并派发 does, as the schedule's creator.
  z.object({
    kind: z.literal('dispatch_task'), botId: z.uuid().nullable(), prompt: z.string().trim().min(1).max(8000),
    title: taskTitleInputSchema.optional(), destination: taskDestinationSchema.optional(), profileId: agentProfileReferenceSchema.optional(),
  }).strict(),
])
export type DispatchTask = Extract<z.infer<typeof taskSchema>, { kind: 'dispatch_task' }>
/** GitHub events an automation can run on: those the GitHub App subscribes to (decision 2026-11-15-1704). */
export const GITHUB_TRIGGER_EVENTS = [
  'pull_request_opened', 'draft_opened', 'pull_request_pushed', 'pull_request_merged', 'pull_request_closed', 'label_change',
  'issue_opened', 'comment', 'review_submitted', 'review_comment', 'checks_completed', 'checks_failed',
] as const
export type GitHubTriggerEvent = typeof GITHUB_TRIGGER_EVENTS[number]
/** A repository as the workspace names it, `v2/github.com/<owner>/<name>` in lower case. */
export const githubRepositoryKey = z.string().regex(/^v2\/github\.com\/[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/)
export const eventTriggerSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('github'), event: z.enum(GITHUB_TRIGGER_EVENTS),
    repositories: z.array(githubRepositoryKey).min(1).max(20),
    branches: z.array(z.string().trim().min(1).max(250)).max(20).optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    /** One sentence checked against each event before a run starts; an event that does not match is skipped. */
    runWhen: z.string().trim().min(1).max(500).optional(),
  }).strict(),
])
export type EventTrigger = z.infer<typeof eventTriggerSchema>
export const definitionSchema = z.object({
  title: z.string().trim().min(1).max(200), timezone: z.string().min(1).max(100), timing: timingSchema, task: taskSchema,
  misfire: z.enum(['skip', 'catch_up_once']), maxLatenessMinutes: z.number().int().min(1).max(10080),
  maxConcurrent: z.number().int().min(1).max(5).optional(),
  /** Runs started on one day in the automation's time zone; past it, timed and event runs are skipped and 立即运行 refused. */
  maxRunsPerDay: z.number().int().min(1).max(500).optional(),
  /** dispatch_task: 'new' makes a task at every run; 'single' makes one and sends each later run to it as a follow-up. */
  threadMode: z.enum(['new', 'single']).optional(),
  /** 满足任一条件就运行: event triggers beside the timing. Only an automation that hands a Bot a task has them. */
  events: z.array(eventTriggerSchema).min(1).max(20).optional(),
}).strict().refine(value => !value.events || value.task.kind === 'dispatch_task', { message: 'eventTriggersNeedDispatchTask', path: ['events'] })
export const SCHEDULE_PAGE_MAX = 100
const scheduleCursor = z.templateLiteral([z.iso.datetime({ precision: 6 }), '/', z.uuid()])
export const scheduleListInput = z.object({
  scheduleId: z.uuid().optional(),
  limit: z.number().int().min(1).max(SCHEDULE_PAGE_MAX).optional(),
  cursor: scheduleCursor.optional(),
}).strict()

export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), requestId: z.string().min(1).max(200), definition: definitionSchema }).strict(),
  scheduleListInput.extend({ action: z.literal('list') }),
  z.object({ action: z.literal('history'), scheduleId: z.uuid() }).strict(),
  z.object({ action: z.literal('update'), scheduleId: z.uuid(), version: z.number().int().positive(), definition: definitionSchema }).strict(),
  z.object({ action: z.enum(['pause', 'resume', 'cancel']), scheduleId: z.uuid(), version: z.number().int().positive() }).strict(),
  // 立即运行: one occurrence due now. The same requestId never adds a second one.
  z.object({ action: z.literal('run_now'), scheduleId: z.uuid(), version: z.number().int().positive(), requestId: z.uuid() }).strict(),
  // 用量: runs and cost per day in the automation's time zone, newest first.
  z.object({ action: z.literal('usage'), scheduleId: z.uuid(), days: z.number().int().min(1).max(90).optional() }).strict(),
])
export type Definition = z.infer<typeof definitionSchema>
export type Command = z.infer<typeof commandSchema>
/** `direct`: a signed-in person acting on the 自动化 page (the server action checked the session); a chat command
 * instead names the person's message (`sourceEventId`). Tools never set `direct`. */
export type Actor = { ownerId: string; workspaceId: string | null; botId: string | null; sourceEventId?: string; direct?: true }
export type ScheduledRead = { occurrenceId: string; leaseToken: string; allowedActions: readonly string[]; prompt: string }
