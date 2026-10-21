import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, deviceTokens, devices, runMessages } from '@/lib/db/schema'
import type { RunCommand } from '@orvilo/protocol/device'

/**
 * The single workspace this MVP serves. The protocol's register answer
 * carries a workspace id; the app itself has no workspaces yet.
 */
export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

/** How long after its last heartbeat a device still counts as online. */
export const DEVICE_ONLINE_WINDOW_MS = 60_000

/** Run states where the daemon may still be working: not terminal. */
const LIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const

export function newDeviceToken(): string {
  return `orv_${randomBytes(32).toString('base64url')}`
}

/** Only the hash is stored; a stolen database yields no usable token. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface DeviceCaller {
  userId: string
  tokenId: string
}

/**
 * The daemon authenticates with `Authorization: Bearer <device token>`.
 * `null` means the token is missing, unknown or revoked.
 */
export async function authenticateDevice(request: Request): Promise<DeviceCaller | null> {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  if (!token) return null
  const [row] = await db
    .select({ id: deviceTokens.id, userId: deviceTokens.userId, lastUsedAt: deviceTokens.lastUsedAt })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.tokenHash, hashDeviceToken(token)), isNull(deviceTokens.revokedAt)))
    .limit(1)
  if (!row) return null
  // A daemon polls every few seconds; one write a minute is enough to show
  // that a token is still in use.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(deviceTokens).set({ lastUsedAt: new Date() }).where(eq(deviceTokens.id, row.id))
  }
  return { userId: row.userId, tokenId: row.id }
}

export async function ownedDevice(deviceId: string, userId: string) {
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.ownerId, userId)))
    .limit(1)
  return row ?? null
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** `?wait=<seconds>`, clamped to the protocol's maximum. */
export function waitSeconds(request: Request, max: number): number {
  const raw = Number(new URL(request.url).searchParams.get('wait') ?? '0')
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(Math.floor(raw), max)
}

/**
 * The commands a device's runs have waiting: a person's message to a running
 * agent (repeats until acked) and a stop someone asked for (repeats until the
 * run ends). Runs in `skip` are left out so a long-poll can wait for new ones.
 */
export async function pendingCommands(deviceId: string, skip: readonly string[]): Promise<RunCommand[]> {
  const runs = await db
    .select({ id: agentRuns.id, stopRequestedAt: agentRuns.stopRequestedAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.deviceId, deviceId), inArray(agentRuns.status, [...LIVE_RUN_STATUSES])))
  const skipped = new Set(skip)
  const live = runs.filter(run => !skipped.has(run.id))
  if (live.length === 0) return []
  const messages = await db
    .select({ id: runMessages.id, runId: runMessages.runId, text: runMessages.text })
    .from(runMessages)
    .where(and(isNull(runMessages.deliveredAt), inArray(runMessages.runId, live.map(run => run.id))))
    .orderBy(asc(runMessages.createdAt))
    .limit(500)
  const commands: RunCommand[] = messages.map(message => ({
    kind: 'input' as const, runId: message.runId, messageId: message.id, text: message.text,
  }))
  for (const run of live) {
    if (run.stopRequestedAt) commands.push({ kind: 'stop' as const, runId: run.id })
  }
  return commands
}

/** Marks messages the agent now holds; called by the daemon's ack. */
export async function ackCommands(deviceId: string, delivered: readonly string[]): Promise<void> {
  if (delivered.length === 0) return
  const owned = await db
    .select({ id: runMessages.id })
    .from(runMessages)
    .innerJoin(agentRuns, eq(agentRuns.id, runMessages.runId))
    .where(and(eq(agentRuns.deviceId, deviceId), inArray(runMessages.id, [...delivered])))
  if (owned.length === 0) return
  await db
    .update(runMessages)
    .set({ deliveredAt: new Date() })
    .where(and(inArray(runMessages.id, owned.map(row => row.id)), isNull(runMessages.deliveredAt)))
}
