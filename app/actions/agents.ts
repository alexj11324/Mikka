'use server'

import { readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'

import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { desktopHumanSessionId } from '@/lib/desktop-rpc/session'
import { deploymentSwitch } from '@/lib/deployment-switches'

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { headers } from 'next/headers'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { SelectResult } from 'drizzle-orm/query-builders/select.types'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db, pool } from '@/lib/db'
import {
  agents, agentRuns, coordinatorEvents, deviceRepos, devices, runMessages, users,
  type SupportedHarness,
} from '@/lib/db/schema'
import { issueDeviceToken } from '@/lib/device-link'
import { deviceOnlineStates } from '@/lib/device-presence'
import { withDevicePresence } from '@/lib/live/presence-read'
import type { PresenceDevice } from '@/lib/live/presence'
import { devicePresenceView, type PresenceReason } from '@/lib/device-scheduling'
import { DEVICE_ONLINE_WINDOW_MS, isDeviceOnline } from '@mikka/protocol/device'
import { removeOwnedDevice, renameOwnedDevice, setOwnedDeviceEnabled } from '@/lib/device-removal'
import { enqueueDeviceCommand, type DeviceCommandKind } from '@/lib/device-management'
import { listSshHosts } from '@/lib/ssh'
import { citationSources } from '@/lib/coordinator/store'
import { requestRunStop } from '@/lib/agent-runs'
import { sendThreadMessage } from '@/lib/thread-continue'
import { factoryEventId } from '@/lib/factory/event-id'
import { FactoryError } from '@/lib/factory/contract'
import { readThreadChunks, threadChunkCursor, type ThreadChunkCursor } from '@/lib/thread-chunks'
import { executionBotName, runBotId, runBotName, threadNameLines } from '@/lib/run-bot-name'
import { requireIssueAccess } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { ISSUE_THREAD_LIMIT, canReadThread, projectIssueThreads, threadQuestionRunId, withRunChain, type IssueThread } from '@/lib/issue-threads'
import { readThreadQuestionState, type ThreadQuestionDeadline } from '@/lib/issue-thread-questions'
import { runIsActive } from '@/lib/issue-run-conversation'
import { issueThreadListText } from '@/lib/issue-thread-list-projection'
import { listIssueRunChains, readRunChain, readRunChainCheckpoint } from '@/lib/run-chain'
import type { HarnessInfo } from '@mikka/protocol/harness'
import { parseUnifiedDiff, type ThreadChangesResult } from '@/lib/thread-changes'
import { threadPromptView } from '@/lib/thread-prompt'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { actAs } from '@/lib/acting-user'

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

async function getWorkspaceReader() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  return { id: session.user.id, [tokenWorkspace]: context.workspace.id, [enterprisePrincipal]: { kind: 'session' as const, sessionId: session.session.id } }
}

async function withOwnWorkspaceRun<T>(runId: string, work: (userId: string) => Promise<T>): Promise<T> {
  const reader = await getWorkspaceReader()
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, reader.id), eq(agentRuns.workspaceId, reader[tokenWorkspace]))).limit(1)
  if (!run) throw new ActionFailureError('runNotFound')
  return actAs(reader, () => work(reader.id))
}

export interface DeviceRepoView {
  id: string
  repoPath: string
  baseBranch: string | null
  verifyCommand: string | null
}

export interface DeviceView {
  id: string
  name: string
  deviceType: 'laptop' | 'server'
  hostname: string | null
  platform: string | null
  arch: string | null
  harnesses: HarnessInfo[]
  online: boolean
  presenceReason?: PresenceReason
  offlineDays?: number | null
  /** 参与调度 (decision 2026-11-02-1400): off, Mikka never sends this device a run. */
  enabled: boolean
  lastSeenAt: Date | null
  repos: DeviceRepoView[]
}

export interface AgentView {
  id: string
  name: string
  description: string
  instructions: string
  harness: SupportedHarness
  deviceId: string | null
  deviceName: string | null
}

/** Every local device this person owns, with its repository history. */
export async function listDevices(): Promise<DeviceView[]> {
  return (await readDevices(await getUserId())).devices
}

/**
 * The device list for 设备 settings, with when to read it again. Registration, a rename,
 * enable/disable, removal, a repository and a device coming back online push `device_list`.
 * Going offline writes nothing: a heartbeat device's lapse is a deadline, and a device
 * online through the gateway keeps the 60 s fallback while it is (presenceFallback).
 */
export async function pollDevices() {
  const userId = await getUserId()
  const { devices: items, expiries, gatewayOnline, observedAt, presenceDevices } = await readDevices(userId)
  const { ownerListRead } = await import('@/lib/live/list-read-server')
  const live = withDevicePresence(await ownerListRead(userId, expiries, observedAt), presenceDevices, process.env, observedAt)
  return { devices: items, live, presenceFallback: gatewayOnline }
}

