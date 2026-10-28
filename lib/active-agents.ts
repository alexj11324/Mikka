import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { agentRuns, agents, coordinatorSessions, devices } from '@/lib/db/schema'
import type * as schema from '@/lib/db/schema'
import { coordinatorLeaseActive } from '@/lib/coordinator/lease'
import { DEVICE_ONLINE_WINDOW_MS } from '@mikka/protocol/device'
import { WORKING_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { runBotName } from '@/lib/run-bot-name'

// MIK-7: the agents working for the signed-in person right now, for the
// "who is working" strip. Only the caller's own runs and agents; no prompt,
// worktree, device or error fields leave the server.


export type ActiveAgent = {
  id: string
  kind: 'agent' | 'coordinator'
  name: string
  avatarUrl: null
  startedAt: string
  state: 'working' | 'waiting_input'
  runId: string | null
  issueId: string | null
}

export const COORDINATOR_ID = 'coordinator'
export const COORDINATOR_NAME = 'Coordinator'

type Database = NodePgDatabase<typeof schema>
type ActiveRunRow = { agentId: string; name: string; runId: string; issueId: string | null; status: string; startedAt: Date }

/**
 * One entry per agent. An agent with several live runs shows its earliest
 * start; it is `working` if any run is working, `waiting_input` only when every
 * run is waiting. runId/issueId come from the earliest run.
 */
export function mergeAgentRuns(rows: ActiveRunRow[]): ActiveAgent[] {
  const byAgent = new Map<string, { first: ActiveRunRow; working: boolean }>()
  for (const row of rows) {
    const working = row.status !== 'waiting_input'
    const seen = byAgent.get(row.agentId)
    if (!seen) { byAgent.set(row.agentId, { first: row, working }); continue }
    seen.working ||= working
    if (row.startedAt < seen.first.startedAt || (+row.startedAt === +seen.first.startedAt && row.runId < seen.first.runId)) seen.first = row
  }
  return [...byAgent.entries()].map(([id, { first, working }]) => ({
    id, kind: 'agent' as const, name: first.name, avatarUrl: null, startedAt: first.startedAt.toISOString(),
    state: working ? 'working' as const : 'waiting_input' as const, runId: first.runId, issueId: first.issueId,
  }))
}

/** Earliest start first; ties by id so polling does not reshuffle the list. */
export function sortActiveAgents(list: ActiveAgent[]): ActiveAgent[] {
  return [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export async function listActiveAgents(database: Database, userId: string, now = new Date()): Promise<ActiveAgent[]> {
  const onlineSince = new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS)
  const startedAt = sql<Date>`coalesce(${agentRuns.startedAt}, ${agentRuns.createdAt})`.mapWith(agentRuns.createdAt)
  const [rows, [session]] = await Promise.all([
    database.select({ agentId: agents.id, name: runBotName, runId: agentRuns.id, issueId: agentRuns.issueId, status: agentRuns.status, startedAt })
      .from(agentRuns)
      .innerJoin(agents, and(eq(agents.id, agentRuns.agentId), eq(agents.userId, userId)))
      .leftJoin(devices, and(eq(devices.id, agentRuns.deviceId), eq(devices.ownerId, userId)))
      .where(and(
        eq(agentRuns.userId, userId),
        inArray(agentRuns.status, [...WORKING_RUN_STATUSES]),
        or(gt(agentRuns.leaseExpiresAt, now), and(isNull(agentRuns.leaseExpiresAt), gt(devices.lastSeenAt, onlineSince))),
      )),
    database.select({ leaseHolder: coordinatorSessions.leaseHolder, leaseUntil: coordinatorSessions.leaseUntil, updatedAt: coordinatorSessions.updatedAt })
      .from(coordinatorSessions).where(and(eq(coordinatorSessions.userId, userId), isNull(coordinatorSessions.botId))).limit(1),
  ])
  const list = mergeAgentRuns(rows)
  if (coordinatorLeaseActive(session, now)) {
    // coordinator_sessions has no turn start column yet, so startedAt uses updatedAt for now
    // (bumped when a turn takes or renews the lease). Replace once a real start time is stored.
    list.push({ id: COORDINATOR_ID, kind: 'coordinator', name: COORDINATOR_NAME, avatarUrl: null, startedAt: session!.updatedAt.toISOString(), state: 'working', runId: null, issueId: null })
  }
  return sortActiveAgents(list)
}

type Copy = { pleaseSignIn: string; unavailable: string; noParameters: string }

/**
 * GET /api/agent/sessions/active, without the framework: the route passes the
 * signed-in user (or null) and the reader, so this is testable without a DB.
 */
export async function activeAgentsResponse(request: Request, userId: string | null, list: (userId: string) => Promise<ActiveAgent[]>, copy: Copy): Promise<Response> {
  const headers = { 'Cache-Control': 'private, no-store' }
  if (!userId) return Response.json({ error: copy.pleaseSignIn }, { status: 401, headers })
  if ([...new URL(request.url).searchParams.keys()].length) return Response.json({ error: copy.noParameters }, { status: 400, headers })
  try {
    const agents = await list(userId)
    return Response.json(agents.length ? { agents, polledAt: new Date().toISOString() } : { agents: [] }, { headers })
  } catch {
    return Response.json({ error: copy.unavailable }, { status: 503, headers })
  }
}
