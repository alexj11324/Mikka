import { LIVE_ID } from './events'

export type ListLiveRead = {
  ownerId: string
  /** The authenticated reader's owned personal transport, or slow fallback. */
  workspaceId: string | null
  deadline?: { at: string; afterMs: number }
  /** Live keys' revisions, read before this list (lib/live/revisions.ts). */
  revisions?: Record<string, number>
}
export type ObservedList = { live?: ListLiveRead; requestedAt?: number }

export class ListReadScopeError extends Error {
  constructor(readonly kind: 'owner' | 'workspace') { super('List read scope changed'); this.name = 'ListReadScopeError' }
}

/** A placeholder key with a null transport never asks for a guessed ticket. */
export const UNRESOLVED_LIST_SCOPE = '00000000-0000-4000-8000-000000000000'
export const liveListReadOptions = { refreshInterval: 0, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false } as const

export const issueListKey = (ownerId: string, workspaceId: string) => ['issues', ownerId, workspaceId] as const
/** Existing detail controls can refresh all of this viewer's cached workspaces
 * without knowing (or borrowing) the currently selected transport scope. */
export const isIssueListKey = (key: unknown, ownerId?: string) => Array.isArray(key) && key[0] === 'issues' && (!ownerId || key[1] === ownerId)
export const groupListKey = (ownerId: string, workspaceId: string) => ['bot-list-groups', ownerId, workspaceId] as const
export const botListKey = (ownerId: string, workspaceId: string) => ['bots', ownerId, workspaceId] as const
export const isBotListKey = (key: unknown) => key === 'bots' || (Array.isArray(key) && key[0] === 'bots')

/** The request-start anchor belongs to this actual read, not its response or
 * a later render. A cached value retains that same observation. */
export async function observeListRead<T extends object>(read: () => Promise<T>): Promise<T & { requestedAt: number }> {
  const requestedAt = performance.now()
  return { ...await read(), requestedAt }
}

export function ownerListWorkspace(read: ObservedList | undefined, ownerId: string): string | null {
  return read?.live?.ownerId === ownerId && read.live.workspaceId && LIVE_ID.test(read.live.workspaceId) ? read.live.workspaceId : null
}

export function listReadDeadline(read: ObservedList | undefined, ownerId: string, now = performance.now()) {
  if (!read || read.live?.ownerId !== ownerId || !read.live.deadline) return undefined
  const deadline = read.live.deadline
  const anchored = Number.isFinite(read.requestedAt)
  const elapsed = anchored ? Math.max(0, now - read.requestedAt!) : Infinity
  return { at: deadline.at, afterMs: Math.max(0, deadline.afterMs - elapsed),
    ...(anchored && deadline.afterMs > 0 ? { observation: read.requestedAt! } : {}) }
}
