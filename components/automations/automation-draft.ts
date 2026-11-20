import { dailyTimeRepeats, resolveLocal } from '@/lib/schedules/wall-time'
import type { AutomationEffort, Definition, DispatchTask, EventTrigger, GitHubTriggerEvent, LinearTriggerEvent, SlackTriggerEvent } from '@/lib/schedules/contract'
import { slackUserId } from '@/lib/slack/user-id'
import type { TaskDestination } from '@/lib/task-destination'
import type { TaskAgent } from '@/lib/task-create-command'
import type { MachineSize } from '@/lib/cloud-computer/machine-pricing'

export type ScheduleKind = 'once' | 'interval' | 'daily' | 'cron'
/** One GitHub event trigger as the editor holds it; lists are comma-separated text. */
export type GitHubTriggerDraft = { event: GitHubTriggerEvent; repositories: string[]; branches: string; labels: string; pullAuthors?: string; runWhen: string }
export type LinearTriggerDraft = { event: LinearTriggerEvent; teams: string[]; labels: string; runWhen: string }
export type SlackTriggerDraft = { event: SlackTriggerEvent; channels: string[]; authors: string; reactions: string; runWhen: string }
export type IntervalUnit = 'minutes' | 'hours' | 'days'
const UNIT_MINUTES: Record<IntervalUnit, number> = { minutes: 1, hours: 60, days: 1440 }

/** What the 自动化 editor holds: the definition as fields, local times in the automation's own time zone. */
export type AutomationDraft = {
  title: string
  /** What it is for, under its name; '' is none. */
  description: string
  /** The Environment each run uses; null is the Project's default. */
  environmentId: string | null
  botId: string | null
  /** 'auto' (workspace default), 'cloud', 'cloudflare' or a device ID. */
  machine: string
  /** 'auto' leaves the Agent profile to the dispatch. */
  profileId: string
  /** The Agent each run's task runs on; none chosen, the automation cannot save (decision 2026-11-17-1800). */
  agent: TaskAgent | null
  timezone: string
  scheduleOn: boolean
  scheduleKind: ScheduleKind
  /** `YYYY-MM-DDTHH:mm`, wall time in `timezone`. */
  onceAt: string
  intervalStart: string
  intervalValue: number
  intervalUnit: IntervalUnit
  dailyTime: string
  /** The person's choice for a repeated daily time; null until they choose. */
  fold: 'earlier' | 'later' | null
  cron: string
  prompt: string
  taskTitle: string
  misfire: Definition['misfire']
  lateness: number
  concurrent: number
  /** 0 is 不限. */
  perDay: number
  /** Runs in: a new thread each run, one standing thread (the first run's), or an existing thread. */
  eachRun: 'new_task' | 'same_task' | 'existing_thread'
  /** Runs in 'existing_thread': the thread's root run. */
  singleThreadId: string | null
  /** The model each run asks for (one of 优先使用的模型 on the Agent), and its effort; null is the Agent's default. */
  model: string | null
  effort: AutomationEffort | null
  /** The machine size; null is the Environment's default, else Mikka's. */
  machineSize: MachineSize | null
  /** Pin each run's new thread. */
  pin: boolean
  /** 满足任一条件就运行: GitHub event triggers beside the timing. */
  github: GitHubTriggerDraft[]
  /** 满足任一条件就运行: Linear event triggers, on teams of the person's own Linear connection. */
  linear: LinearTriggerDraft[]
  /** 满足任一条件就运行: Slack event triggers, on channels of the workspace's Slack installation. */
  slack: SlackTriggerDraft[]
  /** 运行后发到 Slack: the channel and the locale the posts are written in; null is off. */
  notify: { channel: string; locale: 'zh-CN' | 'en' } | null
  /** Webhook: its own URL starts a run; null is off, otherwise the minutes requests are gathered into one run. */
  webhook: number | null
  /** A chat-made automation's own task (reminder, snapshot, read): kept as it is. */
  otherTask: Exclude<Definition['task'], DispatchTask> | null
}

/** An instant as the wall time the editor shows in `zone`. */
export function wallTime(at: string | Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

/** A wall time in `zone` as an instant; null for a time the clocks skip. A repeated one takes the earlier. */
export function instant(wall: string, zone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall)
  if (!match) return null
  const [, year, month, day, hour, minute] = match.map(Number)
  const at = resolveLocal(Date.UTC(year!, month! - 1, day!, hour!, minute!), zone, 'earlier')
  return at === null ? null : new Date(at).toISOString()
}

