'use server'

import type { IssuePullRequest } from '@/lib/issue-metadata'
import type { DirectoryInput } from '@/lib/conversation-directory-input'
import { conversationOrganization, type ConversationOrganizationChange } from '@/lib/conversation-organization'
import { runAwaitingApproval, runHistoryWindow } from '@/lib/task-state-query'
import { singleFlight } from '@/lib/single-flight'
import { readCompactRunFailure, runFailureBrief, type CompactRunFailure } from '@/lib/run-failure-projection'

import { createHash } from 'node:crypto'
import { DEVICE_ONLINE_WINDOW_MS, isDeviceOnline } from '@mikka/protocol/device'
import { headers } from 'next/headers'
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { deviceOnlineStates } from '@/lib/device-presence'
import { gatewayConfig } from '@/lib/builtin-gateway/config'
import { ActionFailureError } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { agents, agentRuns, bots, conversationReads, devices, issues, type RunOutcome, type RunStatus } from '@/lib/db/schema'
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
import { conversationTitle } from '@/lib/short-title'
import { threadName } from '@/lib/issue-threads'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { joinThreadRead, threadUnread } from '@/lib/thread-reads'
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
    issueId: agentRuns.issueId, runId: agentRuns.id, issueTitle: sql<string>`coalesce(${issueShortTitle}, ${issues.title})`.as('issueTitle'),
    // The conversation's own stored title and the opening of what it was asked: the run is named by conversationTitle below.
    conversationTitle: agentRuns.title, asked: sql<string>`left(${runTaskPrompt}, 200)`.as('asked'), agentName: runAgentName.as('agentName'),
    status: agentRuns.status, outcome: agentRuns.outcome, failureDetails: runFailureBrief.as('failureDetails'),
    botId: runBotId.as('botId'),
    expiresAt: sql<Date | null>`(select min(r."createdAt")+${runHistoryWindow} from agent_runs r where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."workspaceId"=${agentRuns.workspaceId} and r."createdAt">now()-${runHistoryWindow})`.as('expiresAt'),
    harnesses: sql<string[]>`array(select a.harness from agent_runs r join agents a on a.id=r."agentId" where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."workspaceId"=${agentRuns.workspaceId} and r."createdAt" > now() - ${runHistoryWindow} group by a.harness order by max(r."createdAt") desc)`.as('harnesses'),
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).innerJoin(issues, eq(issues.id, agentRuns.issueId))
    .where(and(eq(agentRuns.userId, session.user.id), eq(agentRuns.workspaceId, context.workspace.id), visibility.predicate, isNotNull(agentRuns.issueId), sql`${agentRuns.createdAt} > now() - ${runHistoryWindow}`))
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id)).limit(200).as('latest_task_runs')
  // Select the same 200 issues first. Bot decoration is a one-to-one join in
  // this database; a missing or foreign bot cannot remove or duplicate a task.
  const rows = await db.select({
    issueId: latest.issueId, runId: latest.runId, issueTitle: latest.issueTitle, conversationTitle: latest.conversationTitle, asked: latest.asked, agentName: latest.agentName,
    status: latest.status, outcome: latest.outcome, failureDetails: latest.failureDetails, expiresAt: latest.expiresAt, harnesses: latest.harnesses,
    bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape },
  }).from(latest).leftJoin(bots, and(eq(bots.id, latest.botId), eq(bots.ownerId, session.user.id), eq(bots.workspaceId, context.workspace.id))).orderBy(latest.issueId)
  const live = await ownerListRead(session.user.id, rows.map(row => row.expiresAt), observedAt, begun)
  // `issueTitle` names the run where a list or a notification names it: the conversation's one short title (decision
  // 2026-11-13-1405), its stored one first, never the task's full title. The field keeps its name for released clients.
  const items: TaskRun[] = rows.map(({ expiresAt: _expiresAt, conversationTitle: stored, asked, ...row }) => ({ ...row,
    issueTitle: conversationTitle({ title: stored, name: threadName(asked ?? '', ''), issue: { title: row.issueTitle } }),
    failureDetails: readCompactRunFailure(row.failureDetails), issueId: row.issueId! }))
  return { items, live }
}

