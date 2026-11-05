import { unstable_serialize } from 'swr'
import { withBasePath } from '../base-path'
import { PENDING_ACTION_TTL_MS, type PendingActionView } from '../pending-action-view'
import { approvalDeadline, approvalExpired, type ApprovalReadTime } from './approval-cache'

export interface PendingActionPage extends ApprovalReadTime { items: PendingActionView[] }
export const pendingActionsPageKey = (ownerId: string | undefined, sessionId: string | undefined) =>
  ownerId && sessionId ? ['pending-actions', ownerId, sessionId] : null
export const pendingActionsLiveKeys = (ownerId: string | undefined, sessionId: string | undefined) => {
  const key = pendingActionsPageKey(ownerId, sessionId)
  return key ? [unstable_serialize(key)] : []
}

export async function loadPendingActionPage(ownerId: string): Promise<PendingActionPage> {
  const requestedAt = performance.now()
  const response = await fetch(withBasePath('/api/pending-actions'), { cache: 'no-store' })
  if (!response.ok || response.headers.get('x-mikka-viewer') !== encodeURIComponent(ownerId)) throw Error('pendingActionsUnavailable')
  const items: unknown = await response.json()
  if (!Array.isArray(items)) throw Error('pendingActionsUnavailable')
  return { items, requestedAt, observedAt: response.headers.get('x-mikka-observed-at') ?? undefined }
}

export function pendingActionExpiresAt(item: Pick<PendingActionView, 'action' | 'createdAt'>) {
  const ttl = ['credential_operation', 'browser_operation'].includes(item.action) ? 5 * 60_000 : PENDING_ACTION_TTL_MS
  return new Date(Date.parse(item.createdAt) + ttl).toISOString()
}

export const pendingActionExpired = (item: PendingActionView, read: ApprovalReadTime) => approvalExpired(pendingActionExpiresAt(item), read)

/** At most one expiry timer per list. It only invalidates the read; the original
 * server TTL, ownership and atomic decision remain authoritative. */
export function nextPendingActionDeadline(page: PendingActionPage | undefined) {
  return page?.items.flatMap(item => {
    const deadline = approvalDeadline(pendingActionExpiresAt(item), page)
    return deadline ? [deadline] : []
  }).sort((a, b) => a.afterMs - b.afterMs)[0] ?? null
}
