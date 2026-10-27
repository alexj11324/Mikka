import type { RunReport } from '@mikka/protocol/run'
import type { CoordinatorEventKind, RunStatus } from '@/lib/db/schema'

/** One row for `coordinator_events`, before it gets an id. */
export interface CoordinatorEventInput {
  userId: string
  kind: CoordinatorEventKind
  dedupeKey: string
  issueId: string | null
  runId: string | null
  payload: Record<string, unknown>
}

export interface TelegramReplyTarget {
  threadId: string
  telegramUserId: string
}

export interface TelegramMessageSource extends TelegramReplyTarget {
  messageId: number
}

/** A message the person wrote to their Coordinator. */
export function userMessageEvent(
  userId: string,
  text: string,
  options: { issueId?: string | null; telegram?: TelegramMessageSource } = {},
): CoordinatorEventInput {
  const id = crypto.randomUUID()
  const telegram = options.telegram
  return {
    userId,
    kind: 'user_message',
    dedupeKey: telegram ? 'telegram:' + telegram.threadId + ':' + telegram.messageId : 'user_message:' + id,
    issueId: options.issueId ?? null,
    runId: null,
    payload: { text, ...(telegram ? { telegram } : {}) },
  }
}

/** Unique Telegram destinations for the user messages in one claimed batch. */
export function telegramReplyTargets(events: ReadonlyArray<Pick<CoordinatorEventInput, 'kind' | 'payload'>>): TelegramReplyTarget[] {
  const targets = new Map<string, TelegramReplyTarget>()
  for (const event of events) {
    if (event.kind !== 'user_message') continue
    const value = event.payload.telegram
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const source = value as Record<string, unknown>
    if (typeof source.threadId !== 'string' || !source.threadId || typeof source.telegramUserId !== 'string' || !source.telegramUserId || typeof source.messageId !== 'number' || !Number.isSafeInteger(source.messageId)) continue
    const target = { threadId: source.threadId, telegramUserId: source.telegramUserId }
    targets.set(JSON.stringify(target), target)
  }
  return [...targets.values()]
}

/** A run ended. One event per run, however often the daemon reports it. */
export function runFinishedEvent(run: { id: string; userId: string; issueId: string | null; kind: string; status: RunStatus; stopReason: string; report?: RunReport | null }): CoordinatorEventInput {
  return {
    userId: run.userId,
    kind: 'run_finished',
    dedupeKey: `run_finished:${run.id}`,
    issueId: run.issueId,
    runId: run.id,
    payload: { status: run.status, stopReason: run.stopReason, runKind: run.kind, summary: run.report?.summary ?? null },
  }
}

/** A run lost its device and was queued again as `retryRunId`. Background: nobody needs to act. */
export function runRetriedEvent(run: { id: string; userId: string; issueId: string | null }, retry: { runId: string; attempt: number; maxAttempts: number; movedToDeviceId?: string | null }): CoordinatorEventInput {
  return {
    userId: run.userId,
    kind: 'run_retried',
    dedupeKey: `run_retried:${run.id}`,
    issueId: run.issueId,
    runId: run.id,
    payload: { retryRunId: retry.runId, attempt: retry.attempt, maxAttempts: retry.maxAttempts, ...(retry.movedToDeviceId ? { movedToDeviceId: retry.movedToDeviceId } : {}) },
  }
}

/**
 * An issue moved to done, or null when this save is not that move. Keyed by
 * the revision that made the move, so reopening and finishing again is a new
 * event.
 */
export function issueDoneEvent(before: { status: string }, after: { id: string; userId: string; title: string; status: string; revision: number }): CoordinatorEventInput | null {
  if (before.status === 'done' || after.status !== 'done') return null
  return {
    userId: after.userId,
    kind: 'issue_done',
    dedupeKey: `issue_done:${after.id}:${after.revision}`,
    issueId: after.id,
    runId: null,
    payload: { title: after.title, previousStatus: before.status },
  }
}

/** The run an agent's worker tool call came from. */
interface WorkerRun { id: string; userId: string; issueId: string | null }

function workerEvent(kind: 'run_report' | 'run_question' | 'run_blocked', run: WorkerRun, payload: Record<string, unknown>): CoordinatorEventInput {
  return { userId: run.userId, kind, dedupeKey: `${kind}:${run.id}:${crypto.randomUUID()}`, issueId: run.issueId, runId: run.id, payload }
}

/** The agent inside a run reached a milestone and says so (MCP `report`). */
export function runReportEvent(run: WorkerRun, text: string): CoordinatorEventInput {
  return workerEvent('run_report', run, { text })
}

/** The agent inside a run asks the person something (MCP `ask`); the answer comes back as an instruction. */
export function runQuestionEvent(run: WorkerRun, question: { question: string; options?: string[]; context?: string }): CoordinatorEventInput {
  return workerEvent('run_question', run, {
    question: question.question,
    ...(question.options ? { options: question.options } : {}),
    ...(question.context ? { context: question.context } : {}),
  })
}

/** The agent inside a run cannot go on (MCP `blocked`). */
export function runBlockedEvent(run: WorkerRun, reason: string): CoordinatorEventInput {
  return workerEvent('run_blocked', run, { reason })
}

/** One item a briefing names, as the Coordinator reads it. */
export interface BriefingEventItem { source: string; action: string; title: string; actor: string | null; url: string | null; required: boolean }

/**
 * The person's briefing is ready: the daily one at 08:00 their time, or the
 * first one after they connect an app. One event per briefing kind and local
 * date, so a rerun of the cron does not push it twice.
 */
export function briefingEvent(briefing: { userId: string; localDate: string; kind: 'first' | 'daily'; total: number; counts: Record<string, number> }, items: readonly BriefingEventItem[]): CoordinatorEventInput {
  return {
    userId: briefing.userId, kind: 'daily_briefing', dedupeKey: `daily_briefing:${briefing.userId}:${briefing.localDate}:${briefing.kind}`, issueId: null, runId: null,
    payload: { localDate: briefing.localDate, briefingKind: briefing.kind, total: briefing.total, counts: briefing.counts, items },
  }
}

/** The person approved or declined something an agent proposed in their accounts (lib/pending-actions.ts). */
export function actionDecidedEvent(
  action: { id: string; userId: string; action: string; input: Record<string, unknown> },
  decision: { status: 'done' | 'failed' | 'declined'; error: string | null; outcome: Record<string, string> },
): CoordinatorEventInput {
  return {
    userId: action.userId, kind: 'action_decided', dedupeKey: `action_decided:${action.id}`, issueId: null, runId: null,
    payload: { actionId: action.id, action: action.action, input: action.input, status: decision.status, ...(decision.error ? { error: decision.error } : {}), outcome: decision.outcome },
  }
}
