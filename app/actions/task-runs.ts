'use server'

import { singleFlight } from '@/lib/single-flight'
import { readCompactRunFailure, runFailureBrief, type CompactRunFailure } from '@/lib/run-failure-projection'

import { createHash } from 'node:crypto'
import { DEVICE_ONLINE_WINDOW_MS, isDeviceOnline } from '@mikka/protocol/device'
import { headers } from 'next/headers'
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { deviceOnlineStates } from '@/lib/device-presence'
import { gatewayConfig } from '@/lib/builtin-gateway/config'
import { ActionFailureError } from '@/lib/action-error'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { agents, agentRuns, bots, devices, issues, type RunOutcome, type RunStatus } from '@/lib/db/schema'
import { runAgentName, runBotId, runBotName, runTaskPrompt } from '@/lib/run-bot-name'
import { replyLine } from '@/lib/thread-groups'
import { queryVersionWithExpiry } from '@/lib/db/query-version'
import { withDatabaseOperation } from '@/lib/db/egress-sample'
import { ownerListRead } from '@/lib/live/list-read-server'
import { withDevicePresence } from '@/lib/live/presence-read'
import type { PresenceDevice } from '@/lib/live/presence'
import { changedListIds, listPositionKey, readListPositions, unchangedList, type ListPosition } from '@/lib/list-poll'
import { cacheReadAction } from '@/lib/cache-read-action'
import { beginWorkspaceListRead } from '@/lib/live/revision-read'
import { issueShortTitle } from '@/lib/short-title-sql'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { issueVisibility } from '@/lib/issue-visibility'

/** The newest run on each issue, for the right column's 我的任务 groups (MIK-38). */
export interface TaskRun {
  issueId: string
  /** The newest run on the issue: a notification opens it beside its task (R-82). */
  runId: string
  issueTitle: string
  /** The Agent running the newest thread (Claude Code, Codex): the desktop notification's line (R-78). */
  agentName: string
  status: RunStatus
  /** How it came out once it ended, as the decision model judged it; null while running or not judged yet (R-52). */
  outcome: RunOutcome | null
  failureDetails?: CompactRunFailure | null
  /** The Bot that owns the task's newest thread, with its own bloub look (R-25); null for the Coordinator's own work. */
  bot: { id: string; name: string; color: string; shape: string } | null
  /** The coding agents (harnesses) of the task's threads, newest first: the board card's agent marks. */
  harnesses: string[]
}

export async function listTaskRuns(): Promise<TaskRun[]> {
  return (await pollTaskRuns()).items
}

/** Same owner-wide reader, with server-observed scope and window expiry. */
export async function pollTaskRuns() {
  return withDatabaseOperation('/actions/task-runs/read', readTaskRuns)
}

async function readTaskRuns() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  const visibility = await issueVisibility(session.user, false, context.workspace.id)
  const observedAt = Date.now()
  const begun = await beginWorkspaceListRead(session.user.id, context.workspace.id, ['task_run_list'])
  // A run whose device went offline is retried (or lands in 等你) by the minute
  // run-recovery cron (sweepExpiredRunLeases), not by this poll.
  const latest = db.selectDistinctOn([agentRuns.issueId], {
    // A thread's name: its task's short title while the task keeps the title it was written from (lib/short-title.ts).
    issueId: agentRuns.issueId, runId: agentRuns.id, issueTitle: sql<string>`coalesce(${issueShortTitle}, ${issues.title})`.as('issueTitle'), agentName: runAgentName.as('agentName'),
    status: agentRuns.status, outcome: agentRuns.outcome, failureDetails: runFailureBrief.as('failureDetails'),
    botId: runBotId.as('botId'),
    expiresAt: sql<Date | null>`(select min(r."createdAt")+interval '30 days' from agent_runs r where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."workspaceId"=${agentRuns.workspaceId} and r."createdAt">now()-interval '30 days')`.as('expiresAt'),
    harnesses: sql<string[]>`array(select a.harness from agent_runs r join agents a on a.id=r."agentId" where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."workspaceId"=${agentRuns.workspaceId} and r."createdAt" > now() - interval '30 days' group by a.harness order by max(r."createdAt") desc)`.as('harnesses'),
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(eq(agentRuns.userId, session.user.id), eq(agentRuns.workspaceId, context.workspace.id), visibility.predicate, isNotNull(agentRuns.issueId), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id)).limit(200).as('latest_task_runs')
  // Select the same 200 issues first. Bot decoration is a one-to-one join in
  // this database; a missing or foreign bot cannot remove or duplicate a task.
  const rows = await db.select({
    issueId: latest.issueId, runId: latest.runId, issueTitle: latest.issueTitle, agentName: latest.agentName,
    status: latest.status, outcome: latest.outcome, failureDetails: latest.failureDetails, expiresAt: latest.expiresAt, harnesses: latest.harnesses,
    bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape },
  }).from(latest).leftJoin(bots, and(eq(bots.id, latest.botId), eq(bots.ownerId, session.user.id), eq(bots.workspaceId, context.workspace.id))).orderBy(latest.issueId)
  const live = await ownerListRead(session.user.id, rows.map(row => row.expiresAt), observedAt, begun)
  const items: TaskRun[] = rows.map(({ expiresAt: _expiresAt, ...row }) => ({ ...row, failureDetails: readCompactRunFailure(row.failureDetails), issueId: row.issueId! }))
  return { items, live }
}

