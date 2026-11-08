type ReplayClient = {
  onSessionId(callback: (sessionId: string) => void): () => void
  sessionRecordingStarted(): boolean
}
type ReplayEvent = { event: string; properties: Record<string, unknown> } | null
type ReplayObserver = {
  bind(client: ReplayClient): void
  observe(event: ReplayEvent): void
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const validId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
  && value !== '00000000-0000-0000-0000-000000000000'
const observers = new WeakMap<object, ReplayObserver>()

/** A read-only view of naturally produced Replay metadata; never starts capture. */
export function installReplayReadiness(target: object, now: () => number = Date.now): ReplayObserver {
  const existing = observers.get(target)
  if (existing) return existing
  let client: ReplayClient | null = null
  let unsubscribe: (() => void) | undefined
  let sessionId: string | null = null, sessionObservedAt: number | null = null
  let snapshotSessionId: string | null = null, snapshotObservedAt: number | null = null
  const clearSnapshot = () => { snapshotSessionId = null; snapshotObservedAt = null }
  const read = () => {
    let recordingStarted: boolean | null = null
    try {
      const value = client?.sessionRecordingStarted()
      if (typeof value === 'boolean') recordingStarted = value
    } catch { /* A failed observer cannot change SDK capture or disclose its error. */ }
    const snapshotObserved = sessionId !== null && snapshotSessionId === sessionId
    return Object.freeze({ version: 1, sdkLoaded: client !== null, sessionId, recordingStarted,
      snapshotObserved, sessionObservedAt, snapshotObservedAt: snapshotObserved ? snapshotObservedAt : null,
      observedAt: now() })
  }
  const observer: ReplayObserver = Object.freeze({
    bind(next: ReplayClient) {
      try { unsubscribe?.() } catch { /* Replacing an observer must not break SDK initialization. */ }
      unsubscribe = undefined
      client = next
      sessionId = null; sessionObservedAt = null
      try {
        unsubscribe = next.onSessionId(id => {
          const nextId = validId(id) ? id : null
          if (!nextId) { sessionId = null; sessionObservedAt = null; clearSnapshot(); return }
          if (nextId !== sessionId) {
            sessionId = nextId
            sessionObservedAt = nextId ? now() : null
            if (!nextId || snapshotSessionId !== nextId) clearSnapshot()
          }
        })
      } catch {
        client = null; sessionId = null; sessionObservedAt = null; clearSnapshot()
      }
    },
    observe(event: ReplayEvent) {
      try {
        if (event?.event !== '$snapshot') return
        const id = event.properties.$session_id
        if (!validId(id)) { clearSnapshot(); return }
        if (snapshotSessionId !== id) { snapshotSessionId = id; snapshotObservedAt = now() }
      } catch { clearSnapshot() }
    },
  })
  // Configurable permits HMR; only the reader is public, never the SDK or observer.
  try { Object.defineProperty(target, '__mikkaReplayReadiness', { value: read, configurable: true }) }
  catch { /* An unavailable bridge fails the acceptance gate, not normal product capture. */ }
  observers.set(target, observer)
  return observer
}
