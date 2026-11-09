import { observeReadDiagnostic } from './read-diagnostics'

type Cache = { get(key: string): { data?: unknown; error?: unknown } | undefined }
type Outcome = { status: 'committed' | 'discarded' } | { status: 'failed'; error: unknown }
type Read = {
  began: number
  pendingDispatchAt?: number
  pendingRevoked?: Promise<void>
  revokePending?: () => void
  dispatchCaptured?: boolean
  dispatchNotified?: boolean
  dispatchAmbiguous?: boolean
  settled: Promise<Outcome>
  received: boolean
  value?: unknown
  committedValue?: WeakRef<object>
  accepted: boolean
  superseded: boolean
  callbackFailure?: { error: unknown }
  applied(): boolean
}
const latest = new WeakMap<Cache, Map<string, Read>>()

// Only audited single-snapshot fetchers opt in. The current observation exists
// for their synchronous invocation, never across an await or another request.
const snapshotFetchers = new WeakSet<object>()
type SynchronousRead = { read: Read; current(): boolean }
let synchronousRead: SynchronousRead | undefined

export function snapshotReadFetcher<T extends (...args: never[]) => unknown>(fetcher: T): T {
  snapshotFetchers.add(fetcher)
  return fetcher
}
export const isSnapshotReadFetcher = (fetcher: unknown) => typeof fetcher === 'function' && snapshotFetchers.has(fetcher)

/** A pending hint can let the matching SWR read settle; it is never completed
 * coverage. Multiple calls/dispatches are ambiguous and revoke the hint. */
export function capturePendingReadDispatch(): (() => void) | undefined {
  const observation = synchronousRead
  if (!observation || !observation.current()) return
  const { read } = observation
  observeReadDiagnostic('pending_capture', { read, began: read.began })
  if (read.dispatchCaptured) {
    read.dispatchAmbiguous = true
    read.pendingDispatchAt = undefined
    read.revokePending?.()
    observeReadDiagnostic('pending_revoke', { read, reason: 'revoked', began: read.began })
    return
  }
  read.dispatchCaptured = true
  read.pendingRevoked = new Promise(resolve => { read.revokePending = resolve })
  return () => {
    if (!observation.current() || read.received || read.superseded) return
    if (read.dispatchNotified || read.dispatchAmbiguous) {
      read.dispatchAmbiguous = true
      read.pendingDispatchAt = undefined
      read.revokePending?.()
      observeReadDiagnostic('pending_revoke', { read, reason: 'revoked', began: read.began })
      return
    }
    read.dispatchNotified = true
    read.pendingDispatchAt = readBoundary()
    observeReadDiagnostic('pending_dispatch', { read, began: read.began, pending: read.pendingDispatchAt })
  }
}

let order = 0

/** A same-realm ordering barrier, not a transport timestamp. Fetcher entry is
 * earlier than its HTTP send (including hydration/native batching), so it is
 * a conservative boundary even when those steps delay the actual request. */
export const readBoundary = () => ++order

// A proof names only an actual response object. Nothing is added to the wire or
// persisted, and no response is retained separately from its existing owner.
const dispatched = new WeakMap<object, number>()

/** Capture immediately before fetch, after encoding/queueing. This is a lower
 * bound on transport dispatch, not the instant bytes reached the server. */
export function captureReadDispatch() {
  const began = readBoundary()
  return <T>(value: T): T => {
    if (value !== null && typeof value === 'object') dispatched.set(value, began)
    return value
  }
}

/** Preserve one result's proof through a shallow wrapper or batch projection.
 * Callers must not attach it to merged data or a different logical read. */
export function carryReadDispatch<T>(source: unknown, value: T): T {
  const began = source !== null && typeof source === 'object' ? dispatched.get(source) : undefined
  if (began !== undefined && value !== null && typeof value === 'object') dispatched.set(value, began)
  return value
}

/** Keep only the latest actual read per cache/key. A completed proof weakly
 * names the object already in SWR; it retains no separate response value. */