/** A thread: one run, newest first. Its name comes from its task, else its prompt. */
export interface Thread {
  id: string
  /** The bot that started it; null when the Coordinator dispatched it to an agent. */
  botId: string | null
  /** 'mcp' when an MCP client dispatched it: not the Coordinator's, though it has no bot either. */
  source: 'mcp' | null
  /** The Bot that dispatched it; the Agent running it is `harness` (R-78). */
  agentName: string
  issueId: string | null
  prompt: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  /** The opening of the agent's last reply on one plain line; null before it says anything (and for runs from before it was stored). */
  lastReply: string | null
  /** When that reply was last written; with updatedAt, the row's last activity. */
  lastReplyAt: string | null
  /** How it came out once it ended, as the decision model judged it; null while running or not judged yet (R-52). */
  outcome: RunOutcome | null
  failureDetails?: CompactRunFailure | null
  /** The coding agent running it (claude_code, codex…); its mark is the thread's icon (R-78). */
  harness: string | null
  waitingFor?: { deviceId: string; deviceName: string; deviceType: 'laptop' | 'server'; harness: string }
}

/** The right column's threads: every run the Coordinator or a bot started in the last 30 days, latest activity first. */
export async function listThreads(): Promise<Thread[]> {
  return (await readThreads()).items!
}

/** Authorization is checked even when an existing snapshot has not changed. */
export async function pollThreads(known?: string, positions?: readonly ListPosition[]) {
  const previous = readListPositions(positions, 200)
  const valid = positions === undefined || previous !== undefined
  return readThreads(valid && known && /^[0-9a-f]{32}$/.test(known) ? known : undefined, previous)
}

export async function syncThreadList(known?: string, positions?: readonly ListPosition[]) {
  return cacheReadAction(async () => ({ snapshot: await pollThreads(known, positions) }))
}

