import { withBasePath } from '@/lib/base-path'
import type { ApprovedWriteView } from './approved-writes'
import type { WritePage } from './write-discovery'
import type { WriteActionName } from './write-schema'

export type ApprovedWriteItem = WritePage['items'][number]
export class ApprovedWriteClientError extends Error {
  constructor(readonly uncertain = false, readonly disabled = false) { super('approvedWriteUnavailable') }
}

/** Availability is not authorization; POST still checks its current server gate. */
export async function loadApprovedWriteAvailability(): Promise<boolean> {
  try {
    const response = await fetch(withBasePath('/api/approved-writes'), { method: 'GET', cache: 'no-store' })
    const result = await response.json()
    if (!response.ok || typeof result?.enabled !== 'boolean') throw new ApprovedWriteClientError()
    return result.enabled
  } catch { throw new ApprovedWriteClientError() }
}

/** Only read calls belong in polling. A decision is sent once per explicit click. */
async function request(body: Record<string, unknown>, decision = false): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(withBasePath('/api/approved-writes'), { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch { throw new ApprovedWriteClientError(decision) }
  const result = await response.json().catch(() => null)
  if (!response.ok || !result || typeof result !== 'object' || Array.isArray(result)) {
    const disabled = response.status === 503 && result?.error === 'approvedWritesDisabled'
    const noEffect = disabled || [400, 401, 403].includes(response.status) || response.status === 409 && ['writeDenied', 'writePolicyChanged', 'pendingActionUnavailable', 'operationBindingConflict', 'operationIntentAmbiguous'].includes(result?.error)
    throw new ApprovedWriteClientError(decision && !noEffect, disabled)
  }
  return result
}

export async function loadUnresolvedWrites(viewerId: string, cursor?: string): Promise<WritePage> {
  let result: Record<string, unknown>
  try { result = await request({ op: 'list', unresolvedOnly: true, limit: 50, ...(cursor ? { cursor } : {}) }) }
  catch (error) {
    if (error instanceof ApprovedWriteClientError && error.disabled) return { items: [], nextCursor: null, asOf: '' }
    throw error
  }
  // The session hook/cache can lag a cookie switch. Never cache another owner's
  // response under the old viewer's key (same pattern as integration settings).
  if (result.viewerId !== viewerId || !Array.isArray(result.items) || !(result.nextCursor === null || typeof result.nextCursor === 'string') || typeof result.asOf !== 'string') throw new ApprovedWriteClientError()
  return result as unknown as WritePage
}

export async function readApprovedWrite(action: WriteActionName, id: string): Promise<ApprovedWriteView> {
  const result = await request({ op: 'view', action, id })
  if (result.id !== id || result.action !== action || !['pending', 'running', 'done', 'declined'].includes(String(result.status))) throw new ApprovedWriteClientError()
  return result as unknown as ApprovedWriteView
}

export async function decideApprovedWrite(action: WriteActionName, id: string, approve: boolean): Promise<'done' | 'declined' | 'running'> {
  const result = await request({ op: 'decide', action, id, approve }, true)
  if (!['done', 'declined', 'running'].includes(String(result.status))) throw new ApprovedWriteClientError(true)
  return result.status as 'done' | 'declined' | 'running'
}
