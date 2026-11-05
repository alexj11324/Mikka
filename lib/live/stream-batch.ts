import { setTimeout as delay } from 'node:timers/promises'

const pending = new WeakMap<object, Map<string, Promise<void>>>()

/** Coalesce committed stream batches before resolving their notification
 * scope. Every request awaits the same bounded work through after/waitUntil.
 * Match the previous two-second read cadence before doing scope queries. The
 * slot is released before IO, so a change during IO retains a next batch. */
export function batchStreamInvalidation(scope: object, runId: string, work: () => Promise<void>, wait: () => Promise<void> = () => delay(2_000)) {
  let queue = pending.get(scope)
  if (!queue) { queue = new Map(); pending.set(scope, queue) }
  const existing = queue.get(runId)
  if (existing) return existing
  const current = queue
  const job = Promise.resolve().then(wait)
    .finally(() => { if (current.get(runId) === job) current.delete(runId) })
    .then(work)
  current.set(runId, job)
  return job
}
