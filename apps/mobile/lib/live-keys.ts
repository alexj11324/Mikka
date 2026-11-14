// Which live keys each screen listens to: the ones the web listens to for the same data
// (hooks/use-live-lists.ts, components/devices/devices-settings.tsx, hooks/use-computer.ts,
// components/workspace/issue-thread-panel.tsx). `home` is the person's own home channel
// (GET /api/mobile/home `live.workspaceId`), `open` the workspace the app has open.
import { UNRESOLVED_LIVE_ID, type LiveRef } from './live-client'
import type { BotPage, ComputerStatus, ThreadDetail, Threads } from './types'
import { apiCache } from './api-cache'
import type { PresenceProof } from '../../../lib/live/presence'

type Spec = { refs: LiveRef[]; minIntervalMs?: number; deadline?: { at: string; afterMs: number } | null; presence?: PresenceProof | null }
const LIST_MERGE_MS = 2_000

/** A list's key is its channel's own workspace id; with no channel known it reads once a minute and asks for no ticket. */
export const listRef = (kind: LiveRef['kind'], scope: string | null | undefined): LiveRef => ({ kind, id: scope || UNRESOLVED_LIVE_ID, scope: scope || null })

/** A read that refreshes only by the minute fallback, never by push. */
export const minuteRef = (kind: LiveRef['kind']): LiveRef => ({ kind, id: UNRESOLVED_LIVE_ID, scope: null })

/**
 * 线程: the threads (thread_list) and the machines (device_list). A machine coming online
 * writes (its heartbeat route pushes device_list); the gateway acknowledges the
 * actual device watch before its minute fallback stops. Old servers retain that
 * fallback while any device is online. Keep the refs stable as metadata arrives.
 */
export function threadsLive(data: Threads | null, home: string | null | undefined, ownerId = apiCache.owner()): Spec {
  if (data?.live?.presence !== undefined) {
    const presence = data.live.ownerId === ownerId && data.live.workspaceId === home ? data.live.presence : null
    return { minIntervalMs: LIST_MERGE_MS, refs: [listRef('thread_list', home), listRef('device_list', home)], presence }
  }
  const presence = !data || data.devices.some(device => device.online) ? null : undefined
  return { minIntervalMs: LIST_MERGE_MS, refs: [listRef('thread_list', home), listRef('device_list', home)], presence }
}

/**
 * A bot's page: its threads, their PRs and 资料库 follow its runs (thread_list); 置顶 / 通知 and what
 * its chat changes, schedules included, follow its chat (bot_chat); a rename or removal, the roster (bot_list).
 */
export function botPageLive(_data: BotPage | null, botId: string | null | undefined, home: string | null | undefined, open: string | null | undefined): Spec {
  return {
    minIntervalMs: LIST_MERGE_MS,
    refs: [
      listRef('thread_list', home),
      { kind: 'bot_chat', id: botId && home ? botId : UNRESOLVED_LIVE_ID, scope: home || null },
      listRef('bot_list', open),
    ],
  }
}

/**
 * 任务: the open workspace's tasks, and the person's own (personal) ones on their home channel (useLiveIssueList);
 * a thread blocking or resuming moves its task in or out of 受阻, so it follows the person's runs too (task_run_list).
 */
export function tasksLive(home: string | null | undefined, open: string | null | undefined, issueIds: readonly string[] = []): Spec {
  const scopes = [...new Set([open || null, home || null])]
  return { minIntervalMs: LIST_MERGE_MS, refs: [...scopes.map(scope => listRef('issue_list', scope)), listRef('task_run_list', home),
    ...issueIds.map(id => ({ kind: 'factory_issue' as const, id, scope: open }))] }
}

/** Only an open, authorized Task listens to its discussion and attempt keys. */
export function taskDetailLive(id: string, workspaceId: string | null | undefined, home: string | null | undefined, open: string | null | undefined, factoryTaskId?: string, factoryActivityVersion?: number, hasConnections = false): Spec {
  const spec = tasksLive(home, open)
  if (workspaceId) for (const kind of ['issue_document', 'issue_threads'] as const) spec.refs.push({ kind, id, scope: workspaceId })
  if (workspaceId && hasConnections) spec.refs.push({ kind: 'issue_relations', id, scope: workspaceId })
  if (workspaceId && factoryActivityVersion === 1) {
    spec.refs.push({ kind: 'factory_issue', id, scope: workspaceId })
    if (factoryTaskId) spec.refs.push({ kind: 'factory_task', id: factoryTaskId, scope: workspaceId })
  }
  return spec
}

/** One thread: each of its runs' text (`thread`) and state (`run`), on the channel the server resolved for that run. */
export function threadLive(data: ThreadDetail | null, runId: string): Spec {
  const runs = data?.live?.runs ?? [{ id: runId, workspaceId: null }]
  return {
    minIntervalMs: LIST_MERGE_MS,
    refs: runs.flatMap(run => (['thread', 'run'] as const).map(kind => ({ kind, id: run.workspaceId ? run.id : UNRESOLVED_LIVE_ID, scope: run.workspaceId }))),
  }
}

/** A bot's computer: its state key, and the moment the server says it changes with no write (a lease, a wake). */
export function computerLive(data: ComputerStatus | null, botId: string | null | undefined): Spec {
  const scope = data?.live?.workspaceId ?? null
  return { minIntervalMs: 500, deadline: data?.live?.deadline, refs: [{ kind: 'computer_state', id: botId && scope ? botId : UNRESOLVED_LIVE_ID, scope }] }
}

/** A group chat's page, on its workspace's channel (where its members' group_list arrives too). */
export function groupChatLive(conversationId: string, workspaceId: string | null | undefined): Spec {
  return { minIntervalMs: 1_000, refs: [{ kind: 'group_chat', id: workspaceId ? conversationId : UNRESOLVED_LIVE_ID, scope: workspaceId || null }] }
}
