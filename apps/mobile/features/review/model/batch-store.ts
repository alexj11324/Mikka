import { useCallback, useSyncExternalStore } from 'react'
import { EMPTY_BATCH, type Batch } from './review'

/**
 * Each task's pending batch (comments, note, attached checks), kept on the device while the person moves between the
 * review, a file's diff and the comment sheet, until 发给 Agent sends it. One idempotency key per batch: a second tap
 * on a batch that already went sends nothing twice.
 */
const batches = new Map<string, { batch: Batch; key: string }>()
const listeners = new Set<() => void>()
const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

function entry(taskId: string) {
  let found = batches.get(taskId)
  if (!found) { found = { batch: EMPTY_BATCH, key: newKey() }; batches.set(taskId, found) }
  return found
}

export function setBatch(taskId: string, next: (batch: Batch) => Batch) {
  const current = entry(taskId)
  batches.set(taskId, { batch: next(current.batch), key: current.key })
  listeners.forEach(listener => listener())
}

/** After a send the batch empties and a later one gets a new key. */
export function clearBatch(taskId: string) {
  batches.set(taskId, { batch: EMPTY_BATCH, key: newKey() })
  listeners.forEach(listener => listener())
}

export const batchKey = (taskId: string) => entry(taskId).key

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function useBatch(taskId: string) {
  const batch = useSyncExternalStore(subscribe, () => entry(taskId).batch, () => entry(taskId).batch)
  const update = useCallback((next: (batch: Batch) => Batch) => setBatch(taskId, next), [taskId])
  return [batch, update] as const
}
