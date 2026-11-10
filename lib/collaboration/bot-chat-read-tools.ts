import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { issueVisibility } from '@/lib/issue-visibility'
import { issueForUser } from '@/lib/issue-access'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { visibleRuns, readRun } from '@/lib/agent-runs'
import { tiptapToText } from '@/lib/tiptap-text'
import { recordBotChatResourceRead, sharedBotToolContext } from './bot-chat'
import type { SharedBotChatScope } from './bot-chat-contract'

export async function listSharedBotIssues(ownerId: string, scope: SharedBotChatScope, input: { status?: string }) {
  const { reader, workspaceId } = await sharedBotToolContext(ownerId, scope)
  const rows = await db.select({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority,
    content: issueAttrsContent, updatedAt: issues.updatedAt }).from(issues)
    .where(and((await issueVisibility(reader, false, workspaceId)).predicate, input.status ? eq(issues.status, input.status) : undefined))
    .orderBy(desc(issues.updatedAt)).limit(100)
  const visible = []
  for (const row of rows) {
    if (readIssueMetadata(row.content).deletedAt || !await recordBotChatResourceRead(ownerId, scope, 'task', row.id)) continue
    const { content, updatedAt, ...item } = row
    visible.push({ ...item, number: readIssueMetadata(content).number ?? null, updatedAt: updatedAt.toISOString() })
    if (visible.length === 50) break
  }
  return visible
}

export async function listSharedBotRuns(ownerId: string, scope: SharedBotChatScope, input: { issueId?: string; activeOnly?: boolean }) {
  const { reader } = await sharedBotToolContext(ownerId, scope)
  const rows = await visibleRuns(reader, input)
  const visible = []
  for (const run of rows) if (await recordBotChatResourceRead(ownerId, scope, 'thread', run.id))
    visible.push({ id: run.id, issueId: run.issueId, agent: run.agentName, status: run.status,
      stopReason: run.stopReason, createdAt: run.createdAt.toISOString() })
  return visible
}

export async function getSharedBotIssue(ownerId: string, scope: SharedBotChatScope, issueId: string) {
  const { reader } = await sharedBotToolContext(ownerId, scope)
  if (!await recordBotChatResourceRead(ownerId, scope, 'task', issueId)) return { error: 'issueNotFound' }
  const issue = await issueForUser(reader, issueId)
  if (!issue) return { error: 'issueNotFound' }
  const runs = await listSharedBotRuns(ownerId, scope, { issueId })
  return { id: issue.id, number: readIssueMetadata(issue.content).number ?? null, title: issue.title,
    status: issue.status, priority: issue.priority, body: tiptapToText(issue.content).slice(0, 8000), runs,
    thread: runs[0] ? { runId: runs[0].id, status: runs[0].status } : null }
}

export async function getSharedBotRun(ownerId: string, scope: SharedBotChatScope, runId: string) {
  const { reader } = await sharedBotToolContext(ownerId, scope)
  if (!await recordBotChatResourceRead(ownerId, scope, 'thread', runId)) return { error: 'runNotFound' }
  const detail = await readRun(reader, runId)
  if (!detail) return { error: 'runNotFound' }
  const { run } = detail
  return { id: run.id, issueId: run.issueId, agent: run.agentName, harness: run.harness, status: run.status,
    stopReason: run.stopReason, error: run.error, summary: (run.report as { summary?: string } | null)?.summary ?? null,
    sourceCommit: run.report?.sourceCommit ?? null, skillMount: run.report?.skillMount ?? null, runtime: run.report?.runtime ?? null, verify: run.report?.verify ?? null,
    startedAt: run.startedAt?.toISOString() ?? null, finishedAt: run.finishedAt?.toISOString() ?? null,
    recentEvents: detail.chunks.slice(-5).map(chunk => JSON.stringify(chunk).slice(0, 1000)) }
}