async function readDevices(userId: string) {
  const rows = await db.select({
    id: devices.id, name: devices.name, deviceType: devices.deviceType, hostname: devices.hostname, platform: devices.platform, arch: devices.arch,
    harnesses: devices.harnesses, lastSeenAt: devices.lastSeenAt, enabled: devices.enabled,
  }).from(devices).where(and(eq(devices.ownerId, userId), eq(devices.kind, 'local'), isNull(devices.removedAt))).orderBy(desc(devices.lastSeenAt))
  const repos = rows.length
    ? await db.select({
      id: deviceRepos.id, deviceId: deviceRepos.deviceId, repoPath: deviceRepos.repoPath, baseBranch: deviceRepos.baseBranch, verifyCommand: deviceRepos.verifyCommand,
    }).from(deviceRepos).where(inArray(deviceRepos.deviceId, rows.map(row => row.id)))
    : []
  const observedAt = Date.now()
  const presence = await deviceOnlineStates(rows, observedAt)
  const heartbeat = (device: (typeof rows)[number]) => isDeviceOnline(device.lastSeenAt, observedAt)
  const expiries = rows.flatMap(device => device.lastSeenAt && heartbeat(device) ? [device.lastSeenAt.getTime() + DEVICE_ONLINE_WINDOW_MS] : [])
  const gatewayOnline = rows.some(device => presence.get(device.id) && !heartbeat(device))
  const views: DeviceView[] = rows.map(device => ({
    id: device.id, name: device.name, deviceType: device.deviceType, hostname: device.hostname, platform: device.platform, arch: device.arch,
    harnesses: device.harnesses, lastSeenAt: device.lastSeenAt, enabled: device.enabled,
    online: presence.get(device.id) ?? false,
    ...devicePresenceView(device.lastSeenAt, presence.get(device.id) ?? false, observedAt),
    repos: repos.filter(repo => repo.deviceId === device.id).map(repo => ({
      id: repo.id, repoPath: repo.repoPath, baseBranch: repo.baseBranch, verifyCommand: repo.verifyCommand,
    })),
  }))
  const presenceDevices = rows.map((device): PresenceDevice => [device.id, presence.get(device.id) ?? false,
    device.lastSeenAt && heartbeat(device) ? device.lastSeenAt.getTime() + DEVICE_ONLINE_WINDOW_MS : 0])
  return { devices: views, expiries, gatewayOnline, observedAt, presenceDevices }
}

/** Mints a device token. The plaintext is returned once and never stored. */
export async function createDeviceToken(input: { name: string }): Promise<ActionResult<{ token: string }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ name: z.string().trim().max(60) }).safeParse(input)
    if (!parsed.success) return { error: 'deviceNameTooLong' }
    const token = await issueDeviceToken(userId, parsed.data.name)
    return { token }
  })
}

export interface SshHostView {
  alias: string
  hostName: string | null
  user: string | null
}

/**
 * Whether the orchestrator may dispatch runs to this device. Off keeps the
 * device registered and visible; it simply gets no work.
 */
export async function setDeviceEnabled(input: { deviceId: string; enabled: boolean }): Promise<ActionResult<{ success: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ deviceId: z.uuid(), enabled: z.boolean() }).safeParse(input)
    if (!parsed.success) return { error: 'deviceNotFound' }
    return setOwnedDeviceEnabled(userId, parsed.data.deviceId, parsed.data.enabled)
  })
}

/** Renames one of the person's devices (1–60 characters); the daemon keeps the new name. */
export async function renameDevice(id: string, name: string): Promise<ActionResult<{ id: string; name: string }>> {
  return runAction(async () => renameOwnedDevice(await getUserId(), id, name))
}

/**
 * Removes one of the person's devices. Refused with `deviceHasActiveRuns`
 * while a thread is live on it. Its daemon credentials are revoked at once;
 * past threads keep their device (lib/device-removal.ts).
 */
export async function removeDevice(id: string): Promise<ActionResult<{ id: string; revokedTokens: number; uninstall: 'queued' | 'not_possible' }>> {
  return runAction(async () => removeOwnedDevice(await getUserId(), id))
}

/** The hosts in this server's `~/.ssh/config`, offered as one-click targets. */
export async function listLocalSshHosts(): Promise<SshHostView[]> {
  await getUserId()
  return listSshHosts()
}

export async function listAgents(): Promise<AgentView[]> {
  const userId = await getUserId()
  const rows = await db.select({
    id: agents.id, name: executionBotName, description: agents.description, instructions: agents.instructions,
    harness: agents.harness, deviceId: agents.deviceId, deviceName: devices.name,
  }).from(agents).leftJoin(devices, eq(devices.id, agents.deviceId))
    .where(and(eq(agents.userId, userId), sql`not exists (select 1 from bot_cloud_runtimes bcr where bcr."agentId" = ${agents.id})`)).orderBy(asc(agents.name))
  return rows
}

/** Who currently collaborates on the issue (R-26): they see that its threads exist. */
async function issueThreadAccess(issueId: string) {
  const { issue, user } = await requireIssueAccess(issueId)
  if (!issue.workspaceId) throw new ActionFailureError('issueNotFound')
  const members = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, issue.workspaceId), eq(workspaceMembers.status, 'active')))
  return { issue, user, memberIds: new Set(members.map(member => member.id)) }
}

const threadColumns = {
  id: agentRuns.id, issueId: agentRuns.issueId, userId: agentRuns.userId, status: agentRuns.status, prompt: agentRuns.prompt, promptTaskStart: agentRuns.promptTaskStart, promptTaskLength: agentRuns.promptTaskLength,
  // Only the report's summary: runSummaryText reads nothing else of it.
  sessionId: agentRuns.sessionId, deviceRepoId: agentRuns.deviceRepoId, failureDetails: agentRuns.failureDetails, report: sql<Record<string, unknown> | null>`case when jsonb_typeof(${agentRuns.report}) = 'object' then jsonb_build_object('summary', ${agentRuns.report}->'summary') end`, error: agentRuns.error, createdAt: agentRuns.createdAt, finishedAt: agentRuns.finishedAt,
  agentName: runBotName, harness: agents.harness, ownerName: users.name, stopRequestedAt: agentRuns.stopRequestedAt, outcome: agentRuns.outcome, kind: agentRuns.kind,
  botColor: sql<string | null>`(select b.color from bots b where b.id = ${runBotId})`, botShape: sql<string | null>`(select b.shape from bots b where b.id = ${runBotId})`,
  // Who did the stretch (lib/issue-threads.ts threadProfile): the frozen Profile's public summary and its current mark.
  profile: sql<unknown>`case when ${agentRuns.agentDefinition}->'agentProfile' is null then null else jsonb_build_object(
    'profileId',${agentRuns.agentDefinition}->'agentProfile'->'profileId','name',${agentRuns.agentDefinition}->'agentProfile'->'name',
    'roles',${agentRuns.agentDefinition}->'agentProfile'->'definition'->'roles','description',${agentRuns.agentDefinition}->'agentProfile'->'definition'->'description',
    'icon',(select p.icon from factory_agent_profiles p where p.id::text=${agentRuns.agentDefinition}->'agentProfile'->>'profileId' and p."ownerId"=${agentRuns.userId}),
    'color',(select p.color from factory_agent_profiles p where p.id::text=${agentRuns.agentDefinition}->'agentProfile'->>'profileId' and p."ownerId"=${agentRuns.userId})) end`,
}

