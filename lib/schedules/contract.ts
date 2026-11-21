import { z } from 'zod'
import { SCHEDULE_READ_TOOL_IDS } from '@/lib/coordinator/scheduled-read-tools'
import { taskDestinationSchema } from '@/lib/task-destination'
import { taskAgentSchema } from '@/lib/task-create-command'
import { slackUserId } from '@/lib/slack/user-id'
import { taskTitleInputSchema } from '@/lib/task-title-input'
import { agentProfileReferenceSchema } from '@/lib/factory/agent-profile-reference'
import { MACHINE_SIZES, type MachineSize } from '@/lib/cloud-computer/machine-pricing'
import { MODEL_ROUTING_EFFORTS } from '@/lib/model-routing'

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
    // The Agent each run's task runs on (decision 2026-11-17-1800). A schedule without one is refused at dispatch (agentRequired).
    agent: taskAgentSchema.optional(),
  }).strict(),
])
export type DispatchTask = Extract<z.infer<typeof taskSchema>, { kind: 'dispatch_task' }>
/** GitHub events an automation can run on: those the GitHub App subscribes to (decision 2026-11-15-1704). */
export const GITHUB_TRIGGER_EVENTS = [
  'pull_request_opened', 'draft_opened', 'pull_request_pushed', 'pull_request_merged', 'pull_request_closed', 'label_change',
  'issue_opened', 'comment', 'review_submitted', 'review_comment', 'checks_completed', 'checks_failed',
] as const
export type GitHubTriggerEvent = typeof GITHUB_TRIGGER_EVENTS[number]
/** These deliveries include the PR itself, independently of the sender, commenter or reviewer. */
export function supportsPullAuthors(event: GitHubTriggerEvent) {
  return event.startsWith('pull_request_') || event === 'draft_opened' || event === 'review_submitted' || event === 'review_comment'
}
export const githubLogin = z.string().trim().min(1).max(39).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/)
/** A repository as the workspace names it, `v2/github.com/<owner>/<name>` in lower case. */
export const githubRepositoryKey = z.string().regex(/^v2\/github\.com\/[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/)
/** Linear events an automation can run on (decision 2026-11-15-1930): those the Linear app's webhook already sends. */
export const LINEAR_TRIGGER_EVENTS = ['issue_created', 'issue_status_changed', 'issue_label_added', 'issue_assigned', 'comment_created'] as const
export type LinearTriggerEvent = typeof LINEAR_TRIGGER_EVENTS[number]
export const slackReactionName = z.string().trim().regex(/^[a-z0-9_+'-]{1,100}$/)

/** Slack events an automation can run on (decision 2026-11-15-2010); reaction_added needs the app's reactions subscription. */
export const SLACK_TRIGGER_EVENTS = ['message', 'mention', 'reaction_added'] as const
export type SlackTriggerEvent = typeof SLACK_TRIGGER_EVENTS[number]
export const eventTriggerSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('github'), event: z.enum(GITHUB_TRIGGER_EVENTS),
    repositories: z.array(githubRepositoryKey).min(1).max(20),
    pullAuthors: z.array(githubLogin).min(1).max(20).optional(),
    branches: z.array(z.string().trim().min(1).max(250)).max(20).optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    /** One sentence checked against each event before a run starts; an event that does not match is skipped. */
    runWhen: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({
    source: z.literal('linear'), event: z.enum(LINEAR_TRIGGER_EVENTS),
    /** Linear team IDs from the creator's own Linear connection. */
    teams: z.array(z.string().min(1).max(128)).min(1).max(20),
    labels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    runWhen: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({
    source: z.literal('slack'), event: z.enum(SLACK_TRIGGER_EVENTS),
    /** Channel IDs of the workspace's Slack installation the Bot can see. */
    channels: z.array(z.string().regex(/^[CG][A-Z0-9]{2,30}$/)).min(1).max(20),
    authors: z.array(z.string().refine(slackUserId)).max(20).optional(),
    /** reaction_added: the emoji names that count (without colons); empty or absent is any. */
    reactions: z.array(slackReactionName).max(20).optional(),
    runWhen: z.string().trim().min(1).max(500).optional(),
  }).strict(),
]).refine(value => value.source !== 'github' || !value.pullAuthors?.length || supportsPullAuthors(value.event))
export type EventTrigger = z.infer<typeof eventTriggerSchema>
export type GitHubEventTrigger = Extract<EventTrigger, { source: 'github' }>
export type LinearEventTrigger = Extract<EventTrigger, { source: 'linear' }>
export type SlackEventTrigger = Extract<EventTrigger, { source: 'slack' }>
/** Reasoning effort a run asks its model for; the model's own default when absent. */
export const AUTOMATION_EFFORTS = MODEL_ROUTING_EFFORTS
export type AutomationEffort = typeof AUTOMATION_EFFORTS[number]
const machineSizeSchema = z.enum(Object.keys(MACHINE_SIZES) as [MachineSize, ...MachineSize[]])
/** Organize: applied to the thread each run starts, for the automation's creator. Threads have no folders or tags yet. */
const runsOrganizeSchema = z.object({ pin: z.literal(true).optional() }).strict()
const DISPATCH_ONLY = ['environmentId', 'singleThreadId', 'model', 'machineSize', 'runs'] as const
export const definitionSchema = z.object({
  title: z.string().trim().min(1).max(200), timezone: z.string().min(1).max(100), timing: timingSchema, task: taskSchema,
  /** What the automation is for, shown under its name. */
  description: z.string().trim().min(1).max(2000).optional(),
  /** The workspace Environment (repositories, setup, variables) each run uses. */
  environmentId: z.uuid().optional(),
  /** eachRun 'existing_thread': the thread (its root run) every run is sent to as a follow-up. */
  singleThreadId: z.uuid().optional(),
  /** The model each run's task asks for, and its reasoning effort; the Agent's default when absent. */
  model: z.object({ id: z.string().trim().min(1).max(200), effort: z.enum(AUTOMATION_EFFORTS).optional() }).strict().optional(),
  /** The size of the Cloudflare machine each run gets; the Environment's default, else Mikka's, when absent. */
  machineSize: machineSizeSchema.optional(),
  runs: runsOrganizeSchema.optional(),
  misfire: z.enum(['skip', 'catch_up_once']), maxLatenessMinutes: z.number().int().min(1).max(10080),
  maxConcurrent: z.number().int().min(1).max(5).optional(),
  /** Runs started on one day in the automation's time zone; past it, timed and event runs are skipped and 立即运行 refused. */
  maxRunsPerDay: z.number().int().min(1).max(500).optional(),
  /** dispatch_task: 'new_task' makes a task at every run; 'same_task' makes one and sends each later run to it as a
   * follow-up; 'existing_thread' sends every run to `singleThreadId`. */
  eachRun: z.enum(['new_task', 'same_task', 'existing_thread']).optional(),
  /** 满足任一条件就运行: event triggers beside the timing. Only an automation that hands a Bot a task has them. */
  events: z.array(eventTriggerSchema).min(1).max(20).optional(),
  /** Webhook: the automation's own URL starts a run; requests within `batchMinutes` of the first go to one run. */
  webhook: z.object({ batchMinutes: z.number().int().min(0).max(60) }).strict().optional(),
  /** 运行后发到 Slack: each finished run is posted to this channel of the workspace's Slack, in the locale saved here. */
  notify: z.object({ slack: z.object({
    channel: z.string().regex(/^[CG][A-Z0-9]{2,30}$/), locale: z.enum(['zh-CN', 'en']),
    /** Post with the run-as person's name and picture (chat:write.customize) instead of the app's. */
    postAsRunner: z.boolean().optional(),
    /** One plain line: no footer, no status card. */
    quiet: z.boolean().optional(),
  }).strict() }).strict().optional(),
}).strict()
  .refine(value => value.task.kind === 'dispatch_task' || DISPATCH_ONLY.every(key => value[key] === undefined), { message: 'eventTriggersNeedDispatchTask', path: ['task'] })
  .refine(value => (value.eachRun === 'existing_thread') === (value.singleThreadId !== undefined), { message: 'singleThreadRequired', path: ['singleThreadId'] })
  .refine(value => !value.events || value.task.kind === 'dispatch_task', { message: 'eventTriggersNeedDispatchTask', path: ['events'] })
  .refine(value => !value.webhook || value.task.kind === 'dispatch_task', { message: 'eventTriggersNeedDispatchTask', path: ['webhook'] })
  .refine(value => !value.notify || value.task.kind === 'dispatch_task', { message: 'eventTriggersNeedDispatchTask', path: ['notify'] })
export const SCHEDULE_PAGE_MAX = 100
const scheduleCursor = z.templateLiteral([z.iso.datetime({ precision: 6 }), '/', z.uuid()])
export const scheduleListInput = z.object({
  scheduleId: z.uuid().optional(),
  deleted: z.boolean().optional(),
  /** 我的自动化: only those the reader created. */
  owner: z.literal('me').optional(),
  /** 定时: only those that run on a schedule (one-shot, interval, daily or cron), whatever else triggers them. */
  trigger: z.literal('schedule').optional(),
  limit: z.number().int().min(1).max(SCHEDULE_PAGE_MAX).optional(),
  cursor: scheduleCursor.optional(),
}).strict()

const webhookBatchPageInput = scheduleListInput.pick({ limit: true, cursor: true }).extend({
  status: z.enum(['collecting', 'queued', 'cancelled']).optional(),
})

/** With batches, read only webhook windows and return their metadata without request bodies. */
export const scheduleHistoryInput = z.object({
  scheduleId: z.uuid(),
  batches: webhookBatchPageInput.optional(),
}).strict()

export const webhookBatchListInput = webhookBatchPageInput.extend({ scheduleId: z.uuid() })
export const webhookBatchInput = z.object({ scheduleId: z.uuid(), batchId: z.uuid(), version: z.number().int().positive() }).strict()

export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), requestId: z.string().min(1).max(200), definition: definitionSchema }).strict(),
  scheduleListInput.extend({ action: z.literal('list') }),
  scheduleHistoryInput.extend({ action: z.literal('history') }),
  webhookBatchInput.extend({ action: z.enum(['flush_batch', 'cancel_batch']) }),
  z.object({ action: z.literal('update'), scheduleId: z.uuid(), version: z.number().int().positive(), definition: definitionSchema }).strict(),
  z.object({ action: z.enum(['pause', 'resume', 'cancel', 'delete', 'restore']), scheduleId: z.uuid(), version: z.number().int().positive() }).strict(),
  // 接手: an owner or admin makes a workspace automation theirs; from then on it runs as them (decision 2026-11-15-1840).
  z.object({ action: z.literal('take_over'), scheduleId: z.uuid(), version: z.number().int().positive() }).strict(),
  // Webhook 地址: a new secret URL for the automation; the previous one stops working. Returned once.
  z.object({ action: z.literal('webhook_key'), scheduleId: z.uuid(), version: z.number().int().positive() }).strict(),
  // 置顶: the reader's own pin.
  z.object({ action: z.literal('pin'), scheduleId: z.uuid(), pinned: z.boolean() }).strict(),
  // 文件夹和标签: the workspace's; set by the creator or an owner/admin, without changing the automation's version.
  z.object({ action: z.literal('organize'), scheduleId: z.uuid(), folder: z.string().trim().min(1).max(60).nullable(), tags: z.array(z.string().trim().min(1).max(30)).max(10) }).strict(),
  // 立即运行: one occurrence due now. The same requestId never adds a second one.
  z.object({ action: z.literal('run_now'), scheduleId: z.uuid(), version: z.number().int().positive(), requestId: z.uuid() }).strict(),
  z.object({ action: z.literal('cancel_run'), scheduleId: z.uuid(), runId: z.uuid(), version: z.number().int().positive() }).strict(),
  // Duplicate to: a copy in this or another workspace the person can write to, checked again there. Fields the target
  // cannot use are cleared and reported; the copy starts paused when any were. The webhook key and pins are not copied.
  z.object({ action: z.literal('duplicate'), scheduleId: z.uuid(), targetWorkspaceId: z.uuid(), requestId: z.uuid() }).strict(),
  // Runs as: who each dispatched run acts, is billed and posts as; null is the creator. A person can name only themselves
  // (consent). The creator, an owner/admin or that person can return it to the creator.
  z.object({ action: z.literal('run_as'), scheduleId: z.uuid(), version: z.number().int().positive(), userId: z.string().min(1).max(200).nullable() }).strict(),
  // 用量: runs and cost per day in the automation's time zone, newest first.
  z.object({ action: z.literal('usage'), scheduleId: z.uuid(), days: z.number().int().min(1).max(90).optional() }).strict(),
])
export type Definition = z.infer<typeof definitionSchema>
export type Command = z.infer<typeof commandSchema>
/** `direct`: a signed-in person acting on the 自动化 page (the server action checked the session); a chat command
 * instead names the person's message (`sourceEventId`). Tools never set `direct`. */
export type Actor = { ownerId: string; workspaceId: string | null; botId: string | null; sourceEventId?: string; direct?: true }
export type ScheduledRead = { occurrenceId: string; leaseToken: string; allowedActions: readonly string[]; prompt: string }