export function emptyDraft(timezone: string, now = new Date()): AutomationDraft {
  const soon = new Date(Math.ceil((now.getTime() + 3600_000) / 3600_000) * 3600_000)
  return {
    title: '', description: '', environmentId: null, singleThreadId: null, model: null, effort: null, machineSize: null, pin: false, botId: null, machine: 'auto', profileId: 'auto', agent: null, timezone,
    scheduleOn: true, scheduleKind: 'daily', onceAt: wallTime(soon, timezone), intervalStart: wallTime(soon, timezone),
    intervalValue: 1, intervalUnit: 'hours', dailyTime: '09:00', fold: null, cron: '0 9 * * 1-5',
    prompt: '', taskTitle: '', misfire: 'skip', lateness: 30, concurrent: 1, perDay: 0, eachRun: 'new_task', github: [], linear: [], slack: [], notify: null, webhook: null, otherTask: null,
  }
}

export function draftFrom(definition: Definition, now = new Date()): AutomationDraft {
  const draft = emptyDraft(definition.timezone, now)
  const timing = definition.timing
  const task = definition.task
  const destination = task.kind === 'dispatch_task' ? task.destination : undefined
  const unit: IntervalUnit = timing.kind === 'interval' ? (timing.minutes % 1440 === 0 ? 'days' : timing.minutes % 60 === 0 ? 'hours' : 'minutes') : 'hours'
  return {
    ...draft,
    title: definition.title,
    description: definition.description ?? '',
    environmentId: definition.environmentId ?? null,
    singleThreadId: definition.singleThreadId ?? null,
    model: definition.model?.id ?? null,
    effort: definition.model?.effort ?? null,
    machineSize: definition.machineSize ?? null,
    pin: definition.runs?.pin === true,
    botId: task.kind === 'dispatch_task' ? task.botId : null,
    machine: !destination ? 'auto' : destination.kind === 'device' ? destination.deviceId : destination.provider === 'cloudflare' ? 'cloudflare' : 'cloud',
    profileId: task.kind === 'dispatch_task' ? task.profileId ?? 'auto' : 'auto',
    agent: task.kind === 'dispatch_task' ? task.agent ?? null : null,
    scheduleOn: timing.kind !== 'manual',
    scheduleKind: timing.kind === 'manual' ? draft.scheduleKind : timing.kind,
    onceAt: timing.kind === 'once' ? wallTime(timing.at, definition.timezone) : draft.onceAt,
    intervalStart: timing.kind === 'interval' ? wallTime(timing.start, definition.timezone) : draft.intervalStart,
    intervalValue: timing.kind === 'interval' ? timing.minutes / UNIT_MINUTES[unit] : draft.intervalValue,
    intervalUnit: unit,
    dailyTime: timing.kind === 'daily' ? timing.time : draft.dailyTime,
    fold: timing.kind === 'daily' ? timing.fold : null,
    cron: timing.kind === 'cron' ? timing.expression : draft.cron,
    prompt: task.kind === 'dispatch_task' ? task.prompt : '',
    taskTitle: task.kind === 'dispatch_task' ? task.title ?? '' : '',
    misfire: definition.misfire, lateness: definition.maxLatenessMinutes, concurrent: definition.maxConcurrent ?? 1, perDay: definition.maxRunsPerDay ?? 0, eachRun: definition.eachRun ?? 'new_task',
    github: (definition.events ?? []).flatMap(trigger => trigger.source === 'github' ? [{ event: trigger.event, repositories: [...trigger.repositories],
      branches: (trigger.branches ?? []).join(', '), labels: (trigger.labels ?? []).join(', '), ...(trigger.pullAuthors?.length ? { pullAuthors: trigger.pullAuthors.join(', ') } : {}), runWhen: trigger.runWhen ?? '' }] : []),
    linear: (definition.events ?? []).flatMap(trigger => trigger.source === 'linear' ? [{ event: trigger.event, teams: [...trigger.teams],
      labels: (trigger.labels ?? []).join(', '), runWhen: trigger.runWhen ?? '' }] : []),
    slack: (definition.events ?? []).flatMap(trigger => trigger.source === 'slack' ? [{ event: trigger.event, channels: [...trigger.channels],
      authors: (trigger.authors ?? []).join(', '), reactions: (trigger.reactions ?? []).join(', '), runWhen: trigger.runWhen ?? '' }] : []),
    notify: definition.notify?.slack ? { ...definition.notify.slack } : null,
    webhook: definition.webhook?.batchMinutes ?? null,
    otherTask: task.kind === 'dispatch_task' ? null : task,
  }
}