// A read after a cursor: the client holds the run's prompt (immutable), so only what names the thread is read.
const threadCursorColumns = { ...threadColumns, prompt: sql<string>`coalesce(${threadNameLines}, '')` }

// Read-only location and changes need authority, not conversation content.
const threadIdentityColumns = { id: agentRuns.id, userId: agentRuns.userId }

const { prompt: _prompt, promptTaskStart: _promptTaskStart, promptTaskLength: _promptTaskLength, sessionId: _sessionId, deviceRepoId: _deviceRepoId, report: _report, error: _error, ...threadListColumns } = threadColumns

/** The issue's threads, as much of each as this viewer may see (R-62). */
export async function listIssueThreads(issueId: string): Promise<IssueThread[]> {
  return withDatabaseOperation('/actions/threads/issue-list', async () => (await readIssueThreads(issueId)).threads)
}

/** The same list, plus the channel its `issue_threads` key arrives on: the issue's
 * workspace, or the owner's home for a personal issue; null reads once a minute. */
export async function pollIssueThreads(issueId: string): Promise<{ threads: IssueThread[]; live: { workspaceId: string | null } }> {
  return withDatabaseOperation('/actions/threads/issue-list', async () => {
    const { threads, issue, user } = await readIssueThreads(issueId)
    const [{ documentLiveWorkspace }, { workspacePool }] = await Promise.all([import('@/lib/live/panels'), import('@/lib/workspace-db')])
    return { threads, live: { workspaceId: await documentLiveWorkspace(pool, workspacePool, issue.id, user.id) } }
  })
}

async function readIssueThreads(issueId: string) {
  const { issue, user, memberIds } = await issueThreadAccess(issueId)
  const result = (threads: IssueThread[]) => ({ threads, issue, user })
  if (!memberIds.has(user.id)) return result([])
  // BE-18: fold continuation chains by root first, then take the newest ISSUE_THREAD_LIMIT
  // roots, so continuations never use up a slot (lib/run-chain.ts). Read-only, no locks.
  const chains = await listIssueRunChains(pool, issue.id, [...memberIds], ISSUE_THREAD_LIMIT)
  if (!chains.length) return result([])
  const rows = await db.select({ ...threadListColumns, ...issueThreadListText(user.id) }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.issueId, issue.id), eq(agentRuns.workspaceId, issue.workspaceId!), inArray(agentRuns.userId, [...memberIds]), inArray(agentRuns.id, chains.map(chain => chain.rootRunId))))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(ISSUE_THREAD_LIMIT)
  const byRoot = new Map(chains.map(chain => [chain.rootRunId, chain]))
  return result((await threadQuestions(projectIssueThreads(rows, issue.id, user.id, memberIds).map(thread => withRunChain(thread, byRoot.get(thread.id))), user.id)).threads)
}

/**
 * One thread the viewer may read (canReadThread). With a task, the task's collaborators
 * decide (issueThreadAccess). With none (`issueId` null), the active members of the
 * workspace of the bot that dispatched it, or its owner alone when no bot did
 * (taskFreeThreadMembers); either way only its owner reads it.
 */
type ThreadColumns = typeof threadColumns | typeof threadCursorColumns | typeof threadIdentityColumns
type ReadableThreadResult<T extends ThreadColumns> = {
  row: SelectResult<T, 'partial', { agent_runs: 'not-null'; agents: 'not-null'; user: 'nullable' }>
  user: { id: string }
}

function readableThread(issueId: string | null, runId: string, columns: typeof threadColumns): Promise<ReadableThreadResult<typeof threadColumns>>
function readableThread(issueId: string | null, runId: string, columns: typeof threadCursorColumns): Promise<ReadableThreadResult<typeof threadCursorColumns>>
function readableThread(issueId: string | null, runId: string, columns: typeof threadIdentityColumns): Promise<ReadableThreadResult<typeof threadIdentityColumns>>
async function readableThread(issueId: string | null, runId: string, columns: ThreadColumns): Promise<ReadableThreadResult<typeof threadColumns> | ReadableThreadResult<typeof threadCursorColumns> | ReadableThreadResult<typeof threadIdentityColumns>> {
  if (issueId !== null) {
    const access = await issueThreadAccess(issueId)
    if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
    const [row] = await db.select(columns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.issueId, access.issue.id), eq(agentRuns.workspaceId, access.issue.workspaceId!))).limit(1)
    if (!row || !canReadThread(row.userId, access.user.id, access.memberIds)) throw new ActionFailureError('runNotFound')
    return { row, user: access.user }
  }
  const user = await getWorkspaceReader()
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  const [row] = await db.select(columns)
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, user.id), eq(agentRuns.workspaceId, user[tokenWorkspace]), isNull(agentRuns.issueId))).limit(1)
  if (!row) throw new ActionFailureError('runNotFound')
  return { row, user }
}

