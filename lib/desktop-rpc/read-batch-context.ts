import { AsyncLocalStorage } from 'node:async_hooks'
import { isLiveRevisionKind, LIVE_ID } from '../live/events'
import type { LiveScope } from '../live/scope'
import { liveRevisionKey, readLiveRevisions, type LiveRef, type LiveRevisions } from '../live/revisions'

type Database = Parameters<typeof readLiveRevisions>[0]
type RevisionRead = { ref: LiveRef; resolve: (revision: number | undefined) => void; reject: (error: unknown) => void }
type RevisionQueue = { values: Map<string, Promise<number | undefined>>; pending: Map<string, RevisionRead>; scheduled: boolean }
type BatchContext = {
  active: boolean
  owners: Map<object, Map<string, Promise<LiveScope | null>>>
  revisions: Map<Database, RevisionQueue>
}
const batches = new AsyncLocalStorage<BatchContext>()

/** Installed only by the bounded read action. Detached after-work cannot keep
 * using the batch's authority/revision observations once its items settle. */
export async function withReadBatchContext<T>(work: () => Promise<T>): Promise<T> {
  const scope: BatchContext = { active: true, owners: new Map(), revisions: new Map() }
  try { return await batches.run(scope, work) }
  finally { scope.active = false; scope.owners.clear(); scope.revisions.clear() }
}

export function readBatchOwnerScope(database: object, ownerId: string, read: () => Promise<LiveScope | null>): Promise<LiveScope | null> {
  const scope = batches.getStore()
  if (!scope?.active) return read()
  let owners = scope.owners.get(database)
  if (!owners) { owners = new Map(); scope.owners.set(database, owners) }
  let pending = owners.get(ownerId)
  if (!pending) { pending = Promise.resolve().then(read); owners.set(ownerId, pending) }
  return pending
}

/** Each caller still awaits the revision before its data. Keys arriving in the
 * same microtask share one SQL statement; already observed keys keep the older
 * value, never a newer revision that could acknowledge unseen data. */
export async function readBatchRevisions(database: Database, refs: readonly LiveRef[]): Promise<LiveRevisions> {
  const scope = batches.getStore()
  if (!scope?.active) return readLiveRevisions(database, refs)
  let queue = scope.revisions.get(database)
  if (!queue) { queue = { values: new Map(), pending: new Map(), scheduled: false }; scope.revisions.set(database, queue) }
  const selected = new Map<string, Promise<number | undefined>>()
  for (const ref of refs) {
    if (!isLiveRevisionKind(ref.kind) || !LIVE_ID.test(ref.id)) continue
    const id = ref.id.toLowerCase(), key = liveRevisionKey(ref.kind, id)
    let value = queue.values.get(key)
    if (!value) {
      value = new Promise<number | undefined>((resolve, reject) => { queue!.pending.set(key, { ref: { kind: ref.kind, id }, resolve, reject }) })
      queue.values.set(key, value)
    }
    selected.set(key, value)
  }
  if (queue.pending.size && !queue.scheduled) {
    queue.scheduled = true
    const waiting = queue
    queueMicrotask(() => {
      const reads = [...waiting.pending]
      waiting.pending.clear(); waiting.scheduled = false
      void readLiveRevisions(database, reads.map(([, value]) => value.ref)).then(
        values => { for (const [key, value] of reads) value.resolve(values[key]) },
        error => { for (const [, value] of reads) value.reject(error) },
      )
    })
  }
  const observed = await Promise.all([...selected].map(async ([key, value]) => [key, await value] as const))
  return Object.fromEntries(observed.filter((entry): entry is readonly [string, number] => entry[1] !== undefined))
}
