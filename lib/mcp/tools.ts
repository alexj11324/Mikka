import 'server-only'
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm'
import type { ModelMessage } from 'ai'
import { readRun, runViewColumns } from '@/lib/agent-runs'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { userMessageEvent } from '@/lib/coordinator-events'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { db } from '@/lib/db'
import { agentRuns, agents, coordinatorMessages, coordinatorSessions, issueMembers, issues } from '@/lib/db/schema'
import { issueForUser } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { tiptapToText } from '@/lib/tiptap-text'

// What the MCP tools read and write, scoped to one person. The Coordinator's
// own tools (workflows/coordinator/steps.ts) read the same tables.

const ACTIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const
/** How often a waiting read checks for the Coordinator's reply. */
const REPLY_POLL_MS = 2000

async function lastPosition(userId: string): Promise<number> {
  const [row] = await db.select({ last: sql<number>`coalesce(max(${coordinatorMessages.position}), 0)` })
    .from(coordinatorMessages).where(eq(coordinatorMessages.userId, userId))
  return Number(row?.last ?? 0)
}

/**
 * Queues a message for the person's Coordinator and wakes it, as the chat
 * does. `after` is the conversation's last position before the reply, to pass
 * to readCoordinatorMessages.
 */
export async function sendToCoordinator(userId: string, text: string) {
  const after = await lastPosition(userId)
  await recordCoordinatorEvent(db, userMessageEvent(userId, text))
  await wakeCoordinator(userId)
  return { queued: true, coordinatorRunning: coordinatorEnabled(), after }
}

/** One stored message as text: what was said, and which tools the Coordinator called. */
function displayMessage(message: ModelMessage): { role: 'user' | 'assistant'; text: string; toolCalls?: string[] } | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  if (typeof message.content === 'string') return { role: message.role, text: message.content }
  const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  const toolCalls = message.content.flatMap(part => part.type === 'tool-call' ? [part.toolName] : [])
  if (!text && !toolCalls.length) return null
  return { role: message.role, text, ...(toolCalls.length ? { toolCalls } : {}) }
}

async function messagesAfter(userId: string, after: number, limit: number) {
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(and(eq(coordinatorMessages.userId, userId), gt(coordinatorMessages.position, after)))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  return rows.reverse().flatMap(row => {
    const shown = displayMessage(row.message as unknown as ModelMessage)
    return shown ? [{ position: row.position, createdAt: row.createdAt.toISOString(), ...shown }] : []
  })
}

/** Whether a turn is running, and why the last one failed (cleared when a turn succeeds). */
async function turnState(userId: string) {
  const [session] = await db.select({ leaseUntil: coordinatorSessions.leaseUntil, lastError: coordinatorSessions.lastError, lastErrorAt: coordinatorSessions.lastErrorAt })
    .from(coordinatorSessions).where(eq(coordinatorSessions.userId, userId)).limit(1)
  return {
    working: Boolean(session?.leaseUntil && session.leaseUntil.getTime() > Date.now()),
    error: session?.lastError ?? null, errorAt: session?.lastErrorAt ?? null,
  }
}

/**
 * The conversation after `after` (the newest `limit` messages). With
 * `waitSeconds`, waits until the Coordinator has replied after `after`, a turn
 * fails, or the time runs out.
 */
export async function readCoordinatorMessages(userId: string, input: { after?: number; limit?: number; waitSeconds?: number }) {
  const after = input.after ?? 0
  const limit = input.limit ?? 20
  const started = new Date()
  const deadline = started.getTime() + (input.waitSeconds ?? 0) * 1000
  for (;;) {
    const [messages, turn] = await Promise.all([messagesAfter(userId, after, limit), turnState(userId)])
    const replied = messages.some(message => message.role === 'assistant')
    const failed = Boolean(turn.errorAt && turn.errorAt >= started)
    if (replied || failed || Date.now() + REPLY_POLL_MS > deadline) {
      return { messages, replied, last: messages.at(-1)?.position ?? after, working: turn.working, lastError: turn.error, coordinatorRunning: coordinatorEnabled() }
    }
    await new Promise(resolve => { setTimeout(resolve, REPLY_POLL_MS) })
  }
}

export async function listIssues(userId: string, input: { status?: string }) {
  const rows = await db.selectDistinct({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority, content: issues.content, updatedAt: issues.updatedAt })
    .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(or(eq(issues.userId, userId), eq(issueMembers.memberId, userId)), input.status ? eq(issues.status, input.status) : undefined))
    .orderBy(desc(issues.updatedAt)).limit(100)
  return rows.filter(row => !readIssueMetadata(row.content).deletedAt).slice(0, 50).map(({ content, updatedAt, ...row }) => ({
    ...row, number: readIssueMetadata(content).number ?? null, updatedAt: updatedAt.toISOString(),
  }))
}

export async function getIssue(userId: string, issueId: string) {
  const issue = await issueForUser(userId, issueId)
  if (!issue) return null
  const runs = await db.select(runViewColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.issueId, issue.id), eq(agentRuns.userId, userId))).orderBy(desc(agentRuns.createdAt)).limit(5)
  return {
    id: issue.id, number: readIssueMetadata(issue.content).number ?? null, title: issue.title,
    status: issue.status, priority: issue.priority, body: tiptapToText(issue.content).slice(0, 8000),
    runs: runs.map(run => ({ id: run.id, agent: run.agentName, status: run.status, createdAt: run.createdAt.toISOString() })),
  }
}

export async function listRuns(userId: string, input: { issueId?: string; activeOnly?: boolean }) {
  const rows = await db.select(runViewColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.userId, userId), input.issueId ? eq(agentRuns.issueId, input.issueId) : undefined, input.activeOnly ? inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]) : undefined))
    .orderBy(desc(agentRuns.createdAt)).limit(20)
  return rows.map(run => ({ id: run.id, issueId: run.issueId, agent: run.agentName, status: run.status, stopReason: run.stopReason, createdAt: run.createdAt.toISOString() }))
}

export async function getRun(userId: string, runId: string) {
  const detail = await readRun(userId, runId)
  if (!detail) return null
  const { run } = detail
  return {
    id: run.id, issueId: run.issueId, agent: run.agentName, harness: run.harness, status: run.status,
    stopReason: run.stopReason, error: run.error, summary: (run.report as { summary?: string } | null)?.summary ?? null,
    startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null,
    recentEvents: detail.chunks.slice(-5).map(chunk => JSON.stringify(chunk).slice(0, 1000)),
  }
}
