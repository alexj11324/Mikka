import { unstable_serialize } from 'swr'
import { unstable_serialize as infiniteKey } from 'swr/infinite'
import { LIVE_ID } from './events'

/** Only used with a null transport scope until the authenticated switcher has
 * resolved the personal workspace. It never mints a guessed channel ticket. */
export const UNRESOLVED_APPROVAL_SCOPE = '00000000-0000-4000-8000-000000000000'
export type ApprovalReadTime = { observedAt?: string; requestedAt?: number }
type Switcher = { accounts: readonly { id: string; choices: readonly { id: string; kind?: string }[] }[] }

export function personalApprovalWorkspace(value: Switcher | undefined, ownerId: string | undefined): string | null {
  const choices = value?.accounts.find(account => account.id === ownerId)?.choices ?? []
  const home = choices.find(choice => choice.kind === 'personal' && LIVE_ID.test(choice.id))
  return home?.id ?? null
}

export const approvedWritePageKey = (viewer: string | undefined, scope: string, enabled: boolean, previous?: { nextCursor: string | null } | null) =>
  !viewer || !scope || !enabled || previous && !previous.nextCursor ? null : ['approved-writes', viewer, scope, previous?.nextCursor ?? '']

export function approvedWriteListKeys(viewer: string | undefined, scope: string): string[] {
  return ['approved-write-availability', ...(viewer && scope ? [infiniteKey(() => approvedWritePageKey(viewer, scope, true))] : [])]
}

export const approvedWriteResultKey = (scope: string, action: string, id: string) => ['approved-write-result', scope, action, id]
export const approvedWriteResultLiveKeys = (scope: string, action: string, id: string) => [unstable_serialize(approvedWriteResultKey(scope, action, id))]

/** Read time is conservatively anchored before the request. Network delay, renders and scope resolution
 * and reconnects cannot restart an approval's remaining lifetime. */
export function approvalNow(read: ApprovalReadTime, monotonicNow = performance.now(), wallNow = Date.now()) {
  const observed = Date.parse(read.observedAt ?? '')
  return Number.isFinite(observed) && Number.isFinite(read.requestedAt)
    ? observed + Math.max(0, monotonicNow - read.requestedAt!) : wallNow
}

export function approvalDeadline(expiresAt: string, read: ApprovalReadTime, monotonicNow = performance.now(), wallNow = Date.now()) {
  const expires = Date.parse(expiresAt), remaining = expires - approvalNow(read, monotonicNow, wallNow)
  return Number.isFinite(expires) && remaining > 0 ? { at: expiresAt, afterMs: remaining } : null
}

export function approvalExpired(expiresAt: string, read: ApprovalReadTime, monotonicNow = performance.now(), wallNow = Date.now()) {
  return Date.parse(expiresAt) <= Math.max(wallNow, approvalNow(read, monotonicNow, wallNow))
}

export function nextApprovalDeadline(items: readonly (ApprovalReadTime & { status: string; approvalExpiresAt?: string })[]) {
  const deadlines = items.flatMap(item => {
    if (!item.approvalExpiresAt || !['pending', 'running'].includes(item.status)) return []
    const deadline = approvalDeadline(item.approvalExpiresAt, item)
    return deadline ? [deadline] : []
  })
  return deadlines.sort((a, b) => a.afterMs - b.afterMs)[0] ?? null
}
