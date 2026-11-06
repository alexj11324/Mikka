export const REPLY_FALLBACK_MS = 15_000
export type ReplyRead<T> = { done: false } | { done: true; value: T }
/** Only complete transactional coverage may omit healthy reconciliation.
 * Older best-effort callback subscribers keep the original fallback. */
export type ReplyObserver = { readonly lost: boolean; close(): void }
export type ReplySubscription = (changed: () => void, signal: AbortSignal) =>
  (() => void) | ReplyObserver | Promise<(() => void) | ReplyObserver>

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
  let observer: ReplyObserver | undefined
  let closed = false
  const lifetime = new AbortController()
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => {
    rejectAbort(signal?.reason ?? new DOMException('The waiting request was cancelled', 'AbortError'))
  }
  const changed = () => { dirty = true; wake?.() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (Date.now() < deadline) {
      // Abort/deadline do not wait behind LISTEN establishment. A late result
      // closes itself; the shared subscriber receives the same cancellation.
      let deadlineReached = false
      const preparing = Promise.resolve(options.subscribe(changed, lifetime.signal)).then(value => {
        const close = typeof value === 'function' ? value : () => value.close()
        if (closed || deadlineReached || signal?.aborted) close()
        else { unsubscribe = close; if (typeof value !== 'function') observer = value }
      })
      await Promise.race([preparing, aborted, new Promise<void>(resolve => {
        timer = setTimeout(() => { deadlineReached = true; lifetime.abort(); resolve() }, Math.max(0, deadline - Date.now()))
      })])
      clearTimeout(timer)
      timer = undefined
    }
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
          const next = observer && !observer.lost ? deadline : Math.min(deadline, began + REPLY_FALLBACK_MS)
          timer = setTimeout(resolve, Math.max(0, next - Date.now()))
        }),
        aborted,
      ])
      clearTimeout(timer)
      timer = undefined
      wake = undefined
    }
  } finally {
    closed = true
    lifetime.abort()
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    unsubscribe()
  }
}