/**
 * The task a thread works on, for a thread opened from its address alone (R-82):
 * `{ issueId: null }` for a thread with no task. Null unless the viewer may read
 * that thread, exactly as getIssueThread decides.
 */
export async function findThreadIssue(runId: string): Promise<{ issueId: string | null } | null> {
  return withDatabaseOperation('/actions/threads/find-issue', () => readThreadIssue(runId))
}

async function readThreadIssue(runId: string): Promise<{ issueId: string | null } | null> {
  if (!z.uuid().safeParse(runId).success) return null
  const [run] = await db.select({ ...threadIdentityColumns, issueId: agentRuns.issueId, workspaceId: agentRuns.workspaceId })
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return null
  try {
    if (run.issueId === null) {
      const user = await getWorkspaceReader()
      // The first read already has the task-free identity. Authorization still
      // selects the current workspace and checks active membership on every call.
      return run.userId === user.id && run.workspaceId === user[tokenWorkspace] ? { issueId: null } : null
    }
    await readableThread(run.issueId, runId, threadIdentityColumns)
    return { issueId: run.issueId }
  } catch { return null }
}

export interface IssueThreadDetail {
  delivery?: import('@/lib/thread-delivery').ThreadDeliveryView
  /** Authorized scopes for every attempt; browser state never guesses them. */
  live?: { viewerId?: string; runs: import('@/lib/live/panels').ThreadLiveReference[]; issueWorkspaceId: string | null; questionDeadline: ThreadQuestionDeadline | null; revisions?: Record<string, number> }
  /** The owner sees the stop deadline too, so a reload does not reset the timeout. */
  thread: IssueThread & { failureDetails: RunFailure | null; prompt: string; /** `prompt` is the task alone; the Agent also received system instructions (getThreadInstructions). */ hasInstructions?: true; stopRequestedAt: Date | null; /** Host projection for the existing controls; mutations still revalidate. */ replyAvailable: boolean; retryAvailable: boolean; feedbackEligible:boolean; /** The latest masked run error or the host's fixed wake failure. */ error: string | null; /** The owner's own: quota switches and a quota pause (lib/run-quota-view.ts). */ quota: import('@/lib/run-quota-view').ThreadQuotaView | null; /** Host-confirmed provider recovery, within this owner's thread chain. */ modelFallback?: import('@/lib/run-model-fallback-view').ThreadModelFallbackView[] | null; /** Keep polling while the host prepares a continuation; no uncommitted switch is displayed. */ modelFallbackPending?: boolean }
  chunks: { chunk: Record<string, unknown>; at: Date }[]
  messages: { id: string; submissionId?: string; text: string; at: Date; author: string; image: string | null; mine: boolean }[]
  /** Where `chunks` ends; passed back, the next read returns only later chunks. */
  chunkCursor: ThreadChunkCursor | null
  /** `chunks` holds only the chunks after the cursor that was passed: append them to the ones held. */
  chunksAppend: boolean
  /** A cursor read: `thread.prompt` is left out; the held read's prompt stands (mergeThreadChunks). */
  promptOmitted?: true
  /**
   * What this thread's run holds (lib/context-usage.ts): an estimate from stored
   * text, never a provider count. Optional because a page open across a deploy
   * may still be served by a build that predates it, like every other host
   * projection here.
   */
  context?: import('@/lib/context-usage').ContextUsage
}

/**
 * Which of the viewer's own threads end on a run that owes them an answer, or whose answer is
 * resuming them. Only the owner may answer (lib/agent-runs.ts), and only while Factory lifecycle
 * is on; the answer itself goes through sendIssueThreadMessage to the chain's latestRunId.
 * A teammate's thread or a live run never carries a question.
 */
async function threadQuestions(threads: readonly IssueThread[], viewerId: string): Promise<{ threads: IssueThread[]; deadline: ThreadQuestionDeadline | null }> {
  // Keyed by the chain's live end (threadQuestionRunId), so an earlier attempt's answered question never resurfaces.
  const asked = new Map(threads.flatMap(thread => {
    const runId = thread.ownedByCurrentUser ? threadQuestionRunId(thread) : null
    return runId ? [[thread.id, runId] as const] : []
  }))
  if (!asked.size || !deploymentSwitch('factoryRouting') || !deploymentSwitch('factoryLifecycle')) return { threads: [...threads], deadline: null }
  const { states, deadline } = await readThreadQuestionState(pool, [...new Set(asked.values())], viewerId)
  return { threads: await Promise.all(threads.map(async thread => {
    const question = states.get(asked.get(thread.id) ?? '') ?? null
    // The list and detail share the owner's host-confirmed wake projection;
    // the queued run and its committed answer remain unchanged.
    const questionWake = thread.ownedByCurrentUser && question === 'resuming' && (thread.continuation?.status ?? thread.status) === 'queued'
      ? await (await import('@/lib/factory/questions/wake')).questionWakeFailure(pool, viewerId, thread.latestRunId)
      : null
    return { ...thread, question, questionWake }
  })), deadline }
}

/** Shared with the explicit owner Retry action: a check can recover its own
 * strict question, never become an ordinary task continuation. */