export function observeSWRRead<T>(cache: Cache, key: string, fetcher: (withDispatch: <Result>(run: () => Result) => Result) => T | Promise<T>): Promise<T> {
  const reads = latest.get(cache) ?? new Map<string, Read>()
  latest.set(cache, reads)
  const previous = reads.get(key)
  if (previous) { previous.superseded = true; previous.revokePending?.() }
  let finish!: (outcome: Outcome) => void
  const read: Read = {
    began: readBoundary(), settled: new Promise(resolve => { finish = resolve }),
    received: false, accepted: false, superseded: false,
    applied: () => {
      try {
        const state = cache.get(key)
        const value = read.committedValue ? read.committedValue.deref() : read.value
        // A custom SWR comparator may retain different/older data. Only an
        // actual committed object (or identical primitive) certifies this read.
        return (!read.committedValue || value !== undefined) && read.accepted && !read.superseded
          && state?.error === undefined && Object.is(state?.data, value)
      } catch { return false }
    },
  }
  reads.set(key, read)
  observeReadDiagnostic('read_entry', { cache, key, read, began: read.began })
  // Return this exact promise to SWR. Its continuation runs onSuccess and then
  // commits the cache synchronously; the following microtask checks both.
  const withDispatch = <Result>(run: () => Result): Result => {
    const previous = synchronousRead
    synchronousRead = { read, current: () => reads.get(key) === read && !read.superseded }
    try { return run() } finally { synchronousRead = previous }
  }
  const promise = (async () => fetcher(withDispatch))()
  const complete = (outcome: Outcome) => {
    observeReadDiagnostic('read_complete', { cache, key, read, began: read.began, outcome: outcome.status, accepted: read.accepted, received: read.received, superseded: read.superseded })
    if (outcome.status === 'committed' && read.value !== null && typeof read.value === 'object') {
      read.committedValue = new WeakRef(read.value)
      read.value = undefined
    } else if (reads.get(key) === read) reads.delete(key)
    finish(outcome)
  }
  void promise.then(value => {
    read.received = true; read.value = value
    const sent = value !== null && typeof value === 'object' ? dispatched.get(value) : undefined
    if (sent !== undefined && sent > read.began) read.began = sent
    observeReadDiagnostic('read_received', { cache, key, read, began: read.began, sent, proof: sent !== undefined })
    queueMicrotask(() => {
      // Only this read's original callback failure belongs to it. A retained
      // cache.error can instead be from an older, unrelated request.
      complete(read.callbackFailure ? { status: 'failed', error: read.callbackFailure.error }
        : { status: read.applied() ? 'committed' : 'discarded' })
    })
  }, error => { queueMicrotask(() => complete({ status: 'failed', error })) })
  return promise
}

/** SWR does not call onSuccess for results discarded by a later read/mutation. */
export function acceptSWRRead(cache: Cache, key: string, value: unknown) {
  const read = latest.get(cache)?.get(key)
  if (read?.received && Object.is(read.value, value)) read.accepted = true
}

/** Preserve an original onSuccess exception without turning it into a retry. */
export function failSWRRead(cache: Cache, key: string, value: unknown, error: unknown) {
  const read = latest.get(cache)?.get(key)
  if (read?.received && Object.is(read.value, value)) read.callbackFailure = { error }
}

/** One in-flight or still-committed read may cover obligations predating it.
 * A discarded result, an older read, or an uncovered revision still needs the
 * ordinary SWR revalidation. Failures propagate without an extra retry. */
export async function readFresh(cache: Cache, key: string, after: number, revalidate: () => Promise<unknown>, accepts: (data: unknown) => boolean, current: () => boolean): Promise<unknown> {
  while (current()) {
    const read = latest.get(cache)?.get(key)
    if (!read || read.began <= after && (read.pendingDispatchAt ?? 0) <= after) {
      observeReadDiagnostic('read_fresh', { cache, key, read, after, began: read?.began, pending: read?.pendingDispatchAt, reason: read ? 'before_boundary' : 'no_read', outcome: 'revalidate' })
      return revalidate()
    }
    observeReadDiagnostic('read_fresh', { cache, key, read, after, began: read.began, pending: read.pendingDispatchAt, reason: read.began > after ? 'wait_settled' : 'wait_pending' })
    const outcome = await (read.began > after ? read.settled : Promise.race([
      read.settled,
      read.pendingRevoked!.then(() => ({ status: 'revoked' as const })),
    ]))
    if (!current()) { observeReadDiagnostic('read_fresh', { cache, key, read, after, reason: 'retired' }); return }
    if (outcome.status === 'revoked') {
      const next = latest.get(cache)?.get(key)
      if (next && next !== read) { observeReadDiagnostic('read_fresh', { cache, key, read, after, reason: 'newer_read' }); continue }
      observeReadDiagnostic('read_fresh', { cache, key, read, after, reason: 'revoked', outcome: 'revalidate' })
      return revalidate()
    }
    if (outcome.status === 'failed') { observeReadDiagnostic('read_fresh', { cache, key, read, after, reason: 'failed' }); throw outcome.error }
    if (outcome.status === 'committed' && read.began > after && read.applied()) {
      const data = cache.get(key)?.data
      if (accepts(data)) { observeReadDiagnostic('read_fresh', { cache, key, read, after, reason: 'covers' }); return data }
      observeReadDiagnostic('read_fresh', { cache, key, read, after, reason: 'revision_uncovered' })
    }
    // A later read can itself cover this obligation; never return the old
    // result or let its completion erase the newer read's observation.
    const next = latest.get(cache)?.get(key)
    if (!next || next === read) {
      observeReadDiagnostic('read_fresh', { cache, key, read, after, began: read.began, outcome: outcome.status, reason: 'not_returned' })
      return revalidate()
    }
    observeReadDiagnostic('read_fresh', { cache, key, read, after, reason: 'newer_read' })
  }
}