const list = (text: string) => [...new Set(text.split(/[,，]/).map(item => item.trim()).filter(Boolean))]
function eventTrigger(draft: GitHubTriggerDraft): EventTrigger {
  const branches = list(draft.branches), labels = list(draft.labels)
  const pullAuthors = list(draft.pullAuthors ?? '').map(name => name.replace(/^@/, '').toLowerCase())
  return { source: 'github', event: draft.event, repositories: draft.repositories,
    ...(branches.length ? { branches } : {}), ...(labels.length ? { labels } : {}), ...(pullAuthors.length ? { pullAuthors: [...new Set(pullAuthors)] } : {}), ...(draft.runWhen.trim() ? { runWhen: draft.runWhen.trim() } : {}) }
}
function slackTrigger(draft: SlackTriggerDraft): EventTrigger {
  const authors = list(draft.authors)
  const reactions = list(draft.reactions).map(name => name.replace(/^:|:$/g, '').toLowerCase()).filter(Boolean)
  return { source: 'slack', event: draft.event, channels: draft.channels, ...(authors.length ? { authors } : {}), ...(draft.event === 'reaction_added' && reactions.length ? { reactions } : {}), ...(draft.runWhen.trim() ? { runWhen: draft.runWhen.trim() } : {}) }
}
function linearTrigger(draft: LinearTriggerDraft): EventTrigger {
  const labels = list(draft.labels)
  return { source: 'linear', event: draft.event, teams: draft.teams, ...(labels.length ? { labels } : {}), ...(draft.runWhen.trim() ? { runWhen: draft.runWhen.trim() } : {}) }
}

function destinationOf(machine: string): TaskDestination | undefined {
  if (machine === 'auto') return undefined
  if (machine === 'cloud') return { kind: 'cloud' }
  if (machine === 'cloudflare') return { kind: 'cloud', provider: 'cloudflare' }
  return { kind: 'device', deviceId: machine }
}

/** Whether 每天 at this time needs the person to choose the earlier or the later of two times. */
export function foldNeeded(draft: Pick<AutomationDraft, 'scheduleOn' | 'scheduleKind' | 'dailyTime' | 'timezone'>, now = new Date()): boolean {
  if (!draft.scheduleOn || draft.scheduleKind !== 'daily' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.dailyTime)) return false
  try { return dailyTimeRepeats(draft.dailyTime, draft.timezone, now) } catch { return false }
}

