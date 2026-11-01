'use client'

import { useEffect } from 'react'
import useSWR from 'swr'
import { computerApi, isMockedComputer, subscribeComputerEvents } from '@/lib/computer/client'
import type { ComputerState, ViewerGrant, ViewerMode } from '@/lib/computer/types'

/**
 * One bot's computer: polled every 2s and patched by pushes, so the details
 * page, the chat card and the viewer all show the same state.
 */
export function useComputer(botId: string | null | undefined) {
  const swr = useSWR<ComputerState>(botId ? ['computer', botId] : null, ([, id]: [string, string]) => computerApi.state(id), { refreshInterval: 2000 })
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

/** A short-lived noVNC URL, renewed half a minute before it expires. */
export function useViewerGrant(botId: string | null | undefined, mode: ViewerMode, enabled: boolean) {
  return useSWR<ViewerGrant>(botId && enabled ? ['computer-viewer', botId, mode] : null, ([, id, viewMode]: [string, string, ViewerMode]) => computerApi.viewer(id, viewMode), {
    revalidateOnFocus: false,
    refreshInterval: grant => grant ? Math.max(5000, Date.parse(grant.expiresAt) - Date.now() - 30_000) : 0,
  })
}
