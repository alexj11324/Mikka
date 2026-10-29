import { localExecutionHarnesses } from '@/lib/device-agents'
import { issueVisibility } from '@/lib/issue-visibility'
import 'server-only'
import { and, asc, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { issueForUser } from '@/lib/issue-access'
import { issueMutationsEnabled } from '@/lib/coordinator/issue-tools-enabled'
import { actAs } from '@/lib/acting-user'
import type { ActivityActor } from '@/lib/activity-actor'
import { addRunMessage, queueRun, requestRunStop } from '@/lib/agent-runs'
import { forgetNotes, rememberNote } from '@/lib/coordinator/context'
import { editMemory } from '@/lib/coordinator/store'
import { db } from '@/lib/db'
import { agentRuns, agents, coordinatorSessions, devices, issueMembers, issues, runChunks } from '@/lib/db/schema'
import { DEVICE_ONLINE_WINDOW_MS } from '@/lib/device-link'
import type { IssueLabel } from '@/lib/issue-metadata'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { getIssue as readIssue, saveIssue } from '@/app/actions/issues'
import { updateIssueMetadata, type IssueMetadataPatch } from '@/app/actions/issue-metadata'
import { updateIssueRelation } from '@/app/actions/issue-operations'
import { createIssueInput, updateIssueInput } from '@/lib/coordinator/issue-input'
import { listProjects as readProjects, moveIssueToProject } from '@/app/actions/projects'

// The MCP tools that change things, and the reads that need more than one
// table. Writes go through the app's own server actions inside `actAs`, so an
// agent gets exactly the validation and access checks the person gets in the
// UI. A failed action comes back as `{ error }` with the action's code.

type Failure = { error: string }

/** Throws a failed action's code so a chain of actions stops at the first failure. */
function unwrap<T extends object>(result: T): Exclude<T, { error: string }> {
  if ('error' in result && typeof result.error === 'string') throw new ActionFailureError(result.error as never)
  return result as Exclude<T, { error: string }>
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | Failure> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ActionFailureError) return { error: error.code }
    throw error
  }
}

/** Plain text as a TipTap document: one paragraph per line. */
function textToDoc(text: string) {
  const lines = text.split('\n')
  return { type: 'doc', content: lines.map(line => line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }) }
}

/** The labels the person already uses, so a label named by an agent keeps its color. */
async function knownLabels(userId: string): Promise<Map<string, IssueLabel>> {
  const rows = await db.select({ content: issues.content }).from(issues).where(eq(issues.userId, userId))
  return new Map(rows.flatMap(row => readIssueMetadata(row.content).labels).map(label => [label.name.toLowerCase(), label]))
}

interface IssueChanges {
  title?: string
  status?: string
  priority?: string
  projectId?: string | null
  labels?: string[]
  assigneeUserId?: string | null
  assigneeAgentId?: string | null
}

/** Applies the changes one action at a time, each on the revision the last one left. */
async function applyChanges(userId: string, issueId: string, changes: IssueChanges) {
  let issue = await readIssue(issueId)
  // Historical invitations do not grant personal-task or revoked workspace
  // access. Check the proposed person's effective access before any mutation.
  if (changes.assigneeUserId && !await issueForUser(changes.assigneeUserId, issue.id)) throw new ActionFailureError('memberNotJoined')
  if (changes.title !== undefined || changes.status !== undefined || changes.priority !== undefined) {
    issue = unwrap(await saveIssue({
      id: issue.id, revision: issue.revision, content: issue.content,
      title: changes.title ?? issue.title, status: changes.status ?? issue.status, priority: changes.priority ?? issue.priority,
    })).issue
  }
  const patch: IssueMetadataPatch = {}
  if (changes.labels) {
    const known = await knownLabels(issue.userId)
    patch.labels = changes.labels.map(name => known.get(name.toLowerCase()) ?? { name, color: 'gray' })
  }
  if (changes.assigneeUserId !== undefined) patch.assignee = changes.assigneeUserId ? { kind: 'member', id: changes.assigneeUserId } : null
  if (changes.assigneeAgentId !== undefined) patch.assignee = changes.assigneeAgentId ? { kind: 'agent', id: changes.assigneeAgentId } : null
  if (Object.keys(patch).length) issue = unwrap(await updateIssueMetadata({ id: issue.id, revision: issue.revision, patch })).issue
  if (changes.projectId !== undefined) issue = unwrap(await moveIssueToProject({ issueId: issue.id, revision: issue.revision, projectId: changes.projectId })).issue
  return issue
}

