import { queueTaskRun } from '@/lib/factory/queue-local'
import { localExecutionHarnesses } from '@/lib/device-agents'
import { issueVisibility } from '@/lib/issue-visibility'
import 'server-only'
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, gt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { FactoryError } from '@/lib/factory/contract'
import { AgentProfileError } from '@/lib/factory/agent-profile-definition'
import { AgentProfileAdmissionError } from '@/lib/factory/profile-admission'
import { issueForUser } from '@/lib/issue-access'
import { issueMutationsEnabled } from '@/lib/coordinator/issue-tools-enabled'
import { actAs } from '@/lib/acting-user'
import type { ActivityActor } from '@/lib/activity-actor'
import { addRunMessage,  requestRunStop } from '@/lib/agent-runs'
import { forgetNotes, rememberNote } from '@/lib/coordinator/context'
import { editMemory } from '@/lib/coordinator/store'
import { chatBotId } from '@/lib/coordinator/coordinator-bot'
import { db } from '@/lib/db'
import { agentRuns, agents, coordinatorSessions, devices, issueMembers, issues, runChunks, teamIssuePromotions } from '@/lib/db/schema'
import { deviceOnlineStates } from '@/lib/device-presence'
import type { IssueLabel } from '@/lib/issue-metadata'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { issueAttrsContent } from '@/lib/issue-summary-columns'
import { getIssue, saveIssue } from '@/app/actions/issues'
import { updateIssueMetadata, type IssueMetadataPatch } from '@/app/actions/issue-metadata'
import { updateIssueRelation } from '@/app/actions/issue-operations'
import { createIssueInput, updateIssueInput } from '@/lib/coordinator/issue-input'
import { listProjects as readProjects, moveIssueToProject } from '@/app/actions/projects'
import { taskReaderScope } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'

// The MCP tools that change things, and the reads that need more than one
// table. Writes go through the app's own server actions inside `actAs`, so an
// agent gets exactly the validation and access checks the person gets in the
// UI. A failed action comes back as `{ error }` with the action's code.

type Failure = { error: string }

function scopedUser(userId: string) {
  const workspaceId = taskReaderScope(userId).workspaceId
  return workspaceId ? { id: userId, [tokenWorkspace]: workspaceId } : userId
}

async function taskActor(userId: string, actor?: ActivityActor) {
  const current = scopedUser(userId)
  if (typeof current !== 'string') return current
  if (actor?.actorType === 'system' && z.uuid().safeParse(actor.actorId).success) {
    const workspace = await (await import('@/lib/coordinator/issue-team')).coordinatorTaskWorkspace(userId, actor.actorId!)
    return { id: userId, [tokenWorkspace]: workspace.id }
  }
  throw new ActionFailureError('workspaceAccessDenied')
}

/** Throws a failed action's code so a chain of actions stops at the first failure. */
function unwrap<T extends object>(result: T): Exclude<T, { error: string }> {
  if ('error' in result && typeof result.error === 'string') throw new ActionFailureError(result.error as never)
  return result as Exclude<T, { error: string }>
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | Failure> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof ActionFailureError || error instanceof FactoryError || error instanceof AgentProfileError) return { error: error.code }
    if (error instanceof AgentProfileAdmissionError) return { error: 'agentProfileUnavailable' }
    throw error
  }
}

/** A stable UUID for one tool call's team request. */
function requestIdFor(userId: string, toolCallId: string) {
  const hex = createHash('sha256').update(JSON.stringify(['create_issue:team', userId, toolCallId])).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Plain text as a TipTap document: one paragraph per line. */
function textToDoc(text: string) {
  const lines = text.split('\n')
  return { type: 'doc', content: lines.map(line => line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }) }
}

