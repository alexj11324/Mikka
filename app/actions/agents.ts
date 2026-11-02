'use server'

import { headers } from 'next/headers'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db, pool } from '@/lib/db'
import {
  agents, agentRuns, deviceRepos, devices, issueMembers, runChunks, runMessages, users,
  type SupportedHarness,
} from '@/lib/db/schema'
import { DEVICE_ONLINE_WINDOW_MS, issueDeviceToken } from '@/lib/device-link'
import { removeOwnedDevice, renameOwnedDevice } from '@/lib/device-removal'
import { enqueueDeviceCommand, type DeviceCommandKind } from '@/lib/device-management'
import { listSshHosts } from '@/lib/ssh'
import { citationSources } from '@/lib/coordinator/store'
import { requestRunStop } from '@/lib/agent-runs'
import { sendThreadMessage } from '@/lib/thread-continue'
import { chainChunks } from '@/lib/issue-run-conversation'
import { executionBotName, runBotId, runBotName } from '@/lib/run-bot-name'
import { requireIssueAccess } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { ISSUE_THREAD_LIMIT, canReadThread, projectIssueThreads, taskFreeThreadMembers, threadQuestionRunId, withRunChain, type IssueThread } from '@/lib/issue-threads'
import { threadQuestionStates } from '@/lib/issue-thread-questions'
import { listIssueRunChains, readRunChain } from '@/lib/run-chain'
import type { HarnessInfo } from '@mikka/protocol/harness'
import { autoScheduleOn } from '@/lib/device-auto-schedule'

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
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
  /** Off: the orchestrator gives this device no runs. */
  enabled: boolean
  /** 「允许自动调度」, the stored choice or the type default (servers on, personal computers off). */
  autoSchedule: boolean
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
  const userId = await getUserId()
  const rows = await db.select().from(devices).where(and(eq(devices.ownerId, userId), eq(devices.kind, 'local'), isNull(devices.removedAt))).orderBy(desc(devices.lastSeenAt))
  const repos = rows.length
    ? await db.select().from(deviceRepos).where(inArray(deviceRepos.deviceId, rows.map(row => row.id)))
    : []
  return rows.map(device => ({
    id: device.id, name: device.name, deviceType: device.deviceType, hostname: device.hostname, platform: device.platform, arch: device.arch,
    harnesses: device.harnesses, lastSeenAt: device.lastSeenAt, enabled: device.enabled, autoSchedule: autoScheduleOn(device),
    online: device.lastSeenAt ? Date.now() - device.lastSeenAt.getTime() < DEVICE_ONLINE_WINDOW_MS : false,
    repos: repos.filter(repo => repo.deviceId === device.id).map(repo => ({
      id: repo.id, repoPath: repo.repoPath, baseBranch: repo.baseBranch, verifyCommand: repo.verifyCommand,
    })),
  }))
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
    await db.update(devices)
      .set({ enabled: parsed.data.enabled, updatedAt: new Date() })
      .where(and(eq(devices.id, parsed.data.deviceId), eq(devices.ownerId, userId), isNull(devices.removedAt)))
    return { success: true }
  })
}

/** 「允许自动调度」: whether Mikka may pick this device on its own for new runs. */
export async function setDeviceAutoSchedule(input: { deviceId: string; autoSchedule: boolean }): Promise<ActionResult<{ success: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.object({ deviceId: z.uuid(), autoSchedule: z.boolean() }).safeParse(input)
    if (!parsed.success) return { error: 'deviceNotFound' }
    const updated = await db.update(devices)
      .set({ autoSchedule: parsed.data.autoSchedule, updatedAt: new Date() })
      .where(and(eq(devices.id, parsed.data.deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'), isNull(devices.removedAt)))
      .returning({ id: devices.id })
    if (!updated.length) return { error: 'deviceNotFound' }
    return { success: true }
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
  // A team-linked issue follows the same active-workspace membership rule as requireIssueAccess.
  // Direct issue membership must not resurrect access after removal from its workspace.
  const [link] = await workspaceDb.select({ workspaceId: teamIssues.workspaceId }).from(teamIssues)
    .where(eq(teamIssues.issueId, issue.id)).limit(1)
  let memberIds: string[]
  if (link) {
    const members = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, link.workspaceId), eq(workspaceMembers.status, 'active')))
    memberIds = members.map(member => member.id)
  } else {
    const members = await db.select({ id: issueMembers.memberId }).from(issueMembers).where(eq(issueMembers.issueId, issue.id))
    memberIds = [issue.userId, ...members.map(member => member.id)]
  }
  return { issue, user, memberIds: new Set(memberIds) }
}

