'use client'

import { useEffect, useRef } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { pollIssues, type listIssues } from '@/app/actions/issues'
import { pollTaskRuns, pollThreads, type Thread } from '@/app/actions/task-runs'
import { pollBotChatSummaries } from '@/app/actions/coordinator'
import { pollBots } from '@/app/actions/bots'
import { mergeList } from '@/lib/list-poll'
import { botListKey, groupListKey, issueListKey, ListReadScopeError, listReadDeadline, liveListReadOptions, observeListRead, ownerListWorkspace, UNRESOLVED_LIST_SCOPE, type ListLiveRead } from '@/lib/live/list-read'
import { fetchScopedGroups, GroupMessagesRequestError } from '@/lib/group-messages'
import { heldRevision } from '@/lib/live/revisions'
import { useLiveKey, useLiveKeys } from './use-live-key'

type Issues = Awaited<ReturnType<typeof listIssues>>
type IssueRead = { items: Issues; version?: string; live?: ListLiveRead & { selectedWorkspaceId: string }; requestedAt?: number }
type ThreadRead = { items: Thread[]; version?: string; live?: ListLiveRead; presenceFallback?: boolean; requestedAt?: number }
const LIST_MERGE_MS = 2_000

/** All workspaces keep their existing read authorization. The extra key part
 * prevents an old workspace's late response from replacing the current list. */
export function useLiveIssueList(ownerId: string, workspaceId: string | undefined, paused = false) {
  // Legacy SSR items do not carry the workspace of their authorized read.
  // Read this key normally instead of adopting an unbound snapshot into it.
  const snapshot = useRef<{ ownerId: string; workspaceId?: string; version?: string; items: Issues }>({ ownerId, workspaceId, items: [] })
  const key = workspaceId ? issueListKey(ownerId, workspaceId) : null
  const result = useSWR<IssueRead>(key, () => observeListRead(async () => {
    const previous: { items: Issues; version?: string } = snapshot.current.ownerId === ownerId && snapshot.current.workspaceId === workspaceId ? snapshot.current : { items: [] }
    const next = await pollIssues(previous.version)
    if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
    if (next.live.selectedWorkspaceId !== workspaceId) throw new ListReadScopeError('workspace')
    const items = mergeList(previous.items, next)
    snapshot.current = { ownerId, workspaceId, version: next.version, items }
    return { ...next, items }
  }), {
    ...liveListReadOptions, isPaused: () => paused,
    revalidateOnMount: true,
  })
  const home = result.error instanceof ListReadScopeError ? null : ownerListWorkspace(result.data, ownerId)
  const scopes = [...new Set([workspaceId ?? null, home])]
  const serialized = key ? unstable_serialize(key) : null
  // A push this list already read is skipped; each scope has its own revision.
  useLiveKeys(scopes.map(scope => ({ kind: 'issue_list', id: scope ?? UNRESOLVED_LIST_SCOPE, workspaceId: scope,
    revisions: serialized ? { [serialized]: heldRevision(result.data, 'issue_list', scope) } : undefined })), serialized ? [serialized] : [], null, { minIntervalMs: LIST_MERGE_MS })
  return { ...result, data: result.error instanceof ListReadScopeError ? undefined : result.data }
}

/** The thread reader is owner-wide, independent of the selected team. */
export function useLiveThreadList(ownerId: string, paused = false) {
  const snapshot = useRef<{ ownerId: string; version?: string; items: Thread[] }>({ ownerId, items: [] })
  const key = ['threads', ownerId] as const
  const result = useSWR<ThreadRead>(key, () => observeListRead(async () => {
    const previous: { items: Thread[]; version?: string } = snapshot.current.ownerId === ownerId ? snapshot.current : { items: [] }
    const next = await pollThreads(previous.version)
    if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
    const items = mergeList(previous.items, next)
    snapshot.current = { ownerId, version: next.version, items }
    return { ...next, items }
  }), { ...liveListReadOptions, isPaused: () => paused })
  const home = result.error instanceof ListReadScopeError ? null : ownerListWorkspace(result.data, ownerId)
  const keys = [unstable_serialize(key)]
  useLiveKey('thread_list', home ?? UNRESOLVED_LIST_SCOPE, keys, home, { minIntervalMs: LIST_MERGE_MS, deadline: listReadDeadline(result.data, ownerId), revisions: { [keys[0]]: heldRevision(result.data, 'thread_list', home) } })
  // Presence is not a durable run write. Until the independent Device DO watch
  // can prove its expiry notification, keep its shared 60s fallback alongside
  // the real home channel. A null scope never creates another socket/ticket.
  useLiveKey('thread_list', result.data?.presenceFallback && home ? UNRESOLVED_LIST_SCOPE : null, keys, null, { minIntervalMs: LIST_MERGE_MS })
  return { ...result, data: result.error instanceof ListReadScopeError ? undefined : result.data }
}

