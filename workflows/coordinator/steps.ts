import { generateText, type ModelMessage } from 'ai'
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { addRunMessage, queueRun, readRun, requestRunStop, runViewColumns } from '@/lib/agent-runs'
import { compactionCut, forgetNotes, instructionsWithMemory, promptMessages, rememberNote, SUMMARY_INSTRUCTIONS } from '@/lib/coordinator/context'
import { COORDINATOR_INSTRUCTIONS } from '@/lib/coordinator/instructions'
import { COORDINATOR_MODEL } from '@/lib/coordinator/model'
import * as store from '@/lib/coordinator/store'
import { db } from '@/lib/db'
import { agentRuns, agents, deviceRepos, devices, issueMembers, issues, telegramLinks } from '@/lib/db/schema'
import { DEVICE_ONLINE_WINDOW_MS } from '@/lib/device-link'
import { type ComposioActionName } from '@/lib/composio-actions'
import { runComposioAction } from '@/lib/composio'
import { issueForUser } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { tiptapToText } from '@/lib/tiptap-text'
import type { TelegramReplyTarget } from '@/lib/coordinator-events'
import { postTelegramText } from '@/lib/telegram/client'

// Every function here is a durable step: it runs with full Node access, its
// result is recorded, and a failure is retried. Tools return `{ error }` for
// expected failures instead of throwing, so a bad id is not retried.

type ToolResult<T> = T | { error: string }

async function asToolResult<T>(fn: () => Promise<T>): Promise<ToolResult<T>> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ActionFailureError) return { error: error.code }
    throw error
  }
}

export async function takeInbox(userId: string, holder: string) {
  'use step'
  return store.takeInbox(userId, holder)
}

export async function releaseLease(userId: string, holder: string) {
  'use step'
  return store.releaseLease(userId, holder)
}

export async function failTurn(userId: string, holder: string, error: string) {
  'use step'
  await store.failTurn(userId, holder, error)
}

export async function appendMessages(userId: string, holder: string, messages: ModelMessage[]) {
  'use step'
  await store.appendMessages(userId, holder, messages)
}

/** Linked, de-duplicated Telegram threads that should get this reply. */
export async function telegramReplyThreads(userId: string, targets: TelegramReplyTarget[]): Promise<string[]> {
  'use step'
  const destinations = [...new Map(targets.map(target => [JSON.stringify(target), target])).values()]
  const threads: string[] = []
  for (const target of destinations) {
    const [link] = await db.select({ userId: telegramLinks.userId }).from(telegramLinks)
      .where(and(eq(telegramLinks.userId, userId), eq(telegramLinks.telegramUserId, target.telegramUserId))).limit(1)
    if (link && !threads.includes(target.threadId)) threads.push(target.threadId)
  }
  return threads
}

/**
 * Sends one chunk to one thread. Each chunk is its own durable step, so a
 * retry after a failed chunk resends only that chunk, never the ones already
 * delivered (Telegram sends have no idempotency key).
 */
export async function sendTelegramChunk(threadId: string, chunk: string) {
  'use step'
  await postTelegramText(threadId, chunk)
}

/**
 * Folds older messages into the summary once the conversation passes the
 * token budget, then returns the prompt for this turn: the instructions with
 * the person's memory, and the messages.
 */
export async function preparePrompt(userId: string): Promise<{ instructions: string; messages: ModelMessage[] }> {
  'use step'
  let { summary, memory, messages } = await store.loadConversation(userId)
  const cut = compactionCut(summary, messages)
  if (cut !== null) {
    const folded = messages.filter(row => row.position <= cut)
    const { text } = await generateText({
      model: COORDINATOR_MODEL,
      instructions: SUMMARY_INSTRUCTIONS,
      messages: [...promptMessages(summary, folded), { role: 'user', content: 'Write the summary now.' }],
    })
    await store.saveSummary(userId, text, cut)
    summary = text
    messages = messages.filter(row => row.position > cut)
  }
  return { instructions: instructionsWithMemory(COORDINATOR_INSTRUCTIONS, memory), messages: promptMessages(summary, messages) }
}

export async function remember(userId: string, input: { note: string }) {
  'use step'
  return store.editMemory(userId, memory => {
    const next = rememberNote(memory, input.note)
    return next === null ? { error: 'memoryFull: forget something first' } : { memory: next, result: { remembered: true } }
  })
}

export async function forget(userId: string, input: { text: string }) {
  'use step'
  return store.editMemory(userId, memory => {
    const { memory: next, removed } = forgetNotes(memory, input.text)
    return { memory: next, result: { removed } }
  })
}

