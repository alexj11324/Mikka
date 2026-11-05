'use client'

import { useEffect } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { useLiveKey, watchPageVisibility } from '@/hooks/use-live-key'
import { computerApi, isMockedComputer, subscribeComputerEvents, type ComputerRead } from '@/lib/computer/client'
import { computerReadDeadline } from '@/lib/computer/state-deadline'
import type { ViewerGrant, ViewerMode } from '@/lib/computer/types'

/**
 * One bot's computer, refreshed by committed changes and observed expiries.
 * The details page, chat card and viewer share the same authorized state.
 */
export function useComputer(botId: string | null | undefined) {
  const key = botId ? ['computer', botId] : null
  const swr = useSWR<ComputerRead>(key, ([, id]: [string, string]) => computerApi.state(id), {
    refreshInterval: 0, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false,
  })
  useLiveKey('computer_state', botId && !isMockedComputer(botId) ? botId : null, key ? [unstable_serialize(key)] : [], swr.data?.live?.workspaceId ?? null, {
    minIntervalMs: 500, deadline: computerReadDeadline(swr.data),
  })
  const { mutate } = swr
  useEffect(() => {
    if (!botId) return
    return subscribeComputerEvents(event => {
      if (event.type === 'computer.machine') { void mutate(current => current && { ...current, machine: event.state }, { revalidate: false }); return }
      if (event.botId !== botId) return
      if (event.type === 'computer.control') void mutate(current => current && { ...current, control: event.control, controlledBy: event.controlledBy }, { revalidate: false })
      else if (event.type === 'computer.action') void mutate(current => current && { ...current, lastAction: event.lastAction }, { revalidate: false })
      else void mutate(current => current && { ...current, pendingApproval: event.approval ?? undefined }, { revalidate: false })
    }, isMockedComputer(botId))
  }, [botId, mutate])
  return swr
}

/** When a grant is renewed: half a minute before it expires, never sooner than 5 s after it was issued. */
export function viewerRenewalDelay(grant: ViewerGrant, now = Date.now()) {
  return Math.max(5000, Date.parse(grant.expiresAt) - now - 30_000)
}

/**
 * A short-lived noVNC URL, renewed half a minute before it expires. One timer
 * per grant at its own expiry, not a periodic read (#1212): a renewal only
 * happens while the viewer is open, and a hidden page renews once it is shown.
 */
export function useViewerGrant(botId: string | null | undefined, mode: ViewerMode, enabled: boolean) {
  const swr = useSWR<ViewerGrant>(botId && enabled ? ['computer-viewer', botId, mode] : null, ([, id, viewMode]: [string, string, ViewerMode]) => computerApi.viewer(id, viewMode), {
    revalidateOnFocus: false,
  })
  const { data: grant, mutate } = swr
  const active = Boolean(botId && enabled)
  useEffect(() => {
    if (!active || !grant) return
    let due = false
    const renew = () => { if (document.visibilityState === 'visible') void mutate(); else due = true }
    const timer = setTimeout(renew, viewerRenewalDelay(grant))
    const unwatch = watchPageVisibility(() => { if (due && document.visibilityState === 'visible') { due = false; void mutate() } })
    return () => { clearTimeout(timer); unwatch() }
  }, [active, grant, mutate])
  return swr
}
