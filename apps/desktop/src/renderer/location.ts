import { useMemo, useSyncExternalStore } from 'react'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { mobileTaskLocation } from '@/lib/web-connection/mobile-task-location'
import { serverDocumentKind, serverPageKind } from '@/lib/server-pages'

export type Locale = 'zh-CN' | 'en'
export type Href = string | { pathname?: string; query?: Record<string, string | number | boolean | readonly string[] | null | undefined>; hash?: string }
export const REFRESH_EVENT = 'mikka:desktop-refresh'
const LOCATION_EVENT = 'mikka:desktop-location'
let installed = false

/** Next updates its hooks after history writes; the local router keeps that same
 * contract, including the existing workspace's task-origin marks in history.state. */
export function installNavigation() {
  if (installed) return
  installed = true
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history)
    window.history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
      original(data, unused, url)
      // Let the workspace finish recording its own query before React observes it.
      queueMicrotask(() => window.dispatchEvent(new Event(LOCATION_EVENT)))
    }
  }
}

const subscribe = (changed: () => void) => {
  window.addEventListener(LOCATION_EVENT, changed)
  window.addEventListener('popstate', changed)
  window.addEventListener('hashchange', changed)
  return () => {
    window.removeEventListener(LOCATION_EVENT, changed)
    window.removeEventListener('popstate', changed)
    window.removeEventListener('hashchange', changed)
  }
}
const snapshot = () => mobileTaskLocation(window.location.href)

export function useLocation() {
  const href = useSyncExternalStore(subscribe, snapshot, snapshot)
  return useMemo(() => new URL(href), [href])
}

export function withoutBase(pathname: string) {
  return BASE_PATH && (pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`))
    ? pathname.slice(BASE_PATH.length) || '/'
    : pathname
}

export function localeOf(pathname: string): Locale {
  const path = withoutBase(pathname)
  return path === '/en' || path.startsWith('/en/') ? 'en' : 'zh-CN'
}

export function withoutLocale(pathname: string) {
  const path = withoutBase(pathname)
  return path === '/en' || path === '/zh-CN' ? '/'
    : path.replace(/^\/(?:en|zh-CN)(?=\/)/, '')
}

export function hrefString(href: Href): string {
  if (typeof href === 'string') return href
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item))
    else if (value !== undefined && value !== null) query.set(key, String(value))
  }
  const search = query.toString()
  return `${href.pathname ?? '/'}${search ? `?${search}` : ''}${href.hash ? `#${href.hash.replace(/^#/, '')}` : ''}`
}

/** i18n's getPathname returns a locale path, leaving the base path to its caller. */
export function localeHref(href: Href, locale: string): string {
  const value = hrefString(href)
  if (!value.startsWith('/') || value.startsWith('//')) return value
  const url = new URL(value, 'https://desktop.invalid')
  const pathname = withoutLocale(url.pathname)
  return `${locale === 'en' ? '/en' : ''}${pathname === '/' ? '/' : pathname}${url.search}${url.hash}`
}

export function isOwnURL(url: URL) {
  // Custom schemes need a protocol/host comparison: URL.origin can be "null"
  // outside Electron, and unrelated opaque origins must never compare equal.
  return url.protocol === window.location.protocol && url.host === window.location.host
}

/** HTTP API/auth callbacks and machine endpoints must reach the server rather
 * than becoming an in-memory SPA route. Keep the actual page set explicit. */
export function isClientRoute(url: URL) {
  if (!isOwnURL(url)) return false
  // A self-hosted auth document must return ordinary business navigation to
  // the server entry. The official app and installed clients have no marker.
  if (serverDocumentKind() && !serverPageKind(url)) return false
  const path = withoutLocale(url.pathname)
  return ['/', '/dashboard', '/devices', '/device', '/settings', '/settings/teams', '/settings/members', '/workspaces/new', '/sign-in', '/sign-up', '/forgot-password', '/reset-password', '/verify-email', '/oauth/consent'].includes(path)
    || /^\/(?:invite|a|w)\/[^/]+$/.test(path)
}

export function navigate(href: Href, replace = false, options?: { scroll?: boolean; locale?: string }, localized = false) {
  const value = localized ? localeHref(href, options?.locale ?? localeOf(window.location.pathname)) : hrefString(href)
  const url = new URL(withBasePath(value), window.location.href)
  if (!isOwnURL(url)) {
    if (window.location.protocol === 'mikka:') void window.mikka?.app.openExternal(url.href)
    else window.location.assign(url.href)
    return
  }
  if (!isClientRoute(url)) {
    window.location[replace ? 'replace' : 'assign'](url.href)
    return
  }
  const previous = window.location.pathname
  window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  // The shared workspace's navigation listener owns dirty-draft guards and
  // choosing the visible bot, thread, Artifact and settings section.
  window.dispatchEvent(new Event('mikka:navigate'))
  if (options?.scroll !== false && previous !== url.pathname) window.scrollTo(0, 0)
}

export function refresh() { window.dispatchEvent(new Event(REFRESH_EVENT)) }
