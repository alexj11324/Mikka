import { withBasePath } from '@/lib/base-path'

let shared: { source: EventSource; users: number } | null = null

/**
 * One EventSource on /api/computer/events per tab, shared by every subscriber
 * (computer pushes, sub-agent updates). Closed when the last one leaves.
 */
export function listenComputerStream(type: string, listener: (data: string) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  if (!shared || shared.source.readyState === EventSource.CLOSED) {
    const source = new EventSource(withBasePath('/api/computer/events'), { withCredentials: true })
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) source.close() }
    shared = { source, users: 0 }
  }
  const current = shared
  const handler = (message: Event) => listener((message as MessageEvent<string>).data)
  current.source.addEventListener(type, handler)
  current.users += 1
  return () => {
    current.source.removeEventListener(type, handler)
    current.users -= 1
    if (current.users === 0) { current.source.close(); if (shared === current) shared = null }
  }
}