/** A thread: one run, newest first. Its name comes from its task, else its prompt. */
export interface Thread {
  unread?: boolean
  pauseReason?: 'human_control' | 'quota_exhausted' | null
  stopReason?: string | null
  awaitingApproval?: boolean
  threadReplacedBy?: string | null
  id: string
  /** The bot that started it; null when the Coordinator dispatched it to an agent. */
  botId: string | null
  /** 'mcp' when an MCP client dispatched it: not the Coordinator's, though it has no bot either. */
  source: 'mcp' | null
  /** The Bot that dispatched it; the Agent running it is `harness` (R-78). */
  agentName: string
  issueId: string | null
  prompt: string
  /** The conversation's own stored short title, once it has one (conversationTitle reads it first). */
  title?: string | null
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
  pullState?: IssuePullRequest['state'] | null
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
          sql`${agentRuns.createdAt} > now() - ${runHistoryWindow}`))
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
      unread: threadUnread.as('unread'),
      id: agentRuns.id, botId: agentRuns.botId, agentName: runBotName.as('agentName'), issueId: agentRuns.issueId, prompt: sql<string>`left(${runTaskPrompt}, 200)`.as('prompt'), title: agentRuns.title,
      status: agentRuns.status, createdAt: agentRuns.createdAt, updatedAt: agentRuns.updatedAt,
      lastReply: agentRuns.lastReply, lastReplyAt: agentRuns.lastReplyAt, source: agentRuns.source,
      deviceId: sql<string | null>`case when ${waitingForDevice} then ${devices.id} end`.as('deviceId'),
      deviceName: sql<string | null>`case when ${waitingForDevice} then ${devices.name} end`.as('deviceName'),
      deviceType: sql<'laptop' | 'server' | null>`case when ${waitingForDevice} then ${devices.deviceType} end`.as('deviceType'),
      waitingForDevice: waitingForDevice.as('waitingForDevice'),
      pullState: sql<IssuePullRequest['state'] | null>`(select p."pullRequest"->>'state' from run_publications p
        join issues i on i.id=p."issueId" and i."workspaceId"=${agentRuns.workspaceId} and i."ownershipState"='bound'
        where p."runId"=${agentRuns.id} and p."userId"=${agentRuns.userId} and p."issueId"=${agentRuns.issueId}
          and p.status='published' and p."pullRequest"->>'state' in ('open','draft','merged','closed')
          and coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->>'deletedAt' is null
          and mikka_resource_acl_allowed('account',${session.user.id},i."workspaceId",'task',i.id,'canReadContent'))`.as('pullState'),
      harness: sql<string>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`.as('harness'),
      outcome: agentRuns.outcome, failureDetails: runFailureBrief.as('failureDetails'),
      pauseReason: agentRuns.pauseReason, stopReason: agentRuns.stopReason, awaitingApproval: runAwaitingApproval.as('awaitingApproval'), threadReplacedBy: agentRuns.threadReplacedBy,
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(devices, eq(devices.id, agentRuns.deviceId))
      .leftJoin(conversationReads, joinThreadRead(session.user.id))
      .where(and(eq(agentRuns.userId, session.user.id), eq(agentRuns.workspaceId, context.workspace.id), sql`${agentRuns.createdAt} > now() - ${runHistoryWindow}`))
      .orderBy(desc(sql`greatest(${agentRuns.lastReplyAt}, ${agentRuns.updatedAt})`), desc(agentRuns.createdAt), desc(agentRuns.id)).limit(200)
    const signature = await queryVersionWithExpiry(snapshot, sql`min(snapshot."createdAt")+${runHistoryWindow}`)
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

async function conversationActor() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  const context = await loadWorkspaceContext(undefined, session.user)
  return { ownerId: session.user.id, workspaceId: context.workspace.id }
}

/**
 * Renames a conversation (a thread and the runs that continue it): the person's title is held to the short-title
 * bound, written on every run of the conversation, and never replaced by a generated one (decision 2026-11-13-1405).
 * Only the conversation's owner renames it.
 */
export async function renameConversation(runId: string, title: string): Promise<ActionResult<{ title: string }, 'issueTitleInvalid' | 'runNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { manualConversationTitle } = await import('@/lib/conversation-title')
  const normalized = typeof title === 'string' && title.length <= 400 ? manualConversationTitle(title) : null
  if (!normalized) return { error: 'issueTitleInvalid' }
  const { renameConversationTitle } = await import('@/lib/conversation-title-server')
  const { pool } = await import('@/lib/db')
  const saved = await renameConversationTitle(pool, String(runId), ownerId, title, workspaceId)
  if (!saved) {
    const { renameStandalone } = await import('@/lib/standalone-chat-controls')
    const renamed = await renameStandalone(pool, runId, ownerId, workspaceId, normalized)
    if (!renamed) return { error: 'runNotFound' }
    await (await import('@/lib/live/lists')).groupListChanged(pool, runId)
    return { title: renamed }
  }
  await (await import('@/lib/live/lists')).runListChanged(pool, String(runId))
  return { title: saved }
}

/**
 * Asks the small model for a new title now, replacing even a manual one, because the person asked. `regenerated` is
 * false when the model was unavailable or gave nothing usable: the conversation keeps the title it had.
 */
export async function regenerateConversationTitle(runId: string): Promise<ActionResult<{ title: string | null; regenerated: boolean }, 'runNotFound'>> {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const owned = await pool.query('SELECT title FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3', [runId, ownerId, workspaceId])
  if (!owned.rows[0]) {
    const { regenerateStandalone } = await import('@/lib/standalone-chat-controls')
    const response = await regenerateStandalone(pool, runId, ownerId, workspaceId, async (owner, content, workspace) => {
      const { defaultModelAvailable } = await import('@/lib/default-model')
      if (!await defaultModelAvailable(owner)) return null
      const { generateShortTitle } = await import('@/lib/short-title-server')
      try { return await generateShortTitle(owner, content, workspace) } catch { return null }
    })
    if (!response) return { error: 'runNotFound' }
    if (response.regenerated) await (await import('@/lib/live/lists')).groupListChanged(pool, runId)
    return response
  }
  const { defaultModelAvailable } = await import('@/lib/default-model')
  if (!await defaultModelAvailable(ownerId)) return { title: owned.rows[0].title ?? null, regenerated: false }
  const { nameConversation } = await import('@/lib/conversation-title-server')
  const { generateShortTitle } = await import('@/lib/short-title-server')
  let title: string | null = null
  try { title = await nameConversation(pool, String(runId), ownerId, 'regenerate', generateShortTitle) } catch (error) {
    console.error('Conversation title regenerate failed', error instanceof Error ? error.name : 'unknown')
  }
  if (title) await (await import('@/lib/live/lists')).runListChanged(pool, String(runId))
  return { title: title ?? owned.rows[0].title ?? null, regenerated: !!title }
}

export async function readConversationOrganization(runId: string) {
  const { ownerId, workspaceId } = await conversationActor()
  const { pool } = await import('@/lib/db')
  const state = await conversationOrganization(pool, ownerId, workspaceId, runId)
  if (state) return state
  const { standaloneOrganization } = await import('@/lib/standalone-chat-controls')
  return standaloneOrganization(pool, runId, ownerId, workspaceId)
}

export async function setConversationOrganization(runId: string, change: ConversationOrganizationChange) {
  const { ownerId, workspaceId } = await conversationActor()
  if (!change || !['archived', 'pinned'].includes(change.field) || typeof change.value !== 'boolean') {
    throw new ActionFailureError('validationGeneric')
  }
  const { pool } = await import('@/lib/db')
  const state = await conversationOrganization(pool, ownerId, workspaceId, runId, change)
  if (state) {
    await (await import('@/lib/live/lists')).runListChanged(pool, runId)
    return state
  }
  const { standaloneOrganization } = await import('@/lib/standalone-chat-controls')
  const chat = await standaloneOrganization(pool, runId, ownerId, workspaceId, change)
  if (chat) await (await import('@/lib/live/lists')).groupListChanged(pool, runId)
  return chat
}

export async function listConversations(input: DirectoryInput) {
  const { ownerId, workspaceId } = await conversationActor()
  const { conversationDirectory } = await import('@/lib/conversation-directory')
  const { pool } = await import('@/lib/db')
  return conversationDirectory(pool, ownerId, workspaceId, input)
}

export async function listConversationSidebar() {
  const { ownerId, workspaceId } = await conversationActor()
  const { conversationSidebar } = await import('@/lib/conversation-directory')
  const { pool } = await import('@/lib/db')
  return conversationSidebar(pool, ownerId, workspaceId)
}

/** A workspace switch between composing and searching invalidates the old picker. */
export async function findThreadReferences(expectedWorkspaceId: string, query: string, kind?: 'task' | 'thread' | 'pr') {
  const { ownerId, workspaceId } = await conversationActor()
  if (expectedWorkspaceId !== workspaceId || typeof query !== 'string' || query.length > 120 ||
    (kind !== undefined && !['task', 'thread', 'pr'].includes(kind))) throw new ActionFailureError('validationGeneric')
  const { searchThreadReferences } = await import('@/lib/thread-reference-search')
  return searchThreadReferences(ownerId, workspaceId, query.trim(), kind)
}
