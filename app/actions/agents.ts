'use server'

import { headers } from 'next/headers'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  agents, agentRuns, deviceRepos, deviceTokens, devices,
  SUPPORTED_HARNESSES, type SupportedHarness,
} from '@/lib/db/schema'
import { DEVICE_ONLINE_WINDOW_MS, hashDeviceToken, newDeviceToken } from '@/lib/device-link'
import { listSshHosts } from '@/lib/ssh'
import { modelNameSchema } from '@mikka/protocol/agent-policy'
import { addRunMessage, queueRun, readRun, requestRunStop, runViewColumns, type RunDetail, type RunView } from '@/lib/agent-runs'
import type { HarnessInfo } from '@mikka/protocol/harness'
import {
  AGENT_ROLES, BUILT_IN_AGENT_PRESETS, BUILT_IN_AGENT_ROLES, MAX_AGENT_INSTRUCTIONS_LENGTH,
  isBuiltInAgentRole, type AgentRole,
} from '@/lib/agent-roles'

async function getUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

export interface DeviceRepoView {
  id: string
  repoPath: string
  baseBranch: string
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
  role: AgentRole
  name: string
  description: string
  instructions: string
  /** null: auto, chosen when a run is queued. */
  harness: SupportedHarness | null
  /** null: auto, the harness CLI's own default. */
  model: string | null
  /** null: auto, any of this person's enabled devices. */
  deviceId: string | null
  deviceName: string | null
}

export type { RunDetail, RunView } from '@/lib/agent-runs'

/** Every device this person owns, with the repos agents may work in. */
export async function listDevices(): Promise<DeviceView[]> {
  const userId = await getUserId()
  const rows = await db.select().from(devices).where(eq(devices.ownerId, userId)).orderBy(desc(devices.lastSeenAt))
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
    const token = newDeviceToken()
    await db.insert(deviceTokens).values({
      id: crypto.randomUUID(), userId, name: parsed.data.name, tokenHash: hashDeviceToken(token),
    })
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

export async function addDeviceRepo(input: { deviceId: string; repoPath: string; baseBranch: string; verifyCommand: string }): Promise<void> {
  const userId = await getUserId()
  const parsed = z.object({
    deviceId: z.uuid(),
    repoPath: z.string().trim().min(1).max(4000).startsWith('/'),
    baseBranch: z.string().trim().min(1).max(200),
    verifyCommand: z.string().trim().max(2000),
  }).safeParse(input)
  if (!parsed.success) throw new ActionFailureError('repoPathInvalid')
  const [device] = await db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, parsed.data.deviceId), eq(devices.ownerId, userId))).limit(1)
  if (!device) throw new ActionFailureError('deviceNotFound')
  await db.insert(deviceRepos).values({
    id: crypto.randomUUID(), deviceId: device.id, userId,
    repoPath: parsed.data.repoPath, baseBranch: parsed.data.baseBranch,
    verifyCommand: parsed.data.verifyCommand || null,
  }).onConflictDoNothing()
}

export async function removeDeviceRepo(id: string): Promise<void> {
  const userId = await getUserId()
  const parsed = z.uuid().safeParse(id)
  if (!parsed.success) throw new ActionFailureError('repoNotFound')
  await db.delete(deviceRepos).where(and(eq(deviceRepos.id, parsed.data), eq(deviceRepos.userId, userId)))
}

/**
 * Coordinator, Worker and Reviewer exist for everyone. They are inserted the
 * first time they are missing; the partial unique index on (userId, role)
 * makes a concurrent second insert a no-op, and a custom agent that already
 * took one of the names simply keeps it.
 */
async function ensureBuiltInAgents(userId: string): Promise<void> {
  const existing = await db.select({ role: agents.role }).from(agents).where(eq(agents.userId, userId))
  const missing = BUILT_IN_AGENT_ROLES.filter(role => !existing.some(row => row.role === role))
  if (!missing.length) return
  await db.insert(agents).values(missing.map(role => {
    const preset = BUILT_IN_AGENT_PRESETS[role]
    return {
      id: crypto.randomUUID(), userId, role, name: preset.name,
      description: preset.description, instructions: preset.instructions,
      harness: null, model: null, deviceId: null,
    }
  })).onConflictDoNothing()
}

/** Built-in roles first, in their fixed order, then custom roles by name. */
function roleRank(role: string): number {
  const index = (AGENT_ROLES as readonly string[]).indexOf(role)
  return index === -1 ? AGENT_ROLES.length : index
}

export async function listAgents(): Promise<AgentView[]> {
  const userId = await getUserId()
  await ensureBuiltInAgents(userId)
  const rows = await db.select({
    id: agents.id, role: agents.role, name: agents.name, description: agents.description,
    instructions: agents.instructions, harness: agents.harness, model: agents.model,
    deviceId: agents.deviceId, deviceName: devices.name,
  }).from(agents).leftJoin(devices, eq(devices.id, agents.deviceId))
    .where(eq(agents.userId, userId)).orderBy(asc(agents.name))
  return rows.sort((a, b) => roleRank(a.role) - roleRank(b.role))
}

const agentFields = {
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200),
  instructions: z.string().trim().max(MAX_AGENT_INSTRUCTIONS_LENGTH),
  deviceId: z.uuid().nullable(),
  harness: z.enum(SUPPORTED_HARNESSES).nullable(),
  model: modelNameSchema.nullable(),
}
const agentInput = z.object(agentFields)
const agentUpdateInput = z.object({ id: z.uuid(), ...agentFields })

