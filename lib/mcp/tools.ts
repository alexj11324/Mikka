import { modelMessage } from '@/lib/coordinator/message-safety'
import { issueVisibility } from '@/lib/issue-visibility'
import 'server-only'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { chatBotId } from '@/lib/coordinator/coordinator-bot'
import type { ModelMessage } from 'ai'
import { readRun, visibleRuns } from '@/lib/agent-runs'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { peerCoordinatorMessageEvent } from '@/lib/coordinator-events'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'
import { db, pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { coordinatorSessionScope } from '@/lib/live/coordinator-session'
import { subscribeToCoordinatorReplies } from './reply-live'
import { waitForReply } from './reply-wait'
import { logReplyCompletion } from './reply-completion'
import { coordinatorMessages, coordinatorSessions, issueMembers, issues } from '@/lib/db/schema'
import { issueForUser } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueView, taskIdentifiers } from '@/lib/task-identifier-server'
import { tiptapToText } from '@/lib/tiptap-text'
import { coordinatorLeaseActive } from '@/lib/coordinator/lease'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { taskReaderScope } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'

// What the MCP tools read and write, scoped to one person. The Coordinator's
// own tools (workflows/coordinator/steps.ts) read the same tables.

/** MCP chat operations use the same verified tenant as its task tools. */
const coordinatorChat = (userId: string) => {
  const workspaceId = taskReaderScope(userId).workspaceId
  if (!workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return chatBotId(userId, null, workspaceId)
}

async function lastPosition(userId: string): Promise<number> {
  const [row] = await db.select({ last: sql<number>`coalesce(max(${coordinatorMessages.position}), 0)` })
    .from(coordinatorMessages).where(and(eq(coordinatorMessages.userId, userId), eq(coordinatorMessages.botId, await coordinatorChat(userId))))
  return Number(row?.last ?? 0)
}

/**
 * Queues a message for the person's Coordinator and wakes it, as the chat
 * does. `after` is the conversation's last position before the reply, to pass
 * to readCoordinatorMessages.
 */
export async function sendToCoordinator(userId: string, text: string) {
  const botId = await coordinatorChat(userId)
  const after = await lastPosition(userId)
  await recordCoordinatorEvent(db, peerCoordinatorMessageEvent(userId, botId, text))
  await wakeCoordinator(userId)
  return { queued: true, coordinatorRunning: await coordinatorEnabled(userId, botId), after }
}

/** One stored message as text: what was said, and which tools the Coordinator called. */
function displayMessage(message: ModelMessage): { role: 'user' | 'assistant'; text: string; toolCalls?: string[] } | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  const projected = modelMessage(message)
  if (typeof projected.content === 'string') return { role: message.role, text: projected.content }
  const text = projected.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  const toolCalls = projected.content.flatMap(part => part.type === 'tool-call' ? [part.toolName] : [])
  if (!text && !toolCalls.length) return null
  return { role: message.role, text, ...(toolCalls.length ? { toolCalls } : {}) }
}

/** Whether an assistant reply is past `after`. Only the position comes back; the wait does not transfer message bodies. */
async function hasAssistantAfter(userId: string, botId: string, after: number) {
  const [row] = await db.select({ position: coordinatorMessages.position })
    .from(coordinatorMessages).where(and(eq(coordinatorMessages.userId, userId), eq(coordinatorMessages.botId, botId), gt(coordinatorMessages.position, after), sql`${coordinatorMessages.message}->>'role' = 'assistant'`))
    .limit(1)
  return Boolean(row)
}

async function messagesAfter(userId: string, botId: string, after: number, limit: number) {
  const rows = await db.select({ position: coordinatorMessages.position, message: coordinatorMessages.message, createdAt: coordinatorMessages.createdAt })
    .from(coordinatorMessages).where(and(eq(coordinatorMessages.userId, userId), eq(coordinatorMessages.botId, botId), gt(coordinatorMessages.position, after)))
    .orderBy(desc(coordinatorMessages.position)).limit(limit)
  return rows.reverse().flatMap(row => {
    const shown = displayMessage(row.message as unknown as ModelMessage)
    return shown ? [{ position: row.position, createdAt: row.createdAt.toISOString(), ...shown }] : []
  })
}

/** Whether a turn is running, and why the last one failed (cleared when a turn succeeds). */
async function turnState(userId: string, botId: string) {
  const [session] = await db.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil, lastError: coordinatorSessions.lastError, lastErrorAt: coordinatorSessions.lastErrorAt })
    .from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))).limit(1)
  return {
    working: coordinatorLeaseActive(session),
    error: session?.lastError ?? null, errorAt: session?.lastErrorAt ?? null,
  }
}

/**
 * The conversation after `after` (the newest `limit` messages). With
 * `waitSeconds`, waits until the Coordinator has replied after `after`, a turn
 * fails, or the time runs out.
 */
type CoordinatorReply = {
  messages: Awaited<ReturnType<typeof messagesAfter>>
  replied: boolean
  last: number
  working: boolean
  lastError: string | null
  coordinatorRunning: boolean
}