export async function composioAction(userId: string, action: ComposioActionName, input: unknown) {
  'use step'
  return runComposioAction(userId, action, input)
}

export async function listIssues(userId: string, input: { status?: string }) {
  'use step'
  const rows = await db.selectDistinct({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority, content: issues.content, updatedAt: issues.updatedAt })
    .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(or(eq(issues.userId, userId), eq(issueMembers.memberId, userId)), input.status ? eq(issues.status, input.status) : undefined))
    .orderBy(desc(issues.updatedAt)).limit(100)
  return rows.filter(row => !readIssueMetadata(row.content).deletedAt).slice(0, 50).map(({ content, updatedAt, ...row }) => ({
    ...row, number: readIssueMetadata(content).number ?? null, updatedAt: updatedAt.toISOString(),
  }))
}

export async function getIssue(userId: string, input: { issueId: string }) {
  'use step'
  const issue = await issueForUser(userId, input.issueId)
  if (!issue) return { error: 'issueNotFound' }
  const runs = await db.select(runViewColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.issueId, issue.id), eq(agentRuns.userId, userId))).orderBy(desc(agentRuns.createdAt)).limit(5)
  return {
    id: issue.id, number: readIssueMetadata(issue.content).number ?? null, title: issue.title,
    status: issue.status, priority: issue.priority, body: tiptapToText(issue.content).slice(0, 8000),
    runs: runs.map(run => ({ id: run.id, agent: run.agentName, status: run.status, createdAt: run.createdAt.toISOString() })),
  }
}

export async function listAgents(userId: string) {
  'use step'
  const rows = await db.select({ id: agents.id, name: agents.name, description: agents.description, harness: agents.harness, deviceId: agents.deviceId, deviceName: devices.name, enabled: devices.enabled, lastSeenAt: devices.lastSeenAt })
    .from(agents).leftJoin(devices, eq(devices.id, agents.deviceId)).where(eq(agents.userId, userId)).orderBy(asc(agents.name))
  const deviceIds = [...new Set(rows.map(row => row.deviceId).filter((id): id is string => Boolean(id)))]
  const repos = deviceIds.length ? await db.select().from(deviceRepos).where(inArray(deviceRepos.deviceId, deviceIds)) : []
  return rows.map(row => ({
    id: row.id, name: row.name, description: row.description, harness: row.harness, device: row.deviceName,
    deviceOnline: Boolean(row.enabled && row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < DEVICE_ONLINE_WINDOW_MS),
    repos: repos.filter(repo => repo.deviceId === row.deviceId).map(repo => ({ id: repo.id, path: repo.repoPath, baseBranch: repo.baseBranch })),
  }))
}

export async function dispatchRun(userId: string, input: { issueId: string; agentId: string; deviceRepoId: string; note?: string }) {
  'use step'
  return asToolResult(async () => ({ ...(await queueRun(userId, input)), status: 'queued' }))
}

export async function listRuns(userId: string, input: { issueId?: string; activeOnly?: boolean }) {
  'use step'
  const active = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const
  const rows = await db.select(runViewColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.userId, userId), input.issueId ? eq(agentRuns.issueId, input.issueId) : undefined, input.activeOnly ? inArray(agentRuns.status, [...active]) : undefined))
    .orderBy(desc(agentRuns.createdAt)).limit(20)
  return rows.map(run => ({ id: run.id, issueId: run.issueId, agent: run.agentName, status: run.status, stopReason: run.stopReason, createdAt: run.createdAt.toISOString() }))
}

export async function getRun(userId: string, input: { runId: string }) {
  'use step'
  const detail = await readRun(userId, input.runId)
  if (!detail) return { error: 'runNotFound' }
  const { run } = detail
  return {
    id: run.id, issueId: run.issueId, agent: run.agentName, harness: run.harness, status: run.status,
    stopReason: run.stopReason, error: run.error, summary: (run.report as { summary?: string } | null)?.summary ?? null,
    startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null,
    // The tail of the event stream, enough to see what the agent is doing.
    recentEvents: detail.chunks.slice(-5).map(chunk => JSON.stringify(chunk).slice(0, 1000)),
  }
}

export async function sendToRun(userId: string, input: { runId: string; text: string }) {
  'use step'
  return asToolResult(async () => { await addRunMessage(userId, input); return { sent: true } })
}

export async function stopRun(userId: string, input: { runId: string }) {
  'use step'
  return asToolResult(async () => { await requestRunStop(userId, input.runId); return { stopRequested: true } })
}
