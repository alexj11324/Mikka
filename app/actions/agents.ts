'use server'

import { headers } from 'next/headers'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  agents, agentRuns, deviceRepos, devices, issueMembers, runChunks, runMessages, users,
  type SupportedHarness,
} from '@/lib/db/schema'
import { DEVICE_ONLINE_WINDOW_MS, issueDeviceToken } from '@/lib/device-link'
import { listSshHosts } from '@/lib/ssh'
import { citationSources } from '@/lib/coordinator/store'
import { addRunMessage, requestRunStop } from '@/lib/agent-runs'
import { executionBotName, runBotName } from '@/lib/run-bot-name'
import { requireIssueAccess } from '@/lib/issue-access'
import { workspaceDb } from '@/lib/workspace-db'
import { teamIssues } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { ISSUE_THREAD_LIMIT, canReadThread, projectIssueThreads, type IssueThread } from '@/lib/issue-threads'
import { runIsActive } from '@/lib/issue-run-conversation'
import type { HarnessInfo } from '@mikka/protocol/harness'

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
  hostname: string | null
  platform: string | null
  arch: string | null
  harnesses: HarnessInfo[]
  online: boolean
  /** Off: the orchestrator gives this device no runs. */
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
  const userId = await getUserId()
  const rows = await db.select().from(devices).where(and(eq(devices.ownerId, userId), eq(devices.kind, 'local'))).orderBy(desc(devices.lastSeenAt))
  const repos = rows.length
    ? await db.select().from(deviceRepos).where(inArray(deviceRepos.deviceId, rows.map(row => row.id)))
    : []
  return rows.map(device => ({
    id: device.id, name: device.name, hostname: device.hostname, platform: device.platform, arch: device.arch,
    harnesses: device.harnesses, lastSeenAt: device.lastSeenAt, enabled: device.enabled,
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
      .where(and(eq(devices.id, parsed.data.deviceId), eq(devices.ownerId, userId)))
    return { success: true }
  })
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
  report: agentRuns.report, error: agentRuns.error, createdAt: agentRuns.createdAt, finishedAt: agentRuns.finishedAt,
  agentName: runBotName, harness: agents.harness, ownerName: users.name, stopRequestedAt: agentRuns.stopRequestedAt,
}

/** The issue's threads, as much of each as this viewer may see (R-62). */
export async function listIssueThreads(issueId: string): Promise<IssueThread[]> {
  const { issue, user, memberIds } = await issueThreadAccess(issueId)
  if (!memberIds.has(user.id)) return []
  const rows = await db.select(threadColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.issueId, issue.id), inArray(agentRuns.userId, [...memberIds])))
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(ISSUE_THREAD_LIMIT)
  return projectIssueThreads(rows, issue.id, user.id, memberIds)
}

async function readableThread(issueId: string, runId: string) {
  const access = await issueThreadAccess(issueId)
  if (!z.uuid().safeParse(runId).success) throw new ActionFailureError('runNotFound')
  const [row] = await db.select(threadColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.issueId, access.issue.id))).limit(1)
  if (!row || !canReadThread(row.userId, access.user.id, access.memberIds)) throw new ActionFailureError('runNotFound')
  return { row, user: access.user }
}

export interface IssueThreadDetail {
  /** The owner sees the stop deadline too, so a reload does not reset the timeout. */
  thread: IssueThread & { prompt: string; stopRequestedAt: Date | null }
  chunks: { chunk: Record<string, unknown>; at: Date }[]
  messages: { id: string; text: string; at: Date; author: string; image: string | null; mine: boolean }[]
}

/** One thread as a conversation: what it was asked, what the agent did, and what people said in it. */
export async function getIssueThread(issueId: string, runId: string): Promise<IssueThreadDetail> {
  const { row, user } = await readableThread(issueId, runId)
  const chunks = await db.select({ chunk: runChunks.chunk, at: runChunks.createdAt }).from(runChunks)
    .where(eq(runChunks.runId, row.id)).orderBy(asc(runChunks.seq))
  const messages = await db.select({ id: runMessages.id, text: runMessages.text, at: runMessages.createdAt, userId: runMessages.userId, name: users.name, email: users.email, image: users.image })
    .from(runMessages).leftJoin(users, eq(users.id, runMessages.userId))
    .where(eq(runMessages.runId, row.id)).orderBy(asc(runMessages.createdAt))
  const [thread] = projectIssueThreads([row], row.issueId ?? '', user.id, new Set([user.id]))
  return {
    thread: { ...thread, prompt: row.prompt, stopRequestedAt: row.stopRequestedAt },
    chunks,
    messages: messages.map(message => ({ id: message.id, text: message.text, at: message.at, author: message.name || message.email || '', image: message.image ?? null, mine: message.userId === user.id })),
  }
}

/** Something a person says in a running thread; the daemon delivers it to the agent. */
export async function sendIssueThreadMessage(input: { issueId: string; runId: string; text: string }): Promise<void> {
  const text = z.string().trim().min(1).max(10_000).safeParse(input.text)
  if (!text.success) throw new ActionFailureError('messageRequired')
  const { row, user } = await readableThread(input.issueId, input.runId)
  if (!runIsActive(row.status)) throw new ActionFailureError('runNotFound')
  await addRunMessage(user.id, { runId: row.id, text: text.data })
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
export async function stopRun(runId: string): Promise<void> {
  await requestRunStop(await getUserId(), runId)
}
