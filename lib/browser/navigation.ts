'use client'

import { normalizeAddress } from './note'

export type BrowserAddressRequest = { href: string }
let unread: BrowserAddressRequest | null = null
let version = 0
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }

/** Open through BrowserPane's existing navigation, including a request made before its tab mounts. */
export function openBrowserAddress(value: string): boolean {
  if (typeof window === 'undefined') return false
  const href = normalizeAddress(value, window.location.origin)
  if (!href) return false
  // A fresh request also reloads an address that was explicitly opened again.
  unread = { href }
  version++
  changed()
  return true
}

export const browserAddressRequest = () => unread
/** Tab owners observe explicit opens even when an already-mounted pane consumes immediately. */
export const browserAddressVersion = () => version
export const serverBrowserAddressRequest = () => null
export function subscribeBrowserAddress(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** A consumed request must not replace the browser's newer saved page after a remount. */
export function consumeBrowserAddress(request: BrowserAddressRequest) {
  if (unread !== request) return false
  unread = null
  changed()
  return true
}
