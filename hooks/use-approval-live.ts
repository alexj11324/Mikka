'use client'

import useSWR from 'swr'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import posthog from 'posthog-js'
import { withBasePath } from '@/lib/base-path'
import { personalApprovalWorkspace } from '@/lib/live/approval-cache'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'

const subscribe = (notify: () => void) => posthog.onFeatureFlags(() => notify())
const flagHint = () => posthog.getFeatureFlag('mikka-personal-writes-off', { send_event: false })
const serverHint = () => undefined

/** The browser's flag is only a hint to reread the server capability. Server
 * deployment identity and every POST's kill-switch check remain authoritative.
 * Repeated callbacks with the same value never reintroduce a polling read. */
export function useApprovalFlagHint(refresh: () => unknown) {
  const value = useSyncExternalStore(subscribe, flagHint, serverHint)
  const previous = useRef(value)
  useEffect(() => {
    if (Object.is(previous.current, value)) return
    previous.current = value
    void Promise.resolve().then(refresh).catch(() => {}) // SWR retains and displays the read error.
  }, [value, refresh])
}

/** Shares the existing authenticated switcher cache. Another signed-in
 * account or the currently selected team never supplies a personal scope. */
export function usePersonalApprovalScope(ownerId: string | undefined) {
  const { data } = useSWR<WorkspaceSwitcher>(ownerId ? '/api/workspace/switcher' : null, async () => {
    const response = await fetch(withBasePath('/api/workspace/switcher'), { cache: 'no-store' })
    if (!response.ok) throw Error('approvalScopeUnavailable')
    return response.json() as Promise<WorkspaceSwitcher>
  }, { refreshInterval: 0, shouldRetryOnError: false })
  return personalApprovalWorkspace(data, ownerId)
}
