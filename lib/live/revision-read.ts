import 'server-only'
import type { LiveKind } from './events'
import type { LiveRef, LiveRevisions } from './revisions'
import type { LiveScope } from './scope'
import { readBatchOwnerRevisions } from '../desktop-rpc/read-batch-context'

/** `scope` undefined: the home was not resolved here; ownerListRead reads it as before. */
export type BegunListRead = { scope?: LiveScope | null; revisions: LiveRevisions }

const unavailable = (error: unknown) => console.warn('[live] revision read unavailable', { name: (error as Error | undefined)?.name, code: (error as { code?: string } | undefined)?.code })

/** Call before reading the data: the revisions it returns are then never newer than that data.
 * Best effort: without a revision the next push simply reads. */
export async function readRevisions(refs: readonly LiveRef[], ownerScope?: LiveScope | null): Promise<LiveRevisions> {
  try {
    const { pool } = await import('../db/request-scope')
    return await readBatchOwnerRevisions(pool, refs, ownerScope)
  } catch (error) { unavailable(error); return {} }
}

/** An owner-wide list's home channel and its keys' revisions, read before the list itself. */
export async function beginOwnerListRead(ownerId: string, kinds: readonly LiveKind[], others: readonly LiveRef[] = []): Promise<BegunListRead> {
  let scope: LiveScope | null
  try {
    const [{ workspacePool }, { ownerLiveReadScope }] = await Promise.all([import('../workspace-db'), import('./owner-scope')])
    scope = await ownerLiveReadScope(workspacePool, ownerId)
  } catch (error) { unavailable(error); return { revisions: await readRevisions(others) } }
  return { scope, revisions: await readRevisions([...scope ? kinds.map(kind => ({ kind, id: scope.workspaceId })) : [], ...others], scope) }
}

/** The caller has authorized this effective workspace before reading its list. */
export async function beginWorkspaceListRead(ownerId: string, workspaceId: string, kinds: readonly LiveKind[]): Promise<BegunListRead> {
  return { scope: { ownerId, workspaceId }, revisions: await readRevisions(kinds.map(kind => ({ kind, id: workspaceId }))) }
}