export async function readCoordinatorMessages(userId: string, input: { after?: number; limit?: number; waitSeconds?: number }, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const after = input.after ?? 0
  const limit = input.limit ?? 20
  const started = new Date()
  const deadline = started.getTime() + (input.waitSeconds ?? 0) * 1000
  const botId = await coordinatorChat(userId)
  const scope = await coordinatorSessionScope(pool, workspacePool, userId, botId)
  if (!scope) throw new Error('workspaceAccessDenied')
  return waitForReply<CoordinatorReply>(async final => {
    // A channel key never authorizes the data read. Recheck the persisted scope,
    // including on a deadline or lost-notification reconciliation.
    const current = await coordinatorSessionScope(pool, workspacePool, userId, botId)
    if (!current || current.workspaceId !== scope.workspaceId) throw new Error('workspaceAccessDenied')
    const turn = await turnState(userId, botId)
    const failed = Boolean(turn.errorAt && turn.errorAt >= started)
    if (!final && !failed && !await hasAssistantAfter(userId, botId, after)) return { done: false }
    const messages = await messagesAfter(userId, botId, after, limit)
    const replied = messages.some(message => message.role === 'assistant')
    return { done: true, value: { messages, replied, last: messages.at(-1)?.position ?? after, working: turn.working, lastError: turn.error, coordinatorRunning: await coordinatorEnabled(userId, botId) } }
  }, { deadline, signal, subscribe: (changed, abort) => subscribeToCoordinatorReplies(scope, botId, changed, abort),
    onComplete: completion => logReplyCompletion(botId, completion),
  })
}

export async function listIssues(userId: string, input: { status?: string }) {
  if (!taskReaderScope(userId).workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const rows = await db.selectDistinct({ id: issues.id, ownerId: issues.userId, scope: issues.scope, title: issues.title, status: issues.status, priority: issues.priority, content: issueAttrsContent, updatedAt: issues.updatedAt })
    .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and((await issueVisibility(userId)).predicate, input.status ? eq(issues.status, input.status) : undefined))
    .orderBy(desc(issues.updatedAt)).limit(100)
  const page = rows.filter(row => !readIssueMetadata(row.content).deletedAt).slice(0, 50)
  const identifiers = await taskIdentifiers(page)
  return page.map(({ content, updatedAt, ownerId: _ownerId, scope: _scope, ...row }) => ({
    ...row, identifier: identifiers.get(row.id) ?? null, number: readIssueMetadata(content).number ?? null, updatedAt: updatedAt.toISOString(),
  }))
}

export async function getIssue(userId: string, issueId: string) {
  if (!taskReaderScope(userId).workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const issue = await issueForUser(userId, issueId)
  if (!issue) return null
  const runs = await visibleRuns(userId, { issueId: issue.id, limit: 5 })
  const view = await issueView(issue)
  const metadata = view.metadata
  // Children and the issues this one blocks point at it, so they are found by looking the other way.
  const siblings = await db.select({ id: issues.id, title: issues.title, status: issues.status, content: issueAttrsContent }).from(issues)
    .leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(eq(issues.userId, issue.userId), (await issueVisibility(userId, false, issue.workspaceId!)).predicate))
  const linked = new Map(siblings.filter(row => !readIssueMetadata(row.content).deletedAt).map(row => [row.id, { id: row.id, title: row.title, status: row.status, parentId: readIssueMetadata(row.content).parentId, blockedByIds: readIssueMetadata(row.content).blockedByIds }]))
  const pick = (ids: (string | null)[]) => ids.flatMap(id => {
    const row = id ? linked.get(id) : undefined
    return row ? [{ id: row.id, title: row.title, status: row.status }] : []
  })
  return {
    id: issue.id, identifier: view.identifier, projectId: view.projectId, number: metadata.number ?? null, title: issue.title,
    status: issue.status, priority: issue.priority, body: tiptapToText(issue.content).slice(0, 8000),
    project: metadata.project, delegate: metadata.delegate, labels: metadata.labels.map(label => label.name), assignee: metadata.assignee ? { kind: metadata.assignee.kind, id: metadata.assignee.id, name: metadata.assignee.name } : null,
    dueDate: metadata.dueDate, pullRequests: metadata.pullRequests,
    relations: {
      parent: pick([metadata.parentId])[0] ?? null,
      children: pick([...linked.values()].filter(row => row.parentId === issue.id).map(row => row.id)),
      blockedBy: pick(metadata.blockedByIds), blocks: pick([...linked.values()].filter(row => row.blockedByIds.includes(issue.id)).map(row => row.id)), related: pick(metadata.relatedIds), duplicateOf: pick([metadata.duplicateOfId])[0] ?? null,
    },
    runs: runs.map(run => ({ id: run.id, agent: run.agentName, status: run.status, createdAt: run.createdAt.toISOString() })),
  }
}

export async function listRuns(userId: string, input: { issueId?: string; activeOnly?: boolean }) {
  const rows = await visibleRuns(userId, input)
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
    ...(detail.decisionWarnings?.length ? { decisionWarnings: detail.decisionWarnings } : {}),
  }
}