const threadColumns = {
  id: agentRuns.id, issueId: agentRuns.issueId, userId: agentRuns.userId, status: agentRuns.status, prompt: agentRuns.prompt,
  sessionId: agentRuns.sessionId, deviceRepoId: agentRuns.deviceRepoId, report: agentRuns.report, error: agentRuns.error, createdAt: agentRuns.createdAt, finishedAt: agentRuns.finishedAt,
  agentName: runBotName, harness: agents.harness, ownerName: users.name, stopRequestedAt: agentRuns.stopRequestedAt, outcome: agentRuns.outcome,
  botColor: sql<string | null>`(select b.color from bots b where b.id = ${runBotId})`, botShape: sql<string | null>`(select b.shape from bots b where b.id = ${runBotId})`,
}

/** The issue's threads, as much of each as this viewer may see (R-62). */
export async function listIssueThreads(issueId: string): Promise<IssueThread[]> {
  const { issue, user, memberIds } = await issueThreadAccess(issueId)
  if (!memberIds.has(user.id)) return []
  // BE-18: fold continuation chains by root first, then take the newest ISSUE_THREAD_LIMIT
  // roots, so continuations never use up a slot (lib/run-chain.ts). Read-only, no locks.
  const chains = await listIssueRunChains(pool, issue.id, [...memberIds], ISSUE_THREAD_LIMIT)
  if (!chains.length) return []
  const rows = await db.select(threadColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.issueId, issue.id), inArray(agentRuns.userId, [...memberIds]), inArray(agentRuns.id, chains.map(chain => chain.rootRunId))))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(ISSUE_THREAD_LIMIT)
  const byRoot = new Map(chains.map(chain => [chain.rootRunId, chain]))
  return threadQuestions(projectIssueThreads(rows, issue.id, user.id, memberIds).map(thread => withRunChain(thread, byRoot.get(thread.id))), user.id)
}

/**
 * One thread the viewer may read (canReadThread). With a task, the task's collaborators
 * decide (issueThreadAccess). With none (`issueId` null), the active members of the
 * workspace of the bot that dispatched it, or its owner alone when no bot did
 * (taskFreeThreadMembers); either way only its owner reads it.
 */
async function readableThread(issueId: string | null, runId: string) {
  if (issueId !== null) {
    const access = await issueThreadAccess(issueId)
    if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
    const [row] = await db.select(threadColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.issueId, access.issue.id))).limit(1)
    if (!row || !canReadThread(row.userId, access.user.id, access.memberIds)) throw new ActionFailureError('runNotFound')
    return { row, user: access.user }
  }
  const user = { id: await getUserId() }
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  const [row] = await db.select({ ...threadColumns, botWorkspaceId: sql<string | null>`(select b."workspaceId" from bots b where b.id = ${runBotId})`, hasBot: sql<boolean>`${runBotId} is not null` })
    .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.id, runId), isNull(agentRuns.issueId))).limit(1)
  if (!row) throw new ActionFailureError('runNotFound')
  const workspaceMemberIds = row.botWorkspaceId
    ? (await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, row.botWorkspaceId), eq(workspaceMembers.status, 'active')))).map(member => member.id)
    : null
  if (!canReadThread(row.userId, user.id, taskFreeThreadMembers(row.userId, row.hasBot ? { workspaceMemberIds } : null))) throw new ActionFailureError('runNotFound')
  return { row, user }
}

