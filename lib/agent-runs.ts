import 'server-only'
import { snapshotMailboxTools } from '@/lib/personal-mailbox-capability'
import { freezeWorkerDefinition } from '@/lib/agent-kit/worker'
import type { AgentExecution } from '@/lib/agent-kit/store'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { SubscriptionRepository } from '@/lib/subscription-repository'
import { agents, agentRuns, bots, deviceRepos, devices, issues, runChunks, runMessages, type SupportedHarness } from '@/lib/db/schema'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { localExecutionHarnesses } from '@/lib/device-agents'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { issueVisibility } from '@/lib/issue-visibility'
import { workspaceRunView } from '@/lib/run-visibility'
import { issueForUser } from '@/lib/issue-access'
import { tiptapToText } from '@/lib/tiptap-text'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { runPrompt } from '@/lib/run-prompt'
import { dispatchInput, dispatchRequestKey, type DispatchInput, type DispatchResult } from '@/lib/run-dispatch'
import { sendOwnedRunMessage, stopOwnedRun } from '@/lib/run-control'
import { runBotName } from '@/lib/run-bot-name'

// Run operations for one person, by user id. The agent actions call these
// with the session's user; the Coordinator calls them with its owner's.

export interface RunView {
  id: string
  issueId: string | null
  agentId: string
  agentName: string
  harness: SupportedHarness
  status: string
  kind: string
  stopReason: string | null
  error: string | null
  report: Record<string, unknown> | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

export interface RunDetail {
  run: RunView
  chunks: Record<string, unknown>[]
  messages: { id: string; text: string; createdAt: Date }[]
}

export const runViewColumns = {
  id: agentRuns.id, issueId: agentRuns.issueId, agentId: agentRuns.agentId, agentName: runBotName,
  harness: sql<SupportedHarness>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`, status: agentRuns.status, kind: agentRuns.kind, stopReason: agentRuns.stopReason,
  error: agentRuns.error, report: agentRuns.report, createdAt: agentRuns.createdAt,
  startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt,
}

/**
 * Queues one run of one agent against one issue. The daemon picks it up on its
 * next poll, claims it, and reports back through `/v1/runs/:runId/complete`.
 * `note` is extra direction for this run only, after the issue.
 */
/** `botId` is the bot that dispatched the run (null for the Coordinator); the run reports back to that bot's chat. */
type LocalDispatchInput = { issueId: string; agentId: string; repo: string; note?: string; requestKey?: string }
export async function queueRun(userId: string, input: LocalDispatchInput, botId: string | null = null, execution?: AgentExecution, requestEventId?: string, source: 'mcp' | null = null, approvedRepositoryKey?: string) {
  return queueAdmittedRun(userId, input, botId, execution, requestEventId, source, approvedRepositoryKey)
}

/** Only the Factory/Skill host calls this with an already-open transaction.
 * Repository ids identify prior scheduling metadata; they confer no authority. */
export async function queueFactoryRun(tx: import('pg').PoolClient, userId: string, input: DispatchInput,
  botId: string | null = null, context?: { sourceEventId: string; attemptId: string }, sourceRunId?: string): Promise<DispatchResult> {
  const parsed = dispatchInput.safeParse(input)
  if (!parsed.success || Boolean(context) === Boolean(sourceRunId)) throw new ActionFailureError('runInvalid')
  const { factoryDispatchDatabase } = await import('./factory/transaction')
  const executor = factoryDispatchDatabase(tx)
  return withDatabaseClient(tx, async () => {
    const [repo] = await executor.select().from(deviceRepos).where(and(eq(deviceRepos.id, parsed.data.deviceRepoId), eq(deviceRepos.userId, userId))).limit(1)
    if (!repo?.remoteUrl) throw new ActionFailureError('agentRepoMissing')
    let requestEventId: string | undefined
    if (context) {
      const { rows: [event] } = await tx.query(`SELECT e.payload FROM coordinator_events e
        JOIN factory_tasks t ON t."sourceEventId"=e.id AND t."userId"=e."userId" AND t."botId" IS NOT DISTINCT FROM e."botId"
        JOIN factory_attempts a ON a."taskId"=t.id AND a.id=t."attemptId"
        WHERE e.id=$1 AND e."userId"=$2 AND (e."issueId" IS NULL OR e."issueId"=$3) AND e."botId" IS NOT DISTINCT FROM $4::uuid
          AND e.kind='user_message' AND t."issueId"=$3 AND a.id=$5`, [context.sourceEventId, userId, parsed.data.issueId, botId, context.attemptId])
      if (!event) throw new ActionFailureError('runInvalid')
      // Even malformed destination data must reach the strict host-bound
      // admission check; an unbound ordinary chat request remains valid intake.
      if (Object.hasOwn(event.payload ?? {}, 'taskDestination')) requestEventId = context.sourceEventId
    } else if (sourceRunId) {
      const [source] = await executor.select().from(agentRuns).where(and(eq(agentRuns.id, sourceRunId), eq(agentRuns.userId, userId), eq(agentRuns.issueId, parsed.data.issueId), eq(agentRuns.agentId, parsed.data.agentId), eq(agentRuns.deviceRepoId, parsed.data.deviceRepoId))).limit(1)
      if (!source) throw new ActionFailureError('runInvalid')
      botId = source.botId
      requestEventId = source.agentDefinition?.repositoryAdmission?.requestEventId
    }
    const result = await queueAdmittedRun(userId, { ...parsed.data, repo: repo.remoteUrl, requestKey: parsed.data.requestKey ?? (context ? `factory:${context.attemptId}` : undefined) }, botId, undefined, requestEventId, null, undefined, { executor, repo, client: tx, sourceRunId })
    const [run] = await executor.select({ status: agentRuns.status }).from(agentRuns).where(and(eq(agentRuns.id, result.runId), eq(agentRuns.userId, userId))).limit(1)
    if (!run) throw new ActionFailureError('runInvalid')
    return { runId: result.runId, status: run.status, replayed: result.replayed ?? false }
  })
}

async function queueAdmittedRun(userId: string, input: LocalDispatchInput, botId: string | null, execution?: AgentExecution,
  requestEventId?: string, source: 'mcp' | null = null, approvedRepositoryKey?: string,
  internal?: { executor: Pick<typeof db, 'select' | 'transaction'>; repo: typeof deviceRepos.$inferSelect; client: import('pg').PoolClient; sourceRunId?: string }) {
  const executor = internal?.executor ?? db
  const parsed = z.object({ issueId: z.uuid(), agentId: z.uuid(), repo: z.string().trim().min(1).max(4_000), note: z.string().trim().max(10_000).optional(), requestKey: dispatchRequestKey.optional() }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError('runInvalid')
  let requestedRepositoryKey: string
  try { requestedRepositoryKey = normalizeRepository(parsed.data.repo, { allowFile: daemonTestMode(process.env) }).key } catch { throw new ActionFailureError('repoPathInvalid') }
  if (approvedRepositoryKey && (!requestEventId || requestedRepositoryKey !== approvedRepositoryKey)) throw new ActionFailureError('runInvalid')
  const issue = await issueForUser(userId, parsed.data.issueId, false, executor)
  if (!issue) throw new ActionFailureError('issueNotFound')
  const [agent] = await executor.select().from(agents)
    .where(and(eq(agents.id, parsed.data.agentId), eq(agents.userId, userId))).limit(1)
  if (!agent?.deviceId) throw new ActionFailureError('agentNoDevice')
  const [device] = await executor.select().from(devices).where(and(eq(devices.id, agent.deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'))).limit(1)
  if (!device?.enabled || !localExecutionHarnesses(device.harnesses).includes(agent.harness)) throw new ActionFailureError('agentHarnessMissing')
  const repo = internal?.repo ?? await ensureDeviceRepository(userId, agent.deviceId, parsed.data.repo)
  const runId = crypto.randomUUID()
  const prompt = runPrompt(issue.title, tiptapToText(issue.content), agent.instructions, parsed.data.note)
  const captureDefinition = true
  const subscription = captureDefinition && process.env.MIKKA_BYOS_ENABLED === '1' ? await new SubscriptionRepository(pool).nativeBinding(userId,agent.id,agent.harness) : null
  const mailboxEnabled = process.env.MIKKA_PERSONAL_MAILBOX_ENABLED === '1'
  let mailboxScope: { botId: string | null; workspaceId: string } | undefined
  if (captureDefinition && mailboxEnabled && snapshotMailboxTools(execution?.snapshot).length) {
    const [bot] = botId ? await executor.select({ workspaceId: bots.workspaceId }).from(bots)
      .where(and(eq(bots.id, botId), eq(bots.ownerId, userId))).limit(1) : []
    if (botId && !bot) throw new ActionFailureError('runInvalid')
    mailboxScope = { botId, workspaceId: bot?.workspaceId ?? (await import('@/lib/device-link')).WORKSPACE_ID }
  }
  const agentDefinition = captureDefinition
    ? freezeWorkerDefinition({ harness: agent.harness, instructions: agent.instructions, prompt, parent: execution?.snapshot ?? null, executionId: execution?.id ?? null,subscription, mailboxEnabled, mailboxScope })
    : null
  return (await import('@/lib/run-admission-store')).acceptLocalRun({ id: runId, userId, botId, issueId: issue.id, agentId: agent.id, deviceId: agent.deviceId,
    deviceRepoId: repo.id, prompt, source, definition: agentDefinition!, ...(requestEventId ? { requestEventId } : {}), ...(approvedRepositoryKey ? { approvedRepositoryKey } : {}), ...(parsed.data.requestKey ? { dispatch: { issueId: issue.id, agentId: agent.id, deviceRepoId: repo.id, note: parsed.data.note, requestKey: parsed.data.requestKey } } : {}), ...(internal ? { continuation: true, sourceRunId: internal.sourceRunId } : {}) }, internal?.client)
}

/** Every surface uses this gate. Workspace membership never grants run control,
 * personal agent/session access, or raw transcript access. */
export async function visibleRuns(userId: string, input: { issueId?: string; runIds?: string[]; activeOnly?: boolean; limit?: number } = {}): Promise<RunView[]> {
  if (input.issueId && !z.uuid().safeParse(input.issueId).success) return []
  if (input.runIds && (!input.runIds.length || input.runIds.some(id => !z.uuid().safeParse(id).success))) return []
  const visibility = await issueVisibility(userId)
  const shared = visibility.allowedIds.length ? and(eq(issues.scope, 'workspace'), inArray(issues.id, visibility.allowedIds)) : sql`false`
  const rows = await db.select({ ...runViewColumns, ownerId: agentRuns.userId }).from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(
      or(and(eq(agentRuns.userId, userId), or(isNull(agentRuns.issueId), visibility.predicate)), and(visibility.predicate, shared)),
      input.issueId ? eq(agentRuns.issueId, input.issueId) : undefined,
      input.runIds ? inArray(agentRuns.id, input.runIds) : undefined,
      input.activeOnly ? inArray(agentRuns.status, [...UNFINISHED_RUN_STATUSES]) : undefined,
    )).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(Math.max(1, Math.min(input.limit ?? 20, 100)))
  return rows.map(({ ownerId, ...run }) => ownerId === userId ? run : workspaceRunView(run))
}

export async function readRun(userId: string, runId: string): Promise<RunDetail | null> {
  const [run] = await visibleRuns(userId, { runIds: [runId], limit: 1 })
  if (!run) return null
  // Empty agentId is the deliberately restricted teammate projection.
  if (!run.agentId) return { run, chunks: [], messages: [] }
  const chunks = await db.select({ chunk: runChunks.chunk }).from(runChunks)
    .where(eq(runChunks.runId, run.id)).orderBy(asc(runChunks.seq))
  const messages = await db.select({ id: runMessages.id, text: runMessages.text, createdAt: runMessages.createdAt })
    .from(runMessages).where(eq(runMessages.runId, run.id)).orderBy(asc(runMessages.createdAt))
  return { run, chunks: chunks.map(row => row.chunk), messages }
}

/** A message to the running agent; the daemon delivers it. */
export async function addRunMessage(
  userId: string,
  input: { runId: string; text: string },
  source:'user'|'peer'|{source:'human';sessionId:string}|{source:'orchestrator'}='user',
): Promise<void> {
  const parsed = z
    .object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000) })
    .safeParse(input)
  if (!parsed.success) throw new ActionFailureError('messageRequired')
  // Ordinary user/peer traffic keeps main's single locked owner/state check.
  // Only a host-attested browser session may enter ended Factory questions.
  if (typeof source === 'string' || source.source === 'orchestrator')
    return sendOwnedRunMessage(db,userId,parsed.data,typeof source === 'string' ? source : 'peer')
  const [run] = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.id, parsed.data.runId), eq(agentRuns.userId, userId)),
    )
    .limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  if (
    !['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(
      run.status,
    )
  ) {
    const { factoryQuestions } = await import('@/lib/factory/server')
    const { pool } = await import('@/lib/db')
    const {
      rows: [identity],
    } = await pool.query(
      'SELECT id FROM factory_questions WHERE "originRunId"=$1 AND "userId"=$2',
      [run.id, userId],
    )
    if (!identity) throw new ActionFailureError('runNotActive')
    const q = await factoryQuestions.read(userId, identity.id)
    if (q.status === 'resolved' && q.continuationRunId) {
      const previous = q.answer as {
        input?: { text?: string; reference?: unknown }
      } | null
      if (previous?.input?.text !== parsed.data.text)
        return addRunMessage(
          userId,
          { runId: q.continuationRunId, text: parsed.data.text },
          source,
        )
    }
    if (typeof source==='string' || source.source !== 'human')
      throw new ActionFailureError('factoryQuestionNeedsAnswerTool')
    const { factoryEventId } = await import('@/lib/factory/event-id')
    const { questionReference } = await import('@/lib/factory/questions/store')
    const { questionFingerprint } =
      await import('@/lib/factory/questions/contract')
    const previous = q.answer as {
      input?: { reference?: ReturnType<typeof questionReference> }
    } | null
    const answerId = factoryEventId(
      'task-thread-question-answer',
      questionFingerprint({ questionId: q.id, userId, text: parsed.data.text }),
    )
    await factoryQuestions.answer(
      { source: 'human', userId, sessionId: source.sessionId },
      {
        reference:
          q.answerId === answerId && previous?.input?.reference
            ? previous.input.reference
            : questionReference(q),
        answerId,
        text: parsed.data.text,
      },
    )
    return
  }
  await sendOwnedRunMessage(db,userId,parsed.data,typeof source==='string'?source:source.source==='human'?'user':'peer')
}
/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function requestRunStop(userId: string, runId: string): Promise<void> {
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) throw new ActionFailureError('runNotFound')
  await stopOwnedRun(db, userId, parsed.data)
}
