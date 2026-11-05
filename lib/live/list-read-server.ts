import 'server-only'
import { workspacePool } from '../workspace-db'
import { ownerLiveScope } from './owner-scope'
import type { ListLiveRead } from './list-read'

/** Membership is read in the ordinary authorized read. A missing personal
 * scope stays absent; notification setup cannot create or borrow a workspace. */
export async function ownerListRead(ownerId: string, expiries: readonly (Date | string | number | null | undefined)[] = [], observedAt = Date.now()): Promise<ListLiveRead> {
  const scope = await ownerLiveScope(workspacePool, ownerId)
  const dates = expiries.filter(value => value != null).map(value => new Date(value!).getTime()).filter(Number.isFinite)
  const expiresAt = dates.length ? Math.min(...dates) : null
  return { ownerId, workspaceId: scope?.workspaceId ?? null,
    ...(expiresAt !== null ? { deadline: { at: new Date(expiresAt).toISOString(), afterMs: Math.max(0, expiresAt - observedAt) } } : {}) }
}
