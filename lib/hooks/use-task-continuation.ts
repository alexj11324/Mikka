import { useRef, useState } from 'react'
import type { TaskListPageInput } from '../task-list-page'

type Cursor = NonNullable<TaskListPageInput['after']>
type Page<T> = { items: readonly T[]; next: Cursor | null }

/** A live first-page replacement retires older authorized pages. Continuations
 * are read once per explicit request and late results cannot restore them. */
export function useTaskContinuation<T extends { id: string }>(first: readonly T[], epoch: unknown, firstCursor: Cursor | null,
  read: (after: Cursor) => Promise<Page<T>>) {
  const [tail, setTail] = useState<{ epoch: unknown; items: readonly T[]; next: Cursor | null }>()
  const [pending, setPending] = useState<{ epoch: unknown }>()
  const [failed, setFailed] = useState<{ epoch: unknown }>()
  const flight = useRef<{ epoch: unknown } | null>(null)
  const current = tail?.epoch === epoch ? tail : undefined
  const next = current ? current.next : firstCursor
  async function loadMore() {
    if (!next || flight.current?.epoch === epoch) return
    const request = { epoch }
    flight.current = request
    setPending(request)
    setFailed(undefined)
    try {
      const result = await read(next)
      if (flight.current !== request) return
      const unique = new Map(first.map(item => [item.id, item]))
      for (const item of [...(current?.items ?? []), ...result.items]) if (!unique.has(item.id)) unique.set(item.id, item)
      setTail({ epoch, items: [...unique.values()], next: result.next })
    } catch {
      if (flight.current === request) setFailed(request)
    } finally {
      if (flight.current === request) { flight.current = null; setPending(undefined) }
    }
  }
  return { items: current?.items ?? first, hasMore: Boolean(next), loading: Boolean(pending && pending.epoch === epoch),
    failed: Boolean(failed && failed.epoch === epoch), loadMore }
}