/** `enabled: false` reads nothing and registers no key (the desktop badge on the web). */
export function useLiveTaskRunList(ownerId: string, enabled = true) {
  const key = enabled ? ['task-runs', ownerId] as const : null
  const result = useSWR(key, () => observeListRead(async () => {
    const next = await pollTaskRuns()
    if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
    return next
  }), liveListReadOptions)
  const home = result.error instanceof ListReadScopeError ? null : ownerListWorkspace(result.data, ownerId)
  useLiveKey('task_run_list', key ? home ?? UNRESOLVED_LIST_SCOPE : null, key ? [unstable_serialize(key)] : [], home, { minIntervalMs: LIST_MERGE_MS, deadline: listReadDeadline(result.data, ownerId),
    revisions: key ? { [unstable_serialize(key)]: heldRevision(result.data, 'task_run_list', home) } : undefined })
  return { ...result, data: result.error instanceof ListReadScopeError ? undefined : result.data }
}

export function useLiveBotChatList(ownerId: string) {
  const key = ['bot-chats', ownerId] as const
  const result = useSWR(key, () => observeListRead(async () => {
    const next = await pollBotChatSummaries()
    if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
    return next
  }), liveListReadOptions)
  const home = result.error instanceof ListReadScopeError ? null : ownerListWorkspace(result.data, ownerId)
  // The pinned Coordinator row already shares this normal authorized cache.
  // Only the list's own key holds the list's revision; 'coordinator-chat' always reads.
  useLiveKey('bot_chat_list', home ?? UNRESOLVED_LIST_SCOPE, [unstable_serialize(key), 'coordinator-chat'], home, { minIntervalMs: LIST_MERGE_MS, deadline: listReadDeadline(result.data, ownerId),
    revisions: { [unstable_serialize(key)]: heldRevision(result.data, 'bot_chat_list', home) } })
  return { ...result, data: result.error instanceof ListReadScopeError ? undefined : result.data }
}

export function useLiveGroupList(ownerId: string, workspaceId: string | null, enabled = true) {
  const key = enabled && workspaceId ? groupListKey(ownerId, workspaceId) : null
  const result = useSWR(key, ([, owner, workspace]) => fetchScopedGroups(owner, workspace), liveListReadOptions)
  const unavailable = result.error instanceof ListReadScopeError || (result.error instanceof GroupMessagesRequestError && result.error.code !== 'unavailable')
  const scope = unavailable ? null : workspaceId
  useLiveKey('group_list', key ? scope ?? UNRESOLVED_LIST_SCOPE : null, key ? [unstable_serialize(key)] : [], scope, { minIntervalMs: LIST_MERGE_MS })
  return { ...result, data: unavailable ? undefined : result.data }
}

export function useLiveBotRoster(ownerId: string, workspaceId: string | undefined, paused = false) {
  const key = workspaceId ? botListKey(ownerId, workspaceId) : null
  const result = useSWR(key, () => observeListRead(async () => {
    const next = await pollBots()
    if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
    if (next.live.workspaceId !== workspaceId) throw new ListReadScopeError('workspace')
    return next
  }), { ...liveListReadOptions, isPaused: () => paused })
  const wasPaused = useRef(paused)
  useEffect(() => {
    if (wasPaused.current && !paused) void result.mutate()
    wasPaused.current = paused
  }, [paused, result.mutate])
  const scope = result.error instanceof ListReadScopeError ? null : workspaceId ?? null
  useLiveKey('bot_list', key ? scope ?? UNRESOLVED_LIST_SCOPE : null, key ? [unstable_serialize(key)] : [], scope, { minIntervalMs: LIST_MERGE_MS })
  return { ...result, data: result.error instanceof ListReadScopeError ? undefined : result.data }
}
