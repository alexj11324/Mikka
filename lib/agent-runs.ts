import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { db } from '@/lib/db'
import { MailboxError } from '@/lib/session-mailbox'
import { mailboxes } from '@/lib/mailbox-runtime'
import { agents, agentRuns, deviceRepos, runChunks, runMessages, type SupportedHarness } from '@/lib/db/schema'
import { issueForUser } from '@/lib/issue-access'
import { tiptapToText } from '@/lib/tiptap-text'

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
  id: agentRuns.id, issueId: agentRuns.issueId, agentId: agentRuns.agentId, agentName: agents.name,
  harness: agents.harness, status: agentRuns.status, kind: agentRuns.kind, stopReason: agentRuns.stopReason,
  error: agentRuns.error, report: agentRuns.report, createdAt: agentRuns.createdAt,
  startedAt: agentRuns.startedAt, finishedAt: agentRuns.finishedAt,
}

/**
 * Queues one run of one agent against one issue. The daemon picks it up on its
 * next poll, claims it, and reports back through `/v1/runs/:runId/complete`.
 * `note` is extra direction for this run only, after the issue.
 */
export async function queueRun(userId: string, input: { issueId: string; agentId: string; deviceRepoId: string; note?: string }): Promise<{ runId: string }> {
  const parsed = z.object({ issueId: z.uuid(), agentId: z.uuid(), deviceRepoId: z.uuid(), note: z.string().trim().max(10_000).optional() }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError('runInvalid')
  const issue = await issueForUser(userId, parsed.data.issueId)
  if (!issue) throw new ActionFailureError('issueNotFound')
  const [agent] = await db.select().from(agents)
    .where(and(eq(agents.id, parsed.data.agentId), eq(agents.userId, userId))).limit(1)
  if (!agent?.deviceId) throw new ActionFailureError('agentNoDevice')
  const [repo] = await db.select().from(deviceRepos)
    .where(and(eq(deviceRepos.id, parsed.data.deviceRepoId), eq(deviceRepos.deviceId, agent.deviceId), eq(deviceRepos.userId, userId))).limit(1)
  if (!repo) throw new ActionFailureError('agentRepoMissing')
  const runId = crypto.randomUUID()
  await db.insert(agentRuns).values({
    id: runId, userId, issueId: issue.id, agentId: agent.id, deviceId: agent.deviceId,
    deviceRepoId: repo.id, status: 'queued', kind: 'implement', baseBranch: repo.baseBranch,
    prompt: runPrompt(issue.title, tiptapToText(issue.content), agent.instructions, parsed.data.note),
  })
  return { runId }
}

/** The brief the agent starts from: the issue, any note for this run, then the agent's own role. */
function runPrompt(title: string, body: string, instructions: string, note?: string): string {
  const parts = [`# ${title}`]
  if (body) parts.push(body)
  if (note) parts.push('## Notes for this run', note)
  parts.push('---', 'Work in the repository checked out for this run. When you are done, hand in your work with a short summary of what changed.')
  if (instructions) parts.push('## Your standing instructions', instructions)
  return parts.join('\n\n').slice(0, 100_000)
}

export async function readRun(userId: string, runId: string): Promise<RunDetail | null> {
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) return null
  const [run] = await db.select(runViewColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.id, parsed.data), eq(agentRuns.userId, userId))).limit(1)
  if (!run) return null
  const chunks = await db.select({ chunk: runChunks.chunk }).from(runChunks)
    .where(eq(runChunks.runId, run.id)).orderBy(asc(runChunks.seq))
  const messages = await db.select({ id: runMessages.id, text: runMessages.text, createdAt: runMessages.createdAt })
    .from(runMessages).where(eq(runMessages.runId, run.id)).orderBy(asc(runMessages.createdAt))
  return { run, chunks: chunks.map(row => row.chunk), messages }
}

/** A message to the running agent; the daemon delivers it. */
export async function addRunMessage(userId: string, input: { runId: string; text: string }): Promise<void> {
  const parsed = z.object({ runId: z.uuid(), text: z.string().trim().min(1).max(10_000) }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError('messageRequired')
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns)
    .where(and(eq(agentRuns.id, parsed.data.runId), eq(agentRuns.userId, userId))).limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  await db.insert(runMessages).values({ id: crypto.randomUUID(), runId: run.id, userId, text: parsed.data.text })
}

/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function requestRunStop(userId: string, runId: string): Promise<void> {
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) throw new ActionFailureError('runNotFound')
  try { await mailboxes.stop(userId, runId) }
  catch (error) { if (error instanceof MailboxError) throw new ActionFailureError('runNotFound'); throw error }
}