/** The definition to save, or the first field that keeps it from saving. */
export function definitionFrom(draft: AutomationDraft, now = new Date()): { definition: Definition } | { missing: 'title' | 'prompt' | 'agent' | 'thread' | 'time' | 'fold' | 'interval' | 'cron' | 'repository' | 'team' | 'channel' | 'slackAuthors' } {
  const title = draft.title.trim()
  if (!title) return { missing: 'title' }
  if (!draft.otherTask && !draft.prompt.trim()) return { missing: 'prompt' }
  if (!draft.otherTask && !draft.agent) return { missing: 'agent' }
  if (!draft.otherTask && draft.eachRun === 'existing_thread' && !draft.singleThreadId) return { missing: 'thread' }
  if (draft.github.some(trigger => !trigger.repositories.length)) return { missing: 'repository' }
  if (draft.linear.some(trigger => !trigger.teams.length)) return { missing: 'team' }
  if (draft.slack.some(trigger => !trigger.channels.length)) return { missing: 'channel' }
  if (draft.slack.some(trigger => {
    const authors = list(trigger.authors)
    return authors.length > 20 || !authors.every(slackUserId)
  })) return { missing: 'slackAuthors' }
  let timing: Definition['timing']
  if (!draft.scheduleOn) timing = { kind: 'manual' }
  else if (draft.scheduleKind === 'once') {
    const at = instant(draft.onceAt, draft.timezone)
    if (!at) return { missing: 'time' }
    timing = { kind: 'once', at }
  } else if (draft.scheduleKind === 'interval') {
    const start = instant(draft.intervalStart, draft.timezone)
    const minutes = Math.round(draft.intervalValue * UNIT_MINUTES[draft.intervalUnit])
    if (!start) return { missing: 'time' }
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 525600) return { missing: 'interval' }
    timing = { kind: 'interval', start, minutes }
  } else if (draft.scheduleKind === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.dailyTime)) return { missing: 'time' }
    const needed = foldNeeded(draft, now)
    if (needed && !draft.fold) return { missing: 'fold' }
    timing = { kind: 'daily', time: draft.dailyTime, fold: needed ? draft.fold! : draft.fold ?? 'earlier', gap: 'skip' }
  } else {
    if (draft.cron.trim().split(/\s+/).length !== 5) return { missing: 'cron' }
    timing = { kind: 'cron', expression: draft.cron.trim() }
  }
  const destination = destinationOf(draft.machine)
  const task: Definition['task'] = draft.otherTask ?? {
    kind: 'dispatch_task', botId: draft.botId, prompt: draft.prompt.trim(),
    ...(draft.taskTitle.trim() ? { title: draft.taskTitle.trim() } : {}),
    ...(destination ? { destination } : {}),
    ...(draft.profileId !== 'auto' ? { profileId: draft.profileId } : {}),
    ...(draft.agent ? { agent: draft.agent } : {}),
  }
  const events = draft.otherTask ? [] : [...draft.github.map(eventTrigger), ...draft.linear.map(linearTrigger), ...draft.slack.map(slackTrigger)]
  const description = draft.description.trim()
  // Run settings belong to a dispatched task; a chat-made automation's own task keeps none.
  const run: Partial<Definition> = draft.otherTask ? {} : {
    ...(draft.environmentId ? { environmentId: draft.environmentId } : {}),
    ...(draft.eachRun === 'existing_thread' && draft.singleThreadId ? { singleThreadId: draft.singleThreadId } : {}),
    ...(draft.model ? { model: { id: draft.model, ...(draft.effort ? { effort: draft.effort } : {}) } } : {}),
    ...(draft.machineSize ? { machineSize: draft.machineSize } : {}),
    ...(draft.pin ? { runs: { pin: true as const } } : {}),
    ...(draft.eachRun !== 'new_task' ? { eachRun: draft.eachRun } : {}),
  }
  return { definition: { title, ...(description ? { description } : {}), timezone: draft.timezone, timing, task, misfire: draft.misfire, maxLatenessMinutes: Math.round(draft.lateness), maxConcurrent: Math.round(draft.concurrent), ...(draft.perDay > 0 ? { maxRunsPerDay: Math.round(draft.perDay) } : {}), ...run, ...(events.length ? { events } : {}), ...(!draft.otherTask && draft.webhook !== null ? { webhook: { batchMinutes: Math.round(draft.webhook) } } : {}), ...(!draft.otherTask && draft.notify ? { notify: { slack: draft.notify } } : {}) } }
}

/** 5-field cron forms the list can name: every day, weekdays, one weekday, one day of the month. Anything else shows the expression. */
export function cronShape(expression: string): { kind: 'daily' | 'weekdays'; hour: number; minute: number } | { kind: 'weekly' | 'monthly'; hour: number; minute: number; day: number } | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  if (!/^\d{1,2}$/.test(minute!) || !/^\d{1,2}$/.test(hour!) || month !== '*') return null
  const time = { hour: Number(hour), minute: Number(minute) }
  if (time.hour > 23 || time.minute > 59) return null
  if (dayOfMonth !== '*') return /^\d{1,2}$/.test(dayOfMonth!) && Number(dayOfMonth) >= 1 && Number(dayOfMonth) <= 31 && dayOfWeek === '*' ? { kind: 'monthly', ...time, day: Number(dayOfMonth) } : null
  if (dayOfWeek === '*') return { kind: 'daily', ...time }
  if (dayOfWeek === '1-5') return { kind: 'weekdays', ...time }
  if (/^[0-7]$/.test(dayOfWeek!)) return { kind: 'weekly', ...time, day: Number(dayOfWeek) % 7 }
  return null
}
