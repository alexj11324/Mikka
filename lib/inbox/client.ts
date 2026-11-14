import { readAccessFailure } from '../swr/persistent-cache'
import { withBasePath } from '../base-path'
import { webSelectionVersion } from '../web-connection/selection'
import type { InboxCommand, InboxPage } from './contract'

export type InboxTab = 'pending' | 'snoozed' | 'done'
export class InboxRequestError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

async function inboxRequest(version: number, path: string, init: RequestInit) {
  if (version !== webSelectionVersion()) throw new InboxRequestError('decisionUnavailable', 409)
  const response = await fetch(withBasePath(path), { ...init, credentials: 'same-origin', cache: 'no-store' })
  const data = await response.json().catch(() => null)
  if (version !== webSelectionVersion()) throw new InboxRequestError('decisionUnavailable', 409)
  if (!response.ok) throw new InboxRequestError(typeof data?.error === 'string' ? data.error : 'actionFailed', response.status)
  return data
}

type InboxCounts = { count: number; suggestionCount?: number }

/** Older cached reads contain only the rail count. The page total requires a successful read of both counts. */
export function readableInboxCount(data: InboxCounts | number | undefined, error: unknown) {
  if (data === undefined || readAccessFailure(error)) return undefined
  if (typeof data === 'number') return { count: data, pendingCount: undefined }
  const pendingCount = !error && data.suggestionCount !== undefined ? data.count + data.suggestionCount : undefined
  return { count: data.count, pendingCount }
}

export async function readInboxCount(workspaceId: string, version: number): Promise<InboxCounts> {
  const query = new URLSearchParams({ workspaceId, count: '1' })
  const result = await inboxRequest(version, '/api/inbox?' + query, {})
  if (!Number.isSafeInteger(result?.count) || result.count < 0) throw new InboxRequestError('actionFailed', 0)
  const { count, suggestionCount } = result
  if (suggestionCount !== undefined && (!Number.isSafeInteger(suggestionCount) || suggestionCount < 0 || !Number.isSafeInteger(count + suggestionCount))) {
    throw new InboxRequestError('actionFailed', 0)
  }
  return { count, suggestionCount }
}

export async function readInboxPage(workspaceId: string, tab: InboxTab, cursor: string | null, version: number): Promise<InboxPage> {
  const query = new URLSearchParams({ workspaceId, tab })
  if (cursor !== null) query.set('cursor', cursor)
  const result = await inboxRequest(version, '/api/inbox?' + query, {})
  if (!Array.isArray(result?.items) || typeof result.historySince !== 'string'
    || (result.nextCursor !== null && typeof result.nextCursor !== 'string')) throw new InboxRequestError('actionFailed', 0)
  return result
}

export async function submitInboxCommand(command: InboxCommand, version: number): Promise<{ changed: boolean }> {
  const result = await inboxRequest(version, '/api/inbox', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  })
  if (typeof result?.changed !== 'boolean') throw new InboxRequestError('decisionUnconfirmed', 0)
  return { changed: result.changed }
}
