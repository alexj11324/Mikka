export const TRANSPORT_EVENT = 'mikka:desktop-transport'
export type TransportState = 'ready' | 'offline' | 'unauthenticated' | 'update-required'
let state: TransportState = 'ready'

export function getTransportState() { return state }
export function setTransportState(next: TransportState) {
  // An earlier concurrent response cannot make an incompatible binary usable.
  // Installing the supported app starts a new document and resets this state.
  if (state === 'update-required') return
  if (next === state) return
  state = next
  window.dispatchEvent(new Event(TRANSPORT_EVENT))
}
export function subscribeTransport(changed: () => void) {
  window.addEventListener(TRANSPORT_EVENT, changed)
  return () => window.removeEventListener(TRANSPORT_EVENT, changed)
}
