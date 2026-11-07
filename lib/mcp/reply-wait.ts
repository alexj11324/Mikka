export const REPLY_FALLBACK_MS = 15_000
export type ReplyRead<T> = { done: false } | { done: true; value: T }
/** Only complete transactional coverage may omit healthy reconciliation.
 * Older best-effort callback subscribers keep the original fallback. */
export type ReplyObserver = { readonly lost: boolean; close(): void }
export type ReplyChanged = (reason?: 'notification' | 'lost') => void
export type ReplySubscription = (changed: ReplyChanged, signal: AbortSignal) =>
  (() => void) | ReplyObserver | Promise<(() => void) | ReplyObserver>
export type ReplyWaitCompletion = {
  outcome: 'resolved' | 'deadline' | 'aborted' | 'error'
  readCalls: number
  finalReadCalls: number
  notificationWakes: number
  lossWakes: number
  fallbackWakes: number
  observedLost: boolean
  observerKind: 'none' | 'callback' | 'transactional'
  setupState: 'not_started' | 'pending' | 'ready'
  observerClosed: boolean
  aborted: boolean
  setupMs: number
  durationMs: number
}

/** A notification is a hint to reread, never a reply or an authorization result.
 * Register first, then read; a change during a read requires another read. */
export async function waitForReply<T>(read: (final: boolean) => Promise<ReplyRead<T>>, options: {
  deadline: number
  subscribe: ReplySubscription
  signal?: AbortSignal
  onComplete?: (completion: ReplyWaitCompletion) => void
}): Promise<T> {
  const { deadline, signal } = options
  const started = Date.now()
  let outcome: ReplyWaitCompletion['outcome'] = 'error'
  let readCalls = 0, finalReadCalls = 0, notificationWakes = 0, lossWakes = 0, fallbackWakes = 0
  let observedLost = false, observerClosed = false
  let observerKind: ReplyWaitCompletion['observerKind'] = 'none'
  let setupState: ReplyWaitCompletion['setupState'] = 'not_started'
  let setupStarted: number | undefined, setupEnded: number | undefined
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
  const changed: ReplyChanged = (reason = 'notification') => {
    if (reason === 'lost') { lossWakes++; observedLost = true } else notificationWakes++
    dirty = true; wake?.()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    if (Date.now() < deadline) {
      // Abort/deadline do not wait behind LISTEN establishment. A late result
      // closes itself; the shared subscriber receives the same cancellation.
      let deadlineReached = false
      setupState = 'pending'; setupStarted = Date.now()
      const preparing = Promise.resolve(options.subscribe(changed, lifetime.signal)).then(value => {
        setupState = 'ready'; setupEnded = Date.now()
        observerKind = typeof value === 'function' ? 'callback' : 'transactional'
        const close = () => {
          try { if (typeof value === 'function') value(); else value.close(); observerClosed = true }
          catch (error) { outcome = 'error'; throw error }
        }
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
      readCalls++
      if (final) finalReadCalls++
      const result = await Promise.race([read(final), aborted])
      if (result.done) { outcome = final ? 'deadline' : 'resolved'; return result.value }
      if (final) throw new Error('The deadline read must return the current reply state')
      if (dirty || Date.now() >= deadline) continue
      await Promise.race([
        new Promise<void>(resolve => {
          wake = resolve
          const healthy = observer && !observer.lost
          if (observer && !healthy) observedLost = true
          const next = healthy ? deadline : Math.min(deadline, began + REPLY_FALLBACK_MS)
          timer = setTimeout(() => { if (next < deadline) fallbackWakes++; resolve() }, Math.max(0, next - Date.now()))
        }),
        aborted,
      ])
      clearTimeout(timer)
      timer = undefined
      wake = undefined
    }
  } catch (error) {
    if (signal?.aborted) outcome = 'aborted'
    throw error
  } finally {
    closed = true
    lifetime.abort()
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    try { unsubscribe() }
    finally {
      // Observe only counters and lifecycle state, after logical unsubscribe.
      // A pending setup's late close is not claimed complete by this snapshot.
      const ended = Date.now()
      try {
        options.onComplete?.({ outcome, readCalls, finalReadCalls, notificationWakes, lossWakes, fallbackWakes,
          observedLost, observerKind, setupState, observerClosed, aborted: signal?.aborted ?? false,
          setupMs: setupStarted === undefined ? 0 : Math.max(0, (setupEnded ?? ended) - setupStarted),
          durationMs: Math.max(0, ended - started),
        })
      } catch { /* Diagnostic failure cannot change the reply, abort, or cleanup. */ }
    }
  }
}
