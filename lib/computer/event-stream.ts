import { pageNeedsRefresh, pageRefreshSignal } from '@/lib/app-build'
import { withBasePath } from '@/lib/base-path'

type Subscription = { type: string; handler: (message: Event) => void }
type Shared = { source: EventSource | null; subscriptions: Set<Subscription>; lastId: string; onVisibility: () => void; onRefresh: () => void }

let shared: Shared | null = null

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

function open(state: Shared) {
  if (pageNeedsRefresh()) return
  // A reopened stream resumes after the last event this tab received.
  const source = new EventSource(withBasePath(`/api/computer/events${state.lastId ? `?after=${encodeURIComponent(state.lastId)}` : ''}`), { withCredentials: true })
  source.onerror = () => { if (source.readyState === EventSource.CLOSED) source.close() }
  for (const { type, handler } of state.subscriptions) source.addEventListener(type, handler)
  state.source = source
}

function close(state: Shared) {
  state.source?.close()
  state.source = null
}

/**
 * One EventSource on /api/computer/events per tab, shared by every subscriber
 * (computer pushes, sub-agent updates). Closed when the last one leaves, and
 * while the tab is hidden: the server checks for events every second for as
 * long as a stream is open.
 */
export function listenComputerStream(type: string, listener: (data: string) => void): () => void {
  if (pageNeedsRefresh() || typeof EventSource === 'undefined') return () => {}
  if (!shared) {
    const state: Shared = { source: null, subscriptions: new Set(), lastId: '', onVisibility: () => {
      if (hidden() || pageNeedsRefresh()) close(state)
      else if (!state.source || state.source.readyState === EventSource.CLOSED) open(state)
    }, onRefresh: () => close(state) }
    pageRefreshSignal().addEventListener('abort', state.onRefresh, { once: true })
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', state.onVisibility)
    shared = state
  }
  const current = shared
  const subscription: Subscription = { type, handler: message => {
    const { data, lastEventId } = message as MessageEvent<string>
    if (lastEventId) current.lastId = lastEventId
    listener(data)
  } }
  current.subscriptions.add(subscription)
  if (current.source && current.source.readyState !== EventSource.CLOSED) current.source.addEventListener(type, subscription.handler)
  else if (!hidden()) open(current)
  return () => {
    current.source?.removeEventListener(type, subscription.handler)
    current.subscriptions.delete(subscription)
    if (current.subscriptions.size === 0) {
      close(current)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', current.onVisibility)
      pageRefreshSignal().removeEventListener('abort', current.onRefresh)
      if (shared === current) shared = null
    }
  }
}