async function originalSessionRetry(userId: string, runId: string, issueId: string) {
  const requestId=factoryEventId('question-owner-retry',runId)
  const eventId=factoryEventId('question-recover',requestId)
  const {rows:[question]}=await pool.query(`SELECT q.id AS "questionId",q.revision AS "questionRevision",
    q.status AS "questionStatus",q."continuationRunId",q."originRunId",q."originSessionId",t."botId",t.status AS "taskStatus",r.status AS "runStatus",
    jsonb_build_object('taskId',t.id,'issueId',t."issueId",'attemptId',t."attemptId",'candidateId',t."candidateId",'revision',t.revision) AS binding,
    e.request AS "recoveryRequest"
    FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=$1
    JOIN agent_runs r ON r.id=$2 AND r."userId"=$1 AND r."issueId"=$3
    LEFT JOIN factory_events e ON e."taskId"=t.id AND e."eventId"=$4 AND e.request->>'kind'='question_recover'
      AND e.request->>'userId'=$1 AND e.request->'input'->>'expectedFailedRunId'=r.id::text
      AND e.request->'input'->'reference'->>'questionId'=q.id::text
    WHERE q."userId"=$1 AND q."issueId"=$3 AND t."issueId"=$3
      AND r."questionContinuation"->>'requireSessionResume'='true'
      AND (q."continuationRunId"=r.id OR e."eventId" IS NOT NULL OR q.id::text=r."questionContinuation"->>'questionId')`,[userId,runId,issueId,eventId])
  return { requestId, question }
}

function originalSessionRetryAvailable(question: { recoveryRequest?: unknown; questionStatus: string; taskStatus: string; runStatus: string; continuationRunId: string | null } | undefined, runId: string) {
  return !!question && (!!question.recoveryRequest || (question.questionStatus === 'blocked' && question.taskStatus === 'blocked' && question.runStatus === 'failed' && question.continuationRunId === runId))
}

/**
 * Where a thread runs, for the run-location icon after its title
 * (docs/design/thread-run-location.md). Only the thread's owner sees which
 * machine; anyone else who may read the thread gets null. Its own read, so the
 * conversation's frequent reads never wait on a device's presence.
 */
export async function getThreadMachine(issueId: string | null, runId: string): Promise<import('@/lib/thread-machine').ThreadMachine | null> {
  return withDatabaseOperation('/actions/threads/machine', async () => {
    const { row, user } = await readableThread(issueId, runId, threadIdentityColumns)
    if (row.userId !== user.id) return null
    const chain = await readRunChain(pool, row.userId, row.id)
    const runIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
    return (await import('@/lib/thread-machine-view')).readThreadMachine(pool, user.id, runIds)
  })
}

/**
 * What this thread's run holds (lib/context-usage.ts). One query counts every
 * character in SQL and returns no text: a cursor read must stay small, so the
 * brief cannot be sent again to be measured (tests/thread-detail-bytes.db.test.ts).
 * It covers the whole run chain and the whole stored brief whatever the cursor
 * returned, so a cursor read reports the same usage as a full one.
 */
async function readContextUsage(runIds: string[], rootRunId: string): Promise<import('@/lib/context-usage').ContextUsage> {
  const { CONTEXT_CHARS_SQL, contextUsageFromCounts } = await import('@/lib/context-usage')
  const { rows: [counted] } = await pool.query<Record<string, string | number | null>>(CONTEXT_CHARS_SQL, [runIds, rootRunId])
  const count = (value: unknown) => Number(value ?? 0) || 0
  const counts = (ascii: unknown, other: unknown) => ({ ascii: count(ascii), other: count(other) })
  return contextUsageFromCounts({
    prompt: counts(counted?.promptAscii, counted?.promptOther),
    // The task range is sliced in SQL by the recorded code points, and is empty
    // when the range does not hold (lib/thread-prompt.ts rejects it there).
    task: counts(counted?.taskAscii, counted?.taskOther),
    messages: counts(counted?.messageAscii, counted?.messageOther),
    conversation: counts(counted?.conversationAscii, counted?.conversationOther),
    model: typeof counted?.model === 'string' ? counted.model : null,
  })
}

/** One thread as a conversation: what it was asked, what the agent did, and what people said in it. */
export async function getIssueThread(issueId: string | null, runId: string, after?: ThreadChunkCursor | null): Promise<IssueThreadDetail> {
  return withDatabaseOperation('/actions/threads/detail', () => readIssueThread(issueId, runId, after))
}

