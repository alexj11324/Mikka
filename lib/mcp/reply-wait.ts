export const REPLY_FALLBACK_MS = 15_000
export type ReplyRead<T> = { done: false } | { done: true; value: T }
export type ReplySubscription = (changed: () => void) => () => void

/** A notification is a hint to reread, never a reply or an authorization result.
 * Register first, then read; a change during a read requires another read. */
export async function waitForReply<T>(read: (final: boolean) => Promise<ReplyRead<T>>, options: {
  deadline: number
  subscribe: ReplySubscription
  signal?: AbortSignal
}): Promise<T> {
  const { deadline, signal } = options
  signal?.throwIfAborted()
  let dirty = false
  let wake: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe = () => {}
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => {
    rejectAbort(signal?.reason ?? new DOMException('The waiting request was cancelled', 'AbortError'))
  }
  const changed = () => { dirty = true; wake?.() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (Date.now() < deadline) unsubscribe = options.subscribe(changed)
    for (;;) {
      signal?.throwIfAborted()
      dirty = false
      const began = Date.now()
      const final = began >= deadline
      const result = await Promise.race([read(final), aborted])
      if (result.done) return result.value
      if (final) throw new Error('The deadline read must return the current reply state')
      if (dirty || Date.now() >= deadline) continue
      await Promise.race([
        new Promise<void>(resolve => {
          wake = resolve
          timer = setTimeout(resolve, Math.max(0, Math.min(deadline, began + REPLY_FALLBACK_MS) - Date.now()))
        }),
        aborted,
      ])
      clearTimeout(timer)
      timer = undefined
      wake = undefined
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    unsubscribe()
  }
}
