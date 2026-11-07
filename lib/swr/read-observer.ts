type Cache = { get(key: string): { data?: unknown; error?: unknown } | undefined }
type Outcome = { status: 'committed' | 'discarded' } | { status: 'failed'; error: unknown }
type Read = {
  began: number
  settled: Promise<Outcome>
  received: boolean
  value?: unknown
  accepted: boolean
  superseded: boolean
  callbackFailure?: { error: unknown }
  applied(): boolean
}
const pending = new WeakMap<Cache, Map<string, Read>>()
let order = 0

/** A same-realm ordering barrier, not a transport timestamp. Fetcher entry is
 * earlier than its HTTP send (including hydration/native batching), so it is
 * a conservative boundary even when those steps delay the actual request. */
export const readBoundary = () => ++order

/** Observe only the actual SWR fetcher lifetime. Settled results are not kept. */
export function observeSWRRead<T>(cache: Cache, key: string, fetcher: () => T | Promise<T>): Promise<T> {
  const reads = pending.get(cache) ?? new Map<string, Read>()
  pending.set(cache, reads)
  const previous = reads.get(key)
  if (previous) previous.superseded = true
  let finish!: (outcome: Outcome) => void
  const read: Read = {
    began: readBoundary(), settled: new Promise(resolve => { finish = resolve }),
    received: false, accepted: false, superseded: false,
    applied: () => {
      try {
        const state = cache.get(key)
        // A custom SWR comparator may retain different/older data. Only an
        // actual committed object (or identical primitive) certifies this read.
        return read.accepted && !read.superseded && state?.error === undefined && Object.is(state?.data, read.value)
      } catch { return false }
    },
  }
  reads.set(key, read)
  // Return this exact promise to SWR. Its continuation runs onSuccess and then
  // commits the cache synchronously; the following microtask checks both.
  const promise = (async () => fetcher())()
  const complete = (outcome: Outcome) => {
    if (reads.get(key) === read) reads.delete(key)
    finish(outcome)
  }
  void promise.then(value => {
    read.received = true; read.value = value
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
  const read = pending.get(cache)?.get(key)
  if (read?.received && Object.is(read.value, value)) read.accepted = true
}

/** Preserve an original onSuccess exception without turning it into a retry. */
export function failSWRRead(cache: Cache, key: string, value: unknown, error: unknown) {
  const read = pending.get(cache)?.get(key)
  if (read?.received && Object.is(read.value, value)) read.callbackFailure = { error }
}

/** One in-flight read may cover several obligations created before it began.
 * A discarded result, an older read, or an uncovered revision still needs the
 * ordinary SWR revalidation. Failures propagate without an extra retry. */
export async function readFresh(cache: Cache, key: string, after: number, revalidate: () => Promise<unknown>, accepts: (data: unknown) => boolean, current: () => boolean): Promise<unknown> {
  while (current()) {
    const read = pending.get(cache)?.get(key)
    if (!read || read.began <= after) return revalidate()
    const outcome = await read.settled
    if (!current()) return
    if (outcome.status === 'failed') throw outcome.error
    if (outcome.status === 'committed' && read.applied()) {
      const data = cache.get(key)?.data
      if (accepts(data)) return data
    }
    // A later read can itself cover this obligation; never return the old
    // result or let its completion erase the newer read's observation.
    if (!pending.get(cache)?.has(key)) return revalidate()
  }
}
