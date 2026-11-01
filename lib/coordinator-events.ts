import type { RunReport } from '@mikka/protocol/run'
import type { CoordinatorEventKind, RunStatus } from '@/lib/db/schema'
import type { PublicationErrorCode, PublishedPullRequest } from '@/lib/run-publication-result'

/** One row for `coordinator_events`, before it gets an id. */
export interface CoordinatorEventInput {
  userId: string
  /** The bot whose chat it goes to; null or absent when the work has no bot of its own, which goes to the person's Coordinator. */
  botId?: string | null
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

/** A message the person wrote to their Coordinator, or to one of their bots (`botId`). */
export function userMessageEvent(
  userId: string,
  text: string,
  options: { issueId?: string | null; telegram?: TelegramMessageSource; botId?: string | null } = {},
): CoordinatorEventInput {
  const id = crypto.randomUUID()
  const telegram = options.telegram
  return {
    userId,
    ...(options.botId ? { botId: options.botId } : {}),
    kind: 'user_message',
    dedupeKey: telegram ? 'telegram:' + telegram.threadId + ':' + telegram.messageId : 'user_message:' + id,
    issueId: options.issueId ?? null,
    runId: null,
    payload: { text, ...(telegram ? { telegram } : {}) },
  }
}

/** OAuth delegates access to an Agent; it does not turn Agent prose into a
 * human decision. Result tier preserves the existing wake-on-send behaviour.
 */
export function peerCoordinatorMessageEvent(userId: string, text: string): CoordinatorEventInput & { tier: 'result' } {
  return { userId, kind: 'run_report', dedupeKey: 'peer_message:' + crypto.randomUUID(), issueId: null, runId: null,
    payload: { text, source: 'oauth_agent_mcp' }, tier: 'result' }
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
export function runFinishedEvent(run: { id: string; userId: string; botId?: string | null; issueId: string | null; kind: string; status: RunStatus; stopReason: string; report?: RunReport | null; publication?: { pullRequest?: PublishedPullRequest | null; errorCode?: PublicationErrorCode | null; branch?: string | null } }): CoordinatorEventInput {
  return {
    userId: run.userId,
    ...(run.botId ? { botId: run.botId } : {}),
    kind: 'run_finished',
    dedupeKey: `run_finished:${run.id}`,
    issueId: run.issueId,
    runId: run.id,
    payload: { status: run.status, stopReason: run.stopReason, runKind: run.kind, summary: run.report?.summary ?? null, ...(run.report?.verify?.status === 'not_run' && run.kind !== 'plan' ? { verification: 'not_run' } : {}), ...(run.publication ? { publication: run.publication } : {}) },
  }
}

/** A run lost its device and was queued again as `retryRunId`. Background: nobody needs to act. */
/** Where a lost run went on (decision 2026-10-31-2200-run-machine-fallback): the person's own E2B cloud, or another of their devices. */
export type RunMovedTo = { kind: 'cloud' } | { kind: 'device'; deviceId: string }

export function runRetriedEvent(run: { id: string; userId: string; botId?: string | null; issueId: string | null }, retry: { runId: string; attempt: number; maxAttempts: number; movedToDeviceId?: string | null; movedTo?: RunMovedTo | null }): CoordinatorEventInput {
  return {
    userId: run.userId,
    ...(run.botId ? { botId: run.botId } : {}),
    kind: 'run_retried',
    dedupeKey: `run_retried:${run.id}`,
    issueId: run.issueId,
    runId: run.id,
    payload: { retryRunId: retry.runId, attempt: retry.attempt, maxAttempts: retry.maxAttempts, ...(retry.movedToDeviceId ? { movedToDeviceId: retry.movedToDeviceId } : {}), ...(retry.movedTo ? { movedTo: retry.movedTo } : {}) },
  }
}

/** Which subscription a run was on: its byos_connections id, or null for a device's own CLI login. */
export interface QuotaSubscription { provider: 'claude' | 'codex'; connectionId: string | null }

/** The API key a quota continuation runs on, without the key itself. */
export interface QuotaApiKey { keyId: string; provider: string; name: string | null; last4: string; model: string }

/** A subscription's quota ran out mid-run and the run went on as `retryRunId` on the person's API key. */
export function runCredentialSwitchedEvent(run: { id: string; userId: string; botId?: string | null; issueId: string | null }, from: QuotaSubscription, to: QuotaApiKey, retryRunId: string, resetsAt: string | null): CoordinatorEventInput {
  return {
    userId: run.userId,
    ...(run.botId ? { botId: run.botId } : {}),
    kind: 'run_credential_switched',
    dedupeKey: `run_credential_switched:${run.id}`,
    issueId: run.issueId,
    runId: run.id,
    payload: {
      reason: 'quota_exhausted',
      from: { kind: 'subscription', provider: from.provider, connectionId: from.connectionId },
      to: { kind: 'api_key', keyId: to.keyId, provider: to.provider, name: to.name, last4: to.last4, model: to.model },
      retryRunId, resetsAt,
    },
  }
}

/** A subscription's quota ran out mid-run and nothing could go on with it: the run is paused for the person. */
export function runQuotaPausedEvent(run: { id: string; userId: string; botId?: string | null; issueId: string | null }, from: QuotaSubscription, resetsAt: string | null, why: 'apiKeyAfterQuotaOff' | 'noApiKey'): CoordinatorEventInput {
  return {
    userId: run.userId,
    ...(run.botId ? { botId: run.botId } : {}),
    kind: 'run_quota_paused',
    dedupeKey: `run_quota_paused:${run.id}`,
    issueId: run.issueId,
    runId: run.id,
    payload: {
      reason: 'quota_exhausted', provider: from.provider, connectionId: from.connectionId, resetsAt, why,
      actions: [{ action: 'addApiKey' }, { action: 'retryAfterReset', at: resetsAt }],
    },
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
interface WorkerRun { id: string; userId: string; botId?: string | null; issueId: string | null }

function workerEvent(kind: 'run_report' | 'run_question' | 'run_blocked', run: WorkerRun, payload: Record<string, unknown>): CoordinatorEventInput {
  return { userId: run.userId, ...(run.botId ? { botId: run.botId } : {}), kind, dedupeKey: `${kind}:${run.id}:${crypto.randomUUID()}`, issueId: run.issueId, runId: run.id, payload }
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

/**
 * One item a briefing names, as the Coordinator reads it. `suggestionId`
 * links the item to its suggestion so a client can show it as a chip.
 * `title` is the source's own text until suggestions carry a verb-first
 * action title (R-45, `suggestions.actionTitle`); then that title goes here, with the raw one as fallback.
 */
export interface BriefingEventItem { suggestionId: string; source: string; action: string; title: string; actor: string | null; url: string | null; required: boolean }

/**
 * The person's briefing is ready: the daily one at 08:00 their time, or the
 * first one after they connect an app. One event per briefing kind and local
 * date, so a rerun of the cron does not push it twice.
 */
export function briefingEvent(briefing: { userId: string; localDate: string; kind: 'first' | 'daily'; total: number; counts: Record<string, number> }, items: readonly BriefingEventItem[], personName: string | null = null): CoordinatorEventInput {
  return {
    userId: briefing.userId, kind: 'daily_briefing', dedupeKey: `daily_briefing:${briefing.userId}:${briefing.localDate}:${briefing.kind}`, issueId: null, runId: null,
    payload: { localDate: briefing.localDate, briefingKind: briefing.kind, total: briefing.total, counts: briefing.counts, items, ...(personName ? { personName } : {}) },
  }
}

/** An agent handed over a document or web page (MCP `submit_artifact`). One event per version. */
export function artifactSubmittedEvent(
  submitter: { userId: string; botId?: string | null; runId: string | null; issueId: string | null; authorName: string },
  artifact: { artifactId: string; version: number; title: string; kind: string },
): CoordinatorEventInput {
  return {
    userId: submitter.userId,
    ...(submitter.botId ? { botId: submitter.botId } : {}),
    kind: 'artifact_submitted',
    dedupeKey: `artifact_submitted:${artifact.artifactId}:${artifact.version}`,
    issueId: submitter.issueId,
    runId: submitter.runId,
    payload: { artifactId: artifact.artifactId, version: artifact.version, title: artifact.title, artifactKind: artifact.kind, authorName: submitter.authorName },
  }
}

/** The person approved or declined something an agent proposed in their accounts (lib/pending-actions.ts). */
export function actionDecidedEvent(
  action: { id: string; userId: string; action: string; input: Record<string, unknown> },
  decision: { status: 'done' | 'failed' | 'declined' | 'running'; error: string | null; outcome: Record<string, string> },
  task?: { eventId: string; botId: string | null; issueId: string | null },
): CoordinatorEventInput {
  return {
    userId: action.userId, ...(task ? { botId: task.botId } : {}), kind: 'action_decided', dedupeKey: `action_decided:${action.id}${task ? ':' + task.eventId : ''}`, issueId: task?.issueId ?? null, runId: null,
    payload: { actionId: action.id, action: action.action, input: action.input, status: decision.status, ...(task ? { requestEventId: task.eventId } : {}), ...(decision.error ? { error: decision.error } : {}), outcome: decision.outcome },
  }
}
