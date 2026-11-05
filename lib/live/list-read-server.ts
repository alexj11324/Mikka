import 'server-only'
import { workspacePool } from '../workspace-db'
import { pool } from '../db/request-scope'
import { ownerLiveScope } from './owner-scope'
import type { ListLiveRead } from './list-read'
import type { LiveKind } from './events'
import { readLiveRevisions, type LiveRef, type LiveRevisions } from './revisions'
import type { LiveScope } from './scope'

type Begun = { scope: LiveScope | null; revisions: LiveRevisions }

/** Call before reading the data: the revisions it returns are then never newer than that data. */
export async function readRevisions(refs: readonly LiveRef[]): Promise<LiveRevisions> {
  // Best effort: without a revision the next push simply reads.
  try { return await readLiveRevisions(pool, refs) }
  catch (error) { console.warn('[live] revision read unavailable', { name: (error as Error | undefined)?.name, code: (error as { code?: string } | undefined)?.code }); return {} }
}

/** An owner-wide list's home channel and its keys' revisions, read before the list itself. */
export async function beginOwnerListRead(ownerId: string, kinds: readonly LiveKind[], others: readonly LiveRef[] = []): Promise<Begun> {
  const scope = await ownerLiveScope(workspacePool, ownerId)
  const revisions = await readRevisions([...scope ? kinds.map(kind => ({ kind, id: scope.workspaceId })) : [], ...others])
  return { scope, revisions }
}

/** Membership is read in the ordinary authorized read. A missing personal
 * scope stays absent; notification setup cannot create or borrow a workspace. */
export async function ownerListRead(ownerId: string, expiries: readonly (Date | string | number | null | undefined)[] = [], observedAt = Date.now(), begun?: Begun): Promise<ListLiveRead> {
  const scope = begun ? begun.scope : await ownerLiveScope(workspacePool, ownerId)
  const dates = expiries.filter(value => value != null).map(value => new Date(value!).getTime()).filter(Number.isFinite)
  const expiresAt = dates.length ? Math.min(...dates) : null
  return { ownerId, workspaceId: scope?.workspaceId ?? null,
    ...(expiresAt !== null ? { deadline: { at: new Date(expiresAt).toISOString(), afterMs: Math.max(0, expiresAt - observedAt) } } : {}),
    ...(begun && Object.keys(begun.revisions).length ? { revisions: begun.revisions } : {}) }
}
