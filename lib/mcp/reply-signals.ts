import type { SharedSubscription } from '../db/listen'
import type { ReplyChanged, ReplyObserver } from './reply-wait'

/** Adapt shared PG subscriptions to the waiter's dirty latch. The only timer
 * here is a pending transport wait, cancelled with the bounded MCP request. */
export async function observeReplySignals(
  open: (signal: AbortSignal) => Promise<(SharedSubscription | null)[]>,
  changed: ReplyChanged, signal: AbortSignal,
): Promise<ReplyObserver> {
  const lifetime = new AbortController()
  const stop = () => lifetime.abort()
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  let subscriptions: (SharedSubscription | null)[] = [], closed = false, failed = false
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', stop)
    lifetime.abort()
    for (const subscription of subscriptions) subscription?.close()
  }
  try {
    subscriptions = await open(lifetime.signal)
    if (lifetime.signal.aborted) close()
    for (const subscription of subscriptions) {
      if (!subscription || closed) continue
      const listen = async () => {
        while (!lifetime.signal.aborted) {
          // Runs synchronously after changed(), before another notification can
          // arrive. The waiter's dirty latch covers its in-flight read.
          subscription.reset()
          if (subscription.lost) { changed('lost'); return }
          await subscription.next(2_147_483_647, lifetime.signal)
          if (lifetime.signal.aborted) return
          changed(subscription.lost ? 'lost' : 'notification')
          if (subscription.lost) return // Sticky lost must never busy-loop.
        }
      }
      void listen().catch(() => { failed = true; if (!closed) changed('lost') })
    }
    return { get lost() { return failed || subscriptions.length === 0 || subscriptions.some(value => !value || value.lost) }, close }
  } catch (error) { close(); throw error }
}