async function readIssueThread(issueId: string | null, runId: string, after?: ThreadChunkCursor | null): Promise<IssueThreadDetail> {
  const cursor = after ? threadChunkCursor.parse(after) : null
  // Before any of the thread: this run's keys' revisions (other attempts carry none, so they always read).
  const { readRevisions } = await import('@/lib/live/revision-read')
  const revisions = await readRevisions([{ kind: 'thread', id: runId }, { kind: 'run', id: runId }])
  const { row, user } = cursor ? await readableThread(issueId, runId, threadCursorColumns) : await readableThread(issueId, runId, threadColumns)
  // The run that resumes this one after an answered question, or runs it again after it ended (R-81), is the same thread: its chain (BE-18).
  // Named by its task, not by system text prepended to the prompt (lib/thread-prompt.ts); a cursor read's prompt is already its name lines.
  const named = cursor ? row : { ...row, prompt: threadPromptView(row.prompt, row.promptTaskStart, row.promptTaskLength).task }
  const [projected] = projectIssueThreads([named], row.issueId, user.id, new Set([user.id]))
  const chain = projected ? await readRunChain(pool, row.userId, row.id) : null
  // The conversation is the thread's, across its runs from this one on, oldest first.
  const from = chain ? Math.max(0, chain.attempts.findIndex(attempt => attempt.runId === row.id)) : 0
  const runIds = chain ? chain.attempts.slice(from).map(attempt => attempt.runId) : [row.id]
  // Invalidation reads retain the cursor: only later chunks, not the whole chain again.
  const read = await readThreadChunks(runIds, cursor)
  const chunks = read.chunks
  // The client keeps its held prompt only when it keeps its held chunks; any other read sends the whole prompt.
  const promptOmitted = Boolean(cursor && read.append)
  const stored = cursor && !read.append ? (await db.select({ prompt: agentRuns.prompt, promptTaskStart: agentRuns.promptTaskStart, promptTaskLength: agentRuns.promptTaskLength }).from(agentRuns).where(eq(agentRuns.id, row.id)).limit(1))[0] ?? { prompt: '', promptTaskStart: null, promptTaskLength: null } : row
  // The thread shows the task it was given; the Agent's full instructions open on request (getThreadInstructions).
  const { task: prompt, hasInstructions } = threadPromptView(stored.prompt, stored.promptTaskStart, stored.promptTaskLength)
  const messages = await db.select({ id: runMessages.id,
    submissionId: sql<string | null>`${coordinatorEvents.payload}#>>'{threadSubmission,requestId}'`,
    text: runMessages.text, at: runMessages.createdAt, userId: runMessages.userId, name: users.name, email: users.email, image: users.image })
    .from(runMessages).leftJoin(users, eq(users.id, runMessages.userId))
    .leftJoin(coordinatorEvents, and(eq(coordinatorEvents.id, runMessages.id), eq(coordinatorEvents.userId, user.id), eq(coordinatorEvents.kind, 'user_message')))
    .where(inArray(runMessages.runId, runIds)).orderBy(asc(runMessages.createdAt))
  const { threads: [thread], deadline: questionDeadline } = projected ? await threadQuestions([withRunChain(projected, chain)], user.id) : { threads: [], deadline: null }
  if (!thread) throw new ActionFailureError('runNotFound')
  // A stop request belongs to the live run that send and stop address, not to an earlier attempt.
  const live = chain?.attempts.find(attempt => attempt.runId === thread.latestRunId)
  const stopRequestedAt = live && live.runId !== row.id ? live.stopRequestedAt : row.stopRequestedAt
  // Failure and Retry address that same run. Keep the root's name, prompt and
  // identity while reading the latest failed continuation's masked error.
  let error: string | null = null
  let failureDetails = readRunFailure(live && live.runId !== row.id ? live.failureDetails : row.failureDetails)
  if ((live?.status ?? row.status) === 'failed') {
    if (!live || live.runId === row.id) error = row.error ?? null
    else {
      const [failed] = await db.select({ error: agentRuns.error, failureDetails: agentRuns.failureDetails }).from(agentRuns)
        .where(and(eq(agentRuns.id, live.runId), eq(agentRuns.userId, row.userId),
          row.issueId === null ? isNull(agentRuns.issueId) : eq(agentRuns.issueId, row.issueId), eq(agentRuns.status, 'failed'))).limit(1)
      error = failed?.error ?? null
      failureDetails = readRunFailure(failed?.failureDetails)
    }
  }
  const questionWake = thread.questionWake ?? null
  if (questionWake) error = questionWake.error
  const liveStatus = live?.status ?? row.status
  let replyAvailable = true
  let retryAvailable = !!questionWake || liveStatus === 'failed'
  if (!runIsActive(liveStatus)) {
    // Independent checks cannot enter ordinary continuation (latestTaskRun).
    // Read the latest run's host binding, never a report or the root's stage.
    const { rows: [target] } = await pool.query<{ independentCheck: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM factory_attempts a WHERE a."runId"=r.id AND a.stage IN ('review','verify','monitor')
      ) AS "independentCheck" FROM agent_runs r
      WHERE r.id=$1 AND r."userId"=$2 AND r."issueId" IS NOT DISTINCT FROM $3::uuid`, [thread.latestRunId, user.id, row.issueId])
    replyAvailable = !!target && (!target.independentCheck || thread.question === 'waiting')
    if (!target) retryAvailable = false
    else if (target.independentCheck) {
      const recovery = liveStatus === 'failed' && row.issueId
        ? await originalSessionRetry(user.id, thread.latestRunId, row.issueId) : null
      retryAvailable = originalSessionRetryAvailable(recovery?.question, thread.latestRunId)
    }
  }
  const quota = row.userId === user.id
    ? await (await import('@/lib/run-quota-view')).threadQuotaView(user.id, chain?.attempts.map(attempt => attempt.runId) ?? [row.id], thread.latestRunId)
    : null
  const modelFallback = row.userId === user.id
    ? await (await import('@/lib/run-quota-view')).threadModelFallbackState(user.id, chain?.attempts.map(attempt => attempt.runId) ?? [row.id], thread.latestRunId)
    : null
  const { threadLiveReferences, documentLiveWorkspace } = await import('@/lib/live/panels')
  const { workspacePool } = await import('@/lib/workspace-db')
  const chainRunIds = chain ? chain.attempts.map(attempt => attempt.runId) : [row.id]
  const [runs, issueWorkspaceId, context, delivery] = await Promise.all([
    threadLiveReferences(pool, workspacePool, runIds, user.id),
    row.issueId ? documentLiveWorkspace(pool, workspacePool, row.issueId, user.id) : null,
    // Over the whole chain and the whole brief, so a cursor read reports what a full one does.
    readContextUsage(chainRunIds, row.id),
    row.userId === user.id ? (await import('@/lib/thread-delivery-queue')).threadDeliveryView(pool, user.id, chain?.rootRunId ?? row.id, thread.latestRunId) : undefined,
  ])
  return {
    delivery,
    live: { viewerId: user.id, runs, issueWorkspaceId, questionDeadline, ...(Object.keys(revisions).length ? { revisions } : {}) },
    thread: { ...thread, failureDetails, questionWake, prompt: promptOmitted ? '' : prompt, ...(!promptOmitted && hasInstructions ? { hasInstructions: true as const } : {}), stopRequestedAt, replyAvailable, retryAvailable, quota, modelFallback: modelFallback?.notices ?? null, modelFallbackPending: modelFallback?.pending ?? false, error, feedbackEligible: row.userId===user.id && ['succeeded','failed'].includes(row.status) && !!row.finishedAt && !!row.sessionId && !!row.deviceRepoId },
    chunks,
    messages: messages.map(message => ({ id: message.id, ...(message.submissionId ? { submissionId: message.submissionId } : {}), text: message.text, at: message.at, author: message.name || message.email || '', image: message.image ?? null, mine: message.userId === user.id })),
    chunkCursor: read.cursor,
    chunksAppend: read.append,
    context,
    ...(promptOmitted ? { promptOmitted: true as const } : {}),
  }
}

/** Everything the thread's Agent was sent, for 查看完整指令: read only when the person asks for it. */
export async function getThreadInstructions(issueId: string | null, runId: string): Promise<string> {
  return withDatabaseOperation('/actions/threads/instructions', async () => {
    const { row } = await readableThread(issueId, runId, threadIdentityColumns)
    return (await db.select({ prompt: agentRuns.prompt }).from(agentRuns).where(eq(agentRuns.id, row.id)).limit(1))[0]?.prompt ?? ''
  })
}

/**
 * The thread's 改动 tab (Figma 820:4843): the newest checkpoint of its run chain, a
 * gzipped `git diff --binary` with secrets already masked when it was saved
 * (app/v1/runs/[runId]/checkpoint). Read-only; whoever may read the thread sees it.
 */
export async function getThreadChanges(issueId: string | null, runId: string): Promise<ThreadChangesResult> {
  return withDatabaseOperation('/actions/threads/changes', () => readThreadChanges(issueId, runId))
}

async function readThreadChanges(issueId: string | null, runId: string): Promise<ThreadChangesResult> {
  const { row } = await readableThread(issueId, runId, threadIdentityColumns)
  const { runIds, checkpoint } = await readRunChainCheckpoint(pool, row.userId, row.id)
  if (!checkpoint) return { state: 'none' }
  if (checkpoint.unavailableReason) return { state: 'tooLarge' }
  let text: string
  try { text = gunzipSync(checkpoint.patch, { maxOutputLength: THREAD_CHANGES_MAX_TEXT }).toString('utf8') } catch { return { state: 'tooLarge' } }
  const changes = parseUnifiedDiff(text)
  if (!changes.files.length) return { state: 'none' }
  // 在新标签打开: the file in the thread's pull request, on GitHub's files page.
  const { rows: [published] } = await pool.query<{ url: string }>(
    `SELECT "pullRequest"->>'url' AS url FROM run_publications WHERE "runId"=ANY($1::uuid[]) AND "pullRequest"->>'url' IS NOT NULL ORDER BY "updatedAt" DESC LIMIT 1`, [runIds])
  const prUrl = published && safeHttpUrl(published.url)
  if (prUrl) for (const file of changes.files) file.url = `${prUrl.replace(/\/+$/, '')}/files#diff-${createHash('sha256').update(file.path).digest('hex')}`
  return { state: 'ready', changes }
}

const THREAD_CHANGES_MAX_TEXT = 8 * 1024 * 1024

function safeHttpUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : null } catch { return null }
}

