'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SWRConfig, unstable_serialize, useSWRConfig, type Cache, type Key } from 'swr'
import { useSearchParams } from 'next/navigation'
import { useRouter } from '@/i18n/navigation'
import { APP_BUILD } from '@/lib/app-build'
import { selectedWebServer } from '@/lib/web-connection/selection'
import type { AuthorizedCacheWorkspace } from '@/lib/swr/cache-scope'
import { clearPersistentReadCaches, invalidateResourceAccessCaches, PersistentReadCache, readCacheNamespace, type ReadCacheScope, type ReadCacheState } from '@/lib/swr/persistent-cache'

type InitialRead = { key: unknown; data: unknown }

/** Both the main window and a directly opened Settings page use this boundary.
 * The scope comes from the authenticated server render, never browser storage. */
export function AuthenticatedReadCache({ ownerId, workspace, build = APP_BUILD, initialReads, children }: { ownerId: string; workspace?: AuthorizedCacheWorkspace | null; build?: string; initialReads?: readonly InitialRead[]; children: ReactNode }) {
  const requested = useSearchParams().get('workspace')
  // A pushState to a different workspace must not borrow this one's authority.
  // Its normal reads still work; persistence waits for an authorized server render.
  const server = selectedWebServer()
  const scope = useMemo<ReadCacheScope | null>(() => build && workspace && (!requested || requested === workspace.workspaceId)
    ? { userId: ownerId, workspaceId: workspace.workspaceId, role: workspace.role, accessProof: workspace.accessProof, build, server } : null,
  [ownerId, workspace?.workspaceId, workspace?.role, workspace?.accessProof, requested, build, server])
  const unauthorized = Boolean(build && (!workspace || requested && requested !== workspace.workspaceId))
  return <ReadCacheBoundary key={scope ? readCacheNamespace(scope) : `${ownerId}:${requested ?? ''}:memory`} scope={scope} expiresAt={workspace?.accessExpiresAt} expiresAfterMs={workspace?.accessExpiresAfterMs} unauthorized={unauthorized} initialReads={initialReads}>{children}</ReadCacheBoundary>
}

function ReadCacheBoundary({ scope, expiresAt, expiresAfterMs, unauthorized, initialReads, children }: { scope: ReadCacheScope | null; expiresAt?: string | null; expiresAfterMs?: number | null; unauthorized: boolean; initialReads?: readonly InitialRead[]; children: ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<{ cache: Cache; generation: number; retired?: boolean }>(() => {
    const cache: Cache = new PersistentReadCache(scope, undefined, Boolean(scope?.accessProof))
    // SWR fallback is not necessarily stored in the provider. Put authorized
    // server reads there before the asynchronous disk snapshot can arrive.
    for (const read of initialReads ?? []) {
      const initialState: ReadCacheState = { data: read.data, _k: read.key }
      cache.set(unstable_serialize(read.key as Key), initialState)
    }
    return { cache, generation: 0 }
  })
  const config = useMemo(() => ({ provider: () => state.cache }), [state.cache])
  useEffect(() => { if (unauthorized) void clearPersistentReadCaches() }, [unauthorized])
  const retiredExpiry = useRef<string | null>(null)
  useEffect(() => {
    if (!expiresAt || retiredExpiry.current === expiresAt || !(state.cache instanceof PersistentReadCache) || !state.cache.workspaceId) return
    const cache = state.cache
    const workspaceId=cache.workspaceId!
    // The server TTL is anchored conservatively to this Document's start.
    // A slow response or a skewed wall clock can shorten access, never extend it.
    const serverRemaining = typeof expiresAfterMs === 'number' && Number.isFinite(expiresAfterMs)
      ? expiresAfterMs - (typeof performance !== 'undefined' ? performance.now() : 0) : 0
    const remaining = Math.min(Date.parse(expiresAt) - Date.now(), serverRemaining)
    if (!Number.isFinite(remaining)) return
    const timer = setTimeout(() => { retiredExpiry.current = expiresAt; void invalidateResourceAccessCaches(workspaceId) }, Math.min(2_147_483_647, Math.max(0, remaining)))
    return () => clearTimeout(timer)
  }, [expiresAt, expiresAfterMs, state.cache])
  useEffect(() => {
    if (state.retired || !(state.cache instanceof PersistentReadCache)) return
    return state.cache.connect(documentNavigation => {
      if (documentNavigation) {
        // Clear the old view without mounting another reader before assign().
        // The next Document creates its ordinary fresh authorized boundary.
        setState(current => ({ ...current, retired: true }))
        return
      }
      // Retire the whole provider, including in-flight requests and component
      // refs. Remounted children use an empty in-memory cache until the server
      // confirms the new account/workspace. An old fetch cannot refill it.
      setState(current => ({ cache: new PersistentReadCache(scope, undefined, false), generation: current.generation + 1 }))
      router.refresh()
    })
  }, [state.cache, state.retired, router, scope])
  if (state.retired) return null
  return <SWRConfig key={state.generation} value={config}><HydrateReadCache />{children}</SWRConfig>
}

export function HydrateReadCache() {
  const { cache, mutate } = useSWRConfig()
  useEffect(() => {
    if (!(cache instanceof PersistentReadCache)) return
    let mounted = true
    void cache.hydrate((key, data) => mutate(key, data, { revalidate: false })).then(() => {
      // Middleware pauses reads before SWR records their start time. Start one
      // validation after all hydration mutations, including keys absent on disk.
      if (mounted) cache.resumeHydrationReads()
    })
    return () => { mounted = false }
  }, [cache, mutate])
  return null
}

/** Rendered only after the sign-in server has confirmed there is no session. */
export function ClearUnauthenticatedReadCache() {
  useEffect(() => { void clearPersistentReadCaches() }, [])
  return null
}
