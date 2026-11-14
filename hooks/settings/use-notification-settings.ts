'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { updatePreferences, type getPreferences } from '@/app/actions/preferences'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import type { Preferences } from '@/lib/preferences'

export type NotificationFlags = Pick<Preferences, 'proactive' | 'pushDecide' | 'pushReview' | 'pushFinished' | 'pushBriefing' | 'pushWhen'>
export type NotificationSwitch = Exclude<keyof NotificationFlags, 'pushWhen'>
/** The switches in the order both pages show them */
export const NOTIFICATION_SWITCHES: NotificationSwitch[] = ['proactive', 'pushDecide', 'pushReview', 'pushFinished', 'pushBriefing']

/**
 * D16: the notification settings the phone already has, with optimistic saves
 * that roll back when refused. Shared by the open-source page and the hosted
 * layer (docs/ui-overlay.md).
 */
export function useNotificationSettings() {
  const { data, error, mutate } = useSWR(settingsKeys.preferences(), () => settingsRead<Awaited<ReturnType<typeof getPreferences>>>('preferences'))
  // The change that did not save, kept so 重试 sends exactly it again.
  const [failed, setFailed] = useState<Partial<NotificationFlags> | null>(null)

  async function set(patch: Partial<NotificationFlags>) {
    if (!data) return
    setFailed(null)
    try {
      await mutate(async current => {
        const result = await updatePreferences(patch)
        // A refused save comes back as { error }, not as a throw. Throwing rolls the switch back.
        if (result.error) throw new Error(result.error)
        return { ...(current ?? data), ...result }
      }, { optimisticData: { ...data, ...patch }, rollbackOnError: true, revalidate: false })
    } catch {
      setFailed(patch)
    }
  }

  return { data, error, reload: mutate, set, failed, retry: () => { if (failed) void set(failed) } }
}
