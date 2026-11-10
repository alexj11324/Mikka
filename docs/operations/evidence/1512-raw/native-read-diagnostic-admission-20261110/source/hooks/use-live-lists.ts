'use client'

import { useEffect, useRef } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { syncIssueList, type listIssues } from '@/app/actions/issues'
import { pollTaskRuns, syncThreadList, type Thread } from '@/app/actions/task-runs'
import { pollBotChatSummaries } from '@/app/actions/coordinator'
import { pollBots } from '@/app/actions/bots'
import { heldListPositions, mergeList, type ListPosition } from '@/lib/list-poll'
import { waitForCacheHydration } from '@/lib/swr/persistent-cache'
import { CacheReadError } from '@/lib/cache-read-error'
import { chatKeys, taskRunKeys, threadKeys } from '@/lib/swr/keys'
import { botListKey, groupListKey, issueListKey, ListReadScopeError, listReadDeadline, listReadPresence, liveListReadOptions, observeListRead, ownerListWorkspace, UNRESOLVED_LIST_SCOPE, type ListLiveRead } from '@/lib/live/list-read'
import { fetchScopedGroups, GroupMessagesRequestError } from '@/lib/group-messages'
import { heldRevision } from '@/lib/live/revisions'
import { diagCurrentRead, diagWithRead } from '@/lib/diagnostics/issue1512-native-reads.mjs'
import { snapshotReadFetcher } from '@/lib/swr/read-observer'
import { useLiveKey } from './use-live-key'

type Issues = Awaited<ReturnType<typeof listIssues>>
type IssueRead = { items: Issues; version?: string; positions?: ListPosition[]; live?: ListLiveRead & { selectedWorkspaceId: string }; requestedAt?: number }
type ThreadRead = { items: Thread[]; version?: string; positions?: ListPosition[]; live?: ListLiveRead; presenceFallback?: boolean; requestedAt?: number }
const LIST_MERGE_MS = 2_000

/** All workspaces keep their existing read authorization. The extra key part
 * prevents an old workspace's late response from replacing the current list. */
export function useLiveIssueList(ownerId: string, workspaceId: string | undefined, paused = false) {
  // Legacy SSR items do not carry the workspace of their authorized read.
  // Read this key normally instead of adopting an unbound snapshot into it.
  const { cache } = useSWRConfig()
  const key = workspaceId ? issueListKey(ownerId, workspaceId) : null
  const result = useSWR<IssueRead>(key, async () => {
    const diagnosticRead = diagCurrentRead()
    await waitForCacheHydration(cache)
    return observeListRead(async () => {
      const cached = cache.get(unstable_serialize(key))?.data as IssueRead | undefined
      const previous: IssueRead = cached?.live?.ownerId === ownerId && cached.live.selectedWorkspaceId === workspaceId ? cached : { items: [] }
      const held = heldListPositions(previous)
      const known = held && held.length === previous.positions?.length ? previous.version : undefined
      const result = await diagWithRead(diagnosticRead, () => syncIssueList(known, held))
      if (result.error) throw new CacheReadError(result.error)
      const next = result.snapshot
      if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
      if (next.live.selectedWorkspaceId !== workspaceId) throw new ListReadScopeError('workspace')
      return { version: next.version, live: next.live, items: mergeList(previous.items, next), positions: 'positions' in next ? next.positions : previous.positions }
    })
  }, {
    ...liveListReadOptions, isPaused: () => paused,
    revalidateOnMount: true,
  })
  const unavailable = result.error instanceof ListReadScopeError || result.error instanceof CacheReadError
  const home = unavailable ? null : ownerListWorkspace(result.data, ownerId)
  const serialized = key ? unstable_serialize(key) : null
  const keys = serialized ? [serialized] : []
  // Discovering the owned home only adds its subscription. It must not reopen
  // the selected workspace's live channel or its initial catch-up read.
  useLiveKey('issue_list', unavailable ? null : workspaceId, keys, workspaceId ?? null, {
    minIntervalMs: LIST_MERGE_MS, shareAcrossTabs: true,
    revisions: serialized ? { [serialized]: heldRevision(result.data, 'issue_list', workspaceId) } : undefined,
  })
  useLiveKey('issue_list', unavailable || home === workspaceId ? null : home ?? UNRESOLVED_LIST_SCOPE, keys, home, {
    minIntervalMs: LIST_MERGE_MS, shareAcrossTabs: true,
    revisions: serialized ? { [serialized]: heldRevision(result.data, 'issue_list', home) } : undefined,
  })
  return { ...result, data: unavailable ? undefined : result.data }
}