function issueResult(issue: { id: string; title: string; status: string; priority: string; revision: number; content: Parameters<typeof readIssueMetadata>[0] }) {
  const metadata = readIssueMetadata(issue.content)
  return {
    id: issue.id, number: metadata.number ?? null, title: issue.title, status: issue.status, priority: issue.priority,
    project: metadata.project, labels: metadata.labels.map(label => label.name), assignee: metadata.assignee?.name ?? null,
  }
}

export async function createIssue(userId: string, input: IssueChanges & { title: string; body?: string }, actor?: ActivityActor, toolCallId?: string, taskEvent?: { eventId: string; botId: string | null }) {
  return attempt(() => actAs(userId, async () => {
    if (input.assigneeUserId !== undefined && input.assigneeAgentId !== undefined) return { error: 'validationGeneric' }
    // The legacy MCP contract has no human-assignee field. Do not introduce a
    // multi-action write without the durable transaction and access checks.
    if (toolCallId === undefined && input.assigneeUserId !== undefined) return { error: 'issueToolsDisabled' }
    const mutate = async () => {
      const created = unwrap(await saveIssue({ title: input.title, content: textToDoc(input.body ?? ''), status: input.status ?? 'todo', priority: input.priority ?? 'normal' })).issue
      return issueResult(await applyChanges(userId, created.id, { projectId: input.projectId, labels: input.labels, assigneeUserId: input.assigneeUserId, assigneeAgentId: input.assigneeAgentId }))
    }
    if (toolCallId === undefined) return mutate()
    if (!issueMutationsEnabled()) return { error: 'issueToolsDisabled' }
    const parsed = createIssueInput.safeParse(input)
    if (!parsed.success) return { error: 'validationGeneric' }
    const { idempotentIssueMutation, IssueToolCallConflict } = await import('./issue-mutation')
    try { return await idempotentIssueMutation(userId, 'create_issue', toolCallId, parsed.data, mutate, taskEvent) }
    catch (error) { if (error instanceof IssueToolCallConflict) return { error: error.message }; throw error }
  }, actor))
}

export async function updateIssue(userId: string, input: IssueChanges & { issueId: string }, actor?: ActivityActor, toolCallId?: string) {
  return attempt(() => actAs(userId, async () => {
    if (input.assigneeUserId !== undefined && input.assigneeAgentId !== undefined) return { error: 'validationGeneric' }
    if (toolCallId === undefined && input.assigneeUserId !== undefined) return { error: 'issueToolsDisabled' }
    const { issueId, ...changes } = input
    const mutate = async () => issueResult(await applyChanges(userId, issueId, changes))
    if (toolCallId === undefined) return mutate()
    if (!issueMutationsEnabled()) return { error: 'issueToolsDisabled' }
    const parsed = updateIssueInput.safeParse(input)
    if (!parsed.success) return { error: 'validationGeneric' }
    const { idempotentIssueMutation, IssueToolCallConflict } = await import('./issue-mutation')
    try { return await idempotentIssueMutation(userId, 'update_issue', toolCallId, parsed.data, mutate) }
    catch (error) { if (error instanceof IssueToolCallConflict) return { error: error.message }; throw error }
  }, actor))
}

export async function linkIssues(userId: string, input: { issueId: string; kind: 'parent' | 'child' | 'related' | 'blockedBy' | 'blocks' | 'duplicate'; targetId: string | null; remove?: boolean }, actor?: ActivityActor) {
  return attempt(() => actAs(userId, async () => {
    const issue = await readIssue(input.issueId)
    const saved = unwrap(await updateIssueRelation({ id: issue.id, revision: issue.revision, kind: input.kind, targetId: input.targetId, remove: input.remove ?? false })).issue
    return issueResult(saved)
  }, actor))
}

/** Issues whose title or text contains `query`, most recently updated first. */
export async function searchIssues(userId: string, input: { query: string; status?: string }) {
  const pattern = `%${input.query.replace(/[\\%_]/g, char => `\\${char}`)}%`
  const rows = await db.selectDistinct({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority, content: issues.content, updatedAt: issues.updatedAt })
    .from(issues).leftJoin(issueMembers, and(eq(issueMembers.issueId, issues.id), eq(issueMembers.memberId, userId)))
    .where(and(
      (await issueVisibility(userId)).predicate,
      or(sql`${issues.title} ilike ${pattern}`, sql`${issues.content}::text ilike ${pattern}`),
      input.status ? eq(issues.status, input.status) : undefined,
    ))
    .orderBy(desc(issues.updatedAt)).limit(50)
  return rows.filter(row => !readIssueMetadata(row.content).deletedAt).slice(0, 25).map(({ content, updatedAt, ...row }) => ({
    ...row, number: readIssueMetadata(content).number ?? null, updatedAt: updatedAt.toISOString(),
  }))
}

