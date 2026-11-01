import 'server-only'
import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns, agents, devices } from '@/lib/db/schema'
import { citationSources } from '@/lib/coordinator/store'
import { DEVICE_ONLINE_WINDOW_MS } from '@/lib/device-link'
import { threadName } from '@/lib/issue-threads'
import type { RunSource } from '@/lib/coordinator/citations'
import { runBotName } from '@/lib/run-bot-name'
import { pullRequestsOf, type PrGroup } from '@/lib/thread-groups'

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
  return (await runRows(userId, filter, limit)).map(row => row.thread)
}

/** Threads with what their task links: its id, title and pull requests, as far as this person can see it. */
async function runRows(userId: string, filter: SQL | undefined, limit: number) {
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
    const found = sources[row.id]
    const source = found?.kind === 'run' ? found : undefined
    const thread: MobileThread = {
      id: row.id,
      name: nameOf(source, row.prompt, row.agentName),
      status: mobileThreadStatus(row.status),
      by: row.agentName,
      harness: row.harness,
      device: row.deviceId ? { id: row.deviceId, name: row.deviceName ?? '', kind: machineKind({ name: row.deviceName, platform: row.platform }) } : null,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }
    return { thread, status: row.status, issue: source?.issue ?? null, pullRequests: source?.pullRequests ?? [] }
  })
}

/** The person's threads from the last 30 days, newest first, and their machines with whether each is online (R-24). */
export async function mobileThreads(userId: string, limit = 60): Promise<{ threads: MobileThread[]; devices: { id: string; name: string; kind: MachineKind; online: boolean }[] }> {
  const [threads, machines] = await Promise.all([
    threadRows(userId, sql`${agentRuns.createdAt} > now() - interval '30 days'`, limit),
    db.select({ id: devices.id, name: devices.name, platform: devices.platform, lastSeenAt: devices.lastSeenAt }).from(devices).where(and(eq(devices.ownerId, userId), isNull(devices.removedAt))),
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

export type MobilePullRequest = { url: string; number: number; title: string; group: PrGroup }
export type MobileSchedule = { id: string; title: string; status: 'active' | 'paused'; nextAt: string | null }

/**
 * A bot's page (docs/design/mobile.md, 资料): its threads, the pull requests
 * of the tasks they worked on, and its scheduled tasks, as the web's right
 * panel shows them. `botId` null is the Coordinator, whose threads are the
 * ones it dispatched: no bot on the run, and not from an MCP client.
 */
export async function mobileBot(userId: string, workspaceId: string, botId: string | null): Promise<{ threads: MobileThread[]; pullRequests: MobilePullRequest[]; schedules: MobileSchedule[] }> {
  const own = botId ? eq(agentRuns.botId, botId) : and(isNull(agentRuns.botId), sql`${agentRuns.source} IS DISTINCT FROM 'mcp'`)
  const [rows, schedules] = await Promise.all([
    runRows(userId, own, 60),
    pool.query<{ id: string; title: string; status: 'active' | 'paused'; next_at: Date | null }>(
      `SELECT id, definition->>'title' AS title, status, next_at FROM user_schedules
       WHERE owner_id=$1 AND workspace_id IS NOT DISTINCT FROM $2::uuid AND bot_id IS NOT DISTINCT FROM $3::uuid AND status IN ('active','paused')
       ORDER BY next_at ASC NULLS LAST LIMIT 50`, [userId, workspaceId, botId]),
  ])
  // A PR's own title when it was published with one, else its task's.
  const titles = new Map(rows.flatMap(row => row.pullRequests.map(pr => [pr.url, pr.title ?? row.issue?.title ?? ''] as const)))
  const pullRequests = pullRequestsOf(
    rows.map(row => ({ id: row.thread.id, status: row.status, issueId: row.issue?.id ?? null })),
    [...new Map(rows.flatMap(row => row.issue ? [[row.issue.id, { id: row.issue.id, metadata: { pullRequests: row.pullRequests } }] as const] : [])).values()],
  ).map(row => ({ url: row.url, number: row.number, title: titles.get(row.url) ?? '', group: row.group }))
  return {
    threads: rows.map(row => row.thread),
    pullRequests,
    schedules: schedules.rows.map(row => ({ id: row.id, title: row.title, status: row.status, nextAt: row.next_at?.toISOString() ?? null })),
  }
}
