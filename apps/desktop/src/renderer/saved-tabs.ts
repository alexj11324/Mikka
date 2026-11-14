import { savedTabs, type SavedTabs } from '@mikka/protocol/bridge'

export const SAVED_TABS_KEY = 'mikka:desktop:saved-tabs:v1'
export const MAX_SAVED_TABS = 50

const NEVER_PERSIST_PATHS = [
  /^\/(?:en\/|zh-CN\/)?(?:sign-in|sign-up|forgot-password|reset-password|verify-email|oauth|device)(?:\/|$)/,
  /^\/(?:en\/|zh-CN\/)?(?:invite|organization-invite|a)(?:\/|$)/,
]
const SENSITIVE_QUERY_KEY = /^(?:access_token|refresh_token|id_token|token|code|secret|password|credential|state|api[_-]?key|key|authorization|auth)$/i

/** Only ordinary in-app routes belong in local tab recovery data. */
export function persistableHref(href: string): string | null {
  try {
    if (!href.startsWith('/') || href.startsWith('//')) return null
    const url = new URL(href, 'https://mikka.invalid')
    if (url.origin !== 'https://mikka.invalid') return null
    const appPath = url.pathname.replace(/^\/mikka(?=\/|$)/, '') || '/'
    if (NEVER_PERSIST_PATHS.some(pattern => pattern.test(appPath))) return null
    for (const key of url.searchParams.keys()) if (SENSITIVE_QUERY_KEY.test(key)) return null
    return `${url.pathname}${url.search}${url.hash}`.slice(0, 2048)
  } catch {
    return null
  }
}

export function createSavedTabs(href: string): SavedTabs {
  return { items: [{ entries: [persistableHref(href) ?? '/'], index: 0 }], active: 0 }
}

export function readSavedTabs(storage: Pick<Storage, 'getItem'>): SavedTabs | null {
  try {
    const raw = storage.getItem(SAVED_TABS_KEY)
    if (!raw) return null
    const parsed = savedTabs.safeParse(JSON.parse(raw))
    if (!parsed.success || parsed.data.items.length === 0 || parsed.data.active >= parsed.data.items.length) return null
    const items = parsed.data.items.map(tab => {
      const entries = tab.entries.map(entry => persistableHref(entry))
      if (entries.some(entry => entry === null)) return null
      return { entries: entries as string[], index: tab.index }
    })
    if (items.some(item => item === null)) return null
    return { items: items as SavedTabs['items'], active: parsed.data.active }
  } catch {
    return null
  }
}

export function writeSavedTabs(storage: Pick<Storage, 'setItem'>, value: SavedTabs): boolean {
  const parsed = savedTabs.safeParse(value)
  if (!parsed.success || parsed.data.items.length === 0 || parsed.data.active >= parsed.data.items.length) return false
  const items = parsed.data.items.map(tab => {
    const entries = tab.entries.map(entry => persistableHref(entry))
    if (entries.some(entry => entry === null)) return null
    return { entries: entries as string[], index: tab.index }
  })
  if (items.some(item => item === null)) return false
  try {
    storage.setItem(SAVED_TABS_KEY, JSON.stringify({ items, active: parsed.data.active }))
    return true
  } catch {
    return false
  }
}

export function recordNavigation(tabs: SavedTabs, href: string, mode: 'push' | 'replace'): SavedTabs {
  const items = tabs.items.map(tab => ({ ...tab, entries: [...tab.entries] }))
  const active = Math.min(tabs.active, items.length - 1)
  const tab = items[active]
  if (!tab) return createSavedTabs(href)
  const safeHref = persistableHref(href)
  if (!safeHref) return { items, active }
  if (mode === 'replace') tab.entries[tab.index] = safeHref
  else if (tab.entries[tab.index] !== safeHref) {
    tab.entries = [...tab.entries.slice(0, tab.index + 1), safeHref].slice(-50)
    tab.index = tab.entries.length - 1
  }
  return { items, active }
}

export function recordHistoryLocation(tabs: SavedTabs, href: string): SavedTabs {
  const items = tabs.items.map(tab => ({ ...tab, entries: [...tab.entries] }))
  const active = Math.min(tabs.active, items.length - 1)
  const tab = items[active]
  if (!tab) return createSavedTabs(href)
  const safeHref = persistableHref(href)
  if (!safeHref) return { items, active }
  const matches = tab.entries.map((entry, index) => entry === safeHref ? index : -1).filter(index => index >= 0)
  if (matches.length) tab.index = matches.reduce((best, index) => Math.abs(index - tab.index) < Math.abs(best - tab.index) ? index : best)
  else {
    tab.entries = [...tab.entries.slice(0, tab.index + 1), safeHref].slice(-50)
    tab.index = tab.entries.length - 1
  }
  return { items, active }
}

export function activateTab(tabs: SavedTabs, index: number): SavedTabs {
  if (index < 0 || index >= tabs.items.length) return tabs
  return { ...tabs, active: index }
}

export function addTab(tabs: SavedTabs, href: string): SavedTabs {
  if (tabs.items.length >= MAX_SAVED_TABS) return tabs
  return { items: [...tabs.items, { entries: [persistableHref(href) ?? '/'], index: 0 }], active: tabs.items.length }
}

export function closeTab(tabs: SavedTabs, index: number, fallbackHref: string): SavedTabs {
  if (index < 0 || index >= tabs.items.length) return tabs
  if (tabs.items.length === 1) return createSavedTabs(fallbackHref)
  const items = tabs.items.filter((_, itemIndex) => itemIndex !== index)
  const active = index < tabs.active ? tabs.active - 1 : index === tabs.active ? Math.min(index, items.length - 1) : tabs.active
  return { items, active }
}

export function activeHref(tabs: SavedTabs): string {
  const tab = tabs.items[tabs.active]
  return tab?.entries[tab.index] ?? '/'
}

export function tabLabel(href: string): string {
  try {
    const url = new URL(href, 'https://mikka.invalid')
    if (url.searchParams.has('issue')) return 'Issue'
    const path = url.pathname.replace(/^\/mikka(?=\/|$)/, '').replace(/^\/(?:en|zh-CN)(?=\/|$)/, '')
    if (!path || path === '/') return 'Home'
    const segment = path.split('/').filter(Boolean).pop() ?? 'Home'
    if (segment === 'dashboard') return 'Home'
    if (segment === 'settings') return 'Settings'
    if (segment === 'devices') return 'Devices'
    if (segment === 'teams') return 'Teams'
    if (segment === 'members') return 'Members'
    return decodeURIComponent(segment).replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()).slice(0, 24)
  } catch {
    return 'Mikka'
  }
}
