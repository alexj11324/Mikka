import 'server-only'
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, agents, devices } from '@/lib/db/schema'
import { citationSources } from '@/lib/coordinator/store'
import { DEVICE_ONLINE_WINDOW_MS } from '@/lib/device-link'
import { threadName } from '@/lib/issue-threads'
import type { RunSource } from '@/lib/coordinator/citations'
import { runBotName } from '@/lib/run-bot-name'

/** The app's thread states (docs/design/mobile.md, 线程 screen icons). */
export type MobileThreadStatus = 'running' | 'waiting' | 'failed' | 'done' | 'stopped'

export function mobileThreadStatus(status: string): MobileThreadStatus {
  switch (status) {
    case 'waiting_input': return 'waiting'
    case 'failed': return 'failed'
    case 'succeeded': return 'done'
    case 'stopped': case 'cancelled': return 'stopped'
    default: return 'running'
  }
}

/** A machine as the app draws it: an icon, never its name as a status (mobile.md). */
export function machineKind(device: { name: string | null; platform: string | null } | null): 'cloud' | 'laptop' | 'server' {
  if (!device) return 'cloud'
  if (device.platform === 'darwin' || device.platform === 'win32') return 'laptop'
  if (/cloud/i.test(device.name ?? '')) return 'cloud'
  return 'server'
}

export interface MobileThread {
  id: string
  name: string
  status: MobileThreadStatus
  /** The Bot that started the thread, including the Coordinator. */
  by: string
  harness: string
  device: { id: string; name: string; kind: 'cloud' | 'laptop' | 'server' } | null
  createdAt: string
  finishedAt: string | null
}

/** A thread's name: its task as "MIK-11 群聊建表" when it has one, else the first line of its prompt (glossary). */
function nameOf(source: RunSource | undefined, prompt: string, agentName: string) {
  const issue = source?.issue
  if (issue) {
    const key = issue.identifier ?? (issue.number === null ? null : `#${issue.number}`)
    return key ? `${key} ${issue.title}` : issue.title
  }
  return threadName(prompt, agentName)
}

type MachineKind = ReturnType<typeof machineKind>

async function threadRows(userId: string, filter: SQL | undefined, limit: number): Promise<MobileThread[]> {
  const rows = await db.select({
    id: agentRuns.id, prompt: sql<string>`left(${agentRuns.prompt}, 300)`, status: agentRuns.status,
    agentName: runBotName, harness: agents.harness,
    deviceId: devices.id, deviceName: devices.name, platform: devices.platform,
    createdAt: agentRuns.createdAt, finishedAt: agentRuns.finishedAt,
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.userId, userId), filter))
    .orderBy(desc(agentRuns.createdAt)).limit(limit)
  const sources = rows.length ? await citationSources(userId, [], rows.map(row => row.id)) : {}
  return rows.map(row => {
    const source = sources[row.id]
    return {
      id: row.id,
      name: nameOf(source?.kind === 'run' ? source : undefined, row.prompt, row.agentName),
      status: mobileThreadStatus(row.status),
      by: row.agentName,
      harness: row.harness,
      device: row.deviceId ? { id: row.deviceId, name: row.deviceName ?? '', kind: machineKind({ name: row.deviceName, platform: row.platform }) } : null,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }
  })
}

/** The person's threads from the last 30 days, newest first, and their machines with whether each is online (R-24). */
export async function mobileThreads(userId: string, limit = 60): Promise<{ threads: MobileThread[]; devices: { id: string; name: string; kind: MachineKind; online: boolean }[] }> {
  const [threads, machines] = await Promise.all([
    threadRows(userId, sql`${agentRuns.createdAt} > now() - interval '30 days'`, limit),
    db.select({ id: devices.id, name: devices.name, platform: devices.platform, lastSeenAt: devices.lastSeenAt }).from(devices).where(eq(devices.ownerId, userId)),
  ])
  return {
    threads,
    devices: machines.map(device => ({
      id: device.id, name: device.name, kind: machineKind(device),
      online: device.lastSeenAt ? Date.now() - device.lastSeenAt.getTime() < DEVICE_ONLINE_WINDOW_MS : false,
    })),
  }
}

/** One of the person's threads, for its page. */
export async function mobileThread(userId: string, runId: string): Promise<MobileThread | null> {
  return (await threadRows(userId, eq(agentRuns.id, runId), 1))[0] ?? null
}