export async function listAgents(userId: string) {
  const rows = await db.select({ id: agents.id, harness: agents.harness, deviceId: devices.id, deviceName: devices.name, enabled: devices.enabled, lastSeenAt: devices.lastSeenAt, harnesses: devices.harnesses })
    .from(agents).innerJoin(devices, eq(devices.id, agents.deviceId))
    .where(and(eq(agents.userId, userId), eq(devices.ownerId, userId), eq(devices.kind, 'local'))).orderBy(asc(devices.name), asc(agents.harness))
  return rows.filter(row => localExecutionHarnesses(row.harnesses).includes(row.harness)).map(row => ({
    id: row.id, harness: row.harness, deviceId: row.deviceId, device: row.deviceName,
    deviceOnline: Boolean(row.enabled && row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < DEVICE_ONLINE_WINDOW_MS),
  }))
}

export async function dispatchRun(userId: string, input: { issueId: string; agentId: string; repo: string; note?: string; requestKey?: string }) {
  return attempt(async () => ({ status: 'queued', ...(await queueRun(userId, input, null, undefined, undefined, 'mcp')) }))
}

export async function sendToRun(userId: string, input: { runId: string; text: string }) {
  return attempt(async () => { await addRunMessage(userId, input, 'peer'); return { sent: true } })
}

export async function stopRun(userId: string, runId: string) {
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId))).limit(1)
  if (!run) return { error: 'runNotFound' }
  return attempt(async () => { await requestRunStop(userId, runId); return { stopRequested: true } })
}

/** A page of the run's event stream, by sequence number. */
export async function getRunEvents(userId: string, input: { runId: string; after?: number; limit?: number }) {
  const [run] = await db.select({ id: agentRuns.id, status: agentRuns.status }).from(agentRuns).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, userId))).limit(1)
  if (!run) return null
  const limit = input.limit ?? 50
  const rows = await db.select({ seq: runChunks.seq, chunk: runChunks.chunk, createdAt: runChunks.createdAt }).from(runChunks)
    .where(and(eq(runChunks.runId, run.id), input.after === undefined ? undefined : gt(runChunks.seq, input.after)))
    .orderBy(asc(runChunks.seq)).limit(limit + 1)
  const page = rows.slice(0, limit)
  return {
    status: run.status,
    events: page.map(row => ({ seq: row.seq, createdAt: row.createdAt.toISOString(), event: JSON.stringify(row.chunk).slice(0, 4000) })),
    next: rows.length > limit ? page.at(-1)!.seq : null,
  }
}

export async function listProjects(userId: string) {
  return actAs(userId, async () => (await readProjects()).map(project => ({
    id: project.id, name: project.name, summary: project.summary, status: project.status, priority: project.priority,
    startDate: project.startDate || null, targetDate: project.targetDate || null, issueIds: project.issueIds,
  })))
}

/** Every label on the person's issues, with how many issues carry it. */
export async function listLabels(userId: string) {
  const rows = await db.select({ content: issues.content }).from(issues).where(eq(issues.userId, userId))
  const counts = new Map<string, { name: string; color: string; issues: number }>()
  for (const row of rows) {
    const metadata = readIssueMetadata(row.content)
    if (metadata.deletedAt) continue
    for (const label of metadata.labels) {
      const key = label.name.toLowerCase()
      counts.set(key, { name: counts.get(key)?.name ?? label.name, color: counts.get(key)?.color ?? label.color, issues: (counts.get(key)?.issues ?? 0) + 1 })
    }
  }
  return [...counts.values()].sort((a, b) => b.issues - a.issues)
}

export async function readMemory(userId: string) {
  const [session] = await db.select({ memory: coordinatorSessions.memory }).from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), isNull(coordinatorSessions.botId))).limit(1)
  return { memory: session?.memory ?? '' }
}

export async function remember(userId: string, note: string) {
  return editMemory(userId, memory => {
    const next = rememberNote(memory, note)
    return next === null ? { error: 'memoryFull: forget something first' } : { memory: next, result: { remembered: true } }
  })
}

export async function forget(userId: string, text: string) {
  return editMemory(userId, memory => {
    const { memory: next, removed } = forgetNotes(memory, text)
    return { memory: next, result: { removed } }
  })
}
