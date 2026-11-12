'use client'

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { CLEAR_VIEW_STATE_EVENT, VIEW_STATE_PREFIX } from '../chat-drafts'

/** Browsing state lives for this window's session, separate from saved product settings. */
function createViewStore(scope: string | null) {
  const values = new Map<string, unknown>()
  const listeners = new Set<() => void>()
  const generations = new Map<string, number>()
  let active = true
  const storageKey = (key: string) => `${VIEW_STATE_PREFIX}v1:${scope}:${key}`
  return {
    activate() { active = true },
    retire() { active = false },
    get<T,>(key: string, fallback: T): T {
      if (!values.has(key) && scope && typeof window !== 'undefined') {
        try {
          const saved = window.sessionStorage.getItem(storageKey(key))
          if (saved !== null) values.set(key, JSON.parse(saved))
        } catch { /* The in-memory store still works when storage is unavailable. */ }
      }
      return values.has(key) ? values.get(key) as T : fallback
    },
    generation(key: string) { return generations.get(key) ?? 0 },
    reset<T,>(key: string, value: T) {
      generations.set(key, this.generation(key) + 1)
      this.set(key, value)
    },
    set<T,>(key: string, value: T, generation?: number) {
      if (!active || (generation !== undefined && generation !== this.generation(key))) return
      values.set(key, value)
      if (scope) {
        try { window.sessionStorage.setItem(storageKey(key), JSON.stringify(value)) } catch { /* storage unavailable */ }
      }
      listeners.forEach(listener => listener())
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

const ViewStateContext = createContext<ReturnType<typeof createViewStore> | null>(null)

export function ViewStateProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const store = useMemo(() => createViewStore(scope), [scope])
  // Page navigation may finish a pending draft update, but a discarded account
  // or workspace must never repopulate storage after its security boundary clears it.
  useLayoutEffect(() => {
    store.activate()
    window.addEventListener(CLEAR_VIEW_STATE_EVENT, store.retire)
    return () => { window.removeEventListener(CLEAR_VIEW_STATE_EVENT, store.retire); store.retire() }
  }, [store])
  return <ViewStateContext.Provider value={store}>{children}</ViewStateContext.Provider>
}

function useViewStore() {
  const provided = useContext(ViewStateContext)
  const local = useMemo(() => createViewStore(null), [])
  return provided ?? local
}

/** A confirmed loss of group membership also retires this tab's saved drafts. */
export function useForgetGroupDrafts(ownerId: string, workspaceId: string | null) {
  const store = useViewStore()
  return useCallback((id: string) => {
    if (!workspaceId) return
    store.reset(`group:${id}:draft`, '')
    store.reset(`group:${id}:pending`, [])
    store.reset(`chat-send:group:${ownerId}:${workspaceId}:${id}`, [])
  }, [store, ownerId, workspaceId])
}

/** A keyed state cell: changing objects reads that object's state immediately. */
export function useViewState<T,>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const store = useViewStore()
  const initialRef = useRef({ store, key, value: initial })
  if (initialRef.current.store !== store || initialRef.current.key !== key) initialRef.current = { store, key, value: initial }
  const fallback = initialRef.current.value
  const getSnapshot = useCallback(() => store.get(key, fallback), [store, key, fallback])
  const value = useSyncExternalStore(store.subscribe, getSnapshot, () => fallback)
  // A late completion belongs to the membership under which this cell was opened.
  const generation = useMemo(() => store.generation(key), [store, key])
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(next => {
    store.set(key, typeof next === 'function' ? (next as (previous: T) => T)(store.get(key, fallback)) : next, generation)
  }, [store, key, fallback, generation])
  return [value, setValue]
}

type Position = { top: number; left: number }

/** Restores after asynchronous rows/expanded groups arrive, without fighting user scrolling. */
export function useViewScroll<T extends HTMLElement>(key: string, ready = true, restoreSaved = true) {
  const store = useViewStore()
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !ready) return
    const cell = `scroll:${key}`
    const saved = restoreSaved ? store.get<Position | null>(cell, null) : null
    if (!saved && restoreSaved) { node.scrollTop = 0; node.scrollLeft = 0 }
    let restoring = !!saved
    const restore = () => {
      if (!restoring || !saved) return
      node.scrollTop = saved.top
      node.scrollLeft = saved.left
      if (Math.abs(node.scrollTop - saved.top) < 1 && Math.abs(node.scrollLeft - saved.left) < 1) restoring = false
    }
    const save = () => {
      if (!restoring) store.set(cell, { top: node.scrollTop, left: node.scrollLeft })
    }
    const interact = () => { restoring = false }
    restore()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore)
    const observe = () => { resize?.observe(node); for (const child of node.children) resize?.observe(child) }
    observe()
    const mutation = new MutationObserver(() => { observe(); restore() })
    mutation.observe(node, { childList: true, subtree: true })
    node.addEventListener('scroll', save, { passive: true })
    node.addEventListener('wheel', interact, { passive: true })
    node.addEventListener('touchstart', interact, { passive: true })
    node.addEventListener('pointerdown', interact, { passive: true })
    node.addEventListener('keydown', interact)
    window.addEventListener('pagehide', save)
    return () => {
      save()
      resize?.disconnect(); mutation.disconnect()
      node.removeEventListener('scroll', save)
      node.removeEventListener('wheel', interact)
      node.removeEventListener('touchstart', interact)
      node.removeEventListener('pointerdown', interact)
      node.removeEventListener('keydown', interact)
      window.removeEventListener('pagehide', save)
    }
  }, [store, key, ready, restoreSaved])
  return ref
}