/** Something a person says in a running thread; the daemon delivers it to the agent. */
export async function sendIssueThreadMessage(input: { issueId: string | null; runId: string; text: string; requestId?: string; delivery?: import('@/lib/thread-delivery').ThreadDeliveryMode; expectedOwnerId?: string; expectedWorkspaceId?: string; retryOriginalSession?: true; questionWakeGeneration?: string }): Promise<{ runId: string; continued: boolean }> {
  const text = z.string().trim().min(1).max(10_000).safeParse(input.text)
  if (!text.success) throw new ActionFailureError('messageRequired')
  const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
  const requestHeaders=await headers()
  if(!desktopHumanSessionId()&&(requestHeaders.has('authorization')||!requestHeaders.get('cookie')))throw new ActionFailureError('authRequired')
  const session=await auth.api.getSession({headers:requestHeaders,query:{disableCookieCache:true}})
  if(!session?.user||!session.session?.id||session.user.id!==user.id)throw new ActionFailureError('authRequired')
  if (input.expectedOwnerId && session.user.id !== input.expectedOwnerId) throw new ActionFailureError('authRequired')
  if (input.expectedWorkspaceId && (await loadWorkspaceContext(undefined, session.user)).workspace.id !== input.expectedWorkspaceId) throw new ActionFailureError('workspaceAccessDenied')
  if(row.userId!==user.id)throw new ActionFailureError('runNotFound')
  if(input.retryOriginalSession!==undefined && input.retryOriginalSession!==true)throw new ActionFailureError('runInvalid')
  if (input.delivery !== undefined && (!['queue','steer','interrupt'].includes(input.delivery) || !input.requestId || input.retryOriginalSession)) throw new ActionFailureError('validationGeneric')
  if(input.requestId!==undefined && !z.uuid().safeParse(input.requestId).success)throw new ActionFailureError('validationGeneric')
  if(input.requestId!==undefined && input.retryOriginalSession)throw new ActionFailureError('validationGeneric')
  if(input.questionWakeGeneration!==undefined && (!input.retryOriginalSession || !z.uuid().safeParse(input.questionWakeGeneration).success))throw new ActionFailureError('validationGeneric')
  if(input.questionWakeGeneration!==undefined) {
    if(!row.issueId)throw new ActionFailureError('threadCannotContinue')
    try {
      const {retryQueuedQuestionWake}=await import('@/lib/factory/questions/wake')
      return await retryQueuedQuestionWake(pool,{userId:user.id,sessionId:session.session.id},row.id,input.questionWakeGeneration)
    } catch(error) {
      if(error instanceof FactoryError)throw new ActionFailureError(error.code==='factoryNotFound'?'runNotFound':'threadRecoveryUnavailable')
      throw error
    }
  }
  if(input.retryOriginalSession && row.issueId) {
    // Only the existing owner Retry control requests recovery. A typed label,
    // Bot message or ordinary send never acquires this authority.
    const { requestId, question } = await originalSessionRetry(user.id, row.id, row.issueId)
    if(question) {
      if(!originalSessionRetryAvailable(question, row.id))throw new ActionFailureError('threadCannotContinue')
      // One SQL snapshot selects either the original receipt input or the
      // current reference. Concurrent clicks therefore send the same request.
      const input=question.recoveryRequest?.input ?? {requestId,expectedFailedRunId:row.id,reference:{questionId:question.questionId,questionRevision:question.questionRevision,binding:question.binding,originRunId:question.originRunId,originSessionId:question.originSessionId}}
      try {
        const {factoryRuntimeForBot}=await import('@/lib/factory/runtime')
        const recovered=await factoryRuntimeForBot(question.botId).questions.recover({source:'human',userId:user.id,sessionId:session.session.id},input)
        return {runId:recovered.continuationRunId,continued:true}
      } catch(error) {
        if(error instanceof FactoryError)throw new ActionFailureError(error.code==='factoryNotFound'?'runNotFound':'threadRecoveryUnavailable')
        throw error
      }
    }
  }
  // A working thread gets it as a message; an ended one runs again in the same thread (R-81, lib/thread-continue.ts).
  return sendThreadMessage(user.id,row.id,text.data,{source:'human',sessionId:session.session.id},input.requestId,input.delivery)
}