export type AgentInput = z.input<typeof agentInput>

function agentValidationCode(error: z.ZodError): 'validationNameRequired' | 'validationGeneric' {
  return error.issues[0]?.path[0] === 'name' ? 'validationNameRequired' : 'validationGeneric'
}

/**
 * A pinned device must be this person's; a pinned device and harness together
 * must be a harness that device reports as installed — the daemon's own
 * detection decides. Anything left on auto is checked when a run is queued.
 */
async function checkPlacement(input: { deviceId: string | null; harness: SupportedHarness | null }, userId: string): Promise<void> {
  if (!input.deviceId) return
  const [device] = await db.select().from(devices)
    .where(and(eq(devices.id, input.deviceId), eq(devices.ownerId, userId))).limit(1)
  if (!device) throw new ActionFailureError('deviceNotFound')
  if (input.harness && !device.harnesses.some(info => info.harness === input.harness && info.installed)) {
    throw new ActionFailureError('agentHarnessMissing')
  }
}

/** A custom role. Built-in roles are seeded, never created here. */
export async function createAgent(input: AgentInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = agentInput.safeParse(input)
    if (!parsed.success) throw new ActionFailureError(agentValidationCode(parsed.error))
    await checkPlacement(parsed.data, userId)
    const id = crypto.randomUUID()
    try {
      await db.insert(agents).values({ id, userId, role: 'custom', ...parsed.data })
    } catch (error) {
      // 23505 is the name unique index; anything else is a real failure.
      if ((error as { code?: string }).code === '23505') throw new ActionFailureError('agentDuplicateName')
      throw new ActionFailureError('agentAddFailed')
    }
    return { id }
  })
}

export async function updateAgent(input: AgentInput & { id: string }): Promise<ActionResult<{ success: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = agentUpdateInput.safeParse(input)
    if (!parsed.success) throw new ActionFailureError(agentValidationCode(parsed.error))
    await checkPlacement(parsed.data, userId)
    const { id, ...fields } = parsed.data
    let updated: { id: string }[]
    try {
      updated = await db.update(agents).set({ ...fields, updatedAt: new Date() })
        .where(and(eq(agents.id, id), eq(agents.userId, userId))).returning({ id: agents.id })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ActionFailureError('agentDuplicateName')
      throw new ActionFailureError('agentSaveFailed')
    }
    if (!updated.length) throw new ActionFailureError('agentNotFound')
    return { success: true as const }
  })
}

/** Puts a built-in role's description and prompt back to the shipped ones. */
export async function resetAgentInstructions(id: string): Promise<ActionResult<{ success: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new ActionFailureError('agentNotFound')
    const [agent] = await db.select({ role: agents.role }).from(agents)
      .where(and(eq(agents.id, parsed.data), eq(agents.userId, userId))).limit(1)
    if (!agent) throw new ActionFailureError('agentNotFound')
    if (!isBuiltInAgentRole(agent.role)) throw new ActionFailureError('agentNotBuiltIn')
    const preset = BUILT_IN_AGENT_PRESETS[agent.role]
    await db.update(agents)
      .set({ description: preset.description, instructions: preset.instructions, updatedAt: new Date() })
      .where(and(eq(agents.id, parsed.data), eq(agents.userId, userId)))
    return { success: true as const }
  })
}

/** Deletes a custom role. Built-in roles can be edited or reset, not removed. */
export async function deleteAgent(id: string): Promise<ActionResult<{ success: true }>> {
  return runAction(async () => {
    const userId = await getUserId()
    const parsed = z.uuid().safeParse(id)
    if (!parsed.success) throw new ActionFailureError('agentNotFound')
    const [agent] = await db.select({ role: agents.role }).from(agents)
      .where(and(eq(agents.id, parsed.data), eq(agents.userId, userId))).limit(1)
    if (!agent) throw new ActionFailureError('agentNotFound')
    if (isBuiltInAgentRole(agent.role)) throw new ActionFailureError('agentBuiltInDelete')
    await db.delete(agents).where(and(eq(agents.id, parsed.data), eq(agents.userId, userId)))
    return { success: true as const }
  })
}

/** Queues one run of one agent against one issue. */
export async function startRun(input: { issueId: string; agentId: string; deviceRepoId: string }): Promise<{ runId: string }> {
  return queueRun(await getUserId(), input)
}

export async function listRuns(issueId: string): Promise<RunView[]> {
  const userId = await getUserId()
  const parsed = z.uuid().safeParse(issueId)
  if (!parsed.success) return []
  const rows = await db.select(runViewColumns).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.issueId, parsed.data), eq(agentRuns.userId, userId)))
    .orderBy(desc(agentRuns.createdAt)).limit(20)
  return rows
}

export async function getRun(runId: string): Promise<RunDetail | null> {
  return readRun(await getUserId(), runId)
}

/** A message a person sends the running agent; the daemon delivers it. */
export async function sendRunMessage(input: { runId: string; text: string }): Promise<void> {
  await addRunMessage(await getUserId(), input)
}

/** Asks the daemon to stop the run; it repeats until the run has ended. */
export async function stopRun(runId: string): Promise<void> {
  await requestRunStop(await getUserId(), runId)
}
