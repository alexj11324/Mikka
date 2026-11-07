import { carryReadDispatch } from '@/lib/swr/read-observer'
import { LIVE_ID } from './events'
import { botKeys, issueKeys } from '@/lib/swr/keys'
import type { PresenceProof } from './presence'

export type ListLiveRead = {
  ownerId: string
  /** The authenticated reader's owned personal transport, or slow fallback. */
  workspaceId: string | null
  deadline?: { at: string; afterMs: number }
  /** Live keys' revisions, read before this list (lib/live/revisions.ts). */
  revisions?: Record<string, number>
  /** A device-dependent read needs an acknowledged watch before its presence
   * fallback can stop. Null explicitly retains it; absent means no dependency. */
  presence?: PresenceProof | null
}
export type ObservedList = { live?: ListLiveRead; requestedAt?: number }

/** Old servers keep their existing fallback flag. A new proof is only a
 * prerequisite: LiveChannel still requires the matching Worker acknowledgement. */
export function listReadPresence(read: (ObservedList & { presenceFallback?: boolean }) | undefined) {
  return read?.live?.presence !== undefined ? read.live.presence : read?.presenceFallback ? null : undefined
}

export class ListReadScopeError extends Error {
  constructor(readonly kind: 'owner' | 'workspace') { super('List read scope changed'); this.name = 'ListReadScopeError' }
}

/** A placeholder key with a null transport never asks for a guessed ticket. */
export const UNRESOLVED_LIST_SCOPE = '00000000-0000-4000-8000-000000000000'
export const liveListReadOptions = { refreshInterval: 0, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false } as const

export const issueListKey = issueKeys.list
/** Existing detail controls can refresh all of this viewer's cached workspaces
 * without knowing (or borrowing) the currently selected transport scope. */
export const isIssueListKey = (key: unknown, ownerId?: string) => Array.isArray(key) && key[0] === 'issues' && (!ownerId || key[1] === ownerId)
export const groupListKey = botKeys.groups
export const botListKey = botKeys.list
export const isBotListKey = (key: unknown) => key === 'bots' || (Array.isArray(key) && key[0] === 'bots')

/** The request-start anchor belongs to this actual read, not its response or
 * a later render. A cached value retains that same observation. */
export async function observeListRead<T extends object>(read: () => Promise<T>): Promise<T & { requestedAt: number }> {
  const requestedAt = performance.now()
  const value = await read()
  return carryReadDispatch(value, { ...value, requestedAt })
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