/**
 * The task a thread works on, for a thread opened from its address alone (R-82):
 * `{ issueId: null }` for a thread with no task. Null unless the viewer may read
 * that thread, exactly as getIssueThread decides.
 */
export async function findThreadIssue(runId: string): Promise<{ issueId: string | null } | null> {
  if (!z.uuid().safeParse(runId).success) return null
  const [run] = await db.select({ issueId: agentRuns.issueId }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return null
  try {
    await readableThread(run.issueId, runId)
    return { issueId: run.issueId }
  } catch { return null }
}

export interface IssueThreadDetail {
  /** The owner sees the stop deadline too, so a reload does not reset the timeout. */
  thread: IssueThread & { prompt: string; stopRequestedAt: Date | null; feedbackEligible:boolean; /** This run's failure reason, stored masked (agent_runs.error). */ error: string | null; /** The owner's own: quota switches and a quota pause (lib/run-quota-view.ts). */ quota: import('@/lib/run-quota-view').ThreadQuotaView | null }
  chunks: { chunk: Record<string, unknown>; at: Date }[]
  messages: { id: string; text: string; at: Date; author: string; image: string | null; mine: boolean }[]
}

/**
 * Which of the viewer's own threads end on a run that owes them an answer, or whose answer is
 * resuming them. Only the owner may answer (lib/agent-runs.ts), and only while Factory lifecycle
 * is on; the answer itself goes through sendIssueThreadMessage to the chain's latestRunId.
 * A teammate's thread or a live run never carries a question.
 */
async function threadQuestions(threads: readonly IssueThread[], viewerId: string): Promise<IssueThread[]> {
  // Keyed by the chain's live end (threadQuestionRunId), so an earlier attempt's answered question never resurfaces.
  const asked = new Map(threads.flatMap(thread => {
    const runId = thread.ownedByCurrentUser ? threadQuestionRunId(thread) : null
    return runId ? [[thread.id, runId] as const] : []
  }))
  if (!asked.size || process.env.MIKKA_FACTORY_ROUTING_ENABLED !== '1' || process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED !== '1') return [...threads]
  const byRun = await threadQuestionStates(pool, [...new Set(asked.values())], viewerId)
  return threads.map(thread => ({ ...thread, question: byRun.get(asked.get(thread.id) ?? '') ?? null }))
}

/** One thread as a conversation: what it was asked, what the agent did, and what people said in it. */
export async function getIssueThread(issueId: string | null, runId: string): Promise<IssueThreadDetail> {
  const { row, user } = await readableThread(issueId, runId)
  // The run that resumes this one after an answered question, or runs it again after it ended (R-81), is the same thread: its chain (BE-18).
  const [projected] = projectIssueThreads([row], row.issueId, user.id, new Set([user.id]))
  const chain = projected ? await readRunChain(pool, row.userId, row.id) : null
  // The conversation is the thread's, across its runs from this one on, oldest first.
  const from = chain ? Math.max(0, chain.attempts.findIndex(attempt => attempt.runId === row.id)) : 0
  const runIds = chain ? chain.attempts.slice(from).map(attempt => attempt.runId) : [row.id]
  const chunks = chainChunks(await db.select({ runId: runChunks.runId, chunk: runChunks.chunk, at: runChunks.createdAt }).from(runChunks)
    .innerJoin(agentRuns, eq(agentRuns.id, runChunks.runId))
    .where(inArray(runChunks.runId, runIds)).orderBy(asc(agentRuns.createdAt), asc(runChunks.seq)))
  const messages = await db.select({ id: runMessages.id, text: runMessages.text, at: runMessages.createdAt, userId: runMessages.userId, name: users.name, email: users.email, image: users.image })
    .from(runMessages).leftJoin(users, eq(users.id, runMessages.userId))
    .where(inArray(runMessages.runId, runIds)).orderBy(asc(runMessages.createdAt))
  const [thread] = projected ? await threadQuestions([withRunChain(projected, chain)], user.id) : []
  if (!thread) throw new ActionFailureError('runNotFound')
  // A stop request belongs to the live run that send and stop address, not to an earlier attempt.
  const live = chain?.attempts.find(attempt => attempt.runId === thread.latestRunId)
  const stopRequestedAt = live && live.runId !== row.id ? live.stopRequestedAt : row.stopRequestedAt
  const quota = row.userId === user.id
    ? await (await import('@/lib/run-quota-view')).threadQuotaView(user.id, chain?.attempts.map(attempt => attempt.runId) ?? [row.id], thread.latestRunId)
    : null
  return {
    thread: { ...thread, prompt: row.prompt, stopRequestedAt, quota, error: row.status === 'failed' ? row.error ?? null : null, feedbackEligible: row.userId===user.id && ['succeeded','failed'].includes(row.status) && !!row.finishedAt && !!row.sessionId && !!row.deviceRepoId },
    chunks,
    messages: messages.map(message => ({ id: message.id, text: message.text, at: message.at, author: message.name || message.email || '', image: message.image ?? null, mine: message.userId === user.id })),
  }
}

/** Something a person says in a running thread; the daemon delivers it to the agent. */
export async function sendIssueThreadMessage(input: { issueId: string | null; runId: string; text: string }): Promise<void> {
  const text = z.string().trim().min(1).max(10_000).safeParse(input.text)
  if (!text.success) throw new ActionFailureError('messageRequired')
  const { row, user } = await readableThread(input.issueId, input.runId)
  const requestHeaders=await headers()
  if(requestHeaders.has('authorization')||!requestHeaders.get('cookie'))throw new ActionFailureError('authRequired')
  const session=await auth.api.getSession({headers:requestHeaders,query:{disableCookieCache:true}})
  if(!session?.user||session.user.id!==user.id)throw new ActionFailureError('authRequired')
  // A working thread gets it as a message; an ended one runs again in the same thread (R-81, lib/thread-continue.ts).
  await sendThreadMessage(user.id,row.id,text.data,{source:'human',sessionId:session.session.id})
}

/**
 * A thread's name: the task it works on, as "MIK-11 群聊建表" (glossary:
 * a thread is one run, named for its work, never for its bot). Null when the
 * run is not this person's or works on no task.
 */
export async function getThreadName(runId: string): Promise<string | null> {
  const userId = await getUserId()
  const parsed = z.uuid().safeParse(runId)
  if (!parsed.success) return null
  const source = (await citationSources(userId, [`[[run:${parsed.data}]]`]))[parsed.data]
  if (source?.kind !== 'run' || !source.issue) return null
  const key = source.issue.identifier ?? (source.issue.number === null ? null : `#${source.issue.number}`)
  return key ? `${key} ${source.issue.title}` : source.issue.title
}

/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function stopRun(runId: string): Promise<{ stoppedRunIds: string[] }> {
  return requestRunStop(await getUserId(), runId)
}

/** A run paused because its subscription's quota ran out goes on with the person's API key. Owner only; a repeat returns the same run. */
export async function resumeQuotaPausedRunOnApiKey(runId: string): Promise<{ runId: string }> {
  return (await import('@/lib/run-quota')).resumeQuotaPausedRunOnApiKey(await getUserId(), runId)
}

/** A run paused because its subscription's quota ran out is tried again with its original credential. Owner only; a repeat returns the same run. */
export async function retryQuotaPausedRun(runId: string): Promise<{ runId: string }> {
  return (await import('@/lib/run-quota')).retryQuotaPausedRun(await getUserId(), runId)
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