async function readThreads(known?: string, previous?: ListPosition[]) {
  return withDatabaseOperation('/actions/threads/poll', async () => {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) throw new ActionFailureError('authRequired')
    const context = await loadWorkspaceContext(undefined, session.user)
    const observedAt = Date.now()
    const begun = await beginWorkspaceListRead(session.user.id, context.workspace.id, ['thread_list'])
    // Only queued local work can show "waiting for device". Ask the gateway
    // on this user read, so an idle socket affects both the view and its hash.
    const queuedDevices = gatewayConfig()
      ? await db.selectDistinct({ id: devices.id, lastSeenAt: devices.lastSeenAt }).from(devices)
        .innerJoin(agentRuns, eq(agentRuns.deviceId, devices.id))
        .where(and(eq(agentRuns.userId, session.user.id), eq(agentRuns.workspaceId, context.workspace.id), eq(devices.ownerId, session.user.id),
          eq(devices.kind, 'local'), eq(devices.enabled, true), eq(agentRuns.status, 'queued'),
          sql`${agentRuns.createdAt} > now() - interval '30 days'`))
      : []
    const presence = await deviceOnlineStates(queuedDevices, observedAt)
    const presenceDevices = queuedDevices.map((device): PresenceDevice => [device.id, presence.get(device.id) ?? false,
      device.lastSeenAt && isDeviceOnline(device.lastSeenAt, observedAt) ? device.lastSeenAt.getTime() + DEVICE_ONLINE_WINDOW_MS : 0])
    const onlineIds = [...presence].filter(([, online]) => online).map(([id]) => id)
    const gatewayOffline = onlineIds.length ? sql`not (${inArray(devices.id, onlineIds)})` : sql`true`
    // Hash the visible waiting state, not a raw heartbeat clock: an ordinary
    // heartbeat must not invalidate every historic thread on that machine.
    const waitingForDevice = sql<boolean>`${devices.kind}='local' and ${agentRuns.status}='queued' and
      (${devices.enabled} is false or (${gatewayOffline} and (${devices.lastSeenAt} is null or
       ${devices.lastSeenAt}>statement_timestamp() OR ${devices.lastSeenAt}<statement_timestamp()-(${DEVICE_ONLINE_WINDOW_MS} * interval '1 millisecond'))))`
    const snapshot = db.select({
      id: agentRuns.id, botId: agentRuns.botId, agentName: runBotName.as('agentName'), issueId: agentRuns.issueId, prompt: sql<string>`left(${runTaskPrompt}, 200)`.as('prompt'),
      status: agentRuns.status, createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt,
      lastReply: agentRuns.lastReply, lastReplyAt: agentRuns.lastReplyAt, source: agentRuns.source,
      deviceId: sql<string | null>`case when ${waitingForDevice} then ${devices.id} end`.as('deviceId'),
      deviceName: sql<string | null>`case when ${waitingForDevice} then ${devices.name} end`.as('deviceName'),
      deviceType: sql<'laptop' | 'server' | null>`case when ${waitingForDevice} then ${devices.deviceType} end`.as('deviceType'),
      waitingForDevice: waitingForDevice.as('waitingForDevice'),
      harness: sql<string>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`.as('harness'),
      outcome: agentRuns.outcome, failureDetails: runFailureBrief.as('failureDetails'),
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(devices, eq(devices.id, agentRuns.deviceId))
      .where(and(eq(agentRuns.userId, session.user.id), eq(agentRuns.workspaceId, context.workspace.id), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
      .orderBy(desc(sql`greatest(${agentRuns.lastReplyAt}, ${agentRuns.updatedAt})`), desc(agentRuns.createdAt), desc(agentRuns.id)).limit(200)
    const signature = await queryVersionWithExpiry(snapshot, sql`min(snapshot."createdAt")+interval '30 days'`)
    const version = createHash('sha256').update(JSON.stringify([session.user.id, context.workspace.id, signature.version])).digest('hex').slice(0, 32)
    const visible = snapshot.as('thread_list_expiry')
    const live = withDevicePresence(await ownerListRead(session.user.id, [signature.expiresAt], observedAt, begun), presenceDevices, process.env, observedAt)
    // Device presence has its own bounded watcher prerequisite. Until that
    // route is ready, queued local work retains the shared slow fallback.
    const presenceFallback = queuedDevices.length > 0
    if (known === version) return { ...unchangedList(version), live, presenceFallback }
    // Reading the version first makes a concurrent edit visible on the next poll.
    const manifest = await db.select({ id: visible.id, version: sql<string>`md5(to_jsonb(thread_list_expiry)::text)` }).from(visible)
      .orderBy(desc(sql`greatest(${visible.lastReplyAt}, ${visible.updatedAt})`), desc(visible.createdAt), desc(visible.id))
    const positions = manifest.map(row => ({ id: row.id, version: createHash('sha256').update(`${session.user.id}:${row.version}`).digest('hex').slice(0, 32) }))
    // Auth, current version and the full deletion/expiry manifest belong to
    // each request. Only identical changed-row reads can join after that proof.
    return singleFlight(['/actions/threads/poll', session.user.id, context.workspace.id, version, known ?? null, listPositionKey(previous), JSON.stringify(positions)], async () => {
      const changedIds = changedListIds(positions, previous)
      const rows = changedIds.length ? await db.select().from(visible).where(inArray(visible.id, changedIds))
        .orderBy(desc(sql`greatest(${visible.lastReplyAt}, ${visible.updatedAt})`), desc(visible.createdAt), desc(visible.id)) : []
      const items: Thread[] = rows.map(({ deviceId, deviceName, deviceType, waitingForDevice, harness, ...row }) => ({
        // A cloud run waits on its own sandbox, never on a machine the person can turn on.
        ...(waitingForDevice && deviceId && deviceName !== null && deviceType
          ? { waitingFor: { deviceId, deviceName, deviceType, harness } } : {}),
        ...row, failureDetails: readCompactRunFailure(row.failureDetails), harness: harness ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
        lastReply: replyLine(row.lastReply), lastReplyAt: row.lastReplyAt?.toISOString() ?? null,
      }))
      return { version, items, positions, ...(previous ? { delta: true as const } : {}), live, presenceFallback }
    })
  })
}