/** The thread reader is owner-wide, independent of the selected team. */
export function useLiveThreadList(ownerId: string, paused = false) {
  const { cache } = useSWRConfig()
  const key = threadKeys.list(ownerId)
  const result = useSWR<ThreadRead>(key, async () => {
    const diagnosticRead = diagCurrentRead()
    await waitForCacheHydration(cache)
    return observeListRead(async () => {
      const cached = cache.get(unstable_serialize(key))?.data as ThreadRead | undefined
      const previous: ThreadRead = cached?.live?.ownerId === ownerId ? cached : { items: [] }
      const held = heldListPositions(previous)
      const known = held && held.length === previous.positions?.length ? previous.version : undefined
      const result = await diagWithRead(diagnosticRead, () => syncThreadList(known, held))
      if (result.error) throw new CacheReadError(result.error)
      const next = result.snapshot
      if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
      return { version: next.version, live: next.live, presenceFallback: next.presenceFallback, items: mergeList(previous.items, next), positions: 'positions' in next ? next.positions : previous.positions }
    })
  }, { ...liveListReadOptions, isPaused: () => paused, revalidateOnMount: true })
  const unavailable = result.error instanceof ListReadScopeError || result.error instanceof CacheReadError
  const home = unavailable ? null : ownerListWorkspace(result.data, ownerId)
  const keys = [unstable_serialize(key)]
  useLiveKey('thread_list', unavailable ? null : home ?? UNRESOLVED_LIST_SCOPE, keys, home, { minIntervalMs: LIST_MERGE_MS, deadline: listReadDeadline(result.data, ownerId), revisions: { [keys[0]]: heldRevision(result.data, 'thread_list', home) }, presence: listReadPresence(result.data), shareAcrossTabs: true })
  return { ...result, data: unavailable ? undefined : result.data }
}

/** `enabled: false` reads nothing and registers no key (the desktop badge on the web). */
export function useLiveTaskRunList(ownerId: string, enabled = true) {
  const key = enabled ? taskRunKeys.list(ownerId) : null
  const result = useSWR(key, snapshotReadFetcher(() => observeListRead(async () => {
    const next = await pollTaskRuns()
    if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
    return next
  })), liveListReadOptions)
  const home = result.error instanceof ListReadScopeError ? null : ownerListWorkspace(result.data, ownerId)
  useLiveKey('task_run_list', key ? home ?? UNRESOLVED_LIST_SCOPE : null, key ? [unstable_serialize(key)] : [], home, { minIntervalMs: LIST_MERGE_MS, deadline: listReadDeadline(result.data, ownerId),
    revisions: key ? { [unstable_serialize(key)]: heldRevision(result.data, 'task_run_list', home) } : undefined, shareAcrossTabs: true })
  return { ...result, data: result.error instanceof ListReadScopeError ? undefined : result.data }
}

export function useLiveBotChatList(ownerId: string) {
  const key = chatKeys.list(ownerId)
  const result = useSWR(key, snapshotReadFetcher(() => observeListRead(async () => {
    const next = await pollBotChatSummaries()
    if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
    return next
  })), liveListReadOptions)
  const home = result.error instanceof ListReadScopeError ? null : ownerListWorkspace(result.data, ownerId)
  // The pinned Coordinator row reads this list too. Its open chat listens to its own
  // bot_chat key; a list push never re-reads that whole chat.
  useLiveKey('bot_chat_list', home ?? UNRESOLVED_LIST_SCOPE, [unstable_serialize(key)], home, { minIntervalMs: LIST_MERGE_MS, deadline: listReadDeadline(result.data, ownerId),
    revisions: { [unstable_serialize(key)]: heldRevision(result.data, 'bot_chat_list', home) }, shareAcrossTabs: true })
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
  const result = useSWR(key, snapshotReadFetcher(() => observeListRead(async () => {
    const next = await pollBots()
    if (next.live.ownerId !== ownerId) throw new ListReadScopeError('owner')
    if (next.live.workspaceId !== workspaceId) throw new ListReadScopeError('workspace')
    return next
  })), { ...liveListReadOptions, isPaused: () => paused })
  const wasPaused = useRef(paused)
  useEffect(() => {
    if (wasPaused.current && !paused) void result.mutate()
    wasPaused.current = paused
  }, [paused, result.mutate])
  const scope = result.error instanceof ListReadScopeError ? null : workspaceId ?? null
  useLiveKey('bot_list', key ? scope ?? UNRESOLVED_LIST_SCOPE : null, key ? [unstable_serialize(key)] : [], scope, { minIntervalMs: LIST_MERGE_MS })
  return { ...result, data: result.error instanceof ListReadScopeError ? undefined : result.data }
}