/** The labels the person already uses, so a label named by an agent keeps its color. */
async function knownLabels(userId: string): Promise<Map<string, IssueLabel>> {
  const rows = await db.select({ content: issueAttrsContent }).from(issues).where(and(eq(issues.userId, userId), (await issueVisibility(userId)).predicate))
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
  let issue = unwrap(await getIssue(issueId)).issue
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

/** The host Bot selects the tenant; an optional Team is attached after the
 * application's idempotent creation commits, with its own durable receipt. */
export async function createIssue(userId: string, input: IssueChanges & { title: string; body?: string; teamId?: string }, actor?: ActivityActor, toolCallId?: string, taskEvent?: { eventId: string; botId: string | null }, teamId?: string, chatRequest?: { eventId: string; botId: string | null }) {
  return attempt(async () => actAs(await taskActor(userId, actor), async () => {
    if (input.assigneeUserId !== undefined && input.assigneeAgentId !== undefined) return { error: 'validationGeneric' }
    // The legacy MCP contract has no human-assignee field. Do not introduce a
    // multi-action write without the durable transaction and access checks.
    if (toolCallId === undefined && input.assigneeUserId !== undefined) return { error: 'issueToolsDisabled' }
    if (teamId && toolCallId === undefined) return { error: 'validationGeneric' }
    const mutate = async () => {
      const fields = { title: input.title, content: textToDoc(input.body ?? ''), status: input.status ?? 'todo', priority: input.priority ?? 'normal' }
      const created = unwrap(await saveIssue(fields)).issue
      return issueResult(await applyChanges(userId, created.id, { projectId: input.projectId, labels: input.labels, assigneeUserId: input.assigneeUserId, assigneeAgentId: input.assigneeAgentId }))
    }
    if (toolCallId === undefined) return mutate()
    if (!issueMutationsEnabled()) return { error: 'issueToolsDisabled' }
    const parsed = createIssueInput.safeParse(input)
    if (!parsed.success) return { error: 'validationGeneric' }
    const { idempotentIssueMutation, IssueToolCallConflict } = await import('./issue-mutation')
    try {
      const created = await idempotentIssueMutation(userId, 'create_issue', toolCallId, parsed.data, mutate, taskEvent, chatRequest ? { ...chatRequest, teamId: teamId ?? parsed.data.teamId ?? null } : undefined)
      if (!teamId) return created
      const requestId = requestIdFor(userId, toolCallId)
      const [prior] = await db.select().from(teamIssuePromotions).where(eq(teamIssuePromotions.requestId, requestId)).limit(1)
      const issue = unwrap(await getIssue(created.id)).issue
      const attached = unwrap(await (await import('@/lib/team-issue-promotion')).promoteExistingIssueForUser(userId, {
        requestId, issueId: created.id, teamId, revision: prior?.expectedRevision ?? issue.revision, expectedTeamId: prior?.expectedTeamId ?? null,
      }, actor))
      return issueResult(attached.issue)
    }
    catch (error) { if (error instanceof IssueToolCallConflict) return { error: error.message }; throw error }
  }, actor))
}

export async function updateIssue(userId: string, input: IssueChanges & { issueId: string }, actor?: ActivityActor, toolCallId?: string) {
  return attempt(async () => actAs(await taskActor(userId, actor), async () => {
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
  return attempt(async () => actAs(await taskActor(userId, actor), async () => {
    const issue = unwrap(await getIssue(input.issueId)).issue
    const saved = unwrap(await updateIssueRelation({ id: issue.id, revision: issue.revision, kind: input.kind, targetId: input.targetId, remove: input.remove ?? false })).issue
    return issueResult(saved)
  }, actor))
}

/** Issues whose title or text contains `query`, most recently updated first. */
export async function searchIssues(userId: string, input: { query: string; status?: string }) {
  if (!taskReaderScope(userId).workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const pattern = `%${input.query.replace(/[\\%_]/g, char => `\\${char}`)}%`
  const rows = await db.selectDistinct({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority, content: issueAttrsContent, updatedAt: issues.updatedAt })
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
  const presence = await deviceOnlineStates(rows.map(row => ({ id: row.deviceId, lastSeenAt: row.lastSeenAt })))
  return rows.filter(row => localExecutionHarnesses(row.harnesses).includes(row.harness)).map(row => ({
    id: row.id, harness: row.harness, deviceId: row.deviceId, device: row.deviceName,
    deviceOnline: Boolean(row.enabled && presence.get(row.deviceId)),
  }))
}

function mcpWorkspace(userId: string) {
  const workspaceId = taskReaderScope(userId).workspaceId
  if (!workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return workspaceId
}

export async function dispatchRun(userId: string, input: { issueId: string; agentId: string; repo: string; note?: string; requestKey?: string }) {
  // A run an MCP client dispatches is the person's Coordinator's: its bot row is resolved here, where the run is created.
  // One task, one thread (lib/thread-dispatch.ts): a task with a thread gets this as that thread's work. An MCP client
  // has no chat message of the person's to show an explicit request for a new thread, so it never starts one.
  if (!(await import('@/lib/factory/runtime')).factoryLifecycleEnabled()) return { error: 'factoryLifecycleUnavailable' }
  const issue = await issueForUser(userId, input.issueId)
  if (!issue?.workspaceId || !taskReaderScope(userId).workspaceId) return { error: 'issueNotFound' }
  const { dispatchToTask } = await import('@/lib/thread-dispatch')
  return attempt(async () => dispatchToTask(userId, input.issueId, {
    note: input.note,
    start: async (previous, note) => ({ status: 'queued' as const, ...(await queueTaskRun(userId, { ...input, ...(previous ? { agentId: previous.agentId, repo: previous.remoteUrl ?? input.repo, threadRunId: previous.id } : {}), note, ...await mcpRunModel(userId, input, previous), ...(previous?.readOnly ? { readOnly: true } : {}), ...(previous && input.requestKey ? { requestKey: `thread:${previous.id}:${input.requestKey}`.slice(0, 200) } : {}) }, await chatBotId(userId, null, issue.workspaceId), undefined, undefined, { source: 'mcp', origin: 'api', originRef: { kind: 'api' } })) }),
  }))
}

/** A thread's next run keeps its own model; a new one takes 优先使用的模型 on the named Agent's computer. */
async function mcpRunModel(userId: string, input: { issueId: string; agentId: string }, previous: { id: string; agentId: string } | null) {
  const { latestThreadRunModel } = await import('@/lib/computer/run-model')
  const { pool } = await import('@/lib/db')
  if (previous) {
    const kept = await latestThreadRunModel(pool, userId, input.issueId, previous.agentId)
    if (!kept) throw new ActionFailureError('threadModelUnavailable')
    return kept
  }
  const [agent] = await db.select({ id: agents.id, deviceId: agents.deviceId, harness: agents.harness }).from(agents).where(and(eq(agents.id, input.agentId), eq(agents.userId, userId))).limit(1)
  if (!agent?.deviceId || (agent.harness !== 'codex' && agent.harness !== 'claude_code')) throw new ActionFailureError('agentNoDevice')
  const { executionWorkspace } = await import('@/lib/execution-settings')
  const botId = await chatBotId(userId, null, mcpWorkspace(userId))
  const { target, agentProfile, selectionMode } = await (await import('@/lib/factory/agent-profile')).resolveAgentProfileDispatch(pool,
    { ownerId: userId, workspaceId: await executionWorkspace(userId, botId), botId },
    { issueId: input.issueId, stage: 'execute', location: 'local', agentId: agent.id, deviceId: agent.deviceId, asked: { harness: agent.harness } })
  if (target.kind !== 'device' || target.agentId !== agent.id) throw new ActionFailureError('runModelMissing')
  return { model: target.model, agentProfile, modelDispatch: { mode: selectionMode ?? 'preference', location: 'local' as const, entry: target.entry, ...(target.routing ? { routing: target.routing } : {}) },
    ...(target.subscriptionBindingId ? { subscriptionBindingId: target.subscriptionBindingId } : {}),
    ...(target.entry.source.kind === 'api_key' ? { apiKeyId: target.entry.source.keyId } : {}) }
}

export async function sendToRun(userId: string, input: { runId: string; text: string }) {
  return attempt(async () => { await addRunMessage(userId, input, 'peer'); return { sent: true } })
}

export async function stopRun(userId: string, runId: string) {
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId))).limit(1)
  if (!run) return { error: 'runNotFound' }
  return attempt(async () => ({ stopRequested: true, ...(await requestRunStop(userId, runId)) }))
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
  return actAs(scopedUser(userId), async () => (await readProjects()).map(project => ({
    id: project.id, name: project.name, summary: project.summary, status: project.status, priority: project.priority,
    startDate: project.startDate || null, targetDate: project.targetDate || null, issueIds: project.issueIds,
  })))
}

/** Every label on the person's issues, with how many issues carry it. */
export async function listLabels(userId: string) {
  if (!taskReaderScope(userId).workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  const rows = await db.select({ content: issueAttrsContent }).from(issues).where((await issueVisibility(userId)).predicate)
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
  const botId = await chatBotId(userId, null, mcpWorkspace(userId))
  const [session] = await db.select({ memory: coordinatorSessions.memory }).from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), eq(coordinatorSessions.botId, botId))).limit(1)
  return { memory: session?.memory ?? '' }
}

export async function remember(userId: string, note: string) {
  return editMemory(userId, memory => {
    const next = rememberNote(memory, note)
    return next === null ? { error: 'memoryFull: forget something first' } : { memory: next, result: { remembered: true } }
  }, await chatBotId(userId, null, mcpWorkspace(userId)))
}

export async function forget(userId: string, text: string) {
  return editMemory(userId, memory => {
    const { memory: next, removed } = forgetNotes(memory, text)
    return { memory: next, result: { removed } }
  }, await chatBotId(userId, null, mcpWorkspace(userId)))
}
