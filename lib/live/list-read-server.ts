import 'server-only'
import { workspacePool } from '../workspace-db'
import { ownerLiveScope } from './owner-scope'
import type { ListLiveRead } from './list-read'
import type { BegunListRead } from './revision-read'

/** Membership is read in the ordinary authorized read. A missing personal
 * scope stays absent; notification setup cannot create or borrow a workspace. */
export async function ownerListRead(ownerId: string, expiries: readonly (Date | string | number | null | undefined)[] = [], observedAt = Date.now(), begun?: BegunListRead): Promise<ListLiveRead> {
  // A begun read that resolved the home reuses it; otherwise the home is read here, as before.
  const scope = begun?.scope !== undefined ? begun.scope : await ownerLiveScope(workspacePool, ownerId)
  const dates = expiries.filter(value => value != null).map(value => new Date(value!).getTime()).filter(Number.isFinite)
  const expiresAt = dates.length ? Math.min(...dates) : null
  return { ownerId, workspaceId: scope?.workspaceId ?? null,
    ...(expiresAt !== null ? { deadline: { at: new Date(expiresAt).toISOString(), afterMs: Math.max(0, expiresAt - observedAt) } } : {}),
    ...(begun && Object.keys(begun.revisions).length ? { revisions: begun.revisions } : {}) }
}
