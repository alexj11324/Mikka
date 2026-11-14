import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowLeft, ArrowRight, Plus, X } from 'lucide-react'
import { platform } from 'mikka:platform'
import { activeHref, activateTab, addTab, closeTab, createSavedTabs, moveHistory, nextTabIndex, persistableHref, readSavedTabs, recordHistoryLocation, recordNavigation, tabLabel, writeSavedTabs } from './saved-tabs'
import type { SavedTabs } from '@mikka/protocol/bridge'
import { useLocation, navigate } from './location'

function currentHref() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}
function newTabHref() {
  return window.location.pathname === '/en' || window.location.pathname.startsWith('/en/') ? '/en/' : '/'
}
function readInitialTabs(href: string): SavedTabs {
  try {
    return readSavedTabs(window.localStorage) ?? createSavedTabs(href)
  } catch {
    return createSavedTabs(href)
  }
}
function save(tabs: SavedTabs) {
  try { writeSavedTabs(window.localStorage, tabs) } catch { /* Browser storage may be unavailable. */ }
}

export function DesktopTabs() {
  const t = useTranslations('DesktopRenderer')
  const location = useLocation()
  const safeLocation = persistableHref(`${location.pathname}${location.search}${location.hash}`)
  const enabled = platform === 'desktop' && document.documentElement.dataset.desktopWindow === 'main' && safeLocation !== null
  const initialStoredTabs = useRef<SavedTabs | null>(null)
  const initialRestoreHandled = useRef(false)
  const [tabs, setTabs] = useState<SavedTabs>(() => {
    initialStoredTabs.current = readStoredTabs()
    return initialStoredTabs.current ?? readInitialTabs(safeLocation ?? '/')
  })
  const tabsRef = useRef(tabs)
  const ignoreNavigation = useRef<string | null>(null)
  tabsRef.current = tabs

  useEffect(() => {
    if (!enabled) return
    const onNavigation = (event: Event) => {
      const detail = (event as CustomEvent<{ method?: string; href?: string }>).detail
      const href = persistableHref(detail?.href ?? currentHref())
      if (!href) return
      if (ignoreNavigation.current === href) {
        ignoreNavigation.current = null
        return
      }
      const next = recordNavigation(tabsRef.current, href, detail?.method === 'replaceState' ? 'replace' : 'push')
      tabsRef.current = next
      setTabs(next)
      save(next)
    }
    const onPopState = () => {
      const href = persistableHref(currentHref())
      if (!href) return
      const next = recordHistoryLocation(tabsRef.current, href)
      tabsRef.current = next
      setTabs(next)
      save(next)
    }
    window.addEventListener('mikka:desktop-history', onNavigation)
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('mikka:desktop-history', onNavigation)
      window.removeEventListener('popstate', onPopState)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !safeLocation || initialRestoreHandled.current) return
    initialRestoreHandled.current = true
    if (initialStoredTabs.current) {
      const restoredHref = activeHref(initialStoredTabs.current)
      if (restoredHref !== safeLocation) {
        ignoreNavigation.current = restoredHref
        navigate(restoredHref, true, { scroll: false })
      }
      return
    }
    const next = createSavedTabs(safeLocation)
    initialStoredTabs.current = next
    tabsRef.current = next
    setTabs(next)
    save(next)
  }, [enabled, safeLocation])

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        moveActiveHistory('back')
      } else if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowRight') {
        event.preventDefault()
        moveActiveHistory('forward')
      } else if (event.metaKey && event.key === '[') {
        event.preventDefault()
        moveActiveHistory('back')
      } else if (event.metaKey && event.key === ']') {
        event.preventDefault()
        moveActiveHistory('forward')
      } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        openTab()
      } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        closeActiveTab()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])

  function commit(next: SavedTabs, destination?: string) {
    tabsRef.current = next
    setTabs(next)
    save(next)
    if (destination && persistableHref(destination) && destination !== currentHref()) {
      ignoreNavigation.current = destination
      navigate(destination, true, { scroll: false })
    }
  }
  function moveActiveHistory(direction: 'back' | 'forward') {
    const next = moveHistory(tabsRef.current, direction)
    if (next === tabsRef.current) return
    commit(next, activeHref(next))
  }
  function openTab() {
    const next = addTab(tabsRef.current, newTabHref())
    if (next === tabsRef.current) return
    commit(next, activeHref(next))
  }
  function closeActiveTab() {
    const index = tabsRef.current.active
    const next = closeTab(tabsRef.current, index, newTabHref())
    commit(next, activeHref(next))
  }
  function selectTab(index: number) {
    const next = activateTab(tabsRef.current, index)
    if (next.active === tabsRef.current.active) return
    commit(next, activeHref(next))
  }
  function closeAt(index: number, event: MouseEvent) {
    event.stopPropagation()
    const wasActive = index === tabsRef.current.active
    const next = closeTab(tabsRef.current, index, newTabHref())
    commit(next, wasActive ? activeHref(next) : undefined)
  }

  if (!enabled) return null
  const activeTab = tabs.items[tabs.active]
  return <nav aria-label={t('tabsLabel')} className="desktop-tabs fixed inset-x-0 top-0 z-[100] flex h-10 items-center gap-1 border-b bg-background/95 px-2 text-foreground shadow-sm backdrop-blur">
    <button type="button" aria-label={t('back')} title={`${t('back')} (Alt+← / ⌘+[)`} onClick={() => moveActiveHistory('back')} disabled={!activeTab || activeTab.index <= 0} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ArrowLeft aria-hidden="true" className="size-4" />
    </button>
    <button type="button" aria-label={t('forward')} title={`${t('forward')} (Alt+→ / ⌘+])`} onClick={() => moveActiveHistory('forward')} disabled={!activeTab || activeTab.index >= activeTab.entries.length - 1} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ArrowRight aria-hidden="true" className="size-4" />
    </button>
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label={t('tabsLabel')}>
      {tabs.items.map((tab, index) => {
        const title = tabLabel(tab.entries[tab.index] ?? '/')
        const localizedTitle = title === 'Home' ? t('tabHome') : title === 'Settings' ? t('tabSettings') : title
        return <div key={`${index}:${tab.entries[0]}`} role="presentation" className={`group flex h-8 max-w-56 min-w-24 items-center rounded-md border px-1 ${index === tabs.active ? 'border-border bg-muted' : 'border-transparent hover:bg-muted/70'}`}>
          <button type="button" role="tab" data-tab-index={index} tabIndex={index === tabs.active ? 0 : -1} aria-selected={index === tabs.active} aria-label={localizedTitle} title={localizedTitle} onClick={() => selectTab(index)} onKeyDown={event => {
            const next = nextTabIndex(tabs.items.length, index, event.key)
            if (next === null) return
            event.preventDefault()
            selectTab(next)
            event.currentTarget.parentElement?.parentElement?.querySelector<HTMLButtonElement>(`[data-tab-index="${next}"]`)?.focus()
          }} className="min-w-0 flex-1 truncate px-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {localizedTitle}
          </button>
          <button type="button" aria-label={t('closeTab', { title: localizedTitle })} title={t('closeTab', { title: localizedTitle })} onClick={event => closeAt(index, event)} className="flex size-6 shrink-0 items-center justify-center rounded hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      })}
    </div>
    <button type="button" aria-label={t('newTab')} title={`${t('newTab')} (⌘/Ctrl+T)`} onClick={openTab} disabled={tabs.items.length >= 50} className="flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Plus aria-hidden="true" className="size-4" />
    </button>
  </nav>
}

function readStoredTabs(): SavedTabs | null {
  try { return readSavedTabs(window.localStorage) } catch { return null }
}