/**
 * The composer's send: the same as sendIssueThreadMessage, with a refusal the
 * person can act on (threadReplaced, threadCannotContinue, threadStopping, a
 * dispatch with no machine or model) returned as its code, so the thread says
 * why instead of 「发送失败」. Other failures still throw.
 */
export async function sendIssueThreadReply(input: { issueId: string | null; runId: string; text: string; requestId?: string; delivery?: import('@/lib/thread-delivery').ThreadDeliveryMode; expectedOwnerId?: string; expectedWorkspaceId?: string; retryOriginalSession?: true; questionWakeGeneration?: string }): Promise<ActionResult<{ sent: true; runId: string; continued: boolean }>> {
  return runAction(async () => { const result=await sendIssueThreadMessage(input); return { sent: true as const,...result } })
}

export async function changeQueuedThreadReply(input: { issueId: string | null; runId: string; messageId: string; action: 'cancel' | 'sendNow' }) {
  return runAction(async () => {
    if (!z.uuid().safeParse(input.messageId).success || !['cancel','sendNow'].includes(input.action)) throw new ActionFailureError('validationGeneric')
    const { row, user } = await readableThread(input.issueId, input.runId, threadColumns)
    const requestHeaders = await headers()
    if (!desktopHumanSessionId() && (requestHeaders.has('authorization') || !requestHeaders.get('cookie'))) throw new ActionFailureError('authRequired')
    const session = await auth.api.getSession({ headers: requestHeaders, query: { disableCookieCache: true } })
    if (!session?.session?.id || session.user.id !== user.id || row.userId !== user.id) throw new ActionFailureError('runNotFound')
    const { cancelQueuedThreadReply, deliverQueuedThreadReply } = await import('@/lib/thread-delivery-queue')
    if (input.action === 'cancel') return { status: await cancelQueuedThreadReply(pool, user.id, row.id, input.messageId) }
    return { status: await deliverQueuedThreadReply(pool, user.id, row.id, input.messageId) ? 'sent' as const : 'tooLate' as const }
  })
}

/**
 * A thread's name: the task it works on, as "MIK-11 群聊建表" (glossary:
 * a thread is one run, named for its work, never for its bot). Null when the
 * run is not this person's or works on no task.
 */
export async function getThreadName(runId: string): Promise<string | null> {
  const reader = await getWorkspaceReader()
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) return null
  const source = (await citationSources(reader, [`[[run:${parsed.data}]]`]))[parsed.data]
  if (source?.kind !== 'run' || !source.issue) return null
  const key = source.issue.identifier ?? (source.issue.number === null ? null : `#${source.issue.number}`)
  return key ? `${key} ${source.issue.title}` : source.issue.title
}

/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function stopRun(runId: string): Promise<{ stoppedRunIds: string[] }> {
  return withOwnWorkspaceRun(runId, userId => requestRunStop(userId, runId))
}

/** A run paused because its subscription's quota ran out goes on with the person's API key. Owner only; a repeat returns the same run. */
export async function resumeQuotaPausedRunOnApiKey(runId: string): Promise<{ runId: string }> {
  return withOwnWorkspaceRun(runId, async userId => (await import('@/lib/run-quota')).resumeQuotaPausedRunOnApiKey(userId, runId))
}

/** A run paused because its subscription's quota ran out is tried again with its original credential. Owner only; a repeat returns the same run. */
export async function retryQuotaPausedRun(runId: string): Promise<{ runId: string }> {
  return withOwnWorkspaceRun(runId, async userId => (await import('@/lib/run-quota')).retryQuotaPausedRun(userId, runId))
}

/** Settings #504 queues maintenance through the same owner-scoped backend as HTTP. */
export async function sendDeviceCommand(input: { deviceId: string; kind: DeviceCommandKind }): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ deviceId: z.uuid(), kind: z.enum(['redetect', 'restart', 'update']) }).safeParse(input)
    if (!parsed.success) return { error: 'deviceNotFound' }
    const id = await enqueueDeviceCommand(userId, parsed.data.deviceId, parsed.data.kind)
    return id ? { id } : { error: 'deviceNotFound' }
  })
}
