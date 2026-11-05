'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { SWRConfig, unstable_serialize, useSWRConfig, type Cache, type Key } from 'swr'
import { useSearchParams } from 'next/navigation'
import { useRouter } from '@/i18n/navigation'
import { APP_BUILD } from '@/lib/app-build'
import type { AuthorizedCacheWorkspace } from '@/lib/swr/cache-scope'
import { clearPersistentReadCaches, PersistentReadCache, readCacheNamespace, type ReadCacheScope, type ReadCacheState } from '@/lib/swr/persistent-cache'

type InitialRead = { key: unknown; data: unknown }

/** Both the main window and a directly opened Settings page use this boundary.
 * The scope comes from the authenticated server render, never browser storage. */
export function AuthenticatedReadCache({ ownerId, workspace, build = APP_BUILD, initialReads, children }: { ownerId: string; workspace?: AuthorizedCacheWorkspace | null; build?: string; initialReads?: readonly InitialRead[]; children: ReactNode }) {
  const requested = useSearchParams().get('workspace')
  // A pushState to a different workspace must not borrow this one's authority.
  // Its normal reads still work; persistence waits for an authorized server render.
  const scope: ReadCacheScope | null = build && workspace && (!requested || requested === workspace.workspaceId)
    ? { userId: ownerId, workspaceId: workspace.workspaceId, role: workspace.role, build } : null
  const unauthorized = Boolean(build && (!workspace || requested && requested !== workspace.workspaceId))
  return <ReadCacheBoundary key={scope ? readCacheNamespace(scope) : `${ownerId}:${requested ?? ''}:memory`} scope={scope} unauthorized={unauthorized} initialReads={initialReads}>{children}</ReadCacheBoundary>
}

function ReadCacheBoundary({ scope, unauthorized, initialReads, children }: { scope: ReadCacheScope | null; unauthorized: boolean; initialReads?: readonly InitialRead[]; children: ReactNode }) {
  const router = useRouter()
  const [state, setState] = useState<{ cache: Cache; generation: number }>(() => {
    const cache: Cache = scope ? new PersistentReadCache(scope) : new Map()
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
  useEffect(() => {
    if (!(state.cache instanceof PersistentReadCache)) return
    return state.cache.connect(() => {
      // Retire the whole provider, including in-flight requests and component
      // refs. Remounted children use an empty in-memory cache until the server
      // confirms the new account/workspace. An old fetch cannot refill it.
      setState(current => ({ cache: new Map(), generation: current.generation + 1 }))
      router.refresh()
    })
  }, [state.cache, router])
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
      if (mounted && cache.isEnabled) for (const key of cache.hydrationReadKeys) {
        if (!cache.hasFreshData(key)) void mutate(key)
      }
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
