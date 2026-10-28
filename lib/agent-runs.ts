import 'server-only'
import { freezeWorkerDefinition } from '@/lib/agent-kit/worker'
import type { AgentExecution } from '@/lib/agent-kit/store'
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db, pool } from '@/lib/db'
import { SubscriptionRepository } from '@/lib/subscription-repository'
import { agents, agentRuns, devices, issues, repositorySettings, runPublications, runChunks, runMessages, type SupportedHarness } from '@/lib/db/schema'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { localExecutionHarnesses } from '@/lib/device-agents'
import { daemonTestMode, normalizeRepository } from '@mikka/protocol/repository'
import { issueVisibility } from '@/lib/issue-visibility'
import { workspaceRunView } from '@/lib/run-visibility'
import { issueForUser } from '@/lib/issue-access'
import { tiptapToText } from '@/lib/tiptap-text'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { runPrompt } from '@/lib/run-prompt'
import { sendOwnedRunMessage, stopOwnedRun } from '@/lib/run-control'
import { runBotName } from '@/lib/run-bot-name'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { publicationBranch } from '@/lib/run-publication-policy'
import { admitRepositoryTask } from '@/lib/repository-admission'

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
export async function queueRun(userId: string, input: { issueId: string; agentId: string; repo: string; note?: string }, botId: string | null = null, execution?: AgentExecution): Promise<{ runId: string }> {
  const parsed = z.object({ issueId: z.uuid(), agentId: z.uuid(), repo: z.string().trim().min(1).max(4_000), note: z.string().trim().max(10_000).optional() }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError('runInvalid')
  const issue = await issueForUser(userId, parsed.data.issueId)
  if (!issue) throw new ActionFailureError('issueNotFound')
  const [agent] = await db.select().from(agents)
    .where(and(eq(agents.id, parsed.data.agentId), eq(agents.userId, userId))).limit(1)
  if (!agent?.deviceId) throw new ActionFailureError('agentNoDevice')
  const [device] = await db.select().from(devices).where(and(eq(devices.id, agent.deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'))).limit(1)
  if (!device?.enabled || !localExecutionHarnesses(device.harnesses).includes(agent.harness)) throw new ActionFailureError('agentHarnessMissing')
  try { normalizeRepository(parsed.data.repo, { allowFile: daemonTestMode(process.env) }) } catch { throw new ActionFailureError('repoPathInvalid') }
  const repo = await ensureDeviceRepository(userId, agent.deviceId, parsed.data.repo)
  const runId = crypto.randomUUID()
  const prompt = runPrompt(issue.title, tiptapToText(issue.content), agent.instructions, parsed.data.note)
  const captureDefinition = process.env.MIKKA_AGENT_KIT === '1' || Boolean(execution)
  const subscription = captureDefinition && process.env.MIKKA_BYOS_ENABLED === '1' ? await new SubscriptionRepository(pool).nativeBinding(userId,agent.id,agent.harness) : null
  const agentDefinition = captureDefinition
    ? freezeWorkerDefinition({ harness: agent.harness, instructions: agent.instructions, prompt, parent: execution?.snapshot ?? null, executionId: execution?.id ?? null,subscription })
    : null
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', userId, repo.repoPath])}, 0))`)
    const [setting] = await tx.select().from(repositorySettings).where(and(eq(repositorySettings.userId, userId), eq(repositorySettings.remoteKey, repo.repoPath)))
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-publication:' + issue.id}, 0))`)
    const [previous] = await tx.select().from(runPublications).where(and(eq(runPublications.issueId, issue.id), eq(runPublications.remoteKey, repo.repoPath), sql`${runPublications.branch} is not null`)).orderBy(asc(runPublications.createdAt)).limit(1)
    const identifiers = await taskIdentifiers([{ id: issue.id, ownerId: issue.userId, scope: issue.scope, number: readIssueMetadata(issue.content).number }], tx)
    const identifier = previous?.identifier ?? identifiers.get(issue.id) ?? null
    const branch = previous?.branch ?? publicationBranch(identifier)
    if (!branch || !repo.remoteUrl) throw new ActionFailureError('runInvalid')
    const admission = admitRepositoryTask({ userId, issueId: issue.id, remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl, targetBranch: branch, push: setting?.push, now: new Date() })
    if (!admission) throw new ActionFailureError('runInvalid')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'repository-branch:' + repo.repoPath + ':' + branch}, 0))`)
    const [collision] = await tx.select({ runId: runPublications.runId }).from(runPublications).where(and(eq(runPublications.remoteKey, repo.repoPath), eq(runPublications.branch, branch), sql`${runPublications.issueId} <> ${issue.id}`)).limit(1)
    if (collision) throw new ActionFailureError('runInvalid')
    await tx.insert(agentRuns).values({
      id: runId, userId, botId, issueId: issue.id, agentId: agent.id, deviceId: agent.deviceId,
      deviceRepoId: repo.id, status: 'queued', kind: 'implement', baseBranch: repo.baseBranch,
      prompt, agentDefinition, repositoryAdmission: admission,
    })
    await tx.insert(runPublications).values({ runId, userId, issueId: issue.id, remoteUrl: repo.remoteUrl, remoteKey: repo.repoPath, identifier, branch, baseBranch: repo.baseBranch, pushApproved: true })
  })
  return { runId }
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
      or(eq(agentRuns.userId, userId), and(visibility.predicate, shared)),
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
export async function addRunMessage(userId: string, input: { runId: string; text: string }, origin: 'user' | 'peer' = 'user'): Promise<void> {
  const parsed = z.object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000) }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError('messageRequired')
  await sendOwnedRunMessage(db, userId, parsed.data, origin)
}

/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function requestRunStop(userId: string, runId: string): Promise<void> {
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) throw new ActionFailureError('runNotFound')
  await stopOwnedRun(db, userId, parsed.data)
}
